//! Exact-ID Semantic Scholar hydration, not twenty parallel title searches.
//! Misses are left to the existing audit; they never mean "reference valid".
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const BATCH_SIZE: usize = 20;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    NotConfigured,
    QueueBusy,
    DailyQuota,
    UpstreamRateLimit,
    RateLimited,
    Unauthorized,
    Timeout,
    Network,
    Malformed,
    Unavailable,
}

impl Failure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::QueueBusy => "queue_busy",
            Self::DailyQuota => "daily_quota",
            Self::UpstreamRateLimit => "upstream_rate_limit",
            Self::RateLimited => "rate_limited",
            Self::Unauthorized => "unauthorized",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Malformed => "malformed",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Paper {
    pub external_ids: BTreeMap<String, serde_json::Value>,
    pub title: String,
    pub venue: Option<String>,
    pub year: Option<u32>,
    pub citation_styles: Option<CitationStyles>,
}

#[derive(Deserialize)]
pub(crate) struct CitationStyles {
    pub bibtex: String,
}

pub(crate) fn lookup(ids: &[String]) -> Result<BTreeMap<String, Paper>, Failure> {
    let key = crate::literature_credentials::semanticscholar_key()
        .map_err(|_| Failure::Unavailable)?
        .ok_or(Failure::NotConfigured)?;
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let root = std::env::var_os("XDG_CACHE_HOME")
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| std::path::PathBuf::from(p).join(".cache")))
        .ok_or(Failure::QueueBusy)?;
    pace(
        &root.join("bibcite/requests.sqlite3"),
        &format!("{:x}", Sha256::digest(key.as_bytes())),
    )
    .map_err(|_| Failure::QueueBusy)?;
    lookup_at(
        ids,
        &key,
        "https://api.semanticscholar.org/graph/v1/paper/batch",
    )
}

// Protocol shared with bibcite.sources._s2_gate: epoch milliseconds, one
// transaction covering the wait and reservation, never the network request.
// No API key is persisted. Fail closed rather than bypassing a busy gate.
fn pace(path: &Path, key_hash: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let deadline = Instant::now() + Duration::from_millis(2200);
    let operation = || -> Result<(), Box<dyn std::error::Error>> {
        std::fs::create_dir_all(path.parent().ok_or("Missing pacing directory")?)?;
        let mut db = rusqlite::Connection::open(path)?;
        db.busy_timeout(deadline.saturating_duration_since(Instant::now()))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS s2_pacing (key TEXT PRIMARY KEY, last_dispatch INTEGER NOT NULL)")?;
        db.busy_timeout(deadline.saturating_duration_since(Instant::now()))?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let last: Option<i64> = tx
            .query_row(
                "SELECT last_dispatch FROM s2_pacing WHERE key = ?1",
                [key_hash],
                |r| r.get(0),
            )
            .optional()?;
        let now = || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
        };
        let wait = Duration::from_millis(
            last.unwrap_or(0)
                .saturating_add(1100)
                .saturating_sub(now()?)
                .max(0) as u64,
        );
        if Instant::now() + wait > deadline {
            return Err("Pacing queue busy".into());
        }
        std::thread::sleep(wait);
        if Instant::now() > deadline {
            return Err("Pacing queue busy".into());
        }
        tx.execute("INSERT INTO s2_pacing(key, last_dispatch) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET last_dispatch = excluded.last_dispatch", rusqlite::params![key_hash, now()?])?;
        tx.commit()?;
        Ok(())
    };
    operation().map_err(|_| "Semantic Scholar request queue is busy or unavailable.".into())
}

