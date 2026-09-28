//! Incremental full-text project search: an SQLite FTS5 index of every
//! searchable line, kept current by the file watcher and project transactions
//! and rebuilt from scratch when its schema changes or the database is corrupt.

use crate::models::ProjectSearchResult;
use crate::project;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;

const SCHEMA_VERSION: &str = "4";
const MAX_HITS: usize = 200;
const DB_RELATIVE: &str = ".research/cache/fts.sqlite";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
 );
 CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
    path UNINDEXED,
    line UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
 );
 CREATE TABLE IF NOT EXISTS indexed_files (
    path TEXT PRIMARY KEY NOT NULL,
    modified_ns INTEGER NOT NULL,
    size INTEGER NOT NULL
 );";
const INDEX_TABLES: [&str; 2] = ["lines_fts", "indexed_files"];
static INDEX_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type IndexResult<T> = Result<T, IndexError>;
/// `(modified_ns, size)` recorded for each indexed file.
type Stamp = (i64, i64);

#[derive(Debug)]
struct IndexError {
    message: String,
    sqlite_code: Option<ErrorCode>,
}

impl IndexError {
    fn other(message: impl ToString) -> Self {
        Self { message: message.to_string(), sqlite_code: None }
    }

    fn is_corrupt(&self) -> bool {
        matches!(self.sqlite_code, Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase))
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self { message: error.to_string(), sqlite_code: error.sqlite_error_code() }
    }
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Project search index error: {}", self.message)
    }
}

/// Run `operation` under the root's index lock. A corrupt database is deleted
/// and `recover` runs against a fresh one.
fn with_index_lock<T>(
    root: &Path, operation: impl FnOnce() -> IndexResult<T>,
    recover: impl FnOnce() -> IndexResult<T>,
) -> Result<T, String> {
    let lock = index_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match operation() {
        Err(error) if error.is_corrupt() => {
            reset_database(root).map_err(|reset_error| reset_error.to_string())?;
            recover().map_err(|error| error.to_string())
        }
        result => result.map_err(|error| error.to_string()),
    }
}

pub fn search(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = project::search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    with_index_lock(root, || search_locked(root, &terms), || search_locked(root, &terms))
}

/// Apply a debounced watcher batch without creating an index before it is
/// needed. The watcher reports both rename endpoints, so a missing old path is
/// removed while the new path is inserted in the same SQLite transaction.
pub(crate) fn update_paths(root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    with_index_lock(root, || update_paths_locked(root, paths), || ensure_index(root).map(drop))
}

/// Repair missed watcher events away from the search hot path. This is called
/// when a watcher starts and periodically while it remains alive.
pub(crate) fn reconcile(root: &Path) -> Result<(), String> {
    let reconcile_existing = || match existing_index(root)? {
        Some(mut conn) => reconcile_connection(&mut conn, root),
        None => Ok(()),
    };
    with_index_lock(root, reconcile_existing, || ensure_index(root).map(drop))
}

fn index_lock(root: &Path) -> Arc<Mutex<()>> {
    let mut locks = INDEX_LOCKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
    lock
}

/// A file hit; line 1 with the path as snippet for path-only matches.
fn search_hit(path: &str, snippet: String, line: Option<u32>) -> ProjectSearchResult {
    let title = Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path);
    let file_kind = path.rsplit('.').next().map(|extension| extension.to_lowercase());
    project::file_search_result(path, title, snippet, line, file_kind)
}

fn search_locked(root: &Path, terms: &[String]) -> IndexResult<Vec<ProjectSearchResult>> {
    let conn = ensure_index(root)?;
    let mut stmt = conn.prepare(
        "SELECT path, line, text, rank
             FROM lines_fts
             WHERE lines_fts MATCH ?1
             ORDER BY rank, path, line
             LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![build_match_query(terms), MAX_HITS as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
    })?;

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let (path, line, text) = row?;
        if seen.insert(format!("{path}:{line}")) {
            let line = (line > 0).then_some(line as u32);
            results.push(search_hit(&path, project::clip_line(&text, 180), line));
        }
    }

    // Path-only matches that FTS may miss when the query looks like a filename.
    if results.len() < MAX_HITS {
        let mut stmt = conn.prepare("SELECT path FROM indexed_files ORDER BY path")?;
        for relative in stmt.query_map([], |row| row.get::<_, String>(0))? {
            let relative = relative?;
            let haystack = path_search_text(&relative).to_lowercase();
            if terms.iter().all(|term| haystack.contains(term))
                && seen.insert(format!("{relative}:0"))
            {
                results.push(search_hit(&relative, relative.clone(), Some(1)));
                if results.len() >= MAX_HITS {
                    break;
                }
            }
        }
    }
    results.truncate(MAX_HITS);
    Ok(results)
}

