use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CROSSREF_WORKS_URL: &str = "https://api.crossref.org/works";
const CACHE_PATH: &str = ".research/cache/citation-health-v1.json";
const CACHE_SCHEMA: u32 = 1;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const MAX_REFRESH_PER_SCAN: usize = 24;
const MAX_CACHE_ENTRIES: usize = 512;
const MAX_CONCURRENT_REQUESTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a scan waits on a DOI another scan of the same project is already
/// fetching: past the worst case of one capped round (each worker's share of
/// the cap, every request timing out), so only a wedged fetch reaches it.
const JOIN_DEADLINE: Duration = Duration::from_secs(60);

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

impl CitationHealth {
    /// Too incomplete to vouch for a reference: never checked, or an expired
    /// verdict kept because Crossref was unreachable.
    pub(crate) fn is_incomplete(&self) -> bool {
        self.kind == "unavailable" || self.stale
    }

    fn crossref(kind: &str, checked_at: String) -> Self {
        CitationHealth {
            kind: kind.to_string(),
            update_type: None,
            source: Some("crossref".to_string()),
            date: None,
            link: None,
            checked_at,
            stale: false,
        }
    }
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

/// What the project's cache already knows, without touching the network:
/// fresh verdicts as they are, expired ones marked stale (a known notice stays
/// visible while it waits for a recheck), and nothing at all for a DOI never
/// checked, which is unknown rather than "no problems". `lookup` fills in the
/// rest; the paper list uses this so its rows never wait for Crossref.
pub fn cached(
    root: &Path, dois: impl IntoIterator<Item = String>,
) -> BTreeMap<String, CitationHealth> {
    let now = epoch_seconds();
    let cache = read_cache(root);
    dois.into_iter()
        .filter_map(|doi| {
            let entry = cache.entries.get(&doi)?;
            let stale = now.saturating_sub(entry.checked_at_epoch) >= CACHE_TTL_SECS;
            Some((doi, CitationHealth { stale, ..entry.health.clone() }))
        })
        .collect()
}

pub fn lookup(
    root: &Path, dois: impl IntoIterator<Item = String>,
) -> BTreeMap<String, CitationHealth> {
    lookup_at(root, dois, CROSSREF_WORKS_URL, None)
}

/// `contact` replaces the saved Crossref contact when set (tests only).
fn lookup_at(
    root: &Path, dois: impl IntoIterator<Item = String>, base_url: &str,
    contact: Option<Option<String>>,
) -> BTreeMap<String, CitationHealth> {
    let dois = dois.into_iter().collect::<BTreeSet<_>>();
    if dois.is_empty() {
        return BTreeMap::new();
    }
    let now = epoch_seconds();
    let cache = read_cache(root);
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

    // Opening a project, a save and an Overleaf pull can each scan the same
    // bibliography while an earlier scan is still waiting on Crossref. A DOI
    // already being fetched for this project is awaited, not fetched again,
    // so overlapping scans cost one request per DOI and agree on its answer.
    let claim = Claim::take(root, &stale);
    let fetched = fetch_parallel(&claim.owned, base_url, contact)
        .into_iter()
        .map(|(doi, result)| {
            (doi, result.map(|health| CitationHealth { checked_at: timestamp_now(), ..health }))
        })
        .collect::<BTreeMap<_, _>>();
    let checked = fetched
        .iter()
        .filter_map(|(doi, result)| {
            let health = result.as_ref().ok()?.clone();
            Some((doi.clone(), CacheEntry { checked_at_epoch: now, health }))
        })
        .collect::<BTreeMap<_, _>>();
    if !checked.is_empty() {
        if let Err(error) = merge_into_cache(root, &checked) {
            log::debug!(target: "lattice::citation_health", "Could not write cache: {error}");
        }
    }
    // Published only once the cache holds them, so a scan that starts after
    // this one finishes reads the same verdicts from disk.
    claim.publish(&fetched);
    let joined = claim.wait_for_others();
    for doi in stale {
        match fetched.get(&doi).or_else(|| joined.get(&doi)).cloned() {
            Some(Ok(health)) => {
                results.insert(doi, health);
            }
            Some(Err(error)) => {
                log::debug!(
                    target: "lattice::citation_health",
                    "Crossref lookup failed for {doi}: {error}"
                );
                results.insert(doi.clone(), stale_or_unavailable(&cache, &doi));
            }
            None => {}
        }
    }
    // A large library is refreshed over successive scans rather than making
    // an unbounded burst. Entries outside this scan's cap still expose stale
    // data, or a quiet unavailable state when they have never been checked.
    for doi in dois {
        results.entry(doi.clone()).or_insert_with(|| stale_or_unavailable(&cache, &doi));
    }
    results
}

/// One DOI's fetch under way for one project, which other scans wait on.
#[derive(Default)]
struct InFlight {
    result: Mutex<Option<Result<CitationHealth, String>>>,
    done: Condvar,
}

type InFlightKey = (PathBuf, String);

static IN_FLIGHT: LazyLock<Mutex<HashMap<InFlightKey, Arc<InFlight>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The DOIs one scan fetches itself and the ones it waits on. Dropping it
/// settles whatever it owns and has not published (a panicking worker
/// included), so no waiter is left for the full deadline.
struct Claim {
    root: PathBuf,
    owned: Vec<String>,
    mine: Vec<Arc<InFlight>>,
    others: Vec<(String, Arc<InFlight>)>,
}

impl Claim {
    fn take(root: &Path, dois: &[String]) -> Self {
        let root = root.to_path_buf();
        let mut claim =
            Claim { root: root.clone(), owned: Vec::new(), mine: Vec::new(), others: Vec::new() };
        let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for doi in dois {
            match in_flight.get(&(root.clone(), doi.clone())) {
                Some(pending) => claim.others.push((doi.clone(), Arc::clone(pending))),
                None => {
                    let pending = Arc::new(InFlight::default());
                    in_flight.insert((root.clone(), doi.clone()), Arc::clone(&pending));
                    claim.owned.push(doi.clone());
                    claim.mine.push(pending);
                }
            }
        }
        claim
    }

