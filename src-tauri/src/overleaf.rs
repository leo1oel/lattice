//! Overleaf sync bridge.
//!
//! Talks to Overleaf's private web API the same way the browser does, using a
//! session cookie the user copies from a logged-in browser. Protocol facts,
//! pinned against overleaf-sync (moritzgloeckl), overleaf-sync-rs, and the
//! current overleaf/overleaf server source:
//!
//! - Auth is the plain `Cookie` header (`overleaf_session2=...` on
//!   overleaf.com; self-hosted instances may use `sharelatex.sid`). We store
//!   the full cookie header value verbatim.
//! - `GET {host}/project` (the dashboard) embeds everything we need in meta
//!   tags: `ol-csrfToken`, `ol-prefetchedProjectsBlob` (HTML-entity-encoded
//!   JSON `{ totalSize, projects: [...] }`; legacy instances use
//!   `ol-projects` with a bare array), and `ol-user` (JSON with `email`,
//!   `first_name`, `last_name`).
//! - `GET {host}/project/{id}/download/zip` returns the whole project as a
//!   zip archive.
//! - `POST {host}/project/new/upload` creates a project from a zip archive as
//!   multipart fields `name` and `qqfile`. The JSON response carries the new
//!   `project_id`; CSRF uses the same dashboard token as other mutations.
//! - `POST {host}/project/{id}/upload?folder_id={folder}` uploads one file as
//!   multipart: `name` (file name), `relativePath`, and the file part
//!   `qqfile`. CSRF goes in the `X-Csrf-Token` header (plus `_csrf` query
//!   param, mirroring overleaf-sync). `folder_id` is **required**: the server
//!   reads it from the query string and answers 422 `folder_not_found` when
//!   it is missing, so it cannot be omitted for root-level files.
//! - The root folder id is only exposed over socket.io (`joinProject`). The
//!   realtime bridge records that id in the local link state, then REST uploads
//!   use `folder_id=<root>` and the project-relative path verbatim. Overleaf
//!   creates missing subfolders for nested relative paths.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_HOST: &str = "https://www.overleaf.com";
const SESSION_FILE: &str = "overleaf-session.json";
const STATE_DIR: &str = ".research";
const STATE_FILE: &str = "overleaf.json";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SESSION_EXPIRED: &str = "Overleaf session expired. Reconnect in Settings → Overleaf.";
const NOT_CONNECTED: &str = "Not connected to Overleaf. Connect in Settings → Overleaf.";

/// Above this, a file is left where it is and reported instead of synced.
///
/// Overleaf's own upload limit is 50 MB, and a sync holds every file in memory
/// at once, so a project someone dropped a dataset into would otherwise fail
/// slowly and opaquely — or exhaust memory before it got as far as failing.
const MAX_SYNC_FILE_BYTES: u64 = 45 * 1024 * 1024;

/// LaTeX build artifacts that never sync in either direction.
const ARTIFACT_SUFFIXES: &[&str] = &[
    ".aux",
    ".bbl",
    ".bcf",
    ".blg",
    ".brf",
    ".dvi",
    ".fdb_latexmk",
    ".fls",
    ".idx",
    ".ilg",
    ".ind",
    ".log",
    ".out",
    ".run.xml",
    ".synctex",
    ".synctex.gz",
    ".toc",
    ".lof",
    ".lot",
    ".nav",
    ".snm",
    ".vrb",
    ".xdv",
];

// ---- Public shapes (mirrored in src/app-types.ts) -------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafProject {
    pub id: String,
    pub name: String,
    pub last_updated: Option<String>,
    pub owner_email: Option<String>,
    pub owner_name: Option<String>,
    pub access_level: Option<String>,
    pub archived: bool,
    pub trashed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafLink {
    pub project_id: String,
    pub project_name: String,
    pub host: String,
    pub last_sync: Option<String>,
    /// Linked, but not syncing until it is resumed.
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafConflict {
    pub path: String,
    pub local_copy: String,
    /// Whether the file carries conflict markers to work through.
    ///
    /// False for one that could not be merged line by line at all — a figure,
    /// a PDF — where the remote version simply takes the path and the local
    /// one is kept beside it. Telling someone to resolve the spots in a file
    /// that has none, and opening a marker resolver on it, is worse than
    /// saying plainly that both versions are on disk.
    #[serde(default)]
    pub markers: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafSyncResult {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    /// Files where both sides had edits that combined cleanly.
    pub merged: Vec<String>,
    pub conflicts: Vec<OverleafConflict>,
    pub deleted_local: Vec<String>,
    pub skipped_remote_deletes: Vec<String>,
    /// App-owned transient paths that should be removed remotely without
    /// applying the user's deletion policy for ordinary project files.
    #[serde(default)]
    pub automatic_remote_deletes: Vec<String>,
    /// Files left alone because they are bigger than Overleaf will take.
    /// Reported rather than dropped quietly: to the writer they look synced.
    #[serde(default)]
    pub skipped_large: Vec<String>,
    /// True when local work stayed here because this account cannot write to
    /// the project. Everything incoming still landed.
    #[serde(default)]
    pub read_only: bool,
}

/// What a pending sync would do to one file, computed without touching disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafChange {
    pub path: String,
    /// "incoming" | "outgoing" | "merge" | "conflict" | "deleteLocal" | "skippedRemoteDelete"
    pub kind: String,
    /// The file as it stands locally right now; None when absent locally.
    pub before: Option<String>,
    /// What it becomes if applied; None when it would be deleted.
    pub after: Option<String>,
    pub binary: bool,
}

/// A dry run of `sync`: everything it would do, nothing it did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafPreview {
    pub changes: Vec<OverleafChange>,
    pub remote_version: Option<i64>,
}

/// Result of the cheap remote-change check that live mode polls.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafProbe {
    /// True when Overleaf has moved on since our last sync.
    pub changed: bool,
    /// False when this instance does not tell us a version, in which case
    /// `changed` is meaningless and polling cannot be used to drive syncing.
    pub version_known: bool,
    pub remote_version: Option<i64>,
    pub last_sync: Option<String>,
}

/// One tick of the sign-in-window polling loop (see `overleaf_poll_login`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafLoginPoll {
    pub status: &'static str,
    pub session: Option<OverleafStatus>,
    /// Why a poll is still pending, when we got far enough to have a reason.
    pub detail: Option<String>,
}

impl OverleafLoginPoll {
    pub fn pending() -> Self {
        Self {
            status: "pending",
            session: None,
            detail: None,
        }
    }
    pub fn pending_with(detail: String) -> Self {
        Self {
            status: "pending",
            session: None,
            detail: Some(detail),
        }
    }
    pub fn cancelled() -> Self {
        Self {
            status: "cancelled",
            session: None,
            detail: None,
        }
    }
    pub fn connected(session: OverleafStatus) -> Self {
        Self {
            status: "connected",
            session: Some(session),
            detail: None,
        }
    }
}

// ---- Persisted files -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    host: String,
    cookie: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Our own Overleaf account id. Track changes is stored per account, so
    /// reading whether it is on for us needs to know which one we are.
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    host: String,
    project_id: String,
    project_name: String,
    /// Root entity returned by realtime `joinProject`. Per-file REST uploads
    /// require it; the ordinary project HTTP pages do not expose it.
    #[serde(default)]
    root_folder_id: Option<String>,
    #[serde(default)]
    last_sync: Option<String>,
    /// Newest history version seen on Overleaf at the last sync. Comparing a
    /// cheap probe against this is what lets live mode poll every few seconds
    /// without downloading the project each time.
    #[serde(default)]
    remote_version: Option<i64>,
    /// What this account may do to the project, as Overleaf last reported it.
    /// Absent on projects linked before this was recorded, which reads as
    /// writable — refusing to upload work the user can in fact push is worse
    /// than trying and being told no.
    #[serde(default)]
    permission: Option<String>,
    /// Relative path (forward slashes) → sha256 hex of the content at the
    /// last successful sync.
    #[serde(default)]
    files: BTreeMap<String, String>,
    /// Syncing is switched off for this project, but everything needed to
    /// switch it back on is kept — including `files`, the common ancestor a
    /// resumed sync merges against. Deleting the link instead would throw that
    /// away, and reconnecting afterwards could only offer conflict copies.
    #[serde(default)]
    paused: bool,
}

const PAUSED: &str = "Syncing is paused for this project. Resume it in Settings → Overleaf.";

/// True only when Overleaf explicitly said this account may change project
/// contents.
///
/// Older links did not persist a permission. Treating that unknown state as
/// writable lets an automatic sync attempt mutations before the realtime
/// channel has refreshed the account's current role. Incoming work may still
/// be pulled; outgoing work stays local until a fresh owner/editor permission
/// is recorded.
fn permits_writing(permission: Option<&str>) -> bool {
    matches!(permission, Some("owner") | Some("readAndWrite"))
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_iso() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        .to_string()
}

fn session_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SESSION_FILE)
}

fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STATE_FILE)
}

fn load_session(config_dir: &Path) -> Result<SessionFile, String> {
    let path = session_path(config_dir);
    let raw = fs::read_to_string(&path).map_err(|_| NOT_CONNECTED.to_string())?;
    serde_json::from_str(&raw).map_err(|_| NOT_CONNECTED.to_string())
}

fn save_session(config_dir: &Path, session: &SessionFile) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(err)?;
    let body = serde_json::to_string_pretty(session).map_err(err)?;
    let path = session_path(config_dir);
    let temporary = config_dir.join(format!(".{SESSION_FILE}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    // The cookie is equivalent to an active browser login. Keep the fallback
    // file private even before it moves into the macOS Keychain, and set the
    // mode both at creation and afterward so an older, permissive file is
    // repaired during the next successful sign-in.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options.open(&temporary).map_err(err)?;
        file.write_all(body.as_bytes()).map_err(err)?;
        file.write_all(b"\n").map_err(err)?;
        file.sync_all().map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        fs::rename(&temporary, &path).map_err(err)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn load_state(root: &Path) -> Result<SyncState, String> {
    let path = state_path(root);
    let raw = fs::read_to_string(&path)
        .map_err(|_| "This project is not linked to an Overleaf project.".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Could not read {STATE_DIR}/{STATE_FILE}: {e}"))
}

fn save_state(root: &Path, state: &SyncState) -> Result<(), String> {
    fs::create_dir_all(root.join(STATE_DIR)).map_err(err)?;
    let body = serde_json::to_string_pretty(state).map_err(err)?;
    fs::write(state_path(root), body + "\n").map_err(err)
}

/// RFC 6265 domain matching: a cookie scoped to `overleaf.com` belongs on
/// requests to `www.overleaf.com`.
///
/// This exists because wry's own `cookies_for_url` filter compares the two
/// domains for *equality* (and the cookie crate strips the leading dot), so on
/// macOS it silently drops every `.overleaf.com` cookie and the sign-in window
/// never appears to log in. We read all cookies and match them ourselves.
pub fn cookie_domain_matches(cookie_domain: &str, host: &str) -> bool {
    let cookie_domain = cookie_domain
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let host = host.trim().trim_start_matches('.').to_ascii_lowercase();
    if cookie_domain.is_empty() || host.is_empty() {
        return false;
    }
    host == cookie_domain || host.ends_with(&format!(".{cookie_domain}"))
}

/// Does this cookie jar look like a signed-in session for `host`?
/// `overleaf_session2` is overleaf.com; `sharelatex.sid` is self-hosted CE.
pub fn has_session_cookie(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| name == "overleaf_session2" || name == "sharelatex.sid")
}

pub fn normalize_host(host: &str) -> String {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_HOST.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

// ---- HTTP ------------------------------------------------------------------

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent(USER_AGENT)
        .build()
        .map_err(err)
}

/// True when reqwest ended up on a login page after following redirects.
fn landed_on_login(response: &reqwest::blocking::Response) -> bool {
    response.url().path().contains("/login")
}

fn check_authenticated(response: &reqwest::blocking::Response) -> Result<(), String> {
    let status = response.status();
    if landed_on_login(response) || status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(SESSION_EXPIRED.to_string());
    }
    Ok(())
}

fn fetch_projects_page(
    client: &reqwest::blocking::Client,
    host: &str,
    cookie: &str,
) -> Result<String, String> {
    let response = client
        .get(format!("{host}/project"))
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project list.",
            response.status()
        ));
    }
    response.text().map_err(err)
}

/// Extract the decoded `content` attribute of `<meta name="...">`.
fn meta_content(html: &str, name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    for (start, _) in html.match_indices("<meta") {
        let end = start + html[start..].find('>')?;
        let tag = &html[start..end];
        if !tag.contains(&needle) {
            continue;
        }
        let value_start = tag.find("content=\"")? + "content=\"".len();
        let value_end = value_start + tag[value_start..].find('"')?;
        return Some(html_escape::decode_html_entities(&tag[value_start..value_end]).into_owned());
    }
    None
}

fn json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|k| value.get(k).and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
}

/// Overleaf encodes archived/trashed as booleans today; very old instances
/// used per-user id arrays.
fn json_flag(value: &serde_json::Value, key: &str) -> bool {
    match value.get(key) {
        Some(v) => v
            .as_bool()
            .unwrap_or_else(|| v.as_array().map(|a| !a.is_empty()).unwrap_or(false)),
        None => false,
    }
}

fn parse_user_meta(html: &str) -> (Option<String>, Option<String>) {
    if let Some(raw) = meta_content(html, "ol-user") {
        if let Ok(user) = serde_json::from_str::<serde_json::Value>(&raw) {
            let email = json_str(&user, &["email"]);
            let first = json_str(&user, &["first_name", "firstName"]).unwrap_or_default();
            let last = json_str(&user, &["last_name", "lastName"]).unwrap_or_default();
            let name = format!("{first} {last}").trim().to_string();
            let name = if name.is_empty() { None } else { Some(name) };
            return (email, name);
        }
    }
    (meta_content(html, "ol-usersEmail"), None)
}

fn parse_projects_meta(html: &str) -> Result<Vec<OverleafProject>, String> {
    let raw_projects: Vec<serde_json::Value> =
        if let Some(blob) = meta_content(html, "ol-prefetchedProjectsBlob") {
            let value: serde_json::Value = serde_json::from_str(&blob)
                .map_err(|e| format!("Could not parse the Overleaf project list: {e}"))?;
            value
                .get("projects")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default()
        } else if let Some(blob) = meta_content(html, "ol-projects") {
            serde_json::from_str(&blob)
                .map_err(|e| format!("Could not parse the Overleaf project list: {e}"))?
        } else {
            return Err(SESSION_EXPIRED.to_string());
        };

    let mut projects = Vec::new();
    for value in &raw_projects {
        let Some(id) = json_str(value, &["id", "_id"]) else {
            continue;
        };
        let Some(name) = json_str(value, &["name"]) else {
            continue;
        };
        let owner = value.get("owner");
        let owner_email = owner.and_then(|o| json_str(o, &["email"]));
        let owner_name = owner.map(|o| {
            let first = json_str(o, &["firstName", "first_name"]).unwrap_or_default();
            let last = json_str(o, &["lastName", "last_name"]).unwrap_or_default();
            format!("{first} {last}").trim().to_string()
        });
        projects.push(OverleafProject {
            id,
            name,
            last_updated: json_str(value, &["lastUpdated"]),
            owner_email,
            owner_name: owner_name.filter(|n| !n.is_empty()),
            access_level: json_str(value, &["accessLevel"]),
            archived: json_flag(value, "archived"),
            trashed: json_flag(value, "trashed"),
        });
    }
    projects.sort_by(|a, b| {
        b.last_updated
            .cmp(&a.last_updated)
            .then(a.name.cmp(&b.name))
    });
    Ok(projects)
}