/// The index database with its tables in place, and whether it was built at
/// the current schema.
fn open_db(root: &Path) -> IndexResult<(Connection, bool)> {
    let conn = Connection::open(root.join(DB_RELATIVE))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    let current = meta_get(&conn, "schema")?.as_deref() == Some(SCHEMA_VERSION);
    Ok((conn, current))
}

fn ensure_index(root: &Path) -> IndexResult<Connection> {
    fs::create_dir_all(root.join(".research/cache")).map_err(IndexError::other)?;
    let (mut conn, current) = open_db(root)?;
    if !current {
        rebuild(&mut conn, root)?;
    }
    Ok(conn)
}

/// The index if one was already built at the current schema. Watcher updates
/// never build one: the first search does.
fn existing_index(root: &Path) -> IndexResult<Option<Connection>> {
    if !root.join(DB_RELATIVE).exists() {
        return Ok(None);
    }
    let (conn, current) = open_db(root)?;
    Ok(current.then_some(conn))
}

fn rebuild(conn: &mut Connection, root: &Path) -> IndexResult<()> {
    let transaction = conn.transaction()?;
    transaction.execute_batch("DELETE FROM lines_fts; DELETE FROM indexed_files;")?;
    for relative in collect_searchable_paths(root)? {
        index_file(&transaction, root, &relative)?;
    }
    transaction.execute("DELETE FROM meta WHERE key = 'fingerprint'", [])?;
    meta_set(&transaction, "schema", SCHEMA_VERSION)?;
    let now = unix_timestamp();
    meta_set(&transaction, "built_at", &now)?;
    meta_set(&transaction, "reconciled_at", &now)?;
    Ok(transaction.commit()?)
}

fn index_file(conn: &Connection, root: &Path, relative: &str) -> IndexResult<()> {
    delete_file(conn, relative)?;
    let absolute = project::safe_path(root, relative).map_err(IndexError::other)?;
    let (content, (modified_ns, size)) = read_stable_source(&absolute)?;
    conn.execute(
        "INSERT INTO indexed_files(path, modified_ns, size) VALUES (?1, ?2, ?3)",
        params![relative, modified_ns, size],
    )?;
    let mut insert = conn.prepare("INSERT INTO lines_fts(path, line, text) VALUES (?1, ?2, ?3)")?;
    insert.execute(params![relative, 0i64, path_search_text(relative)])?;
    for (line_number, line) in project::searchable_text_lines(relative, &content) {
        insert.execute(params![relative, line_number as i64, line])?;
    }
    Ok(())
}

/// Read content and its stamp from the same file generation. Atomic-save tools
/// can replace a path between opening it and the final path metadata check;
/// recording the replacement's stamp beside the old bytes would make
/// reconciliation trust a stale index forever. A short bounded retry is
/// sufficient after the watcher debounce and keeps a constantly changing file
/// from blocking the batch.
fn read_stable_source(path: &Path) -> IndexResult<(String, Stamp)> {
    for _ in 0..3 {
        let mut file = fs::File::open(path).map_err(IndexError::other)?;
        let before = file.metadata().map_err(IndexError::other)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(IndexError::other)?;
        let after = fs::metadata(path).map_err(IndexError::other)?;
        if same_file_generation(&before, &after) {
            return Ok((String::from_utf8(bytes).unwrap_or_default(), file_stamp(&before)));
        }
    }
    Err(IndexError::other(format!("{} kept changing while it was indexed", path.display())))
}

fn same_file_generation(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    file_stamp(before) == file_stamp(after)
        && (before.dev(), before.ino()) == (after.dev(), after.ino())
}

/// Every searchable file the Project pane shows.
fn collect_searchable_paths(root: &Path) -> IndexResult<Vec<String>> {
    let nodes = project::scan_tree(root, project::TreeView::Project).map_err(IndexError::other)?;
    Ok(project::tree_files(&nodes)
        .into_iter()
        .filter(|node| project::searchable_text_path(&node.path))
        .map(|node| node.path.clone())
        .collect())
}

