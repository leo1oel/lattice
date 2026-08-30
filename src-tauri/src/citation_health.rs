use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CROSSREF_WORKS_URL: &str = "https://api.crossref.org/works";
const CACHE_PATH: &str = ".research/cache/citation-health-v1.json";
const CACHE_SCHEMA: u32 = 1;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const MAX_REFRESH_PER_SCAN: usize = 24;
const MAX_CACHE_ENTRIES: usize = 512;
const MAX_CONCURRENT_REQUESTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "Lattice/0.1 (research writing; mailto:lattice@local)";

/// A single, bounded summary of Crossref update metadata for one exact DOI.
/// `kind` is intentionally small and stable while `update_type` preserves the
/// upstream vocabulary for users and agents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CitationHealth {
    /// retracted | expressionOfConcern | corrected | replaced | unknown | unavailable
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    pub checked_at: String,
    /// An expired cached result remains more useful than hiding a known notice
    /// when Crossref is temporarily unreachable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CitationHealthCache {
    schema: u32,
    #[serde(default)]
    entries: BTreeMap<String, CacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    checked_at_epoch: u64,
    health: CitationHealth,
}

pub fn lookup(
    root: &Path,
    dois: impl IntoIterator<Item = String>,
) -> BTreeMap<String, CitationHealth> {
    lookup_with_base(root, dois, CROSSREF_WORKS_URL)
}

fn lookup_with_base(
    root: &Path,
    dois: impl IntoIterator<Item = String>,
    base_url: &str,
) -> BTreeMap<String, CitationHealth> {
    let dois = dois.into_iter().collect::<BTreeSet<_>>();
    if dois.is_empty() {
        return BTreeMap::new();
    }
    let now = epoch_seconds();
    let mut cache = read_cache(root);
    let mut results = BTreeMap::new();
    let stale = dois
        .iter()
        .filter(|doi| {
            let Some(entry) = cache.entries.get(*doi) else {
                return true;
            };
            if now.saturating_sub(entry.checked_at_epoch) < CACHE_TTL_SECS {
                results.insert((*doi).clone(), entry.health.clone());
                false
            } else {
                true
            }
        })
        .take(MAX_REFRESH_PER_SCAN)
        .cloned()
        .collect::<Vec<_>>();

    let fetched = fetch_parallel(&stale, base_url);
    for doi in stale {
        match fetched.get(&doi) {
            Some(Ok(health)) => {
                let mut health = health.clone();
                health.checked_at = timestamp_now();
                let entry = CacheEntry {
                    checked_at_epoch: now,
                    health: health.clone(),
                };
                cache.entries.insert(doi.clone(), entry);
                results.insert(doi, health);
            }
            Some(Err(error)) => {
                log::debug!(
                    target: "lattice::citation_health",
                    "Crossref lookup failed for {doi}: {error}"
                );
                if let Some(entry) = cache.entries.get(&doi) {
                    let mut health = entry.health.clone();
                    health.stale = true;
                    results.insert(doi, health);
                } else {
                    results.insert(doi, unavailable());
                }
            }
            None => {}
        }
    }
    // A large library is refreshed over successive scans rather than making
    // an unbounded burst. Entries outside this scan's cap still expose stale
    // data, or a quiet unavailable state when they have never been checked.
    for doi in dois {
        results.entry(doi.clone()).or_insert_with(|| {
            cache
                .entries
                .get(&doi)
                .map(|entry| {
                    let mut health = entry.health.clone();
                    health.stale = true;
                    health
                })
                .unwrap_or_else(unavailable)
        });
    }
    if !fetched.is_empty() {
        trim_cache(&mut cache);
        if let Err(error) = write_cache(root, &cache) {
            log::debug!(target: "lattice::citation_health", "Could not write cache: {error}");
        }
    }
    results
}