fn download_project_zip(
    client: &reqwest::blocking::Client,
    host: &str,
    cookie: &str,
    project_id: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(format!("{host}/project/{project_id}/download/zip"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .map_err(|e| format!("Could not download the project from Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project download.",
            response.status()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().map_err(err)?.to_vec();
    if content_type.contains("text/html") || !bytes.starts_with(b"PK") {
        return Err(SESSION_EXPIRED.to_string());
    }
    Ok(bytes)
}

/// Read a project zip into path → bytes, rejecting zip-slip entries.
fn read_zip_entries(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Overleaf sent an unreadable zip archive: {e}"))?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(err)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().replace('\\', "/");
        let unsafe_path = file.enclosed_name().is_none()
            || name.starts_with('/')
            || name.split('/').any(|part| part == ".." || part.is_empty());
        if unsafe_path {
            return Err(format!("Refusing unsafe path in Overleaf zip: {name}"));
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(err)?;
        entries.insert(name, data);
    }
    Ok(entries)
}

// ---- Hashing, exclusion, local file IO --------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

const TRANSIENT_PDF_RENDER_DIRECTORY: &str = "tmp/pdfs";
const TRANSIENT_PDF_RENDER_PREFIX: &str = "tmp/pdfs/";

fn is_transient_pdf_render_path(path: &str) -> bool {
    path == TRANSIENT_PDF_RENDER_DIRECTORY || path.starts_with(TRANSIENT_PDF_RENDER_PREFIX)
}

fn is_latex_save_error_path(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let lower = file_name.to_ascii_lowercase();
    let lower = lower.strip_suffix("(busy)").unwrap_or(&lower);
    let Some(stem) = lower.strip_suffix("-save-error") else {
        return false;
    };
    ARTIFACT_SUFFIXES
        .iter()
        .any(|suffix| stem.ends_with(suffix))
}

/// Paths (forward-slash relative) that never participate in sync.
fn is_excluded(path: &str) -> bool {
    // Agent PDF rendering uses this local workspace for contact sheets and
    // page images. These are reproducible intermediates, not project assets.
    if is_transient_pdf_render_path(path) {
        return true;
    }
    // Legacy `.omp/` folders may hold MCP server config, whose `env` is where
    // someone puts an API key. Uploading it would hand that key to everyone on
    // the Overleaf project and write it into the project's history.
    if path.starts_with(".research/") || path.starts_with(".git/") || path.starts_with(".omp/") {
        return true;
    }
    if path == ".gitignore" || path == ".git" || path == ".research" || path == ".omp" {
        return true;
    }
    let file_name = path.rsplit('/').next().unwrap_or(path);
    if file_name == ".DS_Store" {
        return true;
    }
    // Conflict copies are ours, not the project's: they exist so someone can
    // compare two versions here. Uploading them puts a duplicate of the paper
    // in front of everyone on Overleaf, where it competes with the real file.
    if is_conflict_copy(file_name) {
        return true;
    }
    // latexmk saves a generated file under this suffix when it cannot trust
    // the result of a failed Biber or engine run. It is the same disposable
    // artifact as the underlying `.bbl`, `.bcf`, etc., not project source.
    if is_latex_save_error_path(path) {
        return true;
    }
    // A compile that is still running leaves half-written artifacts named
    // `main.synctex(busy)` and the like. They vanish on their own, but a sync
    // that catches one mid-compile uploads it, and it then lives on Overleaf
    // and in the project's history forever.
    let lower = file_name.to_ascii_lowercase();
    let lower = lower.strip_suffix("(busy)").unwrap_or(&lower);
    if ARTIFACT_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return true;
    }
    // The compiled output pdf lives at the project root; figure pdfs live in
    // subdirectories and must sync. Exclude root-level pdfs only.
    if !path.contains('/') && lower.ends_with(".pdf") {
        return true;
    }
    false
}

/// A file this app set aside during a conflict, by the name it gave it.
///
/// Shared with the project module, which must never choose one of these as the
/// document to compile — they are byte-identical to the real file at the
/// moment they are made, so the mistake is invisible until an edit goes
/// missing from the PDF.
pub fn is_conflict_copy(file_name: &str) -> bool {
    file_name.contains(" (local conflict ")
}

fn relative_slash_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn local_disk_path(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

fn write_local_file(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let path = local_disk_path(root, rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&path, bytes).map_err(|e| format!("Could not write {rel}: {e}"))
}

// ---- Three-way merge -------------------------------------------------------
//
// Hashes alone can only tell us *that* both sides changed a file, never how to
// combine them. So alongside the hashes we keep a pristine copy of every text
// file as it stood at the last sync; that copy is the common ancestor a real
// line-level merge needs, which is what lets edits to different parts of the
// same file land together instead of one side being pushed aside.

const BASE_DIR: &str = ".research/overleaf-base";

/// Marks the start of an unresolved conflict; also the guard that stops a file
/// full of markers from being uploaded to Overleaf.
///
const CONFLICT_MARKER: &str = "<<<<<<<";

fn base_dir(root: &Path) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in BASE_DIR.split('/') {
        path.push(part);
    }
    path
}

fn base_copy_path(root: &Path, rel: &str) -> PathBuf {
    let mut path = base_dir(root);
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

/// Only text we can meaningfully merge gets a base copy: merging is
/// line-based, and keeping shadow copies of figures would double the project
/// on disk for no benefit.
fn is_mergeable_text(rel: &str, bytes: &[u8]) -> bool {
    const TEXT_SUFFIXES: &[&str] = &[
        ".tex", ".bib", ".txt", ".md", ".html", ".cls", ".sty", ".bst", ".json", ".yml", ".yaml",
        ".csv", ".tikz", ".sty.txt", ".cfg", ".def", ".ltx",
    ];
    let lower = rel.to_ascii_lowercase();
    if !TEXT_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix)) {
        return false;
    }
    // Guard against anything that only looks textual by name.
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn read_base_copy(root: &Path, rel: &str) -> Option<String> {
    fs::read_to_string(base_copy_path(root, rel)).ok()
}

fn write_base_copy(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_mergeable_text(rel, bytes) {
        remove_base_copy(root, rel);
        return Ok(());
    }
    let path = base_copy_path(root, rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    // The shadow tree is Lattice's bookkeeping, never the user's work, so keep
    // it out of the version timeline with a self-ignoring directory.
    let _ = fs::write(base_dir(root).join(".gitignore"), "*\n");
    fs::write(&path, bytes).map_err(|e| format!("Could not record the sync base for {rel}: {e}"))
}

fn remove_base_copy(root: &Path, rel: &str) {
    let _ = fs::remove_file(base_copy_path(root, rel));
}

/// Outcome of reconciling a file both sides changed.
enum MergeOutcome {
    /// Combined cleanly; the bytes belong on disk *and* on Overleaf.
    Clean(Vec<u8>),
    /// Genuinely overlapping edits; the bytes carry conflict markers.
    Conflicted(Vec<u8>),
    /// No usable common ancestor (binary, or a file first seen this sync).
    Unmergeable,
}

fn merge_three_way(root: &Path, rel: &str, remote: &[u8], local: &[u8]) -> MergeOutcome {
    if !is_mergeable_text(rel, remote) || !is_mergeable_text(rel, local) {
        return MergeOutcome::Unmergeable;
    }
    let (Some(base), Ok(ours), Ok(theirs)) = (
        read_base_copy(root, rel),
        std::str::from_utf8(local),
        std::str::from_utf8(remote),
    ) else {
        return MergeOutcome::Unmergeable;
    };
    let options = diffy::MergeOptions::new();
    match options.merge(&base, ours, theirs) {
        Ok(merged) => MergeOutcome::Clean(merged.into_bytes()),
        Err(conflicted) => MergeOutcome::Conflicted(conflicted.into_bytes()),
    }
}

/// Every syncable file in the project, and the paths left behind for being
/// too big to carry — reported so the caller can say so rather than let them
/// look synced.
struct LocalFiles {
    files: BTreeMap<String, Vec<u8>>,
    oversized: Vec<String>,
}

struct RemoteFiles {
    files: BTreeMap<String, Vec<u8>>,
    automatic_remote_deletes: Vec<String>,
}

/// Walk the project and load every syncable file (path → bytes).
fn read_local_files(root: &Path) -> Result<LocalFiles, String> {
    let mut files = BTreeMap::new();
    let mut oversized = Vec::new();
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !(e.file_type().is_dir()
            && (name == ".git"
                || name == ".research"
                || name == ".omp"
                || relative_slash_path(root, e.path())
                    .is_some_and(|path| is_transient_pdf_render_path(&path))))
    });
    for entry in walker {
        let entry = entry.map_err(err)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(rel) = relative_slash_path(root, entry.path()) else {
            continue;
        };
        if is_excluded(&rel) {
            continue;
        }
        // Checked from the directory entry, before reading: the whole project
        // is held in memory at once during a sync, and a dataset or a raw
        // video dropped in the folder would take the app down with it. Overleaf
        // will not accept one either, so there is nothing to gain by trying.
        if entry.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_SYNC_FILE_BYTES {
            oversized.push(rel);
            continue;
        }
        let data = fs::read(entry.path()).map_err(|e| format!("Could not read {rel}: {e}"))?;
        files.insert(rel, data);
    }
    Ok(LocalFiles { files, oversized })
}

/// Where a project being opened from Overleaf should land.
enum Destination {
    /// This project is already downloaded here; open it rather than clone it.
    Existing(PathBuf),
    /// Nothing in the way, or the name was taken by something else.
    Fresh(PathBuf),
}

/// Decide where an Overleaf project should go, given what is already on disk.
///
/// Opening a project that was opened before used to be an error telling
/// someone to go and find the folder themselves, or move it aside — for the
/// commonest thing anyone does with this dialog. It is the same project, so it
/// opens. A folder of the same name holding something else does not block the
/// download either; the copy simply lands beside it under a numbered name,
/// the way a second download of the same file would.
fn destination_for(dest_parent: &Path, folder_name: &str, project_id: &str) -> Destination {
    let root = dest_parent.join(folder_name);
    if !root.exists() || is_empty_dir(&root) {
        return Destination::Fresh(root);
    }
    if load_state(&root).is_ok_and(|state| state.project_id == project_id) {
        return Destination::Existing(root);
    }
    // Taken by something else: find a name that is not.
    for suffix in 2..100 {
        let candidate = dest_parent.join(format!("{folder_name} ({suffix})"));
        if !candidate.exists() || is_empty_dir(&candidate) {
            return Destination::Fresh(candidate);
        }
        if load_state(&candidate).is_ok_and(|state| state.project_id == project_id) {
            return Destination::Existing(candidate);
        }
    }
    Destination::Fresh(root)
}

/// What "Open from Overleaf" would do with a project, so the app can ask
/// before it acts rather than quietly pick.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneTarget {
    /// `open` — already linked here, just open it.
    /// `fresh` — nothing in the way, download it.
    /// `occupied` — a folder of that name holds files but is not linked to
    /// any Overleaf project. Unlinking leaves exactly this, so it is the
    /// state a project is in after Stop syncing.
    pub kind: String,
    pub path: String,
    /// The folder's name, for saying which one is meant.
    pub folder: String,
}

/// Describe the destination without touching anything.
pub fn clone_target(
    project_id: &str,
    project_name: &str,
    dest_parent: &Path,
) -> Result<CloneTarget, String> {
    let folder_name = sanitize_project_name(project_name)?;
    let root = dest_parent.join(&folder_name);
    let kind = if !root.exists() || is_empty_dir(&root) {
        "fresh"
    } else if load_state(&root).is_ok_and(|state| state.project_id == project_id) {
        "open"
    } else {
        "occupied"
    };
    Ok(CloneTarget {
        kind: kind.to_string(),
        path: root.to_string_lossy().into_owned(),
        folder: folder_name,
    })
}

/// Link a folder that is already on disk to an Overleaf project, without
/// downloading over it.
///
/// No base copies are written, and the file table starts empty, which is the
/// truth: there is no common ancestor for these two copies. The first sync
/// therefore treats every file that differs as a conflict — Overleaf's version
/// takes the path and the local one is kept beside it as
/// `name (local conflict …)` — and files that are byte-identical stay quiet.
/// Nothing is overwritten silently and nothing is thrown away.
pub fn adopt_project(
    config_dir: &Path,
    project_id: &str,
    project_name: &str,
    root: &Path,
    access_level: Option<&str>,
) -> Result<PathBuf, String> {
    let session = load_session(config_dir)?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    let state = SyncState {
        host: session.host,
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        root_folder_id: None,
        last_sync: None,
        remote_version: None,
        permission: access_level.map(str::to_string),
        files: BTreeMap::new(),
        paused: false,
    };
    save_state(root, &state)?;
    Ok(root.to_path_buf())
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// Fold a project name into a safe folder name, mirroring
/// `project::validate_new_project_name` (no separators) and stripping
/// characters macOS cannot store.
fn sanitize_project_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("That Overleaf project name cannot be used as a folder name.".to_string());
    }
    Ok(cleaned)
}

fn conflict_copy_name(path: &str, stamp: &str) -> String {
    let (dir, file_name) = match path.rsplit_once('/') {
        Some((dir, name)) => (Some(dir), name),
        None => (None, path),
    };
    let renamed = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            format!("{stem} (local conflict {stamp}).{ext}")
        }
        _ => format!("{file_name} (local conflict {stamp})"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

// ---- Uploads ----------------------------------------------------------------

/// Uploads files into an Overleaf project using the root entity learned from
/// realtime `joinProject`.
struct Uploader<'a> {
    client: &'a reqwest::blocking::Client,
    host: &'a str,
    cookie: &'a str,
    csrf: &'a str,
    project_id: &'a str,
    root_folder_id: &'a str,
}

impl<'a> Uploader<'a> {
    fn new(
        client: &'a reqwest::blocking::Client,
        host: &'a str,
        cookie: &'a str,
        csrf: &'a str,
        project_id: &'a str,
        root_folder_id: &'a str,
    ) -> Self {
        Self {
            client,
            host,
            cookie,
            csrf,
            project_id,
            root_folder_id,
        }
    }

    fn upload(&self, rel: &str, bytes: Vec<u8>) -> Result<(), String> {
        let file_name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let request = self
            .client
            .post(format!("{}/project/{}/upload", self.host, self.project_id))
            .query(&[("_csrf", self.csrf), ("folder_id", self.root_folder_id)]);
        let part = reqwest::blocking::multipart::Part::bytes(bytes).file_name(file_name.clone());
        let form = reqwest::blocking::multipart::Form::new()
            .text("name", file_name)
            .text("relativePath", rel.to_string())
            .part("qqfile", part);
        let response = request
            .header(reqwest::header::COOKIE, self.cookie)
            .header("X-Csrf-Token", self.csrf)
            .header(reqwest::header::ACCEPT, "application/json")
            .multipart(form)
            .send()
            .map_err(err)?;
        check_authenticated(&response)?;
        let status = response.status();
        let body = response.text().unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Overleaf returned {status}: {body}"));
        }
        let ok = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
            .unwrap_or(false);
        if !ok {
            return Err(format!("Overleaf rejected the upload: {body}"));
        }
        Ok(())
    }
}

// ---- Public API ---------------------------------------------------------------

pub fn session_status(config_dir: &Path) -> Result<OverleafStatus, String> {
    match load_session(config_dir) {
        Ok(session) => Ok(OverleafStatus {
            connected: true,
            email: session.email,
            name: session.name,
            host: session.host,
        }),
        Err(_) => Ok(OverleafStatus {
            connected: false,
            email: None,
            name: None,
            host: DEFAULT_HOST.to_string(),
        }),
    }
}

pub fn store_session_cookie(
    config_dir: &Path,
    host: &str,
    cookie: &str,
) -> Result<OverleafStatus, String> {
    let host = normalize_host(host);
    let cookie = cookie.trim().to_string();
    if cookie.is_empty() {
        return Err("Paste the Overleaf session cookie first.".to_string());
    }
    let client = http_client(30)?;
    let html = fetch_projects_page(&client, &host, &cookie).map_err(|e| {
        if e == SESSION_EXPIRED {
            "Overleaf rejected that cookie. Copy a fresh session cookie from a logged-in browser and try again.".to_string()
        } else {
            e
        }
    })?;
    // `fetch_projects_page` already rejects anything that redirected to the
    // login page, so reaching here means the cookie works. Accept any
    // signed-in marker rather than insisting on the projects blob alone: if
    // Overleaf renames that meta tag, connecting should still succeed and the
    // project list should be the thing that reports a clear parse error.
    let signed_in = [
        "ol-prefetchedProjectsBlob",
        "ol-projects",
        "ol-user",
        "ol-usersEmail",
    ]
    .iter()
    .any(|name| meta_content(&html, name).is_some());
    if !signed_in {
        return Err(
            "That cookie did not open the Overleaf dashboard. Copy a fresh session cookie from a logged-in browser and try again."
                .to_string(),
        );
    }
    let (email, name) = parse_user_meta(&html);
    let session = SessionFile {
        host: host.clone(),
        cookie,
        email: email.clone(),
        name: name.clone(),
        user_id: meta_content(&html, "ol-user_id"),
    };
    save_session(config_dir, &session)?;
    Ok(OverleafStatus {
        connected: true,
        email,
        name,
        host,
    })
}

pub fn disconnect(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(session_path(config_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}

pub fn list_projects(config_dir: &Path) -> Result<Vec<OverleafProject>, String> {
    let mut session = load_session(config_dir)?;
    let client = http_client(30)?;
    let html = fetch_projects_page(&client, &session.host, &session.cookie)?;
    // Backfill the account id for sessions stored before it was recorded.
    // This page is fetched anyway, and without the id the per-account track
    // changes setting reads as if we were an anonymous guest.
    if session.user_id.is_none() {
        if let Some(user_id) = meta_content(&html, "ol-user_id") {
            session.user_id = Some(user_id);
            let _ = save_session(config_dir, &session);
        }
    }
    parse_projects_meta(&html)
}

/// Create a new Overleaf project from the current local files and make this
/// folder its synchronized working copy.
///
/// The archive is built from the same filtered snapshot ordinary sync uses,
/// so app state, credentials, build output and oversized files cannot leak
/// through a broader export path. Overleaf creates the remote project from
/// exactly that snapshot; recording it as the first common ancestor means an
/// edit made locally while the upload is in flight is pushed by the next sync
/// rather than mistaken for content already present remotely.
pub fn publish_project(
    config_dir: &Path,
    root: &Path,
    requested_name: &str,
) -> Result<OverleafLink, String> {
    if state_path(root).exists() {
        return Err("This project is already linked to an Overleaf project.".to_string());
    }
    let project_name = sanitize_project_name(requested_name)?;
    let LocalFiles { files, oversized } = read_local_files(root)?;
    if !oversized.is_empty() {
        return Err(format!(
            "These files are too large for Overleaf: {}.",
            oversized.join(", ")
        ));
    }
    if files.is_empty() {
        return Err("This project has no files that can be uploaded to Overleaf.".to_string());
    }
    let unresolved = files
        .iter()
        .filter_map(|(path, bytes)| {
            std::str::from_utf8(bytes)
                .is_ok_and(|text| text.contains(CONFLICT_MARKER))
                .then_some(path.as_str())
        })
        .collect::<Vec<_>>();
    if !unresolved.is_empty() {
        return Err(format!(
            "Resolve the conflict markers before publishing: {}.",
            unresolved.join(", ")
        ));
    }

    let archive = {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (path, bytes) in &files {
            writer
                .start_file(path, zip::write::SimpleFileOptions::default())
                .map_err(|error| format!("Could not prepare {path} for Overleaf: {error}"))?;
            writer
                .write_all(bytes)
                .map_err(|error| format!("Could not prepare {path} for Overleaf: {error}"))?;
        }
        writer
            .finish()
            .map_err(|error| format!("Could not finish the Overleaf archive: {error}"))?
            .into_inner()
    };

    let session = load_session(config_dir)?;
    let client = http_client(180)?;
    let page = fetch_projects_page(&client, &session.host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let archive_name = format!("{project_name}.zip");
    let part = reqwest::blocking::multipart::Part::bytes(archive)
        .file_name(archive_name.clone())
        .mime_str("application/zip")
        .map_err(err)?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("name", archive_name)
        .part("qqfile", part);
    let response = client
        .post(format!("{}/project/new/upload", session.host))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(reqwest::header::ACCEPT, "application/json")
        .multipart(form)
        .send()
        .map_err(|error| format!("Could not upload the project to Overleaf: {error}"))?;
    check_authenticated(&response)?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let payload = serde_json::from_str::<serde_json::Value>(&body).ok();
    let success = payload
        .as_ref()
        .and_then(|value| value.get("success"))
        .and_then(|value| value.as_bool())
        .unwrap_or(status.is_success());
    if !status.is_success() || !success {
        let detail = payload
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(|value| value.as_str())
            .unwrap_or(body.trim());
        let detail = if detail.is_empty() {
            "the server did not explain why"
        } else {
            detail
        };
        return Err(format!(
            "Overleaf could not create the project ({status}): {detail}"
        ));
    }
    let project_id = payload
        .as_ref()
        .and_then(|value| value.get("project_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Overleaf created the project but returned no project id.".to_string())?
        .to_string();

    let remote_version = fetch_remote_version(&client, &session.host, &session.cookie, &project_id);
    let state_files = files
        .iter()
        .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
        .collect();
    let state = SyncState {
        host: session.host.clone(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        root_folder_id: None,
        last_sync: Some(now_iso()),
        remote_version,
        permission: Some("owner".to_string()),
        files: state_files,
        paused: false,
    };
    let finish_link = (|| {
        for (path, bytes) in &files {
            write_base_copy(root, path, bytes)?;
        }
        save_state(root, &state)
    })();
    if let Err(error) = finish_link {
        return Err(format!(
            "Overleaf created {}/project/{project_id}, but Lattice could not link this folder: {error}",
            session.host
        ));
    }

    Ok(OverleafLink {
        project_id,
        project_name,
        host: session.host,
        last_sync: state.last_sync,
        paused: false,
    })
}

/// Download a project and link it. `access_level` is what the dashboard said
/// this account may do, so syncing respects it even before the realtime
/// channel has a chance to confirm.
pub fn clone_project(
    config_dir: &Path,
    project_id: &str,
    project_name: &str,
    dest_parent: &Path,
    access_level: Option<&str>,
) -> Result<PathBuf, String> {
    let session = load_session(config_dir)?;
    let folder_name = sanitize_project_name(project_name)?;
    let root = match destination_for(dest_parent, &folder_name, project_id) {
        // Already here: opening it is what was wanted. A second copy of a
        // project that syncs would only be a second thing to keep in step.
        Destination::Existing(root) => {
            let mut state = load_state(&root)?;
            // The one thing that can have changed while it sat there: what
            // this account is now allowed to do with the project. A missing
            // dashboard role clears an old writable role: unknown must fail
            // closed until realtime supplies fresh evidence.
            if state.permission.as_deref() != access_level {
                state.permission = access_level.map(str::to_string);
                save_state(&root, &state)?;
            }
            return Ok(root);
        }
        Destination::Fresh(root) => root,
    };
    let client = http_client(120)?;
    // This version was observed before the downloaded snapshot. Recording a
    // newer version fetched afterwards could claim that edits made while the
    // zip was in flight are already present on disk.
    let remote_version = fetch_remote_version(&client, &session.host, &session.cookie, project_id);
    let zip_bytes = download_project_zip(&client, &session.host, &session.cookie, project_id)?;
    let entries = read_zip_entries(&zip_bytes)?;

    fs::create_dir_all(&root).map_err(err)?;
    let mut files = BTreeMap::new();
    for (rel, data) in &entries {
        // Old Lattice versions could upload local PDF-render intermediates and
        // failed-build outputs. Do not materialize either when cloning the
        // Overleaf project; a later sync asks the live tree to remove them.
        if is_transient_pdf_render_path(rel) || is_latex_save_error_path(rel) {
            continue;
        }
        write_local_file(&root, rel, data)?;
        if !is_excluded(rel) {
            files.insert(rel.clone(), sha256_hex(data));
            // The freshly cloned state is the first common ancestor, so later
            // syncs can merge concurrent edits instead of choosing a winner.
            write_base_copy(&root, rel, data)?;
        }
    }
    let state = SyncState {
        host: session.host,
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        root_folder_id: None,
        last_sync: Some(now_iso()),
        remote_version,
        permission: access_level.map(str::to_string),
        files,
        paused: false,
    };
    save_state(&root, &state)?;
    Ok(root)
}

/// One message in the project's collaborator chat.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafMessage {
    pub id: String,
    pub content: String,
    pub author_name: String,
    pub author_email: Option<String>,
    /// Milliseconds since the epoch, as Overleaf reports it.
    pub timestamp: i64,
    /// True when this account wrote it, so the UI can side it.
    pub mine: bool,
}

/// Read the project chat, oldest first.
pub fn chat_messages(
    config_dir: &Path,
    root: &Path,
    limit: u32,
) -> Result<Vec<OverleafMessage>, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let response = client
        .get(format!(
            "{host}/project/{}/messages?limit={limit}",
            state.project_id
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project chat.",
            response.status()
        ));
    }
    let body: serde_json::Value = response.json().map_err(err)?;
    let mut messages = parse_chat_messages(&body, session.email.as_deref());
    // Overleaf answers newest-first; a conversation reads the other way.
    messages.reverse();
    Ok(messages)
}

fn parse_chat_messages(body: &serde_json::Value, my_email: Option<&str>) -> Vec<OverleafMessage> {
    body.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let user = item.get("user");
                    let first = user
                        .and_then(|u| json_str(u, &["first_name", "firstName"]))
                        .unwrap_or_default();
                    let last = user
                        .and_then(|u| json_str(u, &["last_name", "lastName"]))
                        .unwrap_or_default();
                    let email = user.and_then(|u| json_str(u, &["email"]));
                    let name = format!("{first} {last}").trim().to_string();
                    let name = if name.is_empty() {
                        email.clone().unwrap_or_else(|| "Someone".to_string())
                    } else {
                        name
                    };
                    Some(OverleafMessage {
                        id: json_str(item, &["id", "_id"])?,
                        content: json_str(item, &["content"]).unwrap_or_default(),
                        mine: match (my_email, email.as_deref()) {
                            (Some(mine), Some(theirs)) => mine.eq_ignore_ascii_case(theirs),
                            _ => false,
                        },
                        author_name: name,
                        author_email: email,
                        timestamp: item
                            .get("timestamp")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Post a message to the project chat.
pub fn send_chat_message(config_dir: &Path, root: &Path, content: &str) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Write a message first.".to_string());
    }
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let response = client
        .post(format!("{host}/project/{}/messages", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({ "content": content }))
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} when sending the message.",
            response.status()
        ));
    }
    Ok(())
}

