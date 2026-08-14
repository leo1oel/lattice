use crate::models::{FileNode, ProjectSearchResult};
use crate::project;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;

const SCHEMA_VERSION: &str = "4";
const MAX_HITS: usize = 200;
const DB_RELATIVE: &str = ".research/cache/fts.sqlite";
static INDEX_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type IndexResult<T> = Result<T, IndexError>;

#[derive(Debug)]
struct IndexError {
    message: String,
    sqlite_code: Option<ErrorCode>,
}

impl IndexError {
    fn other(message: impl ToString) -> Self {
        Self {
            message: message.to_string(),
            sqlite_code: None,
        }
    }

    fn is_corrupt(&self) -> bool {
        matches!(
            self.sqlite_code,
            Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
        )
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self {
            message: error.to_string(),
            sqlite_code: error.sqlite_error_code(),
        }
    }
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Project search index error: {}", self.message)
    }
}

pub fn search(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = project::search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let lock = index_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match search_locked(root, &terms) {
        Ok(results) => Ok(results),
        Err(error) if error.is_corrupt() => {
            reset_database(root).map_err(|reset_error| reset_error.to_string())?;
            search_locked(root, &terms).map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn search_locked(root: &Path, terms: &[String]) -> IndexResult<Vec<ProjectSearchResult>> {
    let conn = ensure_index(root)?;
    let match_query = build_match_query(terms)?;
    let mut stmt = conn.prepare(
        "SELECT path, line, text, rank
             FROM lines_fts
             WHERE lines_fts MATCH ?1
             ORDER BY rank, path, line
             LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![match_query, MAX_HITS as i64], |row| {
        let path: String = row.get(0)?;
        let line: i64 = row.get(1)?;
        let text: String = row.get(2)?;
        Ok((path, line, text))
    })?;

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let (path, line, text) = row?;
        let key = format!("{path}:{line}");
        if !seen.insert(key) {
            continue;
        }
        let title = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(path.as_str())
            .to_string();
        let snippet = clip_snippet(&text);
        let line = if line <= 0 { None } else { Some(line as u32) };
        let file_kind = path
            .rsplit('.')
            .next()
            .map(|extension| extension.to_lowercase());
        results.push(ProjectSearchResult {
            kind: "file".to_string(),
            path,
            title,
            snippet,
            line,
            arxiv_id: None,
            file_kind,
        });
    }

    // Path-only matches that FTS may miss when the query looks like a filename.
    if results.len() < MAX_HITS {
        append_path_matches(&conn, terms, &mut results, &mut seen)?;
    }
    results.truncate(MAX_HITS);
    Ok(results)
}

#[allow(dead_code)]
pub fn invalidate(root: &Path) {
    let lock = index_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = reset_database(root);
}

/// Apply a debounced watcher batch without creating an index before it is
/// needed. The watcher reports both rename endpoints, so a missing old path is
/// removed while the new path is inserted in the same SQLite transaction.
pub(crate) fn update_paths(root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    let lock = index_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match update_paths_locked(root, paths) {
        Ok(()) => Ok(()),
        Err(error) if error.is_corrupt() => {
            reset_database(root).map_err(|reset_error| reset_error.to_string())?;
            ensure_index(root)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Repair missed watcher events away from the search hot path. This is called
/// when a watcher starts and periodically while it remains alive.
pub(crate) fn reconcile(root: &Path) -> Result<(), String> {
    let lock = index_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match reconcile_initialized(root) {
        Ok(()) => Ok(()),
        Err(error) if error.is_corrupt() => {
            reset_database(root).map_err(|reset_error| reset_error.to_string())?;
            ensure_index(root)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn index_lock(root: &Path) -> Arc<Mutex<()>> {
    let mut locks = INDEX_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
    lock
}

fn ensure_index(root: &Path) -> IndexResult<Connection> {
    fs::create_dir_all(root.join(".research/cache")).map_err(IndexError::other)?;
    let mut conn = open_db(root)?;
    init_schema(&conn)?;
    if meta_get(&conn, "schema")?.as_deref() != Some(SCHEMA_VERSION) {
        rebuild(&mut conn, root)?;
    }
    Ok(conn)
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
    transaction.commit()?;
    Ok(())
}

fn index_file(conn: &Connection, root: &Path, relative: &str) -> IndexResult<()> {
    delete_file(conn, relative)?;
    let absolute = project::safe_path(root, relative).map_err(IndexError::other)?;
    let content = fs::read_to_string(&absolute).unwrap_or_default();
    let metadata = fs::metadata(&absolute).map_err(IndexError::other)?;
    let (modified_ns, size) = file_stamp(&metadata);
    conn.execute(
        "INSERT INTO indexed_files(path, modified_ns, size) VALUES (?1, ?2, ?3)",
        params![relative, modified_ns, size],
    )?;
    let mut insert = conn.prepare("INSERT INTO lines_fts(path, line, text) VALUES (?1, ?2, ?3)")?;
    let path_tokens = path_search_text(relative);
    insert.execute(params![relative, 0i64, path_tokens])?;
    for (line_number, line) in project::searchable_text_lines(relative, &content) {
        insert.execute(params![relative, line_number as i64, line])?;
    }
    Ok(())
}

fn append_path_matches(
    conn: &Connection,
    terms: &[String],
    results: &mut Vec<ProjectSearchResult>,
    seen: &mut HashSet<String>,
) -> IndexResult<()> {
    let mut stmt = conn.prepare("SELECT path FROM indexed_files ORDER BY path")?;
    let paths = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for relative in paths {
        let relative = relative?;
        let haystack = path_search_text(&relative).to_lowercase();
        if !terms.iter().all(|term| haystack.contains(term)) {
            continue;
        }
        let key = format!("{relative}:0");
        if !seen.insert(key) {
            continue;
        }
        let title = Path::new(&relative)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(relative.as_str())
            .to_string();
        results.push(ProjectSearchResult {
            kind: "file".to_string(),
            path: relative.clone(),
            title,
            snippet: relative.clone(),
            line: Some(1),
            arxiv_id: None,
            file_kind: relative
                .rsplit('.')
                .next()
                .map(|extension| extension.to_lowercase()),
        });
        if results.len() >= MAX_HITS {
            break;
        }
    }
    Ok(())
}

fn collect_searchable_paths(root: &Path) -> IndexResult<Vec<String>> {
    let mut paths = Vec::new();
    collect_searchable_nodes(
        &project::list_files_for_search(root).map_err(IndexError::other)?,
        &mut paths,
    );
    Ok(paths)
}

fn collect_searchable_nodes(nodes: &[FileNode], paths: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            collect_searchable_nodes(&node.children, paths);
            continue;
        }
        if project::searchable_text_path(&node.path) {
            paths.push(node.path.clone());
        }
    }
}

fn collect_searchable_paths_under(root: &Path, relative: &Path) -> IndexResult<Vec<String>> {
    let absolute = root.join(relative);
    let mut paths = Vec::new();
    let walker = WalkDir::new(&absolute)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
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
            paths.push(relative);
        }
    }
    paths.sort();
    Ok(paths)
}

fn update_paths_locked(root: &Path, paths: &[PathBuf]) -> IndexResult<()> {
    if !db_path(root).exists() {
        return Ok(());
    }
    let mut conn = open_db(root)?;
    init_schema(&conn)?;
    if meta_get(&conn, "schema")?.as_deref() != Some(SCHEMA_VERSION) {
        return Ok(());
    }

    let mut relative_paths = Vec::<PathBuf>::new();
    for path in paths {
        let absolute = if path.is_absolute() {
            path.clone()
        } else {
            root.join(path)
        };
        let Ok(relative) = absolute.strip_prefix(root) else {
            return reconcile_connection(&mut conn, root);
        };
        if relative.as_os_str().is_empty() {
            return reconcile_connection(&mut conn, root);
        }
        if !relative_paths
            .iter()
            .any(|known| relative.starts_with(known))
        {
            relative_paths.retain(|known| !known.starts_with(relative));
            relative_paths.push(relative.to_path_buf());
        }
    }

    let transaction = conn.transaction()?;
    for relative in relative_paths {
        update_path(&transaction, root, &relative)?;
    }
    meta_set(&transaction, "updated_at", &unix_timestamp())?;
    transaction.commit()?;
    Ok(())
}

fn update_path(conn: &Connection, root: &Path, relative: &Path) -> IndexResult<()> {
    let absolute = root.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&absolute) else {
        delete_prefix(conn, relative)?;
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !project::project_tree_path_visible(root, relative) {
        delete_prefix(conn, relative)?;
        return Ok(());
    }
    if metadata.is_dir() {
        return reconcile_subtree(conn, root, relative);
    }
    delete_prefix(conn, relative)?;
    let relative = relative.to_string_lossy();
    if metadata.is_file() && project::searchable_text_path(&relative) {
        index_file(conn, root, &relative)?;
    }
    Ok(())
}

fn reconcile_initialized(root: &Path) -> IndexResult<()> {
    if !db_path(root).exists() {
        return Ok(());
    }
    let mut conn = open_db(root)?;
    init_schema(&conn)?;
    if meta_get(&conn, "schema")?.as_deref() != Some(SCHEMA_VERSION) {
        return Ok(());
    }
    reconcile_connection(&mut conn, root)
}

fn reconcile_connection(conn: &mut Connection, root: &Path) -> IndexResult<()> {
    let mut current = HashMap::new();
    for relative in collect_searchable_paths(root)? {
        let absolute = project::safe_path(root, &relative).map_err(IndexError::other)?;
        if let Ok(metadata) = fs::metadata(absolute) {
            current.insert(relative, file_stamp(&metadata));
        }
    }
    let indexed = indexed_file_stamps(conn)?;
    let transaction = conn.transaction()?;
    for relative in indexed.keys().filter(|path| !current.contains_key(*path)) {
        delete_file(&transaction, relative)?;
    }
    for (relative, stamp) in current {
        if indexed.get(&relative) != Some(&stamp) {
            index_file(&transaction, root, &relative)?;
        }
    }
    meta_set(&transaction, "reconciled_at", &unix_timestamp())?;
    transaction.commit()?;
    Ok(())
}

fn reconcile_subtree(conn: &Connection, root: &Path, prefix: &Path) -> IndexResult<()> {
    let mut current = HashMap::new();
    for relative in collect_searchable_paths_under(root, prefix)? {
        if let Ok(metadata) = fs::metadata(root.join(&relative)) {
            current.insert(relative, file_stamp(&metadata));
        }
    }
    let indexed = indexed_file_stamps(conn)?
        .into_iter()
        .filter(|(path, _)| Path::new(path).starts_with(prefix))
        .collect::<HashMap<_, _>>();
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

fn indexed_file_stamps(conn: &Connection) -> IndexResult<HashMap<String, (i64, i64)>> {
    let mut stmt = conn.prepare("SELECT path, modified_ns, size FROM indexed_files")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
    let mut indexed = HashMap::new();
    for row in rows {
        let (path, stamp) = row?;
        indexed.insert(path, stamp);
    }
    Ok(indexed)
}

fn delete_prefix(conn: &Connection, prefix: &Path) -> IndexResult<()> {
    let prefix = prefix.to_string_lossy();
    let descendants = format!("{}{}", prefix, std::path::MAIN_SEPARATOR);
    conn.execute(
        "DELETE FROM lines_fts
         WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2",
        params![prefix.as_ref(), descendants],
    )?;
    conn.execute(
        "DELETE FROM indexed_files
         WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2",
        params![prefix.as_ref(), descendants],
    )?;
    Ok(())
}

fn delete_file(conn: &Connection, relative: &str) -> IndexResult<()> {
    conn.execute("DELETE FROM lines_fts WHERE path = ?1", params![relative])?;
    conn.execute(
        "DELETE FROM indexed_files WHERE path = ?1",
        params![relative],
    )?;
    Ok(())
}

fn file_stamp(metadata: &fs::Metadata) -> (i64, i64) {
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

fn open_db(root: &Path) -> IndexResult<Connection> {
    let conn = Connection::open(db_path(root))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

fn db_path(root: &Path) -> PathBuf {
    root.join(DB_RELATIVE)
}

fn init_schema(conn: &Connection) -> IndexResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
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
         );",
    )?;
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> IndexResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
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
    let path = db_path(root);
    for path in [
        path.clone(),
        sqlite_sidecar(&path, "-wal"),
        sqlite_sidecar(&path, "-shm"),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(IndexError::other(error)),
        }
    }
    Ok(())
}

fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn build_match_query(terms: &[String]) -> IndexResult<String> {
    if terms.is_empty() {
        return Err(IndexError::other("Empty search."));
    }
    Ok(terms
        .iter()
        // Prefix matching is what users expect from incremental search and is
        // especially important for BibTeX keys such as `chen2024single`.
        .map(|term| format!("\"{}\"*", escape_fts_token(term)))
        .collect::<Vec<_>>()
        .join(" AND "))
}

fn escape_fts_token(term: &str) -> String {
    term.replace('"', "\"\"")
}

fn path_search_text(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let spaced = normalized.replace(['/', '.', '-', '_'], " ");
    format!("{normalized} {spaced}")
}

fn clip_snippet(text: &str) -> String {
    let trimmed = text.trim();
    let clipped: String = trimmed.chars().take(180).collect();
    if trimmed.chars().count() > 180 {
        format!("{clipped}…")
    } else {
        clipped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project;

    #[test]
    fn indexes_and_finds_multiple_line_hits() {
        let parent = std::env::temp_dir().join(format!("lattice-fts-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::create_dir_all(root.join("sections")).unwrap();
        fs::write(
            root.join("sections/method.tex"),
            "Intro line.\nA distinctive latent alignment objective.\nAnother latent alignment remark.\n",
        )
        .unwrap();

        let hits = search(&root, "latent alignment").unwrap();
        assert!(hits.len() >= 2);
        assert!(hits.iter().all(|hit| hit.path == "sections/method.tex"));
        assert!(hits.iter().any(|hit| hit.line == Some(2)));
        assert!(hits.iter().any(|hit| hit.line == Some(3)));

        let path_hits = search(&root, "method.tex").unwrap();
        assert!(path_hits
            .iter()
            .any(|hit| hit.path == "sections/method.tex"));

        fs::write(
            root.join("supplement.html"),
            "<!doctype html>\n<html>\n<head>\n<title>Private metadata title</title>\n<style>.private-style-token { color: red; }</style>\n<script>window.privateScriptToken = true;</script>\n</head>\n<body data-private-attribute-token=\"true\">\n<main><p>A distinctive supplementary result &amp; conclusion.</p></main>\n</body>\n</html>\n",
        )
        .unwrap();
        update_paths(&root, &[root.join("supplement.html")]).unwrap();
        let html_hits = search(&root, "supplementary result").unwrap();
        assert!(html_hits.iter().any(|hit| {
            hit.path == "supplement.html"
                && hit.line == Some(9)
                && hit.snippet.contains("result & conclusion")
        }));
        for non_body_query in [
            "private metadata title",
            "private style token",
            "privatescripttoken",
            "private attribute token",
        ] {
            assert!(
                search(&root, non_body_query).unwrap().is_empty(),
                "unexpected HTML source hit for {non_body_query}"
            );
        }

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn excludes_hidden_project_files_and_directories() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-hidden-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join(".private-notes.md"), "hidden_root_search_token\n").unwrap();
        fs::create_dir_all(root.join(".drafts")).unwrap();
        fs::write(
            root.join(".drafts/notes.md"),
            "hidden_directory_search_token\n",
        )
        .unwrap();

        assert!(search(&root, "hidden_root_search_token")
            .unwrap()
            .is_empty());
        assert!(search(&root, "hidden_directory_search_token")
            .unwrap()
            .is_empty());
        assert!(search(&root, "private notes").unwrap().is_empty());

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn a_file_event_updates_only_that_file() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-update-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("a.tex"), "alpha unique_token_one\n").unwrap();
        fs::write(root.join("b.tex"), "stable untouched_token\n").unwrap();
        assert!(search(&root, "unique_token_one")
            .unwrap()
            .iter()
            .any(|hit| hit.snippet.contains("unique_token_one")));

        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute_batch(
            "CREATE TABLE update_audit(path TEXT NOT NULL);
             CREATE TRIGGER audit_indexed_file_delete
             AFTER DELETE ON indexed_files
             BEGIN INSERT INTO update_audit(path) VALUES (old.path); END;",
        )
        .unwrap();
        drop(conn);

        fs::write(root.join("a.tex"), "beta unique_token_two\n").unwrap();
        update_paths(&root, &[root.join("a.tex")]).unwrap();
        let hits = search(&root, "unique_token_two").unwrap();
        assert!(hits
            .iter()
            .any(|hit| hit.snippet.contains("unique_token_two")));
        assert!(search(&root, "unique_token_one").unwrap().is_empty());
        assert!(search(&root, "untouched_token")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "b.tex"));

        let conn = Connection::open(db_path(&root)).unwrap();
        let deleted = conn
            .prepare("SELECT path FROM update_audit ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(deleted, vec!["a.tex"]);

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn project_transactions_refresh_the_index_before_returning() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-transaction-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("transaction.tex"), "before_transaction_token\n").unwrap();
        assert!(!search(&root, "before_transaction_token")
            .unwrap()
            .is_empty());

        project::apply_transaction(
            &root,
            "Edit transaction.tex",
            vec![(
                "transaction.tex".to_string(),
                "after_transaction_token\n".to_string(),
            )],
        )
        .unwrap();
        assert!(search(&root, "before_transaction_token")
            .unwrap()
            .is_empty());
        assert!(search(&root, "after_transaction_token")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "transaction.tex"));

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn file_events_delete_and_rename_index_entries() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-move-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("removed.md"), "obsolete_delete_token\n").unwrap();
        fs::write(root.join("draft.tex"), "durable_rename_token\n").unwrap();
        assert!(!search(&root, "obsolete_delete_token").unwrap().is_empty());

        fs::remove_file(root.join("removed.md")).unwrap();
        update_paths(&root, &[root.join("removed.md")]).unwrap();
        assert!(search(&root, "obsolete_delete_token").unwrap().is_empty());

        fs::rename(root.join("draft.tex"), root.join("final.tex")).unwrap();
        update_paths(&root, &[root.join("draft.tex"), root.join("final.tex")]).unwrap();
        let hits = search(&root, "durable_rename_token").unwrap();
        assert!(hits.iter().any(|hit| hit.path == "final.tex"));
        assert!(hits.iter().all(|hit| hit.path != "draft.tex"));
        assert!(search(&root, "draft.tex").unwrap().is_empty());

        fs::create_dir(root.join("old-sections")).unwrap();
        fs::write(
            root.join("old-sections/chapter.tex"),
            "directory_rename_token\n",
        )
        .unwrap();
        update_paths(&root, &[root.join("old-sections")]).unwrap();
        fs::rename(root.join("old-sections"), root.join("new-sections")).unwrap();
        update_paths(
            &root,
            &[root.join("old-sections"), root.join("new-sections")],
        )
        .unwrap();
        let hits = search(&root, "directory_rename_token").unwrap();
        assert!(hits
            .iter()
            .any(|hit| hit.path == "new-sections/chapter.tex"));
        assert!(hits
            .iter()
            .all(|hit| hit.path != "old-sections/chapter.tex"));

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn first_search_builds_the_incremental_schema() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-first-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("notes.md"), "first_build_token\n").unwrap();
        assert!(!db_path(&root).exists());

        assert!(search(&root, "first_build_token")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "notes.md"));
        let conn = Connection::open(db_path(&root)).unwrap();
        assert_eq!(
            meta_get(&conn, "schema").unwrap().as_deref(),
            Some(SCHEMA_VERSION)
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM indexed_files WHERE path = 'notes.md'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn upgrades_the_fingerprint_schema_atomically() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-upgrade-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("upgrade.tex"), "schema_upgrade_token\n").unwrap();
        assert!(!search(&root, "schema_upgrade_token").unwrap().is_empty());

        let conn = Connection::open(db_path(&root)).unwrap();
        meta_set(&conn, "schema", "3").unwrap();
        meta_set(&conn, "fingerprint", "legacy-fingerprint").unwrap();
        conn.execute("DELETE FROM indexed_files", []).unwrap();
        drop(conn);

        assert!(search(&root, "schema_upgrade_token")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "upgrade.tex"));
        let conn = Connection::open(db_path(&root)).unwrap();
        assert_eq!(
            meta_get(&conn, "schema").unwrap().as_deref(),
            Some(SCHEMA_VERSION)
        );
        assert_eq!(meta_get(&conn, "fingerprint").unwrap(), None);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM indexed_files WHERE path = 'upgrade.tex'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn reconciliation_repairs_a_missed_file_event() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-reconcile-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("external.tex"), "before_missed_event\n").unwrap();
        assert!(!search(&root, "before_missed_event").unwrap().is_empty());

        fs::write(
            root.join("external.tex"),
            "after_missed_watcher_event_with_new_length\n",
        )
        .unwrap();
        reconcile(&root).unwrap();
        assert!(search(&root, "before_missed_event").unwrap().is_empty());
        assert!(search(&root, "after_missed_watcher_event")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "external.tex"));

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn corrupt_database_is_removed_and_rebuilt() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-corrupt-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("recovered.md"), "corruption_recovery_token\n").unwrap();
        assert!(!search(&root, "corruption_recovery_token")
            .unwrap()
            .is_empty());

        fs::write(db_path(&root), b"not a sqlite database").unwrap();
        let hits = search(&root, "corruption_recovery_token").unwrap();
        assert!(hits.iter().any(|hit| hit.path == "recovered.md"));
        let conn = Connection::open(db_path(&root)).unwrap();
        assert_eq!(
            meta_get(&conn, "schema").unwrap().as_deref(),
            Some(SCHEMA_VERSION)
        );

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn finds_citation_keys_in_the_primary_bibliography() {
        let parent =
            std::env::temp_dir().join(format!("lattice-fts-citation-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{chen2024single, title={A Single Transformer}}\n",
        )
        .unwrap();

        let hits = search(&root, "chen2024single").unwrap();
        assert!(hits.iter().any(|hit| {
            hit.path == "references.bib"
                && hit.line == Some(1)
                && hit.snippet.contains("chen2024single")
        }));

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn finds_a_bibliography_key_from_its_prefix() {
        let parent = std::env::temp_dir().join(format!(
            "lattice-fts-citation-prefix-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{chen2024single, title={A Single Transformer}}\n",
        )
        .unwrap();

        let hits = search(&root, "chen").unwrap();
        assert!(hits.iter().any(|hit| {
            hit.path == "references.bib"
                && hit.line == Some(1)
                && hit.snippet.contains("chen2024single")
        }));

        fs::write(root.join("résumé.md"), "A naïve café comparison.\n").unwrap();
        update_paths(&root, &[root.join("résumé.md")]).unwrap();
        assert!(search(&root, "cafe")
            .unwrap()
            .iter()
            .any(|hit| hit.path == "résumé.md" && hit.line == Some(1)));

        let _ = fs::remove_dir_all(parent);
    }
}
