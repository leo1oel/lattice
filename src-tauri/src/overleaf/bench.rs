//! Where a sync spends its time, against a fake Overleaf that answers like the
//! real one does over a slow link: every request pays a round trip, a new
//! connection pays a proxied TLS handshake on top, the project download is
//! zipped file by file on the server and then crosses the link at a few
//! megabytes a second, and the dashboard page the upload token comes from is
//! slow to render. Requests are answered concurrently, as Overleaf does.
//!
//! The figures are a model, not a recording, chosen so that the sync this
//! replaced, finding nothing to do, takes about 10 s here: the same order as
//! the 12-13 s median the app's own logs show for the real ~110-file project
//! over a proxied link. Run with
//! `NO_PROXY=127.0.0.1 cargo test --lib overleaf::bench -- --ignored --nocapture`:
//! a system proxy may otherwise carry even loopback requests, and close every
//! connection after one request.

use super::link::SyncState;
use super::sync::sync;
use super::test_support::*;
use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RTT: Duration = Duration::from_millis(250);
/// A new connection's TCP and TLS handshakes through a local proxy.
const HANDSHAKE: Duration = Duration::from_millis(750);
const BYTES_PER_SEC: f64 = 1024.0 * 1024.0;
const DASHBOARD_RENDER: Duration = Duration::from_millis(1200);
const DASHBOARD_BYTES: usize = 400 * 1024;
const ZIP_BASE: Duration = Duration::from_millis(150);
const ZIP_PER_FILE: Duration = Duration::from_millis(40);
const HISTORY_SERVER: Duration = Duration::from_millis(150);
const UPLOAD_SERVER: Duration = Duration::from_millis(400);

fn transfer(bytes: usize) -> Duration {
    Duration::from_secs_f64(bytes as f64 / BYTES_PER_SEC)
}

struct Counts {
    connections: AtomicUsize,
    downloads: AtomicUsize,
    dashboards: AtomicUsize,
    history: AtomicUsize,
    uploads: AtomicUsize,
}

/// Serve `zip`, answering version reads with `version` and history reads with
/// `history`, on a thread per request.
fn slow_overleaf(
    zip: Vec<u8>, files: usize, version: i64, history: serde_json::Value,
) -> (String, Arc<Counts>) {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
    let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
    let counts = Arc::new(Counts {
        connections: AtomicUsize::new(0),
        downloads: AtomicUsize::new(0),
        dashboards: AtomicUsize::new(0),
        history: AtomicUsize::new(0),
        uploads: AtomicUsize::new(0),
    });
    let seen = Arc::new(Mutex::new(HashSet::new()));
    let (zip, html, served) = (Arc::new(zip), Arc::new(projects_page_html()), Arc::clone(&counts));
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let (zip, html, counts, seen) =
                (Arc::clone(&zip), Arc::clone(&html), Arc::clone(&served), Arc::clone(&seen));
            let history = history.clone();
            std::thread::spawn(move || {
                let mut body = Vec::new();
                let _ = request.as_reader().read_to_end(&mut body);
                let fresh = seen.lock().unwrap().insert(request.remote_addr().copied());
                let mut wait = RTT + transfer(body.len());
                if fresh {
                    counts.connections.fetch_add(1, Ordering::Relaxed);
                    wait += HANDSHAKE;
                }
                let url = request.url().to_string();
                let path = url.split('?').next().unwrap_or("").to_string();
                let (reply, extra): (Vec<u8>, Duration) = match request.method().as_str() {
                    "GET" if path == "/project" => {
                        counts.dashboards.fetch_add(1, Ordering::Relaxed);
                        let mut page = html.as_bytes().to_vec();
                        page.resize(DASHBOARD_BYTES, b' ');
                        (page, DASHBOARD_RENDER + transfer(DASHBOARD_BYTES))
                    }
                    "GET" if path.ends_with("/download/zip") => {
                        counts.downloads.fetch_add(1, Ordering::Relaxed);
                        let render = ZIP_BASE + ZIP_PER_FILE * files as u32;
                        (zip.to_vec(), render + transfer(zip.len()))
                    }
                    "GET" if url.ends_with("?min_count=1") => {
                        let body = format!("{{\"updates\":[{{\"fromV\":0,\"toV\":{version}}}]}}");
                        (body.into_bytes(), HISTORY_SERVER)
                    }
                    "GET" if path.ends_with("/updates") => {
                        counts.history.fetch_add(1, Ordering::Relaxed);
                        let body = serde_json::json!({ "updates": history });
                        (body.to_string().into_bytes(), HISTORY_SERVER)
                    }
                    "POST" if path.ends_with("/upload") => {
                        counts.uploads.fetch_add(1, Ordering::Relaxed);
                        (b"{\"success\":true}".to_vec(), UPLOAD_SERVER)
                    }
                    _ => (Vec::new(), Duration::ZERO),
                };
                std::thread::sleep(wait + extra);
                let _ = request.respond(tiny_http::Response::from_data(reply));
            });
        }
    });
    (base, counts)
}