    /// Hand each owned DOI's outcome to its waiters and release it.
    fn publish(&self, fetched: &BTreeMap<String, Result<CitationHealth, String>>) {
        let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (doi, pending) in self.owned.iter().zip(&self.mine) {
            let outcome = fetched
                .get(doi)
                .cloned()
                .unwrap_or_else(|| Err("Crossref lookup did not run".to_string()));
            settle(pending, outcome);
            in_flight.remove(&(self.root.clone(), doi.clone()));
        }
    }

    fn wait_for_others(&self) -> BTreeMap<String, Result<CitationHealth, String>> {
        self.others
            .iter()
            .map(|(doi, pending)| {
                let result = pending.result.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let (result, _) = pending
                    .done
                    .wait_timeout_while(result, JOIN_DEADLINE, |result| result.is_none())
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let outcome = result
                    .clone()
                    .unwrap_or_else(|| Err("Crossref lookup is still under way".to_string()));
                (doi.clone(), outcome)
            })
            .collect()
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (doi, pending) in self.owned.iter().zip(&self.mine) {
            let key = (self.root.clone(), doi.clone());
            if in_flight.get(&key).is_some_and(|current| Arc::ptr_eq(current, pending)) {
                settle(pending, Err("Crossref lookup stopped".to_string()));
                in_flight.remove(&key);
            }
        }
    }
}

fn settle(pending: &InFlight, outcome: Result<CitationHealth, String>) {
    let mut result = pending.result.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if result.is_none() {
        *result = Some(outcome);
    }
    pending.done.notify_all();
}

/// An expired cached result remains more useful than hiding a known notice.
fn stale_or_unavailable(cache: &CitationHealthCache, doi: &str) -> CitationHealth {
    cache
        .entries
        .get(doi)
        .map(|entry| CitationHealth { stale: true, ..entry.health.clone() })
        .unwrap_or_else(|| CitationHealth::crossref("unavailable", timestamp_now()))
}

fn fetch_parallel(
    dois: &[String], base_url: &str, contact: Option<Option<String>>,
) -> BTreeMap<String, Result<CitationHealth, String>> {
    if dois.is_empty() {
        return BTreeMap::new();
    }
    let fail_all =
        |error: String| dois.iter().map(|doi| (doi.clone(), Err(error.clone()))).collect();
    let contact =
        match contact.map(Ok).unwrap_or_else(crate::literature_credentials::crossref_contact) {
            Ok(contact) => contact,
            Err(error) => return fail_all(error),
        };
    let user_agent = match &contact {
        Some(email) => format!("Lattice/0.1 (research writing; mailto:{email})"),
        None => "Lattice/0.1 (research writing)".to_string(),
    };
    let client = match crate::literature_service::client(REQUEST_TIMEOUT, Some(&user_agent)) {
        Ok(client) => client,
        Err(error) => return fail_all(format!("could not create client: {error}")),
    };
    let worker_count = dois.len().min(MAX_CONCURRENT_REQUESTS);
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..worker_count)
            .map(|worker| {
                let (client, contact) = (&client, contact.as_deref());
                scope.spawn(move || {
                    let assigned = dois.iter().skip(worker).step_by(worker_count);
                    assigned
                        .map(|doi| (doi.clone(), fetch_one(client, base_url, doi, contact)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect()
    })
}

fn fetch_one(
    client: &reqwest::blocking::Client, base_url: &str, doi: &str, contact: Option<&str>,
) -> Result<CitationHealth, String> {
    // `updates` asks for update notices whose update-to target is this DOI.
    // That target is checked again while parsing: titles and search ranking
    // are never used to infer citation health.
    let mut url = format!(
        "{base_url}?filter=updates:{}&rows=20&select=DOI,URL,update-to",
        crate::openalex::urlencoding(doi)
    );
    if let Some(email) = contact {
        url.push_str("&mailto=");
        url.push_str(&crate::openalex::urlencoding(email));
    }
    let response = crate::literature_service::request(client, &url, None, contact.is_none())?
        .send()
        .map_err(|_| "request unavailable".to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let payload = response.json::<Value>().map_err(|error| error.to_string())?;
    parse_response(&payload, doi)
}

/// The most serious Crossref update notice whose update-to target is exactly
/// `doi`, or "unknown" when there is none.
fn parse_response(payload: &Value, doi: &str) -> Result<CitationHealth, String> {
    let items = payload
        .pointer("/message/items")
        .and_then(Value::as_array)
        .ok_or_else(|| "response had no message.items array".to_string())?;
    let text =
        |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let notices = items.iter().flat_map(|item| {
        let link = text(item, "URL")
            .or_else(|| text(item, "DOI").map(|notice| format!("https://doi.org/{notice}")));
        let updates = item.get("update-to").and_then(Value::as_array).into_iter().flatten();
        updates
            .filter(|update| {
                text(update, "DOI").is_some_and(|target| target.eq_ignore_ascii_case(doi))
            })
            .map(move |update| {
                let update_type = text(update, "type").unwrap_or_else(|| "unknown".to_string());
                CitationHealth {
                    kind: classify(&update_type).to_string(),
                    update_type: Some(update_type),
                    source: text(update, "source"),
                    date: update
                        .pointer("/updated/date-time")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(10).collect()),
                    link: link.clone(),
                    checked_at: String::new(),
                    stale: false,
                }
            })
    });
    Ok(notices
        .max_by_key(|health| (severity(&health.kind), health.date.clone()))
        .unwrap_or_else(|| CitationHealth::crossref("unknown", String::new())))
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

fn read_cache(root: &Path) -> CitationHealthCache {
    fs::read(root.join(CACHE_PATH))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CitationHealthCache>(&bytes).ok())
        .filter(|cache| cache.schema == CACHE_SCHEMA)
        .unwrap_or_else(|| CitationHealthCache { schema: CACHE_SCHEMA, entries: BTreeMap::new() })
}

/// Serializes the read-merge-write of each cache, so two scans that finish
/// together both land instead of the later one writing back what it read
/// before the earlier one saved.
static CACHE_WRITE: Mutex<()> = Mutex::new(());

/// Add `checked` to the cache on disk, keeping whichever verdict for a DOI is
/// newer, and replace the file in one rename: a reader never sees half of it.
fn merge_into_cache(root: &Path, checked: &BTreeMap<String, CacheEntry>) -> Result<(), String> {
    let _guard = CACHE_WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut cache = read_cache(root);
    for (doi, entry) in checked {
        let newer = cache
            .entries
            .get(doi)
            .is_none_or(|current| current.checked_at_epoch <= entry.checked_at_epoch);
        if newer {
            cache.entries.insert(doi.clone(), entry.clone());
        }
    }
    trim_cache(&mut cache);
    let bytes = serde_json::to_vec_pretty(&cache).map_err(|error| error.to_string())?;
    crate::project_fs::ProjectDir::open(root)?.atomic_write(CACHE_PATH, &bytes)
}

/// Drop the oldest checks beyond the cap (ties go to the smaller DOI).
fn trim_cache(cache: &mut CitationHealthCache) {
    let excess = cache.entries.len().saturating_sub(MAX_CACHE_ENTRIES);
    let mut by_age = cache
        .entries
        .iter()
        .map(|(doi, entry)| (entry.checked_at_epoch, doi.clone()))
        .collect::<Vec<_>>();
    by_age.sort();
    for (_, doi) in by_age.into_iter().take(excess) {
        cache.entries.remove(&doi);
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn timestamp_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_exact_doi_updates_keeps_the_most_serious_notice_and_classifies_the_rest() {
        let health = parse_response(&fixture(), "10.1234/example").unwrap();
        assert_eq!(health.kind, "retracted");
        assert_eq!(health.update_type.as_deref(), Some("retraction"));
        assert_eq!(health.source.as_deref(), Some("retraction-watch"));
        assert_eq!(health.date.as_deref(), Some("2023-09-17"));
        assert_eq!(health.link.as_deref(), Some("https://retractionwatch.com/example"));
        // The rest of Crossref's update vocabulary.
        for (update_type, kind) in [
            ("expression_of_concern", "expressionOfConcern"),
            ("erratum", "corrected"),
            ("new_version", "replaced"),
            ("something_new", "unknown"),
        ] {
            assert_eq!(classify(update_type), kind);
        }
    }

    #[test]
    fn caches_mocked_crossref_results_and_reuses_them_offline() {
        let fixture = fixture().to_string();
        let (base, responder) = crate::literature_service::serve_once(move |request| {
            assert!(request.url().contains("filter=updates:10.1234%2Fexample"));
            assert!(request.url().contains("mailto=person%40example.org"));
            request
                .respond(tiny_http::Response::from_string(fixture).with_header(
                    tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
                ))
                .unwrap();
        });
        let root = crate::test_support::TempDir::new("health");
        let online = lookup_at(
            &root,
            ["10.1234/example".to_string()],
            &format!("{base}/works"),
            Some(Some("person@example.org".into())),
        );
        responder.join().unwrap();
        assert_eq!(online["10.1234/example"].kind, "retracted");
        assert!(root.join(CACHE_PATH).is_file());

        // A fresh cache does not contact this unreachable endpoint.
        let cached =
            lookup_at(&root, ["10.1234/example".to_string()], "http://127.0.0.1:1/works", None);
        assert_eq!(cached["10.1234/example"].kind, "retracted");
        assert!(!cached["10.1234/example"].stale);
    }
}