fn fetch_parallel(
    dois: &[String],
    base_url: &str,
) -> BTreeMap<String, Result<CitationHealth, String>> {
    if dois.is_empty() {
        return BTreeMap::new();
    }
    let client = match reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return dois
                .iter()
                .cloned()
                .map(|doi| (doi, Err(format!("could not create client: {error}"))))
                .collect()
        }
    };
    let output = Mutex::new(BTreeMap::new());
    let worker_count = dois.len().min(MAX_CONCURRENT_REQUESTS);
    std::thread::scope(|scope| {
        for worker in 0..worker_count {
            let client = &client;
            let output = &output;
            scope.spawn(move || {
                for doi in dois.iter().skip(worker).step_by(worker_count) {
                    let result = fetch_one(client, base_url, doi);
                    output.lock().unwrap().insert(doi.clone(), result);
                }
            });
        }
    });
    output.into_inner().unwrap()
}

fn fetch_one(
    client: &reqwest::blocking::Client,
    base_url: &str,
    doi: &str,
) -> Result<CitationHealth, String> {
    // `updates` asks for update notices whose update-to target is this DOI.
    // That target is checked again while parsing: titles and search ranking
    // are never used to infer citation health.
    let url = format!(
        "{base_url}?filter=updates:{}&rows=20&select=DOI,URL,update-to&mailto=lattice%40local",
        crate::openalex::urlencoding(doi)
    );
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| error.to_string())?;
    parse_response(&payload, doi)
}

fn parse_response(payload: &Value, doi: &str) -> Result<CitationHealth, String> {
    let items = payload
        .pointer("/message/items")
        .and_then(Value::as_array)
        .ok_or_else(|| "response had no message.items array".to_string())?;
    let mut candidates = Vec::new();
    for item in items {
        let notice_link = item
            .get("URL")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                item.get("DOI")
                    .and_then(Value::as_str)
                    .map(|notice| format!("https://doi.org/{notice}"))
            });
        for update in item
            .get("update-to")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(target) = update.get("DOI").and_then(Value::as_str) else {
                continue;
            };
            if !target.eq_ignore_ascii_case(doi) {
                continue;
            }
            let update_type = update
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let kind = classify(&update_type).to_string();
            let date = update
                .pointer("/updated/date-time")
                .and_then(Value::as_str)
                .map(|value| value.chars().take(10).collect::<String>());
            candidates.push(CitationHealth {
                kind,
                update_type: Some(update_type),
                source: update
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                date,
                link: notice_link.clone(),
                checked_at: String::new(),
                stale: false,
            });
        }
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|health| (severity(&health.kind), health.date.clone()))
        .unwrap_or_else(unknown))
}

fn classify(update_type: &str) -> &'static str {
    match update_type.to_ascii_lowercase().as_str() {
        "retraction" | "partial_retraction" | "withdrawal" | "removal" => "retracted",
        "expression_of_concern" => "expressionOfConcern",
        "correction" | "corrigendum" | "erratum" | "addendum" | "clarification" => "corrected",
        "new_version" | "new_edition" | "replacement" | "reinstatement" => "replaced",
        _ => "unknown",
    }
}

fn severity(kind: &str) -> u8 {
    match kind {
        "retracted" => 4,
        "expressionOfConcern" => 3,
        "corrected" | "replaced" => 2,
        _ => 1,
    }
}

fn unknown() -> CitationHealth {
    CitationHealth {
        kind: "unknown".to_string(),
        update_type: None,
        source: Some("crossref".to_string()),
        date: None,
        link: None,
        checked_at: String::new(),
        stale: false,
    }
}

fn unavailable() -> CitationHealth {
    CitationHealth {
        kind: "unavailable".to_string(),
        update_type: None,
        source: Some("crossref".to_string()),
        date: None,
        link: None,
        checked_at: timestamp_now(),
        stale: false,
    }
}