/// [`collect_searchable_paths`] beneath one folder, with their stamps.
fn searchable_stamps_under(root: &Path, relative: &Path) -> IndexResult<HashMap<String, Stamp>> {
    let mut stamps = HashMap::new();
    let walker =
        WalkDir::new(root.join(relative)).follow_links(false).into_iter().filter_entry(|entry| {
            entry.depth() == 0
                || entry
                    .path()
                    .strip_prefix(root)
                    .is_ok_and(|relative| project::project_tree_path_visible(root, relative))
        });
    for entry in walker {
        let entry = entry.map_err(IndexError::other)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(root).map_err(IndexError::other)?;
        let relative = relative.to_string_lossy().to_string();
        if project::searchable_text_path(&relative) {
            if let Ok(metadata) = fs::metadata(root.join(&relative)) {
                stamps.insert(relative, file_stamp(&metadata));
            }
        }
    }
    Ok(stamps)
}

fn update_paths_locked(root: &Path, paths: &[PathBuf]) -> IndexResult<()> {
    let Some(mut conn) = existing_index(root)? else {
        return Ok(());
    };
    let mut relative_paths = Vec::<PathBuf>::new();
    for path in paths {
        let absolute = if path.is_absolute() { path.clone() } else { root.join(path) };
        let relative = match absolute.strip_prefix(root) {
            Ok(relative) if !relative.as_os_str().is_empty() => relative,
            _ => return reconcile_connection(&mut conn, root),
        };
        if !relative_paths.iter().any(|known| relative.starts_with(known)) {
            relative_paths.retain(|known| !known.starts_with(relative));
            relative_paths.push(relative.to_path_buf());
        }
    }

    let transaction = conn.transaction()?;
    for relative in relative_paths {
        update_path(&transaction, root, &relative)?;
    }
    meta_set(&transaction, "updated_at", &unix_timestamp())?;
    Ok(transaction.commit()?)
}

fn update_path(conn: &Connection, root: &Path, relative: &Path) -> IndexResult<()> {
    match fs::symlink_metadata(root.join(relative)) {
        Ok(metadata)
            if !metadata.file_type().is_symlink()
                && project::project_tree_path_visible(root, relative) =>
        {
            if metadata.is_dir() {
                let current = searchable_stamps_under(root, relative)?;
                return sync_stamps(conn, root, current, Some(relative));
            }
            delete_prefix(conn, relative)?;
            let relative = relative.to_string_lossy();
            if metadata.is_file() && project::searchable_text_path(&relative) {
                index_file(conn, root, &relative)?;
            }
            Ok(())
        }
        _ => delete_prefix(conn, relative),
    }
}

fn reconcile_connection(conn: &mut Connection, root: &Path) -> IndexResult<()> {
    let mut current = HashMap::new();
    for relative in collect_searchable_paths(root)? {
        let absolute = project::safe_path(root, &relative).map_err(IndexError::other)?;
        if let Ok(metadata) = fs::metadata(absolute) {
            current.insert(relative, file_stamp(&metadata));
        }
    }
    let transaction = conn.transaction()?;
    sync_stamps(&transaction, root, current, None)?;
    meta_set(&transaction, "reconciled_at", &unix_timestamp())?;
    Ok(transaction.commit()?)
}

/// Drop indexed files under `prefix` (everywhere when `None`) that are no
/// longer `current`, and re-index those whose stamp moved.
fn sync_stamps(
    conn: &Connection, root: &Path, current: HashMap<String, Stamp>, prefix: Option<&Path>,
) -> IndexResult<()> {
    let mut stmt = conn.prepare("SELECT path, modified_ns, size FROM indexed_files")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
    let mut indexed = rows.collect::<Result<HashMap<String, Stamp>, _>>()?;
    indexed.retain(|path, _| prefix.is_none_or(|prefix| Path::new(path).starts_with(prefix)));
    for relative in indexed.keys().filter(|path| !current.contains_key(*path)) {
        delete_file(conn, relative)?;
    }
    for (relative, stamp) in current {
        if indexed.get(&relative) != Some(&stamp) {
            index_file(conn, root, &relative)?;
        }
    }
    Ok(())
}

fn delete_file(conn: &Connection, relative: &str) -> IndexResult<()> {
    for table in INDEX_TABLES {
        conn.execute(&format!("DELETE FROM {table} WHERE path = ?1"), params![relative])?;
    }
    Ok(())
}

/// Remove `prefix` and everything beneath it.
fn delete_prefix(conn: &Connection, prefix: &Path) -> IndexResult<()> {
    let prefix = prefix.to_string_lossy();
    let descendants = format!("{}{}", prefix, std::path::MAIN_SEPARATOR);
    for table in INDEX_TABLES {
        conn.execute(
            &format!("DELETE FROM {table} WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2"),
            params![prefix.as_ref(), descendants],
        )?;
    }
    Ok(())
}