// ---- Comment threads ------------------------------------------------------
//
// Overleaf's review panel is a set of threads keyed by id. The thread's
// position in the document lives in the document's own ranges (which arrive on
// the realtime channel when a document is joined); the conversation lives
// here, behind the same session cookie as everything else.

/// One message in a comment thread.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafComment {
    pub id: String,
    pub content: String,
    pub author_name: String,
    pub author_email: Option<String>,
    /// Milliseconds since the epoch, as Overleaf reports it.
    pub timestamp: i64,
    pub mine: bool,
}

/// A comment thread: everything said on one spot in the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafThread {
    pub id: String,
    pub messages: Vec<OverleafComment>,
    pub resolved: bool,
    pub resolved_by: Option<String>,
    /// ISO 8601, as Overleaf reports it.
    pub resolved_at: Option<String>,
}

/// Every comment thread in the project, oldest message first within a thread.
pub fn threads(config_dir: &Path, root: &Path) -> Result<Vec<OverleafThread>, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let response = client
        .get(format!("{host}/project/{}/threads", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project's comments.",
            response.status()
        ));
    }
    let body: serde_json::Value = response.json().map_err(err)?;
    Ok(parse_threads(&body, session.email.as_deref()))
}

/// `{ "<threadId>": { messages: [...], resolved?, resolved_at?, resolved_by_user? } }`
fn parse_threads(body: &serde_json::Value, my_email: Option<&str>) -> Vec<OverleafThread> {
    let Some(map) = body.as_object() else {
        return Vec::new();
    };
    let mut threads: Vec<OverleafThread> = map
        .iter()
        .map(|(id, thread)| {
            let messages = thread
                .get("messages")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| parse_comment(item, my_email))
                        .collect()
                })
                .unwrap_or_default();
            OverleafThread {
                id: id.clone(),
                messages,
                resolved: thread
                    .get("resolved")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                resolved_by: thread.get("resolved_by_user").and_then(person_name),
                resolved_at: json_str(thread, &["resolved_at", "resolvedAt"]),
            }
        })
        .collect();
    // Newest conversation first: that is the one someone is waiting on.
    threads.sort_by_key(|thread| {
        std::cmp::Reverse(thread.messages.last().map(|m| m.timestamp).unwrap_or(0))
    });
    threads
}

fn parse_comment(item: &serde_json::Value, my_email: Option<&str>) -> Option<OverleafComment> {
    let user = item.get("user");
    let email = user.and_then(|u| json_str(u, &["email"]));
    Some(OverleafComment {
        id: json_str(item, &["id", "_id"])?,
        content: json_str(item, &["content"]).unwrap_or_default(),
        mine: match (my_email, email.as_deref()) {
            (Some(mine), Some(theirs)) => mine.eq_ignore_ascii_case(theirs),
            _ => false,
        },
        author_name: user
            .and_then(person_name)
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Someone".to_string()),
        author_email: email,
        timestamp: item
            .get("timestamp")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
    })
}

/// "Ada Lovelace" from whichever spelling of the name fields this Overleaf uses.
fn person_name(user: &serde_json::Value) -> Option<String> {
    let first = json_str(user, &["first_name", "firstName"]).unwrap_or_default();
    let last = json_str(user, &["last_name", "lastName"]).unwrap_or_default();
    let name = format!("{first} {last}").trim().to_string();
    if name.is_empty() {
        json_str(user, &["name"])
    } else {
        Some(name)
    }
}

/// POST/DELETE against a thread, answering with the status rather than an
/// error, for the one caller that has a second route to try.
fn thread_request_status(
    config_dir: &Path,
    root: &Path,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<reqwest::StatusCode, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let mut request = client
        .request(method, format!("{host}/project/{}{path}", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    } else {
        // Overleaf answers 411 Length Required to a POST with no length at
        // all, which is what a bodyless `reqwest` request sends. Browsers set
        // this themselves; we have to say it out loud.
        request = request.header(reqwest::header::CONTENT_LENGTH, "0");
    }
    let response = request
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    Ok(response.status())
}

/// POST/DELETE against a thread, with the CSRF token Overleaf insists on.
fn thread_request(
    config_dir: &Path,
    root: &Path,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    what: &str,
) -> Result<(), String> {
    let status = thread_request_status(config_dir, root, method, path, body)?;
    if !status.is_success() {
        return Err(format!("Overleaf returned {status} when {what}."));
    }
    Ok(())
}

/// Where one comment thread is anchored, and in which document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafCommentAnchor {
    pub thread_id: String,
    /// Overleaf's id for the document the comment sits in.
    pub doc_id: String,
    pub position: i64,
    pub quote: String,
}

/// Where every comment in the project is anchored, in one call.
///
/// The editing channel only reveals the ranges of documents that have been
/// joined, so without this a comment on a file nobody has opened has no
/// quoted text, cannot be jumped to, and — the part that was an outright bug —
/// cannot be resolved or deleted, because those endpoints are keyed by the
/// document the thread lives in and the only id to hand was the open one.
///
/// Answers `[{ "id": <docId>, "ranges": { "comments": [...], "changes": [...] } }]`;
/// a document with nothing in it still appears, with empty ranges.
pub fn comment_anchors(
    config_dir: &Path,
    root: &Path,
) -> Result<Vec<OverleafCommentAnchor>, String> {
    Ok(parse_comment_anchors(&project_ranges(config_dir, root)?))
}

/// The raw ranges of every document in the project.
fn project_ranges(config_dir: &Path, root: &Path) -> Result<serde_json::Value, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let response = client
        .get(format!("{host}/project/{}/ranges", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project's comment anchors.",
            response.status()
        ));
    }
    response.json().map_err(err)
}

/// One document's comment and suggestion ranges, read without joining it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRanges {
    pub comments: Vec<crate::overleaf_rt::CommentRange>,
    pub changes: Vec<crate::overleaf_rt::TrackedChange>,
}

/// What is anchored in one document right now.
///
/// The editing channel states this once, when the document is joined, and
/// never repeats it — and it never echoes our own operation back to us, so
/// after suggesting an edit there is nothing on the channel to say the
/// suggestion exists. Re-joining would answer that but replaces the buffer
/// under whoever is typing; this asks the same question without disturbing
/// anything.
pub fn doc_ranges(config_dir: &Path, root: &Path, doc_id: &str) -> Result<DocRanges, String> {
    let body = project_ranges(config_dir, root)?;
    let ranges = body
        .as_array()
        .and_then(|docs| {
            docs.iter()
                .find(|entry| json_str(entry, &["id", "_id"]).as_deref() == Some(doc_id))
        })
        .and_then(|entry| entry.get("ranges").cloned())
        .unwrap_or_default();
    Ok(DocRanges {
        comments: crate::overleaf_rt::parse_comment_ranges(&ranges),
        changes: crate::overleaf_rt::parse_tracked_changes(&ranges),
    })
}

fn parse_comment_anchors(body: &serde_json::Value) -> Vec<OverleafCommentAnchor> {
    body.as_array()
        .map(|docs| {
            docs.iter()
                .flat_map(|entry| {
                    let doc_id = json_str(entry, &["id", "_id"]).unwrap_or_default();
                    let ranges = entry.get("ranges").cloned().unwrap_or_default();
                    // The same `{ p, c, t }` shape the editing channel sends,
                    // so it goes through the same parser — including the
                    // transport unpacking the quoted text needs.
                    crate::overleaf_rt::parse_comment_ranges(&ranges)
                        .into_iter()
                        .map(move |range| OverleafCommentAnchor {
                            thread_id: range.thread_id,
                            doc_id: doc_id.clone(),
                            position: range.position,
                            quote: range.quote,
                        })
                })
                .filter(|anchor| !anchor.doc_id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Add a message to an existing thread.
pub fn reply_to_thread(
    config_dir: &Path,
    root: &Path,
    thread_id: &str,
    content: &str,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Write a reply first.".to_string());
    }
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        &format!("/thread/{thread_id}/messages"),
        Some(serde_json::json!({ "content": content })),
        "posting the reply",
    )
}

/// Resolving, reopening and deleting are all keyed by the document the thread
/// sits in — Overleaf needs to know where to clear the marker.
pub fn resolve_thread(
    config_dir: &Path,
    root: &Path,
    doc_id: &str,
    thread_id: &str,
    resolved: bool,
) -> Result<(), String> {
    let action = if resolved { "resolve" } else { "reopen" };
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        &format!("/doc/{doc_id}/thread/{thread_id}/{action}"),
        None,
        if resolved {
            "resolving the comment"
        } else {
            "reopening the comment"
        },
    )
}

/// Change what one message says. Overleaf only lets the author do this.
pub fn edit_message(
    config_dir: &Path,
    root: &Path,
    thread_id: &str,
    message_id: &str,
    content: &str,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A comment cannot be empty. Delete it instead.".to_string());
    }
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        &format!("/thread/{thread_id}/messages/{message_id}/edit"),
        Some(serde_json::json!({ "content": content })),
        "saving the edit",
    )
}

/// Remove one message from a thread.
///
/// Overleaf has two routes for this and they are not interchangeable: the
/// plain one is for owners and editors deleting anyone's message, and
/// `own-messages` is what everyone else — a reviewer, say — must use for their
/// own. We only ever offer this on your own message, so the narrower route is
/// the one that works for every role; the wider one is the fallback for
/// self-hosted servers old enough not to have it.
pub fn delete_message(
    config_dir: &Path,
    root: &Path,
    thread_id: &str,
    message_id: &str,
) -> Result<(), String> {
    let status = thread_request_status(
        config_dir,
        root,
        reqwest::Method::DELETE,
        &format!("/thread/{thread_id}/own-messages/{message_id}"),
        None,
    )?;
    if status.is_success() {
        return Ok(());
    }
    if status != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Overleaf returned {status} when deleting the comment."
        ));
    }
    thread_request(
        config_dir,
        root,
        reqwest::Method::DELETE,
        &format!("/thread/{thread_id}/messages/{message_id}"),
        None,
        "deleting the comment",
    )
}

pub fn delete_thread(
    config_dir: &Path,
    root: &Path,
    doc_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    thread_request(
        config_dir,
        root,
        reqwest::Method::DELETE,
        &format!("/doc/{doc_id}/thread/{thread_id}"),
        None,
        "deleting the comment",
    )
}

// ---- Overleaf's own history ----------------------------------------------
//
// Separate from Lattice's version timeline, which records what happened on
// this machine. This is the project's history as Overleaf kept it, including
// everything done in the browser while this app was closed — so it is the only
// thing that can answer "put it back the way it was on Tuesday" for work that
// never passed through here.

/// One entry in the project's history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafUpdate {
    /// The version range this entry covers.
    pub from_version: i64,
    pub to_version: i64,
    /// Milliseconds since the epoch.
    pub start_ts: i64,
    pub end_ts: i64,
    /// Who was involved. Overleaf reports nulls for accounts it can no longer
    /// resolve, and those are dropped rather than shown as blanks.
    pub authors: Vec<String>,
    /// The files this entry touched.
    pub paths: Vec<String>,
    /// Named versions attached to this entry.
    pub labels: Vec<OverleafLabel>,
    /// "dropbox", "git-bridge", "file-restore" … when the work came from
    /// somewhere other than the editor.
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafLabel {
    pub id: String,
    pub comment: String,
    pub version: i64,
    pub created_at: Option<String>,
    pub author: Option<String>,
}

fn history_get(config_dir: &Path, root: &Path, path: &str) -> Result<serde_json::Value, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(30)?;
    let response = client
        .get(format!("{host}/project/{}{path}", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if response.status().as_u16() == 402 {
        return Err("Overleaf's full history needs a paid plan on this project.".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project history.",
            response.status()
        ));
    }
    response.json().map_err(err)
}

/// A page of history, newest first. `before` continues from a previous page's
/// `nextBefore` — which is a version number despite Overleaf calling it a
/// timestamp.
pub fn history_updates(
    config_dir: &Path,
    root: &Path,
    before: Option<i64>,
    count: u32,
) -> Result<(Vec<OverleafUpdate>, Option<i64>), String> {
    let query = match before {
        Some(before) => format!("/updates?min_count={count}&before={before}"),
        None => format!("/updates?min_count={count}"),
    };
    let body = history_get(config_dir, root, &query)?;
    let updates = body
        .get("updates")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().map(parse_history_update).collect())
        .unwrap_or_default();
    let next = body
        .get("nextBeforeTimestamp")
        .and_then(serde_json::Value::as_i64);
    Ok((updates, next))
}

fn parse_history_update(item: &serde_json::Value) -> OverleafUpdate {
    let meta = item.get("meta");
    OverleafUpdate {
        from_version: item
            .get("fromV")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        to_version: item
            .get("toV")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        start_ts: meta
            .and_then(|m| m.get("start_ts"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        end_ts: meta
            .and_then(|m| m.get("end_ts"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        authors: meta
            .and_then(|m| m.get("users"))
            .and_then(serde_json::Value::as_array)
            .map(|users| users.iter().filter_map(person_name).collect())
            .unwrap_or_default(),
        paths: update_paths(item),
        labels: item
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|labels| labels.iter().filter_map(parse_label).collect())
            .unwrap_or_default(),
        origin: meta
            .and_then(|m| m.get("origin"))
            .and_then(|origin| json_str(origin, &["kind"])),
    }
}

/// Every file an update touched, from the two places Overleaf keeps them.
///
/// `pathnames` only ever lists documents that were edited. Anything done to
/// the project *tree* — uploading a figure, renaming a file, deleting one —
/// lands in `project_ops` instead, and an update that did only that has an
/// empty `pathnames`. Reading just the one field makes real uploads and
/// deletions show up in the timeline as having changed nothing at all.
fn update_paths(item: &serde_json::Value) -> Vec<String> {
    let mut paths: Vec<String> = item
        .get("pathnames")
        .and_then(serde_json::Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    for op in item
        .get("project_ops")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        // A rename is named by where the file ended up, which is what the
        // reader would go looking for now.
        let path = ["rename", "add", "remove"].into_iter().find_map(|kind| {
            op.get(kind)
                .and_then(|body| json_str(body, &["newPathname", "pathname"]))
        });
        if let Some(path) = path {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn parse_label(item: &serde_json::Value) -> Option<OverleafLabel> {
    Some(OverleafLabel {
        id: json_str(item, &["id", "_id"])?,
        comment: json_str(item, &["comment"]).unwrap_or_default(),
        version: item.get("version").and_then(serde_json::Value::as_i64)?,
        created_at: json_str(item, &["created_at", "createdAt"]),
        author: json_str(item, &["user_display_name", "userDisplayName"]),
    })
}

/// How one file read at two versions, as insert/delete/unchanged runs.
pub fn history_diff(
    config_dir: &Path,
    root: &Path,
    path: &str,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let query = format!(
        "/diff?from={from}&to={to}&pathname={}",
        crate::overleaf_rt::url_encode(path)
    );
    history_get(config_dir, root, &query)
}

/// Every file as it stood across a version range. `from == to` lists the tree
/// at one version; entries with no operation existed unchanged at both.
pub fn history_files(
    config_dir: &Path,
    root: &Path,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    history_get(
        config_dir,
        root,
        &format!("/filetree/diff?from={from}&to={to}"),
    )
}

pub fn history_labels(config_dir: &Path, root: &Path) -> Result<Vec<OverleafLabel>, String> {
    let body = history_get(config_dir, root, "/labels")?;
    Ok(body
        .as_array()
        .map(|labels| labels.iter().filter_map(parse_label).collect())
        .unwrap_or_default())
}

/// Roll one file, or the whole project, back to a version.
///
/// Reverting is delete-then-add on Overleaf's side, so the entity's id changes
/// and the file tree events report a removal followed by a creation. That is
/// expected, not a sign something went wrong.
pub fn history_revert(
    config_dir: &Path,
    root: &Path,
    version: i64,
    path: Option<&str>,
) -> Result<(), String> {
    let (endpoint, body) = match path {
        Some(path) => (
            "/revert_file".to_string(),
            serde_json::json!({ "version": version, "pathname": path }),
        ),
        None => (
            "/revert-project".to_string(),
            serde_json::json!({ "version": version }),
        ),
    };
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        &endpoint,
        Some(body),
        "restoring from history",
    )
}

/// Bring back a file that was deleted, using the version it vanished at.
pub fn history_restore_file(
    config_dir: &Path,
    root: &Path,
    version: i64,
    path: &str,
) -> Result<(), String> {
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        "/restore_file",
        Some(serde_json::json!({ "version": version, "pathname": path })),
        "restoring the file",
    )
}

pub fn history_add_label(
    config_dir: &Path,
    root: &Path,
    version: i64,
    comment: &str,
) -> Result<(), String> {
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        "/labels",
        Some(serde_json::json!({ "version": version, "comment": comment })),
        "naming this version",
    )
}

pub fn history_delete_label(config_dir: &Path, root: &Path, label_id: &str) -> Result<(), String> {
    thread_request(
        config_dir,
        root,
        reqwest::Method::DELETE,
        &format!("/labels/{label_id}"),
        None,
        "removing the name",
    )
}

/// Accept tracked changes: the suggested text becomes ordinary text.
///
/// Accepting is the one half of reviewing that does not change the document,
/// which is why it has an endpoint of its own rather than travelling as an
/// operation the way rejecting does.
pub fn accept_changes(
    config_dir: &Path,
    root: &Path,
    doc_id: &str,
    change_ids: &[String],
) -> Result<(), String> {
    if change_ids.is_empty() {
        return Ok(());
    }
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        &format!("/doc/{doc_id}/changes/accept"),
        Some(serde_json::json!({ "change_ids": change_ids })),
        "accepting the suggestion",
    )
}

/// Who wrote the suggestions in this project.
///
/// Kept separate from the project's member list because the author of an old
/// change may have left the project since, and a suggestion with no name on it
/// is one nobody can judge.
pub fn change_authors(config_dir: &Path, root: &Path) -> Result<serde_json::Value, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let response = client
        .get(format!("{host}/project/{}/changes/users", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the suggestion authors.",
            response.status()
        ));
    }
    response.json().map_err(err)
}