fn read_cache(root: &Path) -> CitationHealthCache {
    fs::read(root.join(CACHE_PATH))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CitationHealthCache>(&bytes).ok())
        .filter(|cache| cache.schema == CACHE_SCHEMA)
        .unwrap_or_else(|| CitationHealthCache {
            schema: CACHE_SCHEMA,
            entries: BTreeMap::new(),
        })
}

fn write_cache(root: &Path, cache: &CitationHealthCache) -> Result<(), String> {
    let path = root.join(CACHE_PATH);
    let Some(parent) = path.parent() else {
        return Err("cache path has no parent".to_string());
    };
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(cache).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn trim_cache(cache: &mut CitationHealthCache) {
    if cache.entries.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut oldest = cache
        .entries
        .iter()
        .map(|(doi, entry)| (doi.clone(), entry.checked_at_epoch))
        .collect::<Vec<_>>();
    oldest.sort_by_key(|(_, checked)| *checked);
    for (doi, _) in oldest
        .into_iter()
        .take(cache.entries.len() - MAX_CACHE_ENTRIES)
    {
        cache.entries.remove(&doi);
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn timestamp_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fixture() -> Value {
        serde_json::json!({
            "message": { "items": [
                {
                    "DOI": "10.5555/correction-notice",
                    "URL": "https://doi.org/10.5555/correction-notice",
                    "update-to": [{
                        "DOI": "10.1234/example",
                        "type": "correction",
                        "source": "publisher",
                        "updated": { "date-time": "2021-04-02T00:00:00Z" }
                    }]
                },
                {
                    "DOI": "10.5555/retraction-notice",
                    "URL": "https://retractionwatch.com/example",
                    "update-to": [{
                        "DOI": "10.1234/EXAMPLE",
                        "type": "retraction",
                        "source": "retraction-watch",
                        "updated": { "date-time": "2023-09-17T00:00:00Z" }
                    }]
                },
                {
                    "DOI": "10.5555/unrelated",
                    "update-to": [{ "DOI": "10.9999/other", "type": "retraction" }]
                }
            ]}
        })
    }

    #[test]
    fn parses_only_exact_doi_updates_and_keeps_the_most_serious_notice() {
        let health = parse_response(&fixture(), "10.1234/example").unwrap();
        assert_eq!(health.kind, "retracted");
        assert_eq!(health.update_type.as_deref(), Some("retraction"));
        assert_eq!(health.source.as_deref(), Some("retraction-watch"));
        assert_eq!(health.date.as_deref(), Some("2023-09-17"));
        assert_eq!(
            health.link.as_deref(),
            Some("https://retractionwatch.com/example")
        );
    }

    #[test]
    fn classifies_crossref_update_vocabulary() {
        assert_eq!(classify("expression_of_concern"), "expressionOfConcern");
        assert_eq!(classify("erratum"), "corrected");
        assert_eq!(classify("new_version"), "replaced");
        assert_eq!(classify("something_new"), "unknown");
    }

    #[test]
    fn caches_mocked_crossref_results_and_reuses_them_offline() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/works", server.server_addr());
        let fixture = fixture().to_string();
        let responder = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            assert!(request.url().contains("filter=updates:10.1234%2Fexample"));
            request
                .respond(tiny_http::Response::from_string(fixture).with_header(
                    tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
                ))
                .unwrap();
        });
        let root = std::env::temp_dir().join(format!("lattice-health-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let online = lookup_with_base(&root, ["10.1234/example".to_string()], &endpoint);
        responder.join().unwrap();
        assert_eq!(online["10.1234/example"].kind, "retracted");
        assert!(root.join(CACHE_PATH).is_file());

        // A fresh cache does not contact this unreachable endpoint.
        let cached = lookup_with_base(
            &root,
            ["10.1234/example".to_string()],
            "http://127.0.0.1:1/works",
        );
        assert_eq!(cached["10.1234/example"].kind, "retracted");
        assert!(!cached["10.1234/example"].stale);
        fs::remove_dir_all(root).unwrap();
    }
}