fn file_stamp(metadata: &fs::Metadata) -> Stamp {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    (modified_ns, metadata.len().min(i64::MAX as u64) as i64)
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_default()
}

fn meta_get(conn: &Connection, key: &str) -> IndexResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0))
        .optional()?)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> IndexResult<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn reset_database(root: &Path) -> IndexResult<()> {
    let path = root.join(DB_RELATIVE).into_os_string();
    for suffix in ["", "-wal", "-shm"] {
        let mut sidecar = path.clone();
        sidecar.push(suffix);
        if let Err(error) = fs::remove_file(sidecar) {
            if error.kind() != ErrorKind::NotFound {
                return Err(IndexError::other(error));
            }
        }
    }
    Ok(())
}

/// Every term as a quoted prefix match. Prefix matching is what users expect
/// from incremental search and is especially important for BibTeX keys such
/// as `chen2024single`.
fn build_match_query(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn path_search_text(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let spaced = normalized.replace(['/', '.', '-', '_'], " ");
    format!("{normalized} {spaced}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    fn has_hit(root: &Path, query: &str, path: &str) -> bool {
        search(root, query).unwrap().iter().any(|hit| hit.path == path)
    }

    fn misses(root: &Path, query: &str) -> bool {
        search(root, query).unwrap().is_empty()
    }

    fn db(root: &Path) -> Connection {
        Connection::open(root.join(DB_RELATIVE)).unwrap()
    }

    #[test]
    fn indexes_and_finds_multiple_line_hits_but_not_hidden_files() {
        let fixture = Fixture::project("fts");
        let root = &fixture.root;
        fixture.write(
            "sections/method.tex",
            "Intro line.\nA distinctive latent alignment objective.\nAnother latent alignment remark.\n",
        );
        fixture.write(".private-notes.md", "hidden_root_search_token\n");
        fixture.write(".drafts/notes.md", "hidden_directory_search_token\n");

        let hits = search(root, "latent alignment").unwrap();
        assert!(hits.len() >= 2);
        assert!(hits.iter().all(|hit| hit.path == "sections/method.tex"));
        for line in [2, 3] {
            assert!(hits.iter().any(|hit| hit.line == Some(line)), "line {line}");
        }
        assert!(has_hit(root, "method.tex", "sections/method.tex"));

        fixture.write(
            "supplement.html",
            "<!doctype html>\n<html>\n<head>\n<title>Private metadata title</title>\n<style>.private-style-token { color: red; }</style>\n<script>window.privateScriptToken = true;</script>\n</head>\n<body data-private-attribute-token=\"true\">\n<main><p>A distinctive supplementary result &amp; conclusion.</p></main>\n</body>\n</html>\n",
        );
        update_paths(root, &[fixture.path("supplement.html")]).unwrap();
        let html_hits = search(root, "supplementary result").unwrap();
        assert!(html_hits.iter().any(|hit| {
            hit.path == "supplement.html"
                && hit.line == Some(9)
                && hit.snippet.contains("result & conclusion")
        }));

        // BibTeX keys match by name and prefix; diacritics fold.
        fixture.write("references.bib", "@article{chen2024single, title={A Single Transformer}}\n");
        fixture.write("résumé.md", "A naïve café comparison.\n");
        update_paths(root, &[fixture.path("references.bib"), fixture.path("résumé.md")]).unwrap();
        for (query, path) in [
            ("chen2024single", "references.bib"),
            ("chen", "references.bib"),
            ("cafe", "résumé.md"),
        ] {
            let hits = search(root, query).unwrap();
            assert!(hits.iter().any(|hit| hit.path == path && hit.line == Some(1)), "{query}");
        }

        // Neither HTML outside the body nor hidden files are searchable.
        for query in [
            "private metadata title",
            "private style token",
            "privatescripttoken",
            "private attribute token",
            "hidden_root_search_token",
            "hidden_directory_search_token",
            "private notes",
        ] {
            assert!(misses(root, query), "unexpected hit for {query}");
        }
    }

    #[test]
    fn file_events_and_transactions_update_only_their_files() {
        let fixture = Fixture::project("fts-update");
        let root = &fixture.root;
        fixture.write("a.tex", "alpha unique_token_one\n");
        fixture.write("b.tex", "stable untouched_token\n");
        assert!(has_hit(root, "unique_token_one", "a.tex"));

        db(root)
            .execute_batch(
                "CREATE TABLE update_audit(path TEXT NOT NULL);
                 CREATE TRIGGER audit_indexed_file_delete
                 AFTER DELETE ON indexed_files
                 BEGIN INSERT INTO update_audit(path) VALUES (old.path); END;",
            )
            .unwrap();

        fixture.write("a.tex", "beta unique_token_two\n");
        update_paths(root, &[fixture.path("a.tex")]).unwrap();
        assert!(has_hit(root, "unique_token_two", "a.tex"));
        assert!(misses(root, "unique_token_one"));
        assert!(has_hit(root, "untouched_token", "b.tex"));

        let deleted = db(root)
            .prepare("SELECT path FROM update_audit ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(deleted, vec!["a.tex"]);

        // Project transactions refresh the index before returning.
        let edit = vec![("b.tex".to_string(), "after_transaction_token\n".to_string())];
        project::apply_transaction(root, "Edit b.tex", edit).unwrap();
        assert!(misses(root, "untouched_token"));
        assert!(has_hit(root, "after_transaction_token", "b.tex"));
    }

    #[test]
    fn file_events_and_reconciliation_follow_deletes_renames_and_missed_edits() {
        let fixture = Fixture::project("fts-move");
        let root = &fixture.root;
        fixture.write("removed.md", "obsolete_delete_token\n");
        fixture.write("draft.tex", "durable_rename_token\n");
        fixture.write("external.tex", "before_missed_event\n");
        assert!(has_hit(root, "obsolete_delete_token", "removed.md"));
        assert!(has_hit(root, "before_missed_event", "external.tex"));

        fs::remove_file(fixture.path("removed.md")).unwrap();
        update_paths(root, &[fixture.path("removed.md")]).unwrap();
        assert!(misses(root, "obsolete_delete_token"));

        fs::rename(fixture.path("draft.tex"), fixture.path("final.tex")).unwrap();
        update_paths(root, &[fixture.path("draft.tex"), fixture.path("final.tex")]).unwrap();
        let hits = search(root, "durable_rename_token").unwrap();
        assert!(hits.iter().any(|hit| hit.path == "final.tex"));
        assert!(hits.iter().all(|hit| hit.path != "draft.tex"));
        assert!(misses(root, "draft.tex"));

        fixture.write("old-sections/chapter.tex", "directory_rename_token\n");
        update_paths(root, &[fixture.path("old-sections")]).unwrap();
        fs::rename(fixture.path("old-sections"), fixture.path("new-sections")).unwrap();
        update_paths(root, &[fixture.path("old-sections"), fixture.path("new-sections")]).unwrap();
        let hits = search(root, "directory_rename_token").unwrap();
        assert!(hits.iter().any(|hit| hit.path == "new-sections/chapter.tex"));
        assert!(hits.iter().all(|hit| hit.path != "old-sections/chapter.tex"));

        // Reconciliation repairs an edit the watcher never reported.
        fixture.write("external.tex", "after_missed_watcher_event_with_new_length\n");
        reconcile(root).unwrap();
        assert!(misses(root, "before_missed_event"));
        assert!(has_hit(root, "after_missed_watcher_event", "external.tex"));
    }

    #[test]
    fn the_index_is_built_on_first_search_and_rebuilt_after_upgrades_and_corruption() {
        let fixture = Fixture::project("fts-lifecycle");
        let root = &fixture.root;
        fixture.write("notes.md", "first_build_token\n");
        assert!(!root.join(DB_RELATIVE).exists());
        let assert_current = || {
            assert!(has_hit(root, "first_build_token", "notes.md"));
            let conn = db(root);
            assert_eq!(meta_get(&conn, "schema").unwrap().as_deref(), Some(SCHEMA_VERSION));
            assert_eq!(meta_get(&conn, "fingerprint").unwrap(), None);
            let indexed: i64 = conn
                .query_row(
                    "SELECT count(*) FROM indexed_files WHERE path = ?1",
                    ["notes.md"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(indexed, 1);
        };
        assert_current();

        // A schema change rebuilds atomically, dropping the legacy fingerprint.
        let conn = db(root);
        meta_set(&conn, "schema", "3").unwrap();
        meta_set(&conn, "fingerprint", "legacy-fingerprint").unwrap();
        conn.execute("DELETE FROM indexed_files", []).unwrap();
        drop(conn);
        assert_current();

        // A corrupt database is removed and rebuilt.
        fs::write(root.join(DB_RELATIVE), b"not a sqlite database").unwrap();
        assert_current();
    }
}