/// Turn suggestions on or off for this account.
///
/// The setting is project-wide but stored per account, so turning it on for
/// ourselves means sending the whole map back with our own entry changed.
pub fn set_track_changes(
    config_dir: &Path,
    root: &Path,
    on_for: serde_json::Value,
) -> Result<(), String> {
    thread_request(
        config_dir,
        root,
        reqwest::Method::POST,
        "/track_changes",
        Some(serde_json::json!({ "on_for": on_for })),
        "changing the suggestion setting",
    )
}

/// Create a document in the project, so a file added here shows up for
/// everyone rather than waiting for the next upload to invent it.
pub fn create_doc(
    config_dir: &Path,
    root: &Path,
    parent_folder_id: &str,
    name: &str,
) -> Result<String, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let response = client
        .post(format!("{host}/project/{}/doc", state.project_id))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({ "name": name, "parent_folder_id": parent_folder_id }))
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} when creating {name}.",
            response.status()
        ));
    }
    let body: serde_json::Value = response.json().map_err(err)?;
    json_str(&body, &["_id"]).ok_or_else(|| "Overleaf created no document.".to_string())
}

/// Delete an entity from the project. `kind` is "doc", "file" or "folder".
///
/// Syncing has never done this — a file deleted here simply stayed on
/// Overleaf — which is safe but leaves the two sides permanently different.
pub fn delete_entity(
    config_dir: &Path,
    root: &Path,
    kind: &str,
    entity_id: &str,
) -> Result<(), String> {
    if !matches!(kind, "doc" | "file" | "folder") {
        return Err(format!("{kind} is not something Overleaf can delete."));
    }
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(20)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let response = client
        .delete(format!(
            "{host}/project/{}/{kind}/{entity_id}",
            state.project_id
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} when deleting the {kind}.",
            response.status()
        ));
    }
    Ok(())
}

/// What the realtime channel needs to open a connection for this project:
/// (host, cookie, project id).
pub fn realtime_config(
    config_dir: &Path,
    root: &Path,
) -> Result<(String, String, String, Option<String>), String> {
    let mut session = load_session(config_dir)?;
    let state = load_state(root)?;
    if state.paused {
        return Err(PAUSED.to_string());
    }
    let host = sync_host(&state, &session)?;
    let user_id = ensure_user_id(config_dir, &mut session);
    Ok((host, session.cookie, state.project_id, user_id))
}

/// Our own Overleaf account id, fetched once if the session predates our
/// storing it.
///
/// Sessions signed in before this was recorded have no id, and there is no
/// second chance to read it from the sign-in response. Everything stored per
/// account then reads as if we were an anonymous guest — and turning
/// suggestions on, which has to name the account it is for, cannot be done at
/// all. Backfilling on the project list was not enough: someone who opens a
/// project they already linked never goes near it.
fn ensure_user_id(config_dir: &Path, session: &mut SessionFile) -> Option<String> {
    if session.user_id.is_some() {
        return session.user_id.clone();
    }
    let client = http_client(20).ok()?;
    let html = fetch_projects_page(&client, &session.host, &session.cookie).ok()?;
    let user_id = meta_content(&html, "ol-user_id").or_else(|| {
        serde_json::from_str::<serde_json::Value>(&meta_content(&html, "ol-user")?)
            .ok()
            .and_then(|user| json_str(&user, &["_id", "id"]))
    })?;
    session.user_id = Some(user_id.clone());
    let _ = save_session(config_dir, session);
    Some(user_id)
}

/// Cheap "did anything change over there?" check.
///
/// Overleaf's history API reports the project's newest version in a small JSON
/// payload, so this can run every few seconds — unlike a full sync, which
/// downloads the whole project as a zip. Live mode polls this and only syncs
/// for real when the version moved.
pub fn probe(config_dir: &Path, root: &Path) -> Result<OverleafProbe, String> {
    let session = load_session(config_dir)?;
    let state = load_state(root)?;
    let host = sync_host(&state, &session)?;
    let client = http_client(15)?;
    let response = client
        .get(format!(
            "{host}/project/{}/updates?min_count=1",
            state.project_id
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Could not reach Overleaf: {e}"))?;
    check_authenticated(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "Overleaf returned {} for the project history.",
            response.status()
        ));
    }
    let body: serde_json::Value = response.json().map_err(err)?;
    let remote_version = latest_update_version(&body);
    Ok(OverleafProbe {
        changed: match (remote_version, state.remote_version) {
            (Some(remote), Some(known)) => remote != known,
            // First look with a usable version: sync once to set the baseline.
            (Some(_), None) => true,
            // No version to compare. Saying "changed" here would download the
            // whole project on every poll, which is what earned a 429.
            (None, _) => false,
        },
        version_known: remote_version.is_some(),
        remote_version,
        last_sync: state.last_sync,
    })
}

/// Best-effort read of the project's newest history version. A failure here
/// only costs the next probe a redundant sync, so it never fails a sync.
fn fetch_remote_version(
    client: &reqwest::blocking::Client,
    host: &str,
    cookie: &str,
    project_id: &str,
) -> Option<i64> {
    let response = client
        .get(format!("{host}/project/{project_id}/updates?min_count=1"))
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    latest_update_version(&response.json::<serde_json::Value>().ok()?)
}

/// A number that only moves forward when the project changes.
///
/// Overleaf's history has reported this under more than one name, so try each
/// in turn and fall back to the newest edit's timestamp. Returning `None` here
/// means we genuinely cannot tell whether anything changed — and the caller
/// must then not guess "yes", or it would re-download the project on every
/// poll and get itself rate-limited.
fn latest_update_version(body: &serde_json::Value) -> Option<i64> {
    let updates = body.get("updates")?.as_array()?;
    let versions = updates
        .iter()
        .filter_map(|update| {
            update
                .get("toV")
                .or_else(|| update.get("v"))
                .and_then(|value| value.as_i64())
        })
        .max();
    if versions.is_some() {
        return versions;
    }
    updates
        .iter()
        .filter_map(|update| {
            update
                .get("meta")
                .and_then(|meta| meta.get("end_ts").or_else(|| meta.get("endTs")))
                .and_then(|value| value.as_i64())
        })
        .max()
}

/// Stop or restart syncing this project, keeping the link either way.
///
/// Pausing is not unlinking: the state file and the base copies stay, so
/// resuming picks up as an ordinary sync against the last common ancestor —
/// edits made on either side while it was paused merge line by line, and only
/// genuinely overlapping ones need a person. Deleting the link would leave
/// two copies with no shared history, where the best that can be offered is a
/// conflict copy of every file that differs.
pub fn set_paused(root: &Path, paused: bool) -> Result<(), String> {
    let mut state = load_state(root)?;
    state.paused = paused;
    save_state(root, &state)
}

pub fn project_link(root: &Path) -> Result<Option<OverleafLink>, String> {
    if !state_path(root).exists() {
        return Ok(None);
    }
    let state = load_state(root)?;
    Ok(Some(OverleafLink {
        paused: state.paused,
        project_id: state.project_id,
        project_name: state.project_name,
        host: state.host,
        last_sync: state.last_sync,
    }))
}

// ---- Planning --------------------------------------------------------------
//
// Classification and execution are deliberately separate: the exact same
// decisions drive a real sync and the read-only preview the user sees before
// committing to one, so there is only ever one set of rules to keep honest.

/// One file both sides changed in ways that need a human.
struct ConflictPlan {
    path: String,
    /// See `OverleafConflict::markers`.
    markers: bool,
    /// What lands at `path`: the conflict-marked text, or the remote file when
    /// the two sides cannot be merged line by line.
    resolved: Vec<u8>,
    /// The local file as it stood, kept beside the marked-up one.
    local: Vec<u8>,
    /// Where that pristine local copy goes.
    local_copy: String,
}

/// Everything a sync would do, decided but not yet done.
#[derive(Default)]
struct SyncPlan {
    /// Remote content to write locally (path → bytes).
    pull: Vec<(String, Vec<u8>)>,
    /// Paths to upload from the local snapshot.
    push: Vec<String>,
    /// Cleanly merged content (path → merged bytes); also uploaded.
    merge: Vec<(String, Vec<u8>)>,
    conflict: Vec<ConflictPlan>,
    delete_local: Vec<String>,
    skipped_remote_deletes: Vec<String>,
    /// Post-sync hashes for every surviving path.
    files: BTreeMap<String, String>,
}

/// Decide what a sync would do. Reads base copies from disk, writes nothing.
///
/// `live` holds paths the realtime channel is currently editing. Those are
/// converging through operations already, so this leaves them alone entirely.
fn plan_sync(
    root: &Path,
    state: &SyncState,
    remote: &BTreeMap<String, Vec<u8>>,
    local: &BTreeMap<String, Vec<u8>>,
    live: &BTreeSet<String>,
    stamp: &str,
) -> Result<SyncPlan, String> {
    let mut all_paths: BTreeSet<String> = BTreeSet::new();
    all_paths.extend(remote.keys().cloned());
    all_paths.extend(local.keys().cloned());
    all_paths.extend(state.files.keys().cloned());

    let mut plan = SyncPlan::default();

    for path in &all_paths {
        let remote_bytes = remote.get(path);
        let local_bytes = local.get(path);
        let base_hash = state.files.get(path);
        match (remote_bytes, local_bytes) {
            (Some(rb), Some(lb)) => {
                if rb == lb {
                    plan.files.insert(path.clone(), sha256_hex(rb));
                    continue;
                }
                if live.contains(path) {
                    // The live channel owns this document. Sending our copy up
                    // over REST would land on Overleaf as an out-of-band
                    // overwrite — that is what raises "Document Updated
                    // Externally" for everyone else in the project — and
                    // writing their copy down would fight the editor buffer.
                    // Operations reconcile both sides; leave them to it.
                    if let Some(base) = base_hash {
                        plan.files.insert(path.clone(), base.clone());
                    }
                    continue;
                }
                let remote_hash = sha256_hex(rb);
                let local_hash = sha256_hex(lb);
                let remote_changed = base_hash != Some(&remote_hash);
                let local_changed = base_hash != Some(&local_hash);
                if remote_changed && !local_changed {
                    plan.pull.push((path.clone(), rb.clone()));
                    plan.files.insert(path.clone(), remote_hash);
                } else if local_changed && !remote_changed {
                    plan.push.push(path.clone());
                    plan.files.insert(path.clone(), local_hash);
                } else {
                    // Both sides changed. Combine them line by line against
                    // the copy we kept at the last sync, so edits to different
                    // parts of a file simply merge — only genuinely
                    // overlapping edits need a human.
                    match merge_three_way(root, path, rb, lb) {
                        MergeOutcome::Clean(merged) => {
                            plan.files.insert(path.clone(), sha256_hex(&merged));
                            // Overleaf still holds only their half, so send the
                            // combined file back up to converge both sides.
                            plan.merge.push((path.clone(), merged));
                        }
                        MergeOutcome::Conflicted(conflicted) => {
                            // Markers land in the file itself so the
                            // disagreement is visible exactly where it happened,
                            // and the untouched local version is kept beside it.
                            plan.conflict.push(ConflictPlan {
                                path: path.clone(),
                                markers: true,
                                resolved: conflicted,
                                local: lb.clone(),
                                local_copy: conflict_copy_name(path, stamp),
                            });
                            // Base is their version: once the markers are
                            // resolved the file counts as a local edit again
                            // and goes up on the next sync.
                            plan.files.insert(path.clone(), remote_hash);
                        }
                        MergeOutcome::Unmergeable => {
                            // Binary, or no base copy to merge against: fall
                            // back to keeping both, remote on the real path.
                            plan.conflict.push(ConflictPlan {
                                path: path.clone(),
                                markers: false,
                                resolved: rb.clone(),
                                local: lb.clone(),
                                local_copy: conflict_copy_name(path, stamp),
                            });
                            plan.files.insert(path.clone(), remote_hash);
                        }
                    }
                }
            }
            (Some(rb), None) => {
                let remote_hash = sha256_hex(rb);
                match base_hash {
                    // Deleted locally while remote is unchanged: we never
                    // delete remote files in v1, but we also stop
                    // resurrecting the file locally — drop it from state.
                    Some(base) if *base == remote_hash => {
                        plan.skipped_remote_deletes.push(path.clone());
                    }
                    // New on remote, or deleted locally while remote moved
                    // on (remote wins): pull it.
                    _ => {
                        plan.pull.push((path.clone(), rb.clone()));
                        plan.files.insert(path.clone(), remote_hash);
                    }
                }
            }
            (None, Some(lb)) => {
                let local_hash = sha256_hex(lb);
                match base_hash {
                    // Deleted on remote while local is unchanged: delete it.
                    Some(base) if *base == local_hash => {
                        plan.delete_local.push(path.clone());
                    }
                    // New locally, or deleted remotely after local edits
                    // (upload restores it remotely): push it.
                    _ => {
                        plan.push.push(path.clone());
                        plan.files.insert(path.clone(), local_hash);
                    }
                }
            }
            (None, None) => {
                // Present only in state: deleted on both sides, forget it.
            }
        }
    }

    Ok(plan)
}

/// The remote snapshot a sync or preview works from: the project zip, minus
/// everything that never syncs.
fn fetch_remote_files(host: &str, cookie: &str, project_id: &str) -> Result<RemoteFiles, String> {
    let zip_client = http_client(120)?;
    let zip_bytes = download_project_zip(&zip_client, host, cookie, project_id)?;
    let entries = read_zip_entries(&zip_bytes)?;
    // The realtime tree owns entity ids, so the sync cannot delete these
    // itself. Return app-owned leftovers for the frontend to remove; collapse
    // PDF renders to their stable parent folder so cleanup takes one request.
    // Until deletion succeeds, filtering below also prevents a pull.
    let mut automatic_remote_deletes = entries
        .keys()
        .filter(|path| is_latex_save_error_path(path))
        .cloned()
        .collect::<Vec<_>>();
    if entries
        .keys()
        .any(|path| is_transient_pdf_render_path(path))
    {
        automatic_remote_deletes.push(TRANSIENT_PDF_RENDER_DIRECTORY.to_string());
    }
    automatic_remote_deletes.sort();
    let files = entries
        .into_iter()
        .filter(|(path, _)| !is_excluded(path))
        .collect();
    Ok(RemoteFiles {
        files,
        automatic_remote_deletes,
    })
}

/// The exact Overleaf origin this project belongs to.
///
/// A session cookie is valid only for the origin that issued it. Refuse the
/// request before constructing an HTTP client when the globally signed-in
/// account belongs to a different self-hosted Overleaf instance.
fn canonical_host(host: &str) -> String {
    let normalized = normalize_host(host);
    reqwest::Url::parse(&normalized)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| normalized.to_ascii_lowercase())
}

fn sync_host(state: &SyncState, session: &SessionFile) -> Result<String, String> {
    let session_host = canonical_host(&session.host);
    let linked_host = if state.host.trim().is_empty() {
        session_host.clone()
    } else {
        canonical_host(&state.host)
    };
    if linked_host != session_host {
        return Err(format!(
            "This project is linked to {linked_host}. Sign out and connect to that Overleaf host to continue."
        ));
    }
    Ok(linked_host)
}

fn sync_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M").to_string()
}

/// Record what Overleaf says this account may do, so syncing can respect it
/// even when the realtime channel is not connected.
pub fn set_permission(root: &Path, permission: &str) -> Result<(), String> {
    let mut state = load_state(root)?;
    if state.permission.as_deref() == Some(permission) {
        return Ok(());
    }
    state.permission = Some(permission.to_string());
    save_state(root, &state)
}

/// Record upload metadata available only from realtime `joinProject`.
///
/// This is persisted before the frontend treats the channel as live, so the
/// first automatic sync can upload new files without racing the socket join.
pub fn set_realtime_metadata(
    root: &Path,
    root_folder_id: &str,
    permission: &str,
) -> Result<(), String> {
    let root_folder_id = root_folder_id.trim();
    if root_folder_id.is_empty() {
        return Err("Overleaf's project join returned no root folder id.".to_string());
    }
    let mut state = load_state(root)?;
    if state.root_folder_id.as_deref() == Some(root_folder_id)
        && state.permission.as_deref() == Some(permission)
    {
        return Ok(());
    }
    state.root_folder_id = Some(root_folder_id.to_string());
    state.permission = Some(permission.to_string());
    save_state(root, &state)
}

/// Keep the merge-base tree aligned with the hashes that will be persisted.
///
/// Most successful paths now match the bytes on disk. A conflicted path is
/// the exception: the disk copy has markers while its recorded common
/// ancestor is Overleaf's snapshot. Live-held paths may match neither and
/// deliberately keep their previous base.
fn finalize_base_copies(
    root: &Path,
    previous_files: &BTreeMap<String, String>,
    next_files: &BTreeMap<String, String>,
    remote: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    for (path, expected_hash) in next_files {
        let disk = fs::read(local_disk_path(root, path)).ok();
        let agreed = disk
            .as_ref()
            .filter(|bytes| sha256_hex(bytes) == *expected_hash)
            .or_else(|| {
                remote
                    .get(path)
                    .filter(|bytes| sha256_hex(bytes) == *expected_hash)
            });
        if let Some(bytes) = agreed {
            write_base_copy(root, path, bytes)?;
        }
    }
    // Retain an old base while either side still has the file. A local edit
    // held back by read-only/unknown permission still needs that ancestor when
    // write access returns.
    for path in previous_files.keys() {
        if !next_files.contains_key(path)
            && !local_disk_path(root, path).exists()
            && !remote.contains_key(path)
        {
            remove_base_copy(root, path);
        }
    }
    Ok(())
}