/// A paper of 80 text files and 30 figures.
fn project() -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    for n in 0..80 {
        let text = format!("\\section{{Part {n}}}\n{}", "Words of the paper. ".repeat(400));
        files.push((format!("sections/part{n:02}.tex"), text.into_bytes()));
    }
    for n in 0..30 {
        let figure: Vec<u8> =
            (0..150 * 1024u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        files.push((format!("figures/fig{n:02}.png"), figure));
    }
    files
}

struct Scenario {
    name: &'static str,
    version: i64,
    history: serde_json::Value,
    /// Local edits made before the sync.
    edits: usize,
    /// Whether Overleaf has a changed file the sync must pull.
    remote_edit: bool,
    /// The state left by the previous sync: its recorded version (None after
    /// an upload) and the documents the realtime channel holds now.
    known_version: Option<i64>,
    live: &'static [&'static str],
}

fn run(scenario: &Scenario) {
    let files = project();
    let mut remote = files.clone();
    if scenario.remote_edit {
        remote[1].1.extend_from_slice(b"\nA sentence written on Overleaf.\n");
    }
    let remote_files: Vec<(&str, &[u8])> =
        remote.iter().map(|(path, data)| (path.as_str(), data.as_slice())).collect();
    let zip = build_zip(&remote_files);
    let (base_url, counts) =
        slow_overleaf(zip, remote_files.len(), scenario.version, scenario.history.clone());
    let base: Vec<(&str, &[u8])> =
        files.iter().map(|(path, data)| (path.as_str(), data.as_slice())).collect();
    let root = TempDir::new("overleaf-bench");
    seed_linked_project(&root, &base_url, &base, &base);
    let config = signed_in(&base_url);
    let known = scenario.known_version;
    // The previous sync downloaded and matched Overleaf's copy exactly.
    edit_state(&root, |state: &mut SyncState| {
        state.remote_version = known;
        state.unsettled = Some(BTreeSet::new());
    });
    for (path, data) in files.iter().skip(2).take(scenario.edits) {
        let mut edited = data.clone();
        edited.extend_from_slice(b"\nEdited in Lattice.\n");
        std::fs::write(root.join(path), edited).unwrap();
    }
    let live: BTreeSet<String> = scenario.live.iter().map(|path| path.to_string()).collect();

    let started = Instant::now();
    let result = sync(&config, &root, &live, None).unwrap();
    let took = started.elapsed();
    println!(
        "{:<44} {:>6.2} s  download {} dashboard {} history {} uploads {} connections {}  \
         (pulled {}, pushed {})",
        scenario.name,
        took.as_secs_f64(),
        counts.downloads.load(Ordering::Relaxed),
        counts.dashboards.load(Ordering::Relaxed),
        counts.history.load(Ordering::Relaxed),
        counts.uploads.load(Ordering::Relaxed),
        counts.connections.load(Ordering::Relaxed),
        result.pulled.len(),
        result.pushed.len(),
    );
}

#[test]
#[ignore = "a timing model that takes a minute; run it by name"]
fn where_a_sync_spends_its_time() {
    let live_edit = serde_json::json!([
        { "fromV": 40, "toV": 41, "pathnames": ["sections/part00.tex"] }
    ]);
    let remote_edit = serde_json::json!([
        { "fromV": 40, "toV": 41, "pathnames": ["sections/part01.tex"] }
    ]);
    let none = serde_json::json!([]);
    let scenarios = [
        Scenario {
            name: "nothing changed",
            version: 40,
            history: none.clone(),
            edits: 0,
            remote_edit: false,
            known_version: Some(40),
            live: &[],
        },
        Scenario {
            name: "only a live document typed in",
            version: 41,
            history: live_edit,
            edits: 0,
            remote_edit: false,
            known_version: Some(40),
            live: &["sections/part00.tex"],
        },
        Scenario {
            name: "one local edit to send",
            version: 40,
            history: none.clone(),
            edits: 1,
            remote_edit: false,
            known_version: Some(40),
            live: &[],
        },
        Scenario {
            name: "six local edits to send (an agent's pass)",
            version: 40,
            history: none.clone(),
            edits: 6,
            remote_edit: false,
            known_version: Some(40),
            live: &[],
        },
        Scenario {
            name: "a collaborator's edit to pull",
            version: 41,
            history: remote_edit,
            edits: 0,
            remote_edit: true,
            known_version: Some(40),
            live: &[],
        },
        Scenario {
            name: "check after an upload (version unknown)",
            version: 41,
            history: none,
            edits: 0,
            remote_edit: false,
            known_version: None,
            live: &[],
        },
    ];
    for scenario in &scenarios {
        run(scenario);
    }
}
