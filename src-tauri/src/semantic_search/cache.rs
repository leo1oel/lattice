//! The persistent, bounded embedding cache.
//!
//! Rows hold only a model version, a normalized-text SHA-256, the quantized
//! vector, and a last-used stamp: no source text and no project path.

use super::{BuildFailure, MAX_EMBEDDING_DIMENSION};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// Bump the suffix whenever the row format changes; older tables are dropped.
const TABLE: &str = "embeddings_v2";

pub(super) struct EmbeddingCache {
    connection: Connection,
}

fn cache_error(error: rusqlite::Error) -> BuildFailure {
    BuildFailure::Failed(format!("Could not use the local semantic cache: {error}"))
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

impl EmbeddingCache {
    pub(super) fn open(path: &Path) -> Result<Self, BuildFailure> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                BuildFailure::Failed(format!("Could not create semantic cache folder: {error}"))
            })?;
        }
        let connection = Connection::open(path).map_err(cache_error)?;
        connection.busy_timeout(std::time::Duration::from_secs(5)).map_err(cache_error)?;
        connection.execute_batch("PRAGMA journal_mode = WAL;").map_err(cache_error)?;
        // Eviction only returns pages to the freelist. Incremental auto-vacuum
        // is what hands them back to the filesystem, and switching an existing
        // database into that mode requires one full VACUUM.
        let auto_vacuum = connection
            .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
            .map_err(cache_error)?;
        if auto_vacuum != 2 {
            connection
                .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")
                .map_err(cache_error)?;
        }
        connection
            .execute_batch(&format!(
                "DROP TABLE IF EXISTS embeddings_v1;
                 CREATE TABLE IF NOT EXISTS {TABLE} (
                   model_version TEXT NOT NULL,
                   normalized_text_hash TEXT NOT NULL,
                   dimension INTEGER NOT NULL,
                   vector BLOB NOT NULL,
                   last_used_ts INTEGER NOT NULL,
                   PRIMARY KEY (model_version, normalized_text_hash)
                 );
                 CREATE INDEX IF NOT EXISTS {TABLE}_last_used ON {TABLE} (last_used_ts);"
            ))
            .map_err(cache_error)?;
        Ok(Self { connection })
    }

    /// A cached vector, ignoring rows whose dimension does not match their blob.
    pub(super) fn get(
        &self, model_version: &str, hash: &str,
    ) -> Result<Option<Vec<i8>>, BuildFailure> {
        let row = self
            .connection
            .query_row(
                &format!(
                    "SELECT dimension, vector FROM {TABLE}
                     WHERE model_version = ?1 AND normalized_text_hash = ?2"
                ),
                params![model_version, hash],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()
            .map_err(cache_error)?;
        let Some((dimension, bytes)) = row else {
            return Ok(None);
        };
        let valid = usize::try_from(dimension).is_ok_and(|dimension| {
            dimension != 0 && dimension <= MAX_EMBEDDING_DIMENSION && dimension == bytes.len()
        });
        Ok(valid.then(|| bytes.into_iter().map(|byte| byte as i8).collect()))
    }

    pub(super) fn put(
        &mut self, model_version: &str, hash: &str, vector: &[i8],
    ) -> Result<(), BuildFailure> {
        let bytes = vector.iter().map(|value| *value as u8).collect::<Vec<u8>>();
        self.connection
            .execute(
                &format!(
                    "INSERT OR REPLACE INTO {TABLE}
                     (model_version, normalized_text_hash, dimension, vector, last_used_ts)
                     VALUES (?1, ?2, ?3, ?4, ?5)"
                ),
                params![model_version, hash, vector.len() as i64, bytes, now_seconds()],
            )
            .map_err(cache_error)?;
        Ok(())
    }

    /// Marks this build's live set as most recently used in one transaction, so
    /// eviction never reclaims vectors the current project still needs.
    pub(super) fn touch(
        &mut self, model_version: &str, hashes: &[String],
    ) -> Result<(), BuildFailure> {
        let stamp = now_seconds();
        let transaction = self.connection.transaction().map_err(cache_error)?;
        {
            let mut statement = transaction
                .prepare(&format!(
                    "UPDATE {TABLE} SET last_used_ts = ?1
                     WHERE model_version = ?2 AND normalized_text_hash = ?3"
                ))
                .map_err(cache_error)?;
            for hash in hashes {
                statement.execute(params![stamp, model_version, hash]).map_err(cache_error)?;
            }
        }
        transaction.commit().map_err(cache_error)
    }

    /// Bounds the cache without a time policy: rows belonging to any other model
    /// version are dead weight (a system model revision invalidates them all),
    /// and anything past `keep_rows` is evicted least-recently-used first.
    pub(super) fn prune(
        &mut self, model_version: &str, keep_rows: usize,
    ) -> Result<(), BuildFailure> {
        let stale = self
            .connection
            .execute(
                &format!("DELETE FROM {TABLE} WHERE model_version <> ?1"),
                params![model_version],
            )
            .map_err(cache_error)?;
        let rows = self
            .connection
            .query_row(&format!("SELECT COUNT(*) FROM {TABLE}"), [], |row| row.get::<_, i64>(0))
            .map_err(cache_error)?;
        let excess = usize::try_from(rows).unwrap_or(usize::MAX).saturating_sub(keep_rows);
        let evicted = self
            .connection
            .execute(
                &format!(
                    "DELETE FROM {TABLE} WHERE rowid IN (
                       SELECT rowid FROM {TABLE} ORDER BY last_used_ts ASC, rowid ASC LIMIT ?1
                     )"
                ),
                params![excess as i64],
            )
            .map_err(cache_error)?;
        if stale + evicted > 0 {
            self.connection.execute_batch("PRAGMA incremental_vacuum;").map_err(cache_error)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic_search::tests::column;
    use crate::test_support::TempDir;

    fn open(dir: &TempDir) -> EmbeddingCache {
        EmbeddingCache::open(&dir.join("cache.sqlite3")).unwrap()
    }

    #[test]
    fn malformed_cache_dimensions_are_ignored_without_overflow() {
        let dir = TempDir::new("cache-dimension");
        let cache = open(&dir);
        cache
            .connection
            .execute(
                "INSERT INTO embeddings_v2
                 (model_version, normalized_text_hash, dimension, vector, last_used_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["test-v1", "hash", i64::MAX, vec![0_u8; 4], 0_i64],
            )
            .unwrap();

        assert!(cache.get("test-v1", "hash").unwrap().is_none());
    }

    #[test]
    fn eviction_keeps_the_cache_bounded_and_drops_stale_model_versions() {
        let dir = TempDir::new("prune");
        let mut cache = open(&dir);
        for (index, hash) in ["oldest", "middle", "newest"].iter().enumerate() {
            cache.put("model-a", hash, &[1, 2, 3, 4]).unwrap();
            cache
                .connection
                .execute(
                    "UPDATE embeddings_v2 SET last_used_ts = ?1 WHERE normalized_text_hash = ?2",
                    params![index as i64, hash],
                )
                .unwrap();
        }
        cache.put("model-b", "other-model", &[1, 2, 3, 4]).unwrap();

        cache.prune("model-a", 2).unwrap();

        let remaining: Vec<String> = column(
            &cache.connection,
            "SELECT normalized_text_hash FROM embeddings_v2 ORDER BY last_used_ts",
        );
        assert_eq!(remaining, ["middle", "newest"]);
    }

    #[test]
    fn the_unbounded_v1_cache_is_discarded_on_upgrade() {
        let dir = TempDir::new("legacy");
        Connection::open(dir.join("cache.sqlite3"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE embeddings_v1 (
                   model_version TEXT NOT NULL,
                   normalized_text_hash TEXT NOT NULL,
                   dimension INTEGER NOT NULL,
                   vector BLOB NOT NULL,
                   PRIMARY KEY (model_version, normalized_text_hash)
                 );
                 INSERT INTO embeddings_v1 VALUES ('old', 'hash', 1, x'00');",
            )
            .unwrap();

        let cache = open(&dir);
        let legacy_tables: Vec<i64> = column(
            &cache.connection,
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'embeddings_v1'",
        );
        assert_eq!(legacy_tables, [0]);
        assert_eq!(column::<i64>(&cache.connection, "PRAGMA auto_vacuum"), [2]);
    }
}