pub fn sync(
    config_dir: &Path,
    root: &Path,
    live: &BTreeSet<String>,
) -> Result<OverleafSyncResult, String> {
    let session = load_session(config_dir)?;
    let mut state = load_state(root)?;
    if state.paused {
        return Err(PAUSED.to_string());
    }
    state.files.retain(|path, _| !is_excluded(path));
    let host = sync_host(&state, &session)?;

    let client = http_client(30)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;

    // Where Overleaf's history stood when we took our copy. Comparing it again
    // just before uploading tells us whether anyone edited in the meantime.
    let remote_version_before =
        fetch_remote_version(&client, &host, &session.cookie, &state.project_id);
    let RemoteFiles {
        files: remote,
        automatic_remote_deletes,
    } = fetch_remote_files(&host, &session.cookie, &state.project_id)?;
    let LocalFiles {
        files: local,
        oversized,
    } = read_local_files(root)?;

    let plan = plan_sync(root, &state, &remote, &local, live, &sync_stamp())?;

    let mut result = OverleafSyncResult {
        skipped_large: oversized,
        automatic_remote_deletes,
        ..Default::default()
    };
    let mut new_files = plan.files;
    // Merged bytes that exist on disk but not in the `local` snapshot taken at
    // the start of this sync; uploads read from here first.
    let mut merged_content: BTreeMap<String, Vec<u8>> = BTreeMap::new();

    for (path, bytes) in &plan.pull {
        write_local_file(root, path, bytes)?;
        result.pulled.push(path.clone());
    }
    for (path, bytes) in &plan.merge {
        write_local_file(root, path, bytes)?;
        merged_content.insert(path.clone(), bytes.clone());
        result.merged.push(path.clone());
    }
    for conflict in &plan.conflict {
        write_local_file(root, &conflict.local_copy, &conflict.local)?;
        write_local_file(root, &conflict.path, &conflict.resolved)?;
        result.conflicts.push(OverleafConflict {
            path: conflict.path.clone(),
            local_copy: conflict.local_copy.clone(),
            markers: conflict.markers,
        });
    }
    for path in &plan.delete_local {
        fs::remove_file(local_disk_path(root, path))
            .map_err(|e| format!("Could not delete {path}: {e}"))?;
        result.deleted_local.push(path.clone());
    }
    result.skipped_remote_deletes = plan.skipped_remote_deletes;

    // Plain pushes and merged files both go up; both lists are already in path
    // order, so the merge of the two is simply the sorted union.
    let mut to_push: Vec<String> = plan.push;
    to_push.extend(merged_content.keys().cloned());
    to_push.sort();

    // A reviewer or a viewer may read the project and not change it. Trying
    // anyway would be rejected file by file and reported as a sync failure,
    // when in fact everything that could be done has been: incoming work is
    // already on disk above, and the local edits simply stay here.
    if !permits_writing(state.permission.as_deref()) {
        for path in &to_push {
            new_files.remove(path);
        }
        finalize_base_copies(root, &state.files, &new_files, &remote)?;
        state.files = new_files;
        state.last_sync = Some(now_iso());
        state.remote_version = remote_version_before;
        save_state(root, &state)?;
        result.read_only = true;
        return Ok(result);
    }

    // Never hand Overleaf a file whose conflict markers are still unresolved —
    // that would publish the markers to everyone else in the project.
    let (to_push, held_back): (Vec<String>, Vec<String>) = to_push.into_iter().partition(|path| {
        let bytes = merged_content.get(path).or_else(|| local.get(path));
        !bytes.is_some_and(|value| {
            std::str::from_utf8(value).is_ok_and(|text| text.contains(CONFLICT_MARKER))
        })
    });
    for path in held_back {
        // Keep it out of state too, so it counts as a local edit and uploads
        // as soon as the markers are gone.
        new_files.remove(&path);
    }

    // Overleaf may have moved on between the copy we planned against and now —
    // someone typing in the web editor while we worked. Uploading then replaces
    // whatever they just wrote (and is what makes Overleaf warn them their
    // recent changes may have been overwritten). Stand down instead: dropping
    // these paths from state marks them as local edits again, so the next sync
    // merges their work first and sends the combined result.
    let to_push = if to_push.is_empty() {
        to_push
    } else if remote_version_before.is_some()
        && fetch_remote_version(&client, &host, &session.cookie, &state.project_id)
            != remote_version_before
    {
        for path in &to_push {
            new_files.remove(path);
        }
        Vec::new()
    } else {
        to_push
    };

    if !to_push.is_empty() {
        let root_folder_id = state.root_folder_id.as_deref().ok_or_else(|| {
            "Overleaf is still preparing file uploads. Try syncing again in a moment.".to_string()
        })?;
        let uploader = Uploader::new(
            &client,
            &host,
            &session.cookie,
            &csrf,
            &state.project_id,
            root_folder_id,
        );
        for path in &to_push {
            let bytes = merged_content
                .get(path)
                .or_else(|| local.get(path))
                .cloned()
                .ok_or_else(|| format!("{path} disappeared during sync"))?;
            uploader
                .upload(path, bytes)
                .map_err(|e| format!("Failed to upload \"{path}\" to Overleaf: {e}"))?;
        }
    }
    result.pushed = to_push;

    // Record what both sides now agree on: this is the common ancestor the
    // next sync merges against.
    finalize_base_copies(root, &state.files, &new_files, &remote)?;

    state.files = new_files;
    state.last_sync = Some(now_iso());
    // Remember where Overleaf's history stood, so the next probe can tell
    // "nothing changed" without downloading the project.
    // `remote_version_before` is the only history position known to precede
    // the downloaded snapshot. Never replace it with a newer value fetched at
    // the end: that newer value may include a collaborator's edit which is not
    // in the zip we materialized as the new base.
    //
    // Uploads advance history themselves, but Overleaf does not return the
    // resulting project version. Leave it unknown so the next probe performs
    // one verification sync instead of attributing an unverified latest
    // version to our upload.
    state.remote_version = if result.pushed.is_empty() {
        remote_version_before
    } else {
        None
    };
    save_state(root, &state)?;

    result.pulled.sort();
    result.pushed.sort();
    result.deleted_local.sort();
    result.skipped_remote_deletes.sort();
    result.conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

/// Text we can show in a diff view. Anything else is treated as binary: the UI
/// gets a marker instead of the bytes.
fn displayable_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

/// Build one preview row. A side that exists but cannot be rendered as text
/// makes the whole change binary, and then neither side is shipped to the UI.
fn preview_change(
    path: &str,
    kind: &str,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
) -> OverleafChange {
    let before_text = before.map(displayable_text);
    let after_text = after.map(displayable_text);
    let binary = matches!(before_text, Some(None)) || matches!(after_text, Some(None));
    OverleafChange {
        path: path.to_string(),
        kind: kind.to_string(),
        before: if binary { None } else { before_text.flatten() },
        after: if binary { None } else { after_text.flatten() },
        binary,
    }
}

/// Conflicts first — they are the only rows that need a decision — then the
/// rest in the order the user reads them.
fn change_kind_rank(kind: &str) -> u8 {
    match kind {
        "conflict" => 0,
        "incoming" => 1,
        "merge" => 2,
        "outgoing" => 3,
        "deleteLocal" => 4,
        _ => 5,
    }
}

/// Dry run: what `sync` would do to this project, without doing any of it.
///
/// Same fetch and the same classification as `sync`, so what the user approves
/// is exactly what runs. Nothing here writes to disk or uploads: the CSRF token
/// a real sync needs for uploads is not even fetched.
pub fn preview(
    config_dir: &Path,
    root: &Path,
    live: &BTreeSet<String>,
) -> Result<OverleafPreview, String> {
    let session = load_session(config_dir)?;
    let mut state = load_state(root)?;
    state.files.retain(|path, _| !is_excluded(path));
    let host = sync_host(&state, &session)?;

    let remote = fetch_remote_files(&host, &session.cookie, &state.project_id)?.files;
    let local = read_local_files(root)?.files;
    let plan = plan_sync(root, &state, &remote, &local, live, &sync_stamp())?;

    let mut changes: Vec<OverleafChange> = Vec::new();
    for (path, bytes) in &plan.pull {
        changes.push(preview_change(
            path,
            "incoming",
            local.get(path).map(Vec::as_slice),
            Some(bytes),
        ));
    }
    for path in &plan.push {
        // The base copy is the last version Overleaf saw, so it is the honest
        // "before" for an upload — when we kept one.
        let base = read_base_copy(root, path);
        changes.push(preview_change(
            path,
            "outgoing",
            base.as_deref().map(str::as_bytes),
            local.get(path).map(Vec::as_slice),
        ));
    }
    for (path, bytes) in &plan.merge {
        changes.push(preview_change(
            path,
            "merge",
            local.get(path).map(Vec::as_slice),
            Some(bytes),
        ));
    }
    for conflict in &plan.conflict {
        changes.push(preview_change(
            &conflict.path,
            "conflict",
            Some(&conflict.local),
            Some(&conflict.resolved),
        ));
    }
    for path in &plan.delete_local {
        changes.push(preview_change(
            path,
            "deleteLocal",
            local.get(path).map(Vec::as_slice),
            None,
        ));
    }
    for path in &plan.skipped_remote_deletes {
        changes.push(preview_change(path, "skippedRemoteDelete", None, None));
    }
    changes.sort_by(|a, b| {
        change_kind_rank(&a.kind)
            .cmp(&change_kind_rank(&b.kind))
            .then_with(|| a.path.cmp(&b.path))
    });

    let client = http_client(30)?;
    let remote_version = fetch_remote_version(&client, &host, &session.cookie, &state.project_id);
    Ok(OverleafPreview {
        changes,
        remote_version,
    })
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    const CSRF: &str = "csrf-fixture-token";

    /// Turning suggestions on for this account, against the real service.
    ///
    /// This is the whole path behind the toolbar's Editing/Suggesting button,
    /// and it had two separate ways of doing nothing at all: a session stored
    /// before we recorded the account id could not name whose setting to
    /// change, and the button threw the resulting refusal away.
    #[test]
    #[ignore = "changes a project setting on overleaf.com"]
    fn turns_suggestions_on_for_this_account() {
        let root = std::path::PathBuf::from(std::env::var("OVERLEAF_E2E_PROJECT").unwrap());
        let config = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/app.leo1oel.researchwriter");

        // Whatever the session file holds, an account id has to come back.
        let (_, _, _, user_id) = realtime_config(&config, &root).expect("a linked project");
        let user_id = user_id.expect("our own Overleaf account id");
        println!("account id: {user_id}");
        assert_eq!(
            user_id.len(),
            24,
            "an Overleaf account id is a Mongo ObjectId"
        );

        for on in [true, false] {
            set_track_changes(&config, &root, serde_json::json!({ &user_id: on }))
                .unwrap_or_else(|error| panic!("turning suggestions {on}: {error}"));
            println!("suggestions set to {on}");
        }
    }

    /// The real `/ranges` payload, taken verbatim from overleaf.com with one
    /// comment in the project: every document is listed whether or not it has
    /// anything in it, and the comment's `op` is the same `{p, c, t}` shape
    /// the editing channel sends.
    #[test]
    fn comment_anchors_name_the_document_each_thread_lives_in() {
        let body = serde_json::json!([
            { "id": "6a5acedf2b1182598e0ae369", "ranges": {} },
            { "id": "6a5acedf2b1182598e0ae36a", "ranges": { "comments": [] } },
            { "id": "6a5acedf2b1182598e0ae36b", "ranges": { "comments": [{
                "id": "6a18a500005eedc0ffee1234",
                "metadata": { "ts": "2026-07-25T01:55:50.719Z", "user_id": "65103fad2765" },
                "op": { "c": "\\documentcla", "p": 0, "t": "6a18a500005eedc0ffee1234" },
            }] } },
        ]);
        let anchors = parse_comment_anchors(&body);
        assert_eq!(
            anchors,
            vec![OverleafCommentAnchor {
                thread_id: "6a18a500005eedc0ffee1234".to_string(),
                doc_id: "6a5acedf2b1182598e0ae36b".to_string(),
                position: 0,
                quote: "\\documentcla".to_string(),
            }]
        );

        // The quote travels packed the same way document text does, so a
        // comment on non-ASCII text has to be unpacked or it reads as mojibake.
        let packed: String = "第三节".as_bytes().iter().map(|b| *b as char).collect();
        let chinese = serde_json::json!([{ "id": "d1", "ranges": { "comments": [{
            "op": { "c": packed, "p": 12, "t": "t1" },
        }] } }]);
        assert_eq!(parse_comment_anchors(&chinese)[0].quote, "第三节");
    }

    /// Both halves of a real `/updates` entry, taken verbatim from
    /// overleaf.com: an upload leaves `pathnames` empty and records what it
    /// did in `project_ops`, so a timeline reading only `pathnames` shows it
    /// as an update that touched nothing.
    #[test]
    fn history_update_paths_include_file_operations() {
        let doc_edit = serde_json::json!({
            "fromV": 65, "toV": 67, "pathnames": ["neurips_2026.tex"], "labels": [],
        });
        assert_eq!(
            update_paths(&doc_edit),
            vec!["neurips_2026.tex".to_string()]
        );

        let upload = serde_json::json!({
            "fromV": 43, "toV": 45, "pathnames": [], "labels": [],
            "project_ops": [
                { "atV": 44, "add": { "pathname": "figures/loss.png" } },
                { "atV": 43, "remove": { "pathname": "figures/old.png" } },
            ],
        });
        assert_eq!(
            update_paths(&upload),
            vec![
                "figures/loss.png".to_string(),
                "figures/old.png".to_string()
            ],
        );

        // A rename is listed under where the file ended up, and a path that
        // appears in both fields is only listed once.
        let mixed = serde_json::json!({
            "fromV": 1, "toV": 3, "pathnames": ["main.tex"], "labels": [],
            "project_ops": [
                { "atV": 2, "rename": { "pathname": "draft.tex", "newPathname": "final.tex" } },
                { "atV": 3, "add": { "pathname": "main.tex" } },
            ],
        });
        assert_eq!(
            update_paths(&mixed),
            vec!["main.tex".to_string(), "final.tex".to_string()],
        );
    }

    #[test]
    fn cookie_domain_matching_covers_overleaf_subdomains() {
        // The v0.1.88 sign-in hang: Overleaf scopes its session cookie to
        // `.overleaf.com` while the window URL is `www.overleaf.com`, and an
        // equality check drops it.
        assert!(cookie_domain_matches(".overleaf.com", "www.overleaf.com"));
        assert!(cookie_domain_matches("overleaf.com", "www.overleaf.com"));
        assert!(cookie_domain_matches(
            "www.overleaf.com",
            "www.overleaf.com"
        ));
        assert!(cookie_domain_matches("Overleaf.com", "WWW.Overleaf.com"));
        assert!(cookie_domain_matches(
            "latex.example.edu",
            "latex.example.edu"
        ));
        // Must not leak cookies across unrelated sites.
        assert!(!cookie_domain_matches("evil.com", "www.overleaf.com"));
        assert!(!cookie_domain_matches(
            "notoverleaf.com",
            "www.overleaf.com"
        ));
        assert!(!cookie_domain_matches("www.overleaf.com", "overleaf.com"));
        assert!(!cookie_domain_matches("", "www.overleaf.com"));
    }

    #[test]
    fn session_cookie_detection_accepts_cloud_and_self_hosted_names() {
        assert!(has_session_cookie(&[
            "GCLB".to_string(),
            "overleaf_session2".to_string()
        ]));
        assert!(has_session_cookie(&["sharelatex.sid".to_string()]));
        assert!(!has_session_cookie(&[
            "GCLB".to_string(),
            "_ga".to_string()
        ]));
    }

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        url: String,
        csrf_header: Option<String>,
        cookie_header: Option<String>,
        body: Vec<u8>,
    }

    impl RecordedRequest {
        fn body_text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }
    }

    struct MockServer {
        base: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
    }

    impl MockServer {
        fn recorded(&self) -> Vec<RecordedRequest> {
            self.requests.lock().unwrap().clone()
        }

        fn uploads(&self) -> Vec<RecordedRequest> {
            self.recorded()
                .into_iter()
                .filter(|r| r.method == "POST" && r.url.contains("/upload"))
                .collect()
        }
    }

    fn header_value(request: &tiny_http::Request, name: &'static str) -> Option<String> {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_string())
    }

    fn start_server(html: String, zip_bytes: Vec<u8>) -> MockServer {
        start_server_versioned(html, zip_bytes, Vec::new())
    }

    /// `versions` is served one per `/updates` request (the last value repeats).
    /// An empty list answers 404, matching an instance without history.
    fn start_server_versioned(html: String, zip_bytes: Vec<u8>, versions: Vec<i64>) -> MockServer {
        start_server_versioned_with_upload_failure(html, zip_bytes, versions, None)
    }

    fn start_server_versioned_with_upload_failure(
        html: String,
        zip_bytes: Vec<u8>,
        versions: Vec<i64>,
        fail_upload_at: Option<usize>,
    ) -> MockServer {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind mock server");
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => panic!("expected an IP listener"),
        };
        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let version_queue: Arc<Mutex<std::collections::VecDeque<i64>>> =
            Arc::new(Mutex::new(versions.into_iter().collect()));
        std::thread::spawn(move || {
            let mut upload_count = 0usize;
            for mut request in server.incoming_requests() {
                let mut body = Vec::new();
                let _ = request.as_reader().read_to_end(&mut body);
                let method = request.method().as_str().to_string();
                let url = request.url().to_string();
                recorded.lock().unwrap().push(RecordedRequest {
                    method: method.clone(),
                    url: url.clone(),
                    csrf_header: header_value(&request, "X-Csrf-Token"),
                    cookie_header: header_value(&request, "Cookie"),
                    body,
                });
                let path = url.split('?').next().unwrap_or("").to_string();
                let html_header =
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap();
                let json_header =
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap();
                let outcome = if method == "GET" && path.ends_with("/updates") {
                    let mut queue = version_queue.lock().unwrap();
                    match queue.front().copied() {
                        None => request.respond(tiny_http::Response::empty(404)),
                        Some(version) => {
                            if queue.len() > 1 {
                                queue.pop_front();
                            }
                            request.respond(
                                tiny_http::Response::from_string(format!(
                                    "{{\"updates\":[{{\"fromV\":0,\"toV\":{version}}}]}}"
                                ))
                                .with_header(json_header),
                            )
                        }
                    }
                } else if method == "GET" && path == "/project" {
                    request.respond(
                        tiny_http::Response::from_string(html.clone()).with_header(html_header),
                    )
                } else if method == "GET" && path.ends_with("/download/zip") {
                    request.respond(tiny_http::Response::from_data(zip_bytes.clone()))
                } else if method == "POST" && path == "/project/new/upload" {
                    request.respond(
                        tiny_http::Response::from_string(
                            "{\"success\":true,\"project_id\":\"published-project-1\"}",
                        )
                        .with_header(json_header),
                    )
                } else if method == "POST" && path.ends_with("/upload") {
                    upload_count += 1;
                    if fail_upload_at == Some(upload_count) {
                        request.respond(
                            tiny_http::Response::from_string("upload failed").with_status_code(500),
                        )
                    } else {
                        request.respond(
                            tiny_http::Response::from_string(
                                "{\"success\":true,\"entity_id\":\"e1\",\"entity_type\":\"file\"}",
                            )
                            .with_header(json_header),
                        )
                    }
                } else if method == "POST" && path.ends_with("/folder") {
                    request.respond(
                        tiny_http::Response::from_string(
                            "{\"_id\":\"anchor-folder-1\",\"name\":\"tmp\",\"folders\":[],\"docs\":[],\"fileRefs\":[]}",
                        )
                        .with_header(json_header),
                    )
                } else if method == "DELETE" {
                    request.respond(tiny_http::Response::empty(204))
                } else {
                    request.respond(tiny_http::Response::empty(404))
                };
                let _ = outcome;
            }
        });
        MockServer {
            base: format!("http://127.0.0.1:{port}"),
            requests,
        }
    }

    fn attr(json: &str) -> String {
        html_escape::encode_double_quoted_attribute(json).into_owned()
    }

    fn projects_page_html() -> String {
        let projects = serde_json::json!({
            "totalSize": 3,
            "projects": [
                {
                    "id": "proj-old",
                    "name": "Old Paper",
                    "lastUpdated": "2026-01-02T10:00:00.000Z",
                    "accessLevel": "owner",
                    "archived": false,
                    "trashed": false,
                    "owner": { "email": "researcher@example.edu", "firstName": "Robin", "lastName": "Researcher" }
                },
                {
                    "id": "proj-new",
                    "name": "New Paper",
                    "lastUpdated": "2026-07-01T10:00:00.000Z",
                    "accessLevel": "readAndWrite",
                    "archived": false,
                    "trashed": false,
                    "owner": { "email": "advisor@example.edu", "firstName": "Ada", "lastName": "Advisor" }
                },
                {
                    "id": "proj-archived",
                    "name": "Archived Paper",
                    "lastUpdated": "2026-03-01T10:00:00.000Z",
                    "accessLevel": "owner",
                    "archived": true,
                    "trashed": false,
                    "owner": { "email": "researcher@example.edu", "firstName": "Robin", "lastName": "Researcher" }
                }
            ]
        });
        let user = serde_json::json!({
            "id": "u1",
            "email": "researcher@example.edu",
            "first_name": "Robin",
            "last_name": "Researcher"
        });
        format!(
            "<html><head>\
             <meta name=\"ol-csrfToken\" content=\"{CSRF}\">\
             <meta name=\"ol-user\" data-type=\"json\" content=\"{}\">\
             <meta name=\"ol-prefetchedProjectsBlob\" data-type=\"json\" content=\"{}\">\
             </head><body></body></html>",
            attr(&user.to_string()),
            attr(&projects.to_string()),
        )
    }

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Zip with a `../evil.tex` entry. The writer refuses `..` in names, so
    /// build a same-length placeholder and patch the raw bytes (local header
    /// and central directory both carry the name).
    fn build_malicious_zip() -> Vec<u8> {
        let bytes = build_zip(&[("xx/evil.tex", b"gotcha")]);
        let needle = b"xx/evil.tex";
        let patched: Vec<u8> = {
            let mut out = bytes.clone();
            let mut index = 0;
            while index + needle.len() <= out.len() {
                if &out[index..index + needle.len()] == needle {
                    out[index] = b'.';
                    out[index + 1] = b'.';
                }
                index += 1;
            }
            out
        };
        patched
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "overleaf-rs-test-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pausing keeps what a resumed sync needs to merge.
    ///
    /// The whole reason to pause rather than unlink: the file table is the
    /// common ancestor, and without it reconnecting can only offer a conflict
    /// copy of every file that differs.
    #[test]
    fn pausing_keeps_the_link_and_its_common_ancestor() {
        let root = temp_dir("pause");
        let state = SyncState {
            host: "https://www.overleaf.com".to_string(),
            project_id: "proj-1".to_string(),
            project_name: "Attention Paper".to_string(),
            root_folder_id: Some("root-folder-1".to_string()),
            last_sync: Some("2026-07-25T00:00:00Z".to_string()),
            remote_version: Some(42),
            permission: Some("readAndWrite".to_string()),
            files: BTreeMap::from([("main.tex".to_string(), "abc123".to_string())]),
            paused: false,
        };
        save_state(&root, &state).unwrap();
        write_base_copy(&root, "main.tex", b"the copy from the last sync\n").unwrap();

        set_paused(&root, true).unwrap();
        let link = project_link(&root).unwrap().expect("still linked");
        assert!(link.paused);
        assert_eq!(link.project_id, "proj-1");
        let paused_state = load_state(&root).unwrap();
        assert_eq!(
            paused_state.files.get("main.tex").map(String::as_str),
            Some("abc123")
        );
        assert_eq!(paused_state.remote_version, Some(42));
        assert_eq!(
            read_base_copy(&root, "main.tex").as_deref(),
            Some("the copy from the last sync\n"),
        );

        set_paused(&root, false).unwrap();
        assert!(!project_link(&root).unwrap().unwrap().paused);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn realtime_metadata_records_the_root_folder_without_changing_the_sync_base() {
        let root = temp_dir("realtime-metadata");
        seed_linked_project(
            &root,
            "https://www.overleaf.com",
            &[("main.tex", b"body")],
            &[("main.tex", b"body")],
        );
        let before = load_state(&root).unwrap();

        set_realtime_metadata(&root, "new-root-folder", "owner").unwrap();

        let after = load_state(&root).unwrap();
        assert_eq!(after.root_folder_id.as_deref(), Some("new-root-folder"));
        assert_eq!(after.permission.as_deref(), Some("owner"));
        assert_eq!(after.files, before.files);
        assert_eq!(after.remote_version, before.remote_version);
        let _ = fs::remove_dir_all(root);
    }

    /// Stop syncing, edit, then open the project from Overleaf again.
    ///
    /// Unlinking deletes the state file, so the folder is no longer
    /// recognisable as that project — before this, opening it again quietly
    /// downloaded a second copy into `Name (2)` and left the edits in a folder
    /// nothing pointed at.
    #[test]
    fn a_folder_left_by_unlinking_is_offered_for_relinking_not_duplicated() {
        let parent = temp_dir("adopt");
        let config = temp_dir("adopt-config");
        write_session_file(&config, "https://www.overleaf.com");
        let root = parent.join("Attention Paper");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("main.tex"), b"edited after unlinking\n").unwrap();

        // Files present, no link: the state Stop syncing leaves behind.
        let target = clone_target("proj-1", "Attention Paper", &parent).unwrap();
        assert_eq!(target.kind, "occupied");
        assert_eq!(target.folder, "Attention Paper");

        let adopted = adopt_project(
            &config,
            "proj-1",
            "Attention Paper",
            &root,
            Some("readAndWrite"),
        )
        .unwrap();
        assert_eq!(adopted, root);
        // The edit is untouched — adopting links, it does not download over it.
        assert_eq!(
            fs::read_to_string(root.join("main.tex")).unwrap(),
            "edited after unlinking\n"
        );
        // No common ancestor is claimed, which is what makes the first sync
        // treat a file that differs as a conflict instead of picking a winner.
        let state = load_state(&root).unwrap();
        assert_eq!(state.project_id, "proj-1");
        assert!(state.files.is_empty());
        assert_eq!(state.remote_version, None);
        assert_eq!(state.last_sync, None);

        // Now that it is linked, opening it again just opens it.
        assert_eq!(
            clone_target("proj-1", "Attention Paper", &parent)
                .unwrap()
                .kind,
            "open"
        );
        // A different project of the same name is still a separate folder.
        assert_eq!(
            clone_target("proj-2", "Attention Paper", &parent)
                .unwrap()
                .kind,
            "occupied"
        );

        let _ = fs::remove_dir_all(parent);
        let _ = fs::remove_dir_all(config);
    }

    #[test]
    fn an_empty_or_absent_folder_is_a_plain_download() {
        let parent = temp_dir("fresh-target");
        assert_eq!(
            clone_target("proj-1", "Attention Paper", &parent)
                .unwrap()
                .kind,
            "fresh"
        );
        fs::create_dir_all(parent.join("Attention Paper")).unwrap();
        assert_eq!(
            clone_target("proj-1", "Attention Paper", &parent)
                .unwrap()
                .kind,
            "fresh"
        );
        let _ = fs::remove_dir_all(parent);
    }

    fn write_session_file(config_dir: &Path, host: &str) {
        save_session(
            config_dir,
            &SessionFile {
                host: host.to_string(),
                cookie: "overleaf_session2=fixture-cookie".to_string(),
                email: Some("researcher@example.edu".to_string()),
                name: Some("Robin Researcher".to_string()),
                user_id: Some("user-1".to_string()),
            },
        )
        .unwrap();
    }

    /// A linked local project: files on disk plus a state file whose hashes
    /// describe the given base contents.
    fn seed_linked_project(
        root: &Path,
        host: &str,
        local_files: &[(&str, &[u8])],
        base_files: &[(&str, &[u8])],
    ) {
        for (rel, data) in local_files {
            let path = local_disk_path(root, rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        }
        // A real clone records both the hash and a pristine copy of every text
        // file, which is what later merges use as their common ancestor.
        for (rel, data) in base_files {
            write_base_copy(root, rel, data).unwrap();
        }
        let files = base_files
            .iter()
            .map(|(rel, data)| (rel.to_string(), sha256_hex(data)))
            .collect();
        save_state(
            root,
            &SyncState {
                host: host.to_string(),
                project_id: "proj-1".to_string(),
                project_name: "Test Project".to_string(),
                root_folder_id: Some("root-folder-1".to_string()),
                last_sync: Some("2026-07-01T00:00:00Z".to_string()),
                remote_version: None,
                permission: Some("readAndWrite".to_string()),
                files,
                paused: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn project_requests_reject_a_session_from_another_overleaf_host() {
        let config = temp_dir("host-mismatch-config");
        let root = temp_dir("host-mismatch-project");
        write_session_file(&config, "https://overleaf-b.example");
        seed_linked_project(
            &root,
            "https://overleaf-a.example",
            &[("main.tex", b"linked project")],
            &[("main.tex", b"linked project")],
        );

        let error =
            realtime_config(&config, &root).expect_err("a foreign session must be rejected");
        assert!(error.contains("https://overleaf-a.example"));
        assert!(error.contains("Sign out and connect"));

        let _ = fs::remove_dir_all(config);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn linked_host_matching_uses_url_origins() {
        let session = SessionFile {
            host: "HTTPS://OVERLEAF.EXAMPLE:443/".to_string(),
            cookie: "overleaf_session2=fixture-cookie".to_string(),
            email: None,
            name: None,
            user_id: None,
        };
        let state = SyncState {
            host: "https://overleaf.example/project-path".to_string(),
            project_id: "proj-1".to_string(),
            project_name: "Test Project".to_string(),
            root_folder_id: None,
            last_sync: None,
            remote_version: None,
            permission: None,
            files: BTreeMap::new(),
            paused: false,
        };

        assert_eq!(
            sync_host(&state, &session).unwrap(),
            "https://overleaf.example"
        );
    }

    fn run_sync(
        server: &MockServer,
        local: &[(&str, &[u8])],
        base: &[(&str, &[u8])],
    ) -> (PathBuf, OverleafSyncResult) {
        let config = temp_dir("config");
        let root = temp_dir("project");
        write_session_file(&config, &server.base);
        seed_linked_project(&root, &server.base, local, base);
        let result = sync(&config, &root, &BTreeSet::new()).unwrap();
        (root, result)
    }

    /// A linked project plus its session, ready for a sync or a preview.
    fn seed_preview_project(
        server: &MockServer,
        local: &[(&str, &[u8])],
        base: &[(&str, &[u8])],
    ) -> (PathBuf, PathBuf) {
        let config = temp_dir("preview-config");
        let root = temp_dir("preview-project");
        write_session_file(&config, &server.base);
        seed_linked_project(&root, &server.base, local, base);
        (config, root)
    }

    fn run_preview(
        server: &MockServer,
        local: &[(&str, &[u8])],
        base: &[(&str, &[u8])],
    ) -> (PathBuf, OverleafPreview) {
        let (config, root) = seed_preview_project(server, local, base);
        let result = preview(&config, &root, &BTreeSet::new()).unwrap();
        (root, result)
    }

    fn change_for<'a>(preview: &'a OverleafPreview, path: &str) -> &'a OverleafChange {
        preview
            .changes
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("no preview change for {path}"))
    }

    fn read_local(root: &Path, rel: &str) -> Option<Vec<u8>> {
        fs::read(local_disk_path(root, rel)).ok()
    }

    fn state_files(root: &Path) -> BTreeMap<String, String> {
        load_state(root).unwrap().files
    }

    fn state_remote_version(root: &Path) -> Option<i64> {
        load_state(root).unwrap().remote_version
    }

    #[test]
    fn base_copy_finalization_uses_the_hash_agreement_and_retains_held_ancestors() {
        let root = temp_dir("base-finalization");
        fs::write(local_disk_path(&root, "pulled.tex"), b"new remote").unwrap();
        fs::write(
            local_disk_path(&root, "conflict.tex"),
            format!("{CONFLICT_MARKER} local\n=======\nremote\n>>>>>>> remote\n"),
        )
        .unwrap();
        fs::write(local_disk_path(&root, "held.tex"), b"local edit").unwrap();
        write_base_copy(&root, "pulled.tex", b"old").unwrap();
        write_base_copy(&root, "conflict.tex", b"old").unwrap();
        write_base_copy(&root, "held.tex", b"old ancestor").unwrap();
        let previous = BTreeMap::from([
            ("pulled.tex".to_string(), sha256_hex(b"old")),
            ("conflict.tex".to_string(), sha256_hex(b"old")),
            ("held.tex".to_string(), sha256_hex(b"old ancestor")),
        ]);
        let next = BTreeMap::from([
            ("pulled.tex".to_string(), sha256_hex(b"new remote")),
            ("conflict.tex".to_string(), sha256_hex(b"remote side")),
        ]);
        let remote = BTreeMap::from([
            ("pulled.tex".to_string(), b"new remote".to_vec()),
            ("conflict.tex".to_string(), b"remote side".to_vec()),
            ("held.tex".to_string(), b"old ancestor".to_vec()),
        ]);

        finalize_base_copies(&root, &previous, &next, &remote).unwrap();

        assert_eq!(
            read_base_copy(&root, "pulled.tex").as_deref(),
            Some("new remote")
        );
        assert_eq!(
            read_base_copy(&root, "conflict.tex").as_deref(),
            Some("remote side")
        );
        assert_eq!(
            read_base_copy(&root, "held.tex").as_deref(),
            Some("old ancestor")
        );
    }

    // ---- session + project list ------------------------------------------

    #[test]
    fn overleaf_session_status_defaults_when_absent() {
        let config = temp_dir("status");
        let status = session_status(&config).unwrap();
        assert!(!status.connected);
        assert_eq!(status.host, DEFAULT_HOST);
        assert!(status.email.is_none());
    }

    #[test]
    fn session_file_is_private_and_round_trips_without_a_partial_file() {
        let config = temp_dir("private-session");
        write_session_file(&config, "https://www.overleaf.com");

        let restored = load_session(&config).unwrap();
        assert_eq!(restored.cookie, "overleaf_session2=fixture-cookie");
        assert!(!config.join(format!(".{SESSION_FILE}.tmp")).exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(session_path(&config))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }

        let _ = fs::remove_dir_all(config);
    }

    #[test]
    fn overleaf_store_session_cookie_validates_and_persists() {
        let server = start_server(projects_page_html(), Vec::new());
        let config = temp_dir("store-session");
        let status = store_session_cookie(
            &config,
            &server.base,
            "overleaf_session2=abc123; GCLB=balancer",
        )
        .unwrap();
        assert!(status.connected);
        assert_eq!(status.email.as_deref(), Some("researcher@example.edu"));
        assert_eq!(status.name.as_deref(), Some("Robin Researcher"));
        assert_eq!(status.host, server.base);
        assert!(session_path(&config).exists());

        // The stored session round-trips through session_status.
        let restored = session_status(&config).unwrap();
        assert!(restored.connected);
        assert_eq!(restored.email.as_deref(), Some("researcher@example.edu"));

        // The validation request carried the full cookie header.
        let recorded = server.recorded();
        assert_eq!(
            recorded[0].cookie_header.as_deref(),
            Some("overleaf_session2=abc123; GCLB=balancer")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(session_path(&config))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }

        disconnect(&config).unwrap();
        assert!(!session_status(&config).unwrap().connected);
        disconnect(&config).unwrap(); // idempotent
    }

    #[test]
    fn overleaf_list_projects_parses_and_sorts() {
        let server = start_server(projects_page_html(), Vec::new());
        let config = temp_dir("list");
        write_session_file(&config, &server.base);
        let projects = list_projects(&config).unwrap();
        assert_eq!(projects.len(), 3);
        // Sorted by lastUpdated descending.
        assert_eq!(projects[0].id, "proj-new");
        assert_eq!(projects[1].id, "proj-archived");
        assert_eq!(projects[2].id, "proj-old");
        assert_eq!(projects[0].name, "New Paper");
        assert_eq!(projects[0].access_level.as_deref(), Some("readAndWrite"));
        assert_eq!(
            projects[0].owner_email.as_deref(),
            Some("advisor@example.edu")
        );
        assert_eq!(projects[0].owner_name.as_deref(), Some("Ada Advisor"));
        assert!(projects[1].archived);
        assert!(!projects[1].trashed);
        assert!(!projects[0].archived);
        assert_eq!(
            projects[2].last_updated.as_deref(),
            Some("2026-01-02T10:00:00.000Z")
        );
    }

    #[test]
    fn publishes_local_project_and_records_the_uploaded_snapshot_as_its_base() {
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", b"local body".as_slice())]),
        );
        let config = temp_dir("publish-config");
        let root = temp_dir("publish-project");
        write_session_file(&config, &server.base);
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::create_dir_all(root.join(".research")).unwrap();
        fs::write(root.join("main.tex"), b"local body").unwrap();
        fs::write(root.join("figures/plot.pdf"), b"%PDF figure").unwrap();
        fs::write(root.join("paper.pdf"), b"%PDF build output").unwrap();
        fs::write(root.join(".research/private.json"), b"secret").unwrap();

        let link = publish_project(&config, &root, "Local Paper").unwrap();

        assert_eq!(link.project_id, "published-project-1");
        assert_eq!(link.project_name, "Local Paper");
        assert_eq!(link.host, server.base);
        let request = server
            .recorded()
            .into_iter()
            .find(|request| request.method == "POST" && request.url == "/project/new/upload")
            .expect("project upload request");
        assert_eq!(request.csrf_header.as_deref(), Some(CSRF));
        assert_eq!(
            request.cookie_header.as_deref(),
            Some("overleaf_session2=fixture-cookie")
        );
        let body = request.body_text();
        assert!(body.contains("name=\"name\""));
        assert!(body.contains("Local Paper.zip"));
        assert!(body.contains("name=\"qqfile\""));
        assert!(body.contains("main.tex"));
        assert!(body.contains("figures/plot.pdf"));
        assert!(!body.contains("paper.pdf"));
        assert!(!body.contains("private.json"));
        assert!(!body.contains("secret"));

        let state = load_state(&root).unwrap();
        assert_eq!(state.permission.as_deref(), Some("owner"));
        assert_eq!(state.files.len(), 2);
        assert_eq!(
            state.files.get("main.tex").map(String::as_str),
            Some(sha256_hex(b"local body").as_str())
        );
        assert_eq!(
            read_base_copy(&root, "main.tex").as_deref(),
            Some("local body")
        );
        assert!(read_base_copy(&root, "figures/plot.pdf").is_none());
    }

    // ---- clone -------------------------------------------------------------

    #[test]
    fn overleaf_clone_project_extracts_and_writes_state() {
        let zip = build_zip(&[
            ("main.tex", b"\\documentclass{article}".as_slice()),
            ("refs.bib", b"@article{a}".as_slice()),
            ("figures/fig1.pdf", b"%PDF-1.5 fake".as_slice()),
            ("nested/chapter.tex", b"\\section{One}".as_slice()),
            (
                "lambda_gpu_proposal.bbl-SAVE-ERROR",
                b"failed bibliography output".as_slice(),
            ),
            (
                "tmp/pdfs/full-appendix/page-01.png",
                b"temporary preview".as_slice(),
            ),
        ]);
        let server = start_server(projects_page_html(), zip);
        let config = temp_dir("clone-config");
        let parent = temp_dir("clone-parent");
        write_session_file(&config, &server.base);

        let root = clone_project(&config, "proj-1", "Test: Project", &parent, None).unwrap();
        assert_eq!(root, parent.join("Test- Project"));
        assert_eq!(
            read_local(&root, "main.tex").unwrap(),
            b"\\documentclass{article}"
        );
        assert_eq!(
            read_local(&root, "nested/chapter.tex").unwrap(),
            b"\\section{One}"
        );
        assert_eq!(
            read_local(&root, "figures/fig1.pdf").unwrap(),
            b"%PDF-1.5 fake"
        );
        assert!(read_local(&root, "lambda_gpu_proposal.bbl-SAVE-ERROR").is_none());
        assert!(read_local(&root, "tmp/pdfs/full-appendix/page-01.png").is_none());

        let state = load_state(&root).unwrap();
        assert_eq!(state.project_id, "proj-1");
        assert_eq!(state.project_name, "Test: Project");
        assert_eq!(state.host, server.base);
        assert_eq!(state.files.len(), 4);
        assert_eq!(
            state.files.get("refs.bib").map(String::as_str),
            Some(sha256_hex(b"@article{a}").as_str())
        );

        let link = project_link(&root).unwrap().unwrap();
        assert_eq!(link.project_id, "proj-1");
        assert_eq!(link.project_name, "Test: Project");

        // Opening the same project again opens the copy that is already
        // there, rather than refusing and asking someone to go and find it.
        let again = clone_project(&config, "proj-1", "Test: Project", &parent, None).unwrap();
        assert_eq!(again, root);

        // A different project that happens to share a name lands beside it
        // instead of being blocked by it.
        let other = clone_project(&config, "proj-2", "Test: Project", &parent, None).unwrap();
        assert_ne!(other, root);
        assert_eq!(load_state(&other).unwrap().project_id, "proj-2");
        // And opening *that* one again finds it under its numbered name.
        let other_again = clone_project(&config, "proj-2", "Test: Project", &parent, None).unwrap();
        assert_eq!(other_again, other);
    }

    #[test]
    fn reopening_a_clone_clears_a_stale_writable_permission_when_role_is_unknown() {
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", b"body".as_slice())]),
        );
        let config = temp_dir("clone-permission-config");
        let parent = temp_dir("clone-permission-parent");
        write_session_file(&config, &server.base);
        let root =
            clone_project(&config, "proj-1", "Permission Test", &parent, Some("owner")).unwrap();
        assert_eq!(
            load_state(&root).unwrap().permission.as_deref(),
            Some("owner")
        );

        let reopened = clone_project(&config, "proj-1", "Permission Test", &parent, None).unwrap();

        assert_eq!(reopened, root);
        assert_eq!(load_state(&root).unwrap().permission, None);
    }

    /// Opening a project that is already downloaded opens it.
    ///
    /// The commonest thing anyone does in the Overleaf picker is reach for a
    /// project they have opened before; that used to be the one case that
    /// failed, with an instruction to go and find the folder by hand.
    #[test]
    #[ignore = "reads overleaf.com with the signed-in session"]
    fn opening_an_already_downloaded_project_opens_it() {
        let existing = std::path::PathBuf::from(std::env::var("OVERLEAF_E2E_PROJECT").unwrap());
        let config = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/app.leo1oel.researchwriter");
        let state = load_state(&existing).expect("the project is linked");
        let parent = existing.parent().expect("a parent folder");

        let opened = clone_project(
            &config,
            &state.project_id,
            &state.project_name,
            parent,
            Some("readAndWrite"),
        )
        .expect("opening an already-downloaded project should succeed");
        assert_eq!(opened, existing, "it should be the copy already on disk");
        println!("reopened {}", opened.display());
    }

    #[test]
    fn overleaf_clone_project_rejects_zip_slip() {
        let server = start_server(projects_page_html(), build_malicious_zip());
        let config = temp_dir("slip-config");
        let parent = temp_dir("slip-parent");
        write_session_file(&config, &server.base);
        let outcome = clone_project(&config, "proj-1", "Evil", &parent, None);
        let message = outcome.unwrap_err();
        assert!(message.contains("unsafe path"), "got: {message}");
        assert!(!parent.join("evil.tex").exists());
        assert!(!parent.parent().unwrap().join("evil.tex").exists());
    }

    // ---- sync classification -----------------------------------------------

    #[test]
    fn overleaf_sync_pulls_remote_only_change() {
        let base = b"old body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", b"new remote body".as_slice())]),
        );
        let (root, result) = run_sync(&server, &[("main.tex", base)], &[("main.tex", base)]);
        assert_eq!(result.pulled, vec!["main.tex"]);
        assert!(result.pushed.is_empty());
        assert!(result.conflicts.is_empty());
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"new remote body");
        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(b"new remote body")
        );
        assert!(server.uploads().is_empty());
    }

    #[test]
    fn overleaf_sync_pushes_local_only_change() {
        let base = b"shared body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, result) = run_sync(
            &server,
            &[("main.tex", b"locally edited body".as_slice())],
            &[("main.tex", base)],
        );
        assert_eq!(result.pushed, vec!["main.tex"]);
        assert!(result.pulled.is_empty());

        let uploads = server.uploads();
        assert_eq!(uploads.len(), 1);
        let upload = &uploads[0];
        assert!(upload.url.starts_with("/project/proj-1/upload"));
        // Root-level files use the root id learned from joinProject. Sending a
        // temporary folder plus `../` is rejected by current Overleaf Cloud as
        // path traversal.
        assert!(upload.url.contains("folder_id=root-folder-1"));
        assert!(upload.url.contains(&format!("_csrf={CSRF}")));
        assert_eq!(upload.csrf_header.as_deref(), Some(CSRF));
        let body = upload.body_text();
        assert!(body.contains("name=\"qqfile\"; filename=\"main.tex\""));
        assert!(body.contains("locally edited body"));
        assert!(body.contains("name=\"relativePath\""));
        assert!(body.contains("\r\n\r\nmain.tex\r\n"));
        assert!(!body.contains("../main.tex"));

        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(b"locally edited body")
        );
    }

    #[test]
    fn overleaf_sync_leaves_live_documents_to_the_realtime_channel() {
        // Both sides differ, which would normally push or merge. The realtime
        // channel is already reconciling this file operation by operation, and
        // a REST upload would reach collaborators as an external overwrite.
        let base = b"shared body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[
                ("main.tex", b"remote body".as_slice()),
                ("notes.tex", b"remote notes".as_slice()),
            ]),
        );
        let config = temp_dir("live-config");
        let root = temp_dir("live-project");
        write_session_file(&config, &server.base);
        seed_linked_project(
            &root,
            &server.base,
            &[("main.tex", b"local body".as_slice()), ("notes.tex", base)],
            &[("main.tex", base), ("notes.tex", base)],
        );
        let live: BTreeSet<String> = ["main.tex".to_string()].into_iter().collect();
        let result = sync(&config, &root, &live).unwrap();

        assert!(result.pushed.is_empty());
        assert!(result.merged.is_empty());
        assert!(result.conflicts.is_empty());
        assert!(server.uploads().is_empty());
        // Untouched on disk: the editor buffer owns it while the channel is up.
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"local body");
        // Its recorded base survives, so a later sync can still merge it.
        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(base)
        );
        // Everything else syncs as usual.
        assert_eq!(result.pulled, vec!["notes.tex"]);
    }

    #[test]
    fn overleaf_sync_conflict_keeps_local_copy_and_marks_the_overlap() {
        // Both sides rewrote the same line, so no merge can decide for us.
        let base = b"base body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", b"remote edit".as_slice())]),
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", b"local edit".as_slice())],
            &[("main.tex", base)],
        );
        assert_eq!(result.conflicts.len(), 1);
        let conflict = &result.conflicts[0];
        assert_eq!(conflict.path, "main.tex");
        assert!(conflict.local_copy.starts_with("main (local conflict "));
        assert!(conflict.local_copy.ends_with(").tex"));
        // The file shows both versions where they disagree…
        let merged = String::from_utf8(read_local(&root, "main.tex").unwrap()).unwrap();
        assert!(merged.contains(CONFLICT_MARKER));
        assert!(merged.contains("local edit"));
        assert!(merged.contains("remote edit"));
        // …and the untouched local version survives beside it.
        assert_eq!(
            read_local(&root, &conflict.local_copy).unwrap(),
            b"local edit"
        );
        // Conflicted files are never uploaded in the same round.
        assert!(server.uploads().is_empty());
        assert!(result.pushed.is_empty());
        assert!(result.merged.is_empty());
    }

    #[test]
    fn overleaf_sync_merges_edits_to_different_parts_of_one_file() {
        // The case that used to shove the user's work into a sidecar file:
        // a collaborator edits the top, you edit the bottom.
        let base = "\\section{One}\nalpha\n\n\\section{Two}\nbeta\n";
        let remote = "\\section{One}\nALPHA from Overleaf\n\n\\section{Two}\nbeta\n";
        let local = "\\section{One}\nalpha\n\n\\section{Two}\nBETA edited locally\n";
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", remote.as_bytes())]),
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", local.as_bytes())],
            &[("main.tex", base.as_bytes())],
        );

        assert!(result.conflicts.is_empty());
        assert_eq!(result.merged, vec!["main.tex"]);
        let merged = String::from_utf8(read_local(&root, "main.tex").unwrap()).unwrap();
        assert!(merged.contains("ALPHA from Overleaf"));
        assert!(merged.contains("BETA edited locally"));
        assert!(!merged.contains(CONFLICT_MARKER));

        // Overleaf only had their half, so the combined file goes back up.
        assert_eq!(result.pushed, vec!["main.tex"]);
        let uploads = server.uploads();
        assert_eq!(uploads.len(), 1);
        let body = uploads[0].body_text();
        assert!(body.contains("ALPHA from Overleaf"));
        assert!(body.contains("BETA edited locally"));

        // Both sides now agree, and that agreement is the next merge base.
        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(merged.as_bytes())
        );
        assert_eq!(read_base_copy(&root, "main.tex").unwrap(), merged);
    }

    #[test]
    fn overleaf_sync_stands_down_when_overleaf_moved_while_we_worked() {
        // Someone typed in the Overleaf editor between our snapshot and our
        // upload. Uploading would replace their words, so nothing goes up and
        // the file stays marked as a local edit for the next round.
        let base = b"base body".as_slice();
        let server = start_server_versioned(
            projects_page_html(),
            build_zip(&[("main.tex", base)]),
            // First read (our snapshot), second read (just before uploading).
            vec![11, 12],
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", b"locally edited".as_slice())],
            &[("main.tex", base)],
        );
        assert!(result.pushed.is_empty());
        assert!(server.uploads().is_empty());
        // Dropped from state, so the very next sync re-detects the local edit
        // and sends it merged with whatever they wrote.
        assert!(!state_files(&root).contains_key("main.tex"));
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"locally edited");
    }

    #[test]
    fn overleaf_sync_records_the_downloaded_snapshot_not_a_later_remote_version() {
        // The zip contains version 11. A collaborator reaches version 12 while
        // this pull-only sync is finishing. Recording 12 would make the next
        // probe say the stale local copy is current.
        let base = b"old body".as_slice();
        let remote = b"version eleven".as_slice();
        let server = start_server_versioned(
            projects_page_html(),
            build_zip(&[("main.tex", remote)]),
            vec![11, 12],
        );
        let config = temp_dir("snapshot-version-config");
        let root = temp_dir("snapshot-version-project");
        write_session_file(&config, &server.base);
        seed_linked_project(
            &root,
            &server.base,
            &[("main.tex", base)],
            &[("main.tex", base)],
        );

        let result = sync(&config, &root, &BTreeSet::new()).unwrap();

        assert_eq!(result.pulled, vec!["main.tex"]);
        assert_eq!(read_local(&root, "main.tex").unwrap(), remote);
        assert_eq!(state_remote_version(&root), Some(11));
        let next = probe(&config, &root).unwrap();
        assert!(next.changed);
        assert_eq!(next.remote_version, Some(12));
    }

    #[test]
    fn overleaf_sync_leaves_an_uploaded_version_unverified() {
        // The first two reads prove the remote stayed at 11 until upload. The
        // server does not tell us which history version belongs to that upload,
        // so a later 12 must be verified rather than silently claimed.
        let base = b"base body".as_slice();
        let server = start_server_versioned(
            projects_page_html(),
            build_zip(&[("main.tex", base)]),
            vec![11, 11, 12],
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", b"locally edited".as_slice())],
            &[("main.tex", base)],
        );

        assert_eq!(result.pushed, vec!["main.tex"]);
        assert_eq!(state_remote_version(&root), None);
        let config = temp_dir("uploaded-version-config");
        write_session_file(&config, &server.base);
        // `run_sync` owns a different config directory; probing only needs a
        // valid session and the linked root.
        let next = probe(&config, &root).unwrap();
        assert!(next.changed);
        assert_eq!(next.remote_version, Some(12));
    }

    #[test]
    fn overleaf_sync_does_not_commit_local_state_after_a_partial_upload_failure() {
        // Overleaf's file API is not transactional: the first upload may have
        // succeeded before a later one fails. In that case the local sync state
        // must remain at the old common ancestor. Claiming the edited hashes
        // here would hide the ambiguous partial remote result on the next run.
        let base_a = b"base a".as_slice();
        let base_b = b"base b".as_slice();
        let server = start_server_versioned_with_upload_failure(
            projects_page_html(),
            build_zip(&[("a.tex", base_a), ("b.tex", base_b)]),
            vec![11],
            Some(2),
        );
        let config = temp_dir("partial-upload-config");
        let root = temp_dir("partial-upload-project");
        write_session_file(&config, &server.base);
        seed_linked_project(
            &root,
            &server.base,
            &[
                ("a.tex", b"edited a".as_slice()),
                ("b.tex", b"edited b".as_slice()),
            ],
            &[("a.tex", base_a), ("b.tex", base_b)],
        );

        let outcome = sync(&config, &root, &BTreeSet::new());

        assert!(outcome.is_err());
        assert_eq!(server.uploads().len(), 2);
        assert_eq!(read_local(&root, "a.tex").unwrap(), b"edited a");
        assert_eq!(read_local(&root, "b.tex").unwrap(), b"edited b");
        assert_eq!(read_base_copy(&root, "a.tex").unwrap(), "base a");
        assert_eq!(read_base_copy(&root, "b.tex").unwrap(), "base b");
        let files = state_files(&root);
        assert_eq!(files.get("a.tex"), Some(&sha256_hex(base_a)));
        assert_eq!(files.get("b.tex"), Some(&sha256_hex(base_b)));
    }

    #[test]
    fn overleaf_sync_uploads_when_overleaf_held_still() {
        // Control for the guard above: an unchanged version must not block it.
        let base = b"base body".as_slice();
        let server = start_server_versioned(
            projects_page_html(),
            build_zip(&[("main.tex", base)]),
            vec![11],
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", b"locally edited".as_slice())],
            &[("main.tex", base)],
        );
        assert_eq!(result.pushed, vec!["main.tex"]);
        assert_eq!(server.uploads().len(), 1);
        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(b"locally edited")
        );
    }

    #[test]
    fn overleaf_sync_never_uploads_unresolved_conflict_markers() {
        // A file still carrying markers must not be published to collaborators.
        let base = "alpha\n";
        let local = format!("{CONFLICT_MARKER} ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", base.as_bytes())]),
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", local.as_bytes())],
            &[("main.tex", base.as_bytes())],
        );
        assert!(result.pushed.is_empty());
        assert!(server.uploads().is_empty());
        // Left out of state, so it uploads as soon as the markers are gone.
        assert!(!state_files(&root).contains_key("main.tex"));
        assert_eq!(read_local(&root, "main.tex").unwrap(), local.as_bytes());
    }

    #[test]
    fn overleaf_sync_keeps_both_when_a_binary_file_changed_on_both_sides() {
        // Figures cannot be merged line by line, so fall back to keep-both.
        let server = start_server(
            projects_page_html(),
            build_zip(&[("figures/fig.pdf", b"%PDF remote".as_slice())]),
        );
        let (root, result) = run_sync(
            &server,
            &[("figures/fig.pdf", b"%PDF local".as_slice())],
            &[("figures/fig.pdf", b"%PDF base".as_slice())],
        );
        assert!(result.merged.is_empty());
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(
            read_local(&root, "figures/fig.pdf").unwrap(),
            b"%PDF remote"
        );
        assert_eq!(
            read_local(&root, &result.conflicts[0].local_copy).unwrap(),
            b"%PDF local"
        );
        // A figure has no spots to work through, so the app must not tell
        // anyone to resolve them or open a marker resolver on it.
        assert!(!result.conflicts[0].markers);
    }

    #[test]
    fn overleaf_sync_pulls_remote_new_file() {
        let base = b"body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[
                ("main.tex", base),
                ("figures/fig2.pdf", b"%PDF new figure".as_slice()),
            ]),
        );
        let (root, result) = run_sync(&server, &[("main.tex", base)], &[("main.tex", base)]);
        assert_eq!(result.pulled, vec!["figures/fig2.pdf"]);
        assert_eq!(
            read_local(&root, "figures/fig2.pdf").unwrap(),
            b"%PDF new figure"
        );
        assert!(server.uploads().is_empty());
    }

    #[test]
    fn overleaf_sync_pushes_local_new_nested_file_from_the_project_root() {
        let base = b"body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, result) = run_sync(
            &server,
            &[
                ("main.tex", base),
                ("nested/new-chapter.tex", b"\\section{New}".as_slice()),
            ],
            &[("main.tex", base)],
        );
        assert_eq!(result.pushed, vec!["nested/new-chapter.tex"]);

        let recorded = server.recorded();
        // Uploading through the real root id requires no temporary folder.
        let folder_posts: Vec<_> = recorded
            .iter()
            .filter(|r| r.method == "POST" && r.url == "/project/proj-1/folder")
            .collect();
        assert!(folder_posts.is_empty());

        // The relative path is project-relative and contains no traversal.
        let uploads = server.uploads();
        assert_eq!(uploads.len(), 1);
        assert!(uploads[0].url.contains("folder_id=root-folder-1"));
        let body = uploads[0].body_text();
        assert!(body.contains("nested/new-chapter.tex"));
        assert!(!body.contains("../nested/new-chapter.tex"));
        assert!(body.contains("name=\"qqfile\"; filename=\"new-chapter.tex\""));
        assert!(body.contains("\\section{New}"));

        assert!(!recorded
            .iter()
            .any(|r| r.method == "DELETE" && r.url == "/project/proj-1/folder/anchor-folder-1"));

        assert_eq!(
            state_files(&root).get("nested/new-chapter.tex").unwrap(),
            &sha256_hex(b"\\section{New}")
        );
    }

    #[test]
    fn overleaf_sync_deletes_local_when_remote_deleted_and_local_unchanged() {
        let base = b"body".as_slice();
        let gone = b"stale".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, result) = run_sync(
            &server,
            &[("main.tex", base), ("old.tex", gone)],
            &[("main.tex", base), ("old.tex", gone)],
        );
        assert_eq!(result.deleted_local, vec!["old.tex"]);
        assert!(read_local(&root, "old.tex").is_none());
        assert!(!state_files(&root).contains_key("old.tex"));
        assert!(server.uploads().is_empty());
    }

    #[test]
    fn overleaf_sync_reuploads_when_remote_deleted_but_local_changed() {
        let base = b"body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, result) = run_sync(
            &server,
            &[
                ("main.tex", base),
                ("old.tex", b"edited after remote delete".as_slice()),
            ],
            &[("main.tex", base), ("old.tex", b"original".as_slice())],
        );
        assert_eq!(result.pushed, vec!["old.tex"]);
        assert!(result.deleted_local.is_empty());
        assert_eq!(
            read_local(&root, "old.tex").unwrap(),
            b"edited after remote delete"
        );
        let uploads = server.uploads();
        assert_eq!(uploads.len(), 1);
        assert!(uploads[0]
            .body_text()
            .contains("edited after remote delete"));
        assert!(state_files(&root).contains_key("old.tex"));
    }

    #[test]
    fn overleaf_sync_skips_remote_delete_when_local_deleted() {
        let base = b"body".as_slice();
        let kept_remote = b"still on overleaf".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", base), ("dropped.tex", kept_remote)]),
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", base)], // dropped.tex deleted locally
            &[("main.tex", base), ("dropped.tex", kept_remote)],
        );
        assert_eq!(result.skipped_remote_deletes, vec!["dropped.tex"]);
        // Not re-downloaded, not deleted remotely, dropped from state so it
        // stops resurrecting.
        assert!(read_local(&root, "dropped.tex").is_none());
        assert!(!state_files(&root).contains_key("dropped.tex"));
        assert!(server.uploads().is_empty());
        assert!(!server.recorded().iter().any(|r| r.method == "DELETE"));
    }

    #[test]
    fn overleaf_sync_never_uploads_excluded_files() {
        let base = b"body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, result) = run_sync(
            &server,
            &[
                ("main.tex", base),
                ("main.log", b"latexmk noise".as_slice()),
                (".DS_Store", b"finder noise".as_slice()),
                ("main.pdf", b"%PDF compiled output".as_slice()),
                ("main.synctex.gz", b"synctex".as_slice()),
                (
                    "tmp/pdfs/full-appendix/render-1.png",
                    b"temporary preview".as_slice(),
                ),
            ],
            &[("main.tex", base)],
        );
        assert!(result.pushed.is_empty());
        assert!(result.pulled.is_empty());
        assert!(server.uploads().is_empty());
        let files = state_files(&root);
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["main.tex"]);
        // Excluded files stay untouched on disk.
        assert!(read_local(&root, "main.log").is_some());
        assert!(read_local(&root, "main.pdf").is_some());
        assert!(read_local(&root, "tmp/pdfs/full-appendix/render-1.png").is_some());
    }

    #[test]
    fn overleaf_sync_requests_silent_cleanup_for_legacy_transient_files() {
        let base = b"body".as_slice();
        let preview = b"temporary preview".as_slice();
        let save_error = b"failed bibliography output".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[
                ("lambda_gpu_proposal.bbl-SAVE-ERROR", save_error),
                ("main.tex", base),
                ("tmp/pdfs/full-appendix/page-01.png", preview),
                ("tmp/pdfs/gallery-page-10.png", preview),
            ]),
        );
        let (root, result) = run_sync(
            &server,
            &[("main.tex", base)],
            &[
                ("lambda_gpu_proposal.bbl-SAVE-ERROR", save_error),
                ("main.tex", base),
                ("tmp/pdfs/full-appendix/page-01.png", preview),
            ],
        );

        assert_eq!(
            result.automatic_remote_deletes,
            vec!["lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs"]
        );
        assert!(result.skipped_remote_deletes.is_empty());
        assert!(result.pulled.is_empty());
        assert!(result.pushed.is_empty());
        assert!(read_local(&root, "lambda_gpu_proposal.bbl-SAVE-ERROR").is_none());
        assert!(read_local(&root, "tmp/pdfs/full-appendix/page-01.png").is_none());
        assert!(!state_files(&root)
            .keys()
            .any(|path| path.starts_with("tmp/pdfs/")));
    }

    // ---- preview (dry run) --------------------------------------------------

    #[test]
    fn overleaf_preview_reports_incoming_without_touching_disk() {
        let base = b"old body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", b"new remote body".as_slice())]),
        );
        let (config, root) =
            seed_preview_project(&server, &[("main.tex", base)], &[("main.tex", base)]);

        let file_before = read_local(&root, "main.tex").unwrap();
        let state_before = fs::read(state_path(&root)).unwrap();
        let base_copy_before = read_base_copy(&root, "main.tex").unwrap();

        let preview = preview(&config, &root, &BTreeSet::new()).unwrap();

        assert_eq!(preview.changes.len(), 1);
        let change = &preview.changes[0];
        assert_eq!(change.path, "main.tex");
        assert_eq!(change.kind, "incoming");
        assert_eq!(change.before.as_deref(), Some("old body"));
        assert_eq!(change.after.as_deref(), Some("new remote body"));
        assert!(!change.binary);

        // A dry run leaves the project exactly as it found it…
        assert_eq!(read_local(&root, "main.tex").unwrap(), file_before);
        assert_eq!(fs::read(state_path(&root)).unwrap(), state_before);
        assert_eq!(read_base_copy(&root, "main.tex").unwrap(), base_copy_before);
        // …and never speaks to Overleaf beyond reading.
        assert!(server.uploads().is_empty());
        assert!(!server
            .recorded()
            .iter()
            .any(|r| r.method != "GET" && r.method != "HEAD"));
    }

    #[test]
    fn overleaf_preview_reports_merge_and_conflict() {
        let main_base = "\\section{One}\nalpha\n\n\\section{Two}\nbeta\n";
        let main_remote = "\\section{One}\nALPHA from Overleaf\n\n\\section{Two}\nbeta\n";
        let main_local = "\\section{One}\nalpha\n\n\\section{Two}\nBETA edited locally\n";
        let server = start_server(
            projects_page_html(),
            build_zip(&[
                ("main.tex", main_remote.as_bytes()),
                ("notes.tex", b"remote edit".as_slice()),
            ]),
        );
        let (root, preview) = run_preview(
            &server,
            &[
                ("main.tex", main_local.as_bytes()),
                ("notes.tex", b"local edit".as_slice()),
            ],
            &[
                ("main.tex", main_base.as_bytes()),
                ("notes.tex", b"base body".as_slice()),
            ],
        );

        // Conflicts sort first: they are the rows that need a decision.
        assert_eq!(
            preview
                .changes
                .iter()
                .map(|c| (c.kind.as_str(), c.path.as_str()))
                .collect::<Vec<_>>(),
            vec![("conflict", "notes.tex"), ("merge", "main.tex")]
        );

        let merge = change_for(&preview, "main.tex");
        assert_eq!(merge.before.as_deref(), Some(main_local));
        let merged = merge.after.clone().unwrap();
        assert!(merged.contains("ALPHA from Overleaf"));
        assert!(merged.contains("BETA edited locally"));
        assert!(!merged.contains(CONFLICT_MARKER));

        let conflict = change_for(&preview, "notes.tex");
        assert_eq!(conflict.before.as_deref(), Some("local edit"));
        let marked = conflict.after.clone().unwrap();
        assert!(marked.contains(CONFLICT_MARKER));
        assert!(marked.contains("local edit"));
        assert!(marked.contains("remote edit"));

        // Still a dry run: nothing merged onto disk, no sidecar, no upload.
        assert_eq!(
            read_local(&root, "main.tex").unwrap(),
            main_local.as_bytes()
        );
        assert_eq!(read_local(&root, "notes.tex").unwrap(), b"local edit");
        assert!(server.uploads().is_empty());
    }

    #[test]
    fn overleaf_preview_marks_binary_files() {
        // Figures cannot be shown as text, so the UI gets a marker, not bytes.
        let server = start_server(
            projects_page_html(),
            build_zip(&[("figures/fig.pdf", b"%PDF-1.5\x00remote".as_slice())]),
        );
        let (_, preview) = run_preview(
            &server,
            &[("figures/fig.pdf", b"%PDF-1.5\x00local".as_slice())],
            &[("figures/fig.pdf", b"%PDF-1.5\x00base".as_slice())],
        );
        assert_eq!(preview.changes.len(), 1);
        let change = &preview.changes[0];
        assert_eq!(change.path, "figures/fig.pdf");
        assert_eq!(change.kind, "conflict");
        assert!(change.binary);
        assert!(change.before.is_none());
        assert!(change.after.is_none());
    }

    #[test]
    fn overleaf_preview_lists_outgoing() {
        let base = b"shared body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let (root, preview) = run_preview(
            &server,
            &[("main.tex", b"locally edited body".as_slice())],
            &[("main.tex", base)],
        );
        assert_eq!(preview.changes.len(), 1);
        let change = &preview.changes[0];
        assert_eq!(change.path, "main.tex");
        assert_eq!(change.kind, "outgoing");
        // "Before" is what Overleaf last saw, which is the recorded base copy.
        assert_eq!(change.before.as_deref(), Some("shared body"));
        assert_eq!(change.after.as_deref(), Some("locally edited body"));
        assert!(!change.binary);
        assert!(server.uploads().is_empty());
        assert_eq!(
            read_local(&root, "main.tex").unwrap(),
            b"locally edited body"
        );
    }

    #[test]
    fn overleaf_threads_parse_with_resolution_and_authorship() {
        let body = serde_json::json!({
            "thread-old": {
                "messages": [
                    {"id": "c1", "content": "tighten this", "timestamp": 1_000i64,
                     "user": {"first_name": "Ada", "last_name": "Lovelace",
                              "email": "ada@example.edu"}},
                ],
                "resolved": true,
                "resolved_at": "2026-07-01T10:00:00Z",
                "resolved_by_user": {"firstName": "Robin", "email": "researcher@example.edu"},
            },
            "thread-new": {
                "messages": [
                    {"_id": "c2", "content": "who owns this?", "timestamp": 2_000i64,
                     "user": {"email": "sam@example.edu"}},
                    {"_id": "c3", "content": "me", "timestamp": 3_000i64,
                     "user": {"first_name": "Robin", "email": "RESEARCHER@example.edu"}},
                ],
            },
        });
        let threads = parse_threads(&body, Some("researcher@example.edu"));

        // Most recently discussed first: that is what someone is waiting on.
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].id, "thread-new");
        assert!(!threads[0].resolved);
        assert_eq!(threads[0].messages.len(), 2);
        // No name at all falls back to the address rather than showing blank.
        assert_eq!(threads[0].messages[0].author_name, "sam@example.edu");
        assert!(!threads[0].messages[0].mine);
        // Our own message is ours regardless of how the address is cased.
        assert!(threads[0].messages[1].mine);

        assert_eq!(threads[1].id, "thread-old");
        assert!(threads[1].resolved);
        assert_eq!(threads[1].resolved_by.as_deref(), Some("Robin"));
        assert_eq!(
            threads[1].resolved_at.as_deref(),
            Some("2026-07-01T10:00:00Z")
        );
        assert_eq!(threads[1].messages[0].author_name, "Ada Lovelace");

        // An Overleaf without the review panel answers with nothing at all.
        assert!(parse_threads(&serde_json::json!({}), None).is_empty());
        assert!(parse_threads(&serde_json::json!(null), None).is_empty());
    }

    #[test]
    fn overleaf_sync_never_uploads_for_a_read_only_account() {
        // Incoming work still lands; only the upload half stands down. Trying
        // anyway would be rejected file by file and read as a broken sync.
        let base = b"shared body".as_slice();
        let server = start_server(
            projects_page_html(),
            build_zip(&[
                // Untouched over there, so the local edit is a pure upload
                // candidate rather than something to merge.
                ("main.tex", base),
                ("notes.tex", b"new remote notes".as_slice()),
            ]),
        );
        let config = temp_dir("readonly-config");
        let root = temp_dir("readonly-project");
        write_session_file(&config, &server.base);
        seed_linked_project(
            &root,
            &server.base,
            &[("main.tex", b"local body".as_slice()), ("notes.tex", base)],
            &[("main.tex", base), ("notes.tex", base)],
        );
        set_permission(&root, "readOnly").unwrap();

        let result = sync(&config, &root, &BTreeSet::new()).unwrap();
        assert!(result.read_only);
        assert!(result.pushed.is_empty());
        assert!(server.uploads().is_empty());
        assert_eq!(result.pulled, vec!["notes.tex"]);
        // The local edit is still here, and still counts as unsent.
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"local body");
        assert_eq!(state_files(&root).get("main.tex"), None);

        // A reviewer may comment but not change the text, so the same applies.
        set_permission(&root, "review").unwrap();
        assert!(sync(&config, &root, &BTreeSet::new()).unwrap().read_only);
        // An account that can write is unaffected.
        set_permission(&root, "readAndWrite").unwrap();
        assert!(!sync(&config, &root, &BTreeSet::new()).unwrap().read_only);
    }

    #[test]
    fn overleaf_sync_never_uploads_when_permission_is_unknown() {
        let base = b"shared body".as_slice();
        let server = start_server(projects_page_html(), build_zip(&[("main.tex", base)]));
        let config = temp_dir("unknown-permission-config");
        let root = temp_dir("unknown-permission-project");
        write_session_file(&config, &server.base);
        seed_linked_project(
            &root,
            &server.base,
            &[("main.tex", b"local edit".as_slice())],
            &[("main.tex", base)],
        );
        let mut state = load_state(&root).unwrap();
        state.permission = None;
        save_state(&root, &state).unwrap();

        let result = sync(&config, &root, &BTreeSet::new()).unwrap();

        assert!(result.read_only);
        assert!(result.pushed.is_empty());
        assert!(server.uploads().is_empty());
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"local edit");
        assert!(!state_files(&root).contains_key("main.tex"));
    }

    #[test]
    fn read_only_pull_refreshes_the_base_before_write_access_returns() {
        let original = b"alpha\nshared middle\nbeta\n".as_slice();
        let first_remote = b"alpha from Overleaf\nshared middle\nbeta\n".as_slice();
        let first_server = start_server(
            projects_page_html(),
            build_zip(&[("main.tex", first_remote)]),
        );
        let config = temp_dir("permission-base-config");
        let root = temp_dir("permission-base-project");
        write_session_file(&config, &first_server.base);
        seed_linked_project(
            &root,
            &first_server.base,
            &[("main.tex", original)],
            &[("main.tex", original)],
        );
        let mut state = load_state(&root).unwrap();
        state.permission = None;
        save_state(&root, &state).unwrap();

        let pulled = sync(&config, &root, &BTreeSet::new()).unwrap();

        assert!(pulled.read_only);
        assert_eq!(
            read_base_copy(&root, "main.tex").as_deref(),
            Some("alpha from Overleaf\nshared middle\nbeta\n")
        );

        // Once write access returns, edits to different lines must merge
        // against the pulled snapshot, not the stale pre-permission base.
        fs::write(
            local_disk_path(&root, "main.tex"),
            b"alpha from Overleaf\nshared middle\nbeta locally\n",
        )
        .unwrap();
        let second_server = start_server(
            projects_page_html(),
            build_zip(&[(
                "main.tex",
                b"alpha revised remotely\nshared middle\nbeta\n".as_slice(),
            )]),
        );
        let mut state = load_state(&root).unwrap();
        state.host = second_server.base.clone();
        state.permission = Some("readAndWrite".to_string());
        save_state(&root, &state).unwrap();
        // The second mock server represents the same Overleaf deployment at a
        // new test address, so move the synthetic session with the link.
        write_session_file(&config, &second_server.base);

        let merged = sync(&config, &root, &BTreeSet::new()).unwrap();

        assert_eq!(merged.merged, vec!["main.tex"]);
        assert!(merged.conflicts.is_empty());
        assert_eq!(
            read_local(&root, "main.tex").unwrap(),
            b"alpha revised remotely\nshared middle\nbeta locally\n"
        );
        assert_eq!(second_server.uploads().len(), 1);
    }

    /// Reads the real project's Overleaf history. This is the surface that is
    /// least visible in the open source — several endpoints only exist as
    /// calls the browser makes — so its shapes are worth confirming.
    #[test]
    #[ignore = "reads overleaf.com with the signed-in session"]
    fn reads_the_real_project_history() {
        let root = std::path::PathBuf::from(std::env::var("OVERLEAF_E2E_PROJECT").unwrap());
        let config = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/app.leo1oel.researchwriter");

        let (updates, next) = history_updates(&config, &root, None, 10).expect("updates");
        println!("{} updates, next page before {next:?}", updates.len());
        for update in updates.iter().take(5) {
            println!(
                "  v{}..{} by {:?} touching {:?}{}",
                update.from_version,
                update.to_version,
                update.authors,
                update.paths,
                update
                    .origin
                    .as_deref()
                    .map(|kind| format!(" via {kind}"))
                    .unwrap_or_default()
            );
        }
        assert!(!updates.is_empty(), "a synced project has history");
        let newest = &updates[0];
        assert!(newest.to_version >= newest.from_version);
        assert!(newest.end_ts > 0, "timestamps should be milliseconds");

        let labels = history_labels(&config, &root).expect("labels");
        println!("{} labels", labels.len());

        // The file tree as it stood at one version.
        let files = history_files(&config, &root, newest.from_version, newest.to_version)
            .expect("filetree diff");
        let listed = files
            .get("diff")
            .and_then(serde_json::Value::as_array)
            .map(|entries| entries.len())
            .unwrap_or(0);
        println!("{listed} entries in the tree across that range");
        assert!(listed > 0);

        // And the text diff for one file it touched.
        if let Some(path) = newest.paths.first() {
            let diff = history_diff(&config, &root, path, newest.from_version, newest.to_version)
                .expect("diff");
            let chunks = diff.get("diff").map(|value| match value {
                serde_json::Value::Array(items) => format!("{} chunks", items.len()),
                other => format!("{other}"),
            });
            println!("diff of {path}: {chunks:?}");
            assert!(diff.get("diff").is_some());
        }
    }

    #[test]
    fn overleaf_exclusion_rules() {
        assert!(is_excluded(".research/overleaf.json"));
        // MCP server config: `env` is where an API key goes.
        assert!(is_excluded(".omp/mcp.json"));
        assert!(is_excluded(".omp"));
        assert!(is_excluded(".git/HEAD"));
        assert!(is_excluded(".gitignore"));
        assert!(is_excluded("sub/.DS_Store"));
        assert!(is_excluded("main.aux"));
        assert!(is_excluded("main.synctex.gz"));
        assert!(is_excluded("main.pdf")); // compiled output at root
        assert!(is_excluded("tmp/pdfs/full-appendix/render-1.png"));
        assert!(is_excluded("tmp/pdfs"));
        assert!(!is_excluded("tmp/notes.tex"));
        // Real uploads seen on overleaf.com: a sync caught mid-compile picked
        // up synctex's half-written files and put them in the project history.
        assert!(is_excluded("main.synctex(busy)"));
        assert!(is_excluded("main.synctex.gz(busy)"));
        assert!(is_excluded("nested/chapter.synctex"));
        assert!(is_excluded("main.run.xml"));
        assert!(is_excluded("main.bcf"));
        assert!(is_excluded("lambda_gpu_proposal.bbl-SAVE-ERROR"));
        // A source file whose name merely ends in "(busy)" is still source.
        assert!(!is_excluded("notes(busy).tex"));
        assert!(!is_excluded("figures/fig1.pdf")); // figure pdfs sync
        assert!(!is_excluded("main.tex"));
        assert!(!is_excluded("nested/chapter.tex"));
        // Conflict copies are ours to hold locally, never the project's.
        assert!(is_excluded(
            "neurips_2026 (local conflict 20260724-1308).tex"
        ));
        assert!(is_excluded(
            "nested/paper (local conflict 20260101-0900).tex"
        ));
        assert!(is_conflict_copy("paper (local conflict 20260101-0900).tex"));
        assert!(!is_conflict_copy("paper.tex"));
        assert!(!is_conflict_copy("local conflict notes.tex"));
    }
}