fn lookup_at(
    ids: &[String],
    key: &str,
    endpoint: &str,
) -> Result<BTreeMap<String, Paper>, Failure> {
    if ids.len() > BATCH_SIZE {
        return Err(Failure::Malformed);
    }
    let ids = ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::Unavailable)?;
    let url = format!("{endpoint}?fields=externalIds,title,venue,year,citationStyles");
    let mut request = crate::literature_service::request(
        &client,
        &url,
        Some(serde_json::json!({ "ids": ids })),
        false,
    )
    .map_err(|_| Failure::Unavailable)?;
    request = request.header("x-api-key", key);
    // Exactly one request. In particular, a 429 never starts a retry loop.
    let response = request.send().map_err(|error| {
        if error.is_timeout() {
            Failure::Timeout
        } else {
            Failure::Network
        }
    })?;
    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(Failure::Unauthorized);
        }
        // The public Worker exposes only these stable codes. Never forward its
        // raw response body, which may contain upstream diagnostics.
        let worker_code = response
            .json::<serde_json::Value>()
            .ok()
            .and_then(|body| body.get("code").and_then(|v| v.as_str()).map(str::to_owned));
        return Err(match worker_code.as_deref() {
            Some("queue_busy") => Failure::QueueBusy,
            Some("daily_quota") => Failure::DailyQuota,
            Some("upstream_rate_limit") => Failure::UpstreamRateLimit,
            Some("upstream_timeout") => Failure::Timeout,
            Some("upstream_network") => Failure::Network,
            Some("upstream_malformed") => Failure::Malformed,
            Some("provider_unauthorized") => Failure::Unauthorized,
            _ if status.as_u16() == 429 => Failure::RateLimited,
            _ => Failure::Unavailable,
        });
    }
    let papers: Vec<serde_json::Value> = response.json().map_err(|error| {
        if error.is_timeout() {
            Failure::Timeout
        } else if error.is_decode() {
            Failure::Malformed
        } else {
            Failure::Network
        }
    })?;
    if papers.len() != ids.len() {
        return Err(Failure::Malformed);
    }
    // Nulls retain their position. Confirm the external ID too: response order
    // alone must never attach another paper's metadata to a bibliography entry.
    Ok(ids
        .into_iter()
        .zip(papers)
        .filter_map(|(id, paper)| {
            let paper: Paper = serde_json::from_value(paper).ok()?;
            let (kind, value) = id.split_once(':')?;
            let external = paper
                .external_ids
                .get(if kind == "DOI" { "DOI" } else { "ArXiv" })?
                .as_str()?;
            external.eq_ignore_ascii_case(value).then_some((id, paper))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_gate_shares_persistent_slots_and_bounds_waiting() {
        let dir = std::env::temp_dir().join(format!("s2-pacing-{}", uuid::Uuid::new_v4()));
        let path = dir.join("requests.sqlite3");
        pace(&path, "key-a").unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let first: i64 = db
            .query_row(
                "SELECT last_dispatch FROM s2_pacing WHERE key='key-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // A different key has its own quota, even in the same database.
        pace(&path, "key-b").unwrap();
        pace(&path, "key-a").unwrap();
        let second: i64 = db
            .query_row(
                "SELECT last_dispatch FROM s2_pacing WHERE key='key-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(second - first >= 1100);
        db.execute(
            "UPDATE s2_pacing SET last_dispatch=?1 WHERE key='key-a'",
            [second + 60_000],
        )
        .unwrap();
        let start = Instant::now();
        assert!(pace(&path, "key-a").is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires LATTICE_BIBCITE_SOURCE checkout and uv; no external network"]
    fn rust_batch_and_python_cli_share_the_same_gate() {
        let source = std::env::var("LATTICE_BIBCITE_SOURCE").unwrap();
        let dir = std::env::temp_dir().join(format!("s2-cross-language-{}", uuid::Uuid::new_v4()));
        let path = dir.join("requests.sqlite3");
        pace(&path, "integration").unwrap();
        let output = std::process::Command::new("uv").args(["run", "--project", &source, "python", "-c",
            "import sys; from pathlib import Path; from bibcite import sources; sources._s2_pacing_path=lambda:Path(sys.argv[1]); sources._s2_gate('integration')"])
            .arg(&path).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let db = rusqlite::Connection::open(&path).unwrap();
        let previous: i64 = db
            .query_row(
                "SELECT last_dispatch FROM s2_pacing WHERE key='integration'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        pace(&path, "integration").unwrap();
        let next: i64 = db
            .query_row(
                "SELECT last_dispatch FROM s2_pacing WHERE key='integration'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(next - previous >= 1100);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn batches_deduplicates_and_rejects_misidentified_results() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/batch", server.server_addr());
        let responder = std::thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Post);
            let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
            assert_eq!(
                body["ids"],
                serde_json::json!(["ARXIV:1706.03762", "DOI:10.1234/a", "DOI:10.1234/b"])
            );
            request.respond(tiny_http::Response::from_string(r#"[
                {"externalIds":{"ArXiv":"1706.03762"},"title":"Attention","venue":"NeurIPS","year":2017},
                null,
                {"externalIds":{"DOI":"10.1234/wrong"},"title":"Wrong paper"}
            ]"#)).unwrap();
        });
        let ids = [
            "DOI:10.1234/b",
            "ARXIV:1706.03762",
            "DOI:10.1234/a",
            "DOI:10.1234/a",
        ]
        .map(str::to_string);
        let papers = lookup_at(&ids, "test-key", &endpoint).unwrap();
        responder.join().unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers["ARXIV:1706.03762"].title, "Attention");
    }

    #[test]
    fn rate_limit_is_one_request_and_never_echoes_the_key() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/batch", server.server_addr());
        let responder = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert!(request
                .headers()
                .iter()
                .any(|h| h.field.equiv("x-api-key") && h.value.as_str() == "test-only-secret"));
            request.respond(tiny_http::Response::empty(429)).unwrap();
            assert!(server
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .is_none());
        });
        let error = lookup_at(&["DOI:10.1234/a".into()], "test-only-secret", &endpoint)
            .err()
            .unwrap();
        responder.join().unwrap();
        assert_eq!(error.code(), "rate_limited");
    }

    #[test]
    fn classifies_safe_worker_codes_auth_and_malformed_responses() {
        for (status, body, expected) in [
            (429, r#"{"code":"queue_busy"}"#, "queue_busy"),
            (429, r#"{"code":"daily_quota"}"#, "daily_quota"),
            (
                429,
                r#"{"code":"upstream_rate_limit"}"#,
                "upstream_rate_limit",
            ),
            (502, r#"{"code":"upstream_timeout"}"#, "timeout"),
            (502, r#"{"code":"upstream_network"}"#, "network"),
            (503, r#"{"code":"provider_unauthorized"}"#, "unauthorized"),
            (401, r#"{"error":"private diagnostic"}"#, "unauthorized"),
            (200, "not json", "malformed"),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/batch", server.server_addr());
            let body = body.to_owned();
            let responder = std::thread::spawn(move || {
                let request = server.recv().unwrap();
                request
                    .respond(tiny_http::Response::from_string(body).with_status_code(status))
                    .unwrap();
            });
            let error = lookup_at(&["DOI:10.1234/a".into()], "test-key", &endpoint)
                .err()
                .unwrap();
            responder.join().unwrap();
            assert_eq!(error.code(), expected);
        }
    }
}
