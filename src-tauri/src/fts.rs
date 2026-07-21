use crate::models::{FileNode, ProjectSearchResult};
use crate::project;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const SCHEMA_VERSION: &str = "1";
const MAX_HITS: usize = 200;
const DB_RELATIVE: &str = ".research/cache/fts.sqlite";

pub fn search(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = project::search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    ensure_index(root)?;
    let conn = open_db(root)?;
    let match_query = build_match_query(&terms)?;
    let mut stmt = conn
        .prepare(
            "SELECT path, line, text, rank
             FROM lines_fts
             WHERE lines_fts MATCH ?1
             ORDER BY rank, path, line
             LIMIT ?2",
        )
        .map_err(sqlite_err)?;
    let rows = stmt
        .query_map(params![match_query, MAX_HITS as i64], |row| {
            let path: String = row.get(0)?;
            let line: i64 = row.get(1)?;
            let text: String = row.get(2)?;
            Ok((path, line, text))
        })
        .map_err(sqlite_err)?;

    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (path, line, text) = row.map_err(sqlite_err)?;
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
        append_path_matches(root, &terms, &mut results, &mut seen)?;
    }
    results.truncate(MAX_HITS);
    Ok(results)
}

#[allow(dead_code)]
pub fn invalidate(root: &Path) {
    let path = db_path(root);
    let _ = fs::remove_file(path);
}

fn ensure_index(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join(".research/cache")).map_err(|error| error.to_string())?;
    let fingerprint = project_fingerprint(root)?;
    let conn = open_db(root)?;
    init_schema(&conn)?;
    let current = meta_get(&conn, "fingerprint").unwrap_or_default();
    let version = meta_get(&conn, "schema").unwrap_or_default();
    if current == fingerprint && version == SCHEMA_VERSION {
        return Ok(());
    }
    rebuild(&conn, root)?;
    meta_set(&conn, "fingerprint", &fingerprint)?;
    meta_set(&conn, "schema", SCHEMA_VERSION)?;
    meta_set(
        &conn,
        "built_at",
        &SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|value| value.as_secs().to_string())
            .unwrap_or_default(),
    )?;
    Ok(())
}

fn rebuild(conn: &Connection, root: &Path) -> Result<(), String> {
    conn.execute_batch("DELETE FROM lines_fts;")
        .map_err(sqlite_err)?;

    let mut insert = conn
        .prepare("INSERT INTO lines_fts(path, line, text) VALUES (?1, ?2, ?3)")
        .map_err(sqlite_err)?;
    for relative in collect_searchable_paths(root)? {
        let absolute = project::safe_path(root, &relative)?;
        let content = fs::read_to_string(&absolute).unwrap_or_default();
        let path_tokens = path_search_text(&relative);
        insert
            .execute(params![relative, 0i64, path_tokens])
            .map_err(sqlite_err)?;
        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            insert
                .execute(params![relative, (index + 1) as i64, line])
                .map_err(sqlite_err)?;
        }
    }
    Ok(())
}

fn append_path_matches(
    root: &Path,
    terms: &[String],
    results: &mut Vec<ProjectSearchResult>,
    seen: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    for relative in collect_searchable_paths(root)? {
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

fn collect_searchable_paths(root: &Path) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    collect_searchable_nodes(&project::list_files_for_search(root)?, &mut paths);
    Ok(paths)
}

fn collect_searchable_nodes(nodes: &[FileNode], paths: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            collect_searchable_nodes(&node.children, paths);
            continue;
        }
        if searchable_text_path(&node.path) {
            paths.push(node.path.clone());
        }
    }
}

fn project_fingerprint(root: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for relative in collect_searchable_paths(root)? {
        let absolute = project::safe_path(root, &relative)?;
        let meta = fs::metadata(&absolute).map_err(|error| error.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        parts.push(format!("{relative}:{modified}:{}", meta.len()));
    }
    parts.sort();
    Ok(parts.join("|"))
}

fn open_db(root: &Path) -> Result<Connection, String> {
    Connection::open(db_path(root)).map_err(sqlite_err)
}

fn db_path(root: &Path) -> PathBuf {
    root.join(DB_RELATIVE)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
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
         );",
    )
    .map_err(sqlite_err)
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn build_match_query(terms: &[String]) -> Result<String, String> {
    if terms.is_empty() {
        return Err("Empty search.".to_string());
    }
    Ok(terms
        .iter()
        .map(|term| format!("\"{}\"", escape_fts_token(term)))
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

fn searchable_text_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("tex" | "bib" | "sty" | "cls" | "md" | "txt")
    )
}

fn sqlite_err(error: impl ToString) -> String {
    format!("Project search index error: {}", error.to_string())
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
        assert!(path_hits.iter().any(|hit| hit.path == "sections/method.tex"));

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn rebuilds_when_files_change() {
        let parent = std::env::temp_dir().join(format!("lattice-fts-rebuild-{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&parent);
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "alpha unique_token_one\n").unwrap();
        assert!(search(&root, "unique_token_one").unwrap().iter().any(|hit| hit.snippet.contains("unique_token_one")));

        fs::write(root.join("main.tex"), "beta unique_token_two\n").unwrap();
        let hits = search(&root, "unique_token_two").unwrap();
        assert!(hits.iter().any(|hit| hit.snippet.contains("unique_token_two")));
        assert!(search(&root, "unique_token_one").unwrap().is_empty());

        let _ = fs::remove_dir_all(parent);
    }
}
