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
//! - `POST {host}/project/{id}/upload?folder_id={folder}` uploads one file as
//!   multipart: `name` (file name), `relativePath` (the literal string
//!   `"null"` for root-level files, otherwise a path whose dirname the server
//!   mkdirp's relative to `folder_id`), and the file part `qqfile`. CSRF goes
//!   in the `X-Csrf-Token` header (plus `_csrf` query param, mirroring
//!   overleaf-sync). When `folder_id` is omitted the server defaults it to
//!   the project's root folder.
//! - The root folder id is only exposed over socket.io (`joinProject`), which
//!   we do not speak. For nested uploads we instead create a uniquely named
//!   temporary anchor folder at the project root via
//!   `POST {host}/project/{id}/folder` (JSON `{ "name": ... }`, parent
//!   defaults to root, response carries the new folder's `_id`), upload with
//!   `folder_id=<anchor>` and `relativePath=../<real/relative/path>` (the
//!   server path-joins and normalizes, so the file lands at the real path),
//!   and finally `DELETE {host}/project/{id}/folder/{anchor}`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
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

/// LaTeX build artifacts that never sync in either direction.
const ARTIFACT_SUFFIXES: &[&str] = &[
    ".aux",
    ".bbl",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".log",
    ".out",
    ".synctex.gz",
    ".toc",
    ".lof",
    ".lot",
    ".nav",
    ".snm",
    ".vrb",
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafConflict {
    pub path: String,
    pub local_copy: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafSyncResult {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    pub conflicts: Vec<OverleafConflict>,
    pub deleted_local: Vec<String>,
    pub skipped_remote_deletes: Vec<String>,
}

/// One tick of the sign-in-window polling loop (see `overleaf_poll_login`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafLoginPoll {
    pub status: &'static str,
    pub session: Option<OverleafStatus>,
}

impl OverleafLoginPoll {
    pub fn pending() -> Self {
        Self { status: "pending", session: None }
    }
    pub fn cancelled() -> Self {
        Self { status: "cancelled", session: None }
    }
    pub fn connected(session: OverleafStatus) -> Self {
        Self { status: "connected", session: Some(session) }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    host: String,
    project_id: String,
    project_name: String,
    #[serde(default)]
    last_sync: Option<String>,
    /// Relative path (forward slashes) → sha256 hex of the content at the
    /// last successful sync.
    #[serde(default)]
    files: BTreeMap<String, String>,
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
    fs::write(session_path(config_dir), body + "\n").map_err(err)
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

pub fn normalize_host(host: &str) -> String {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_HOST.to_string();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
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

/// Paths (forward-slash relative) that never participate in sync.
fn is_excluded(path: &str) -> bool {
    if path.starts_with(".research/") || path.starts_with(".git/") {
        return true;
    }
    if path == ".gitignore" || path == ".git" || path == ".research" {
        return true;
    }
    let file_name = path.rsplit('/').next().unwrap_or(path);
    if file_name == ".DS_Store" {
        return true;
    }
    let lower = file_name.to_ascii_lowercase();
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

/// Walk the project and load every syncable file (path → bytes).
fn read_local_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !(e.file_type().is_dir() && (name == ".git" || name == ".research"))
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
        let data = fs::read(entry.path()).map_err(|e| format!("Could not read {rel}: {e}"))?;
        files.insert(rel, data);
    }
    Ok(files)
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

/// Uploads files into an Overleaf project. Nested paths need a real folder id
/// as an anchor (see module docs), created lazily and removed afterwards.
struct Uploader<'a> {
    client: &'a reqwest::blocking::Client,
    host: &'a str,
    cookie: &'a str,
    csrf: &'a str,
    project_id: &'a str,
    anchor_folder_id: Option<String>,
}

impl<'a> Uploader<'a> {
    fn new(
        client: &'a reqwest::blocking::Client,
        host: &'a str,
        cookie: &'a str,
        csrf: &'a str,
        project_id: &'a str,
    ) -> Self {
        Self {
            client,
            host,
            cookie,
            csrf,
            project_id,
            anchor_folder_id: None,
        }
    }

    fn ensure_anchor(&mut self) -> Result<String, String> {
        if let Some(id) = &self.anchor_folder_id {
            return Ok(id.clone());
        }
        let name = format!(
            "__rw-sync-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let response = self
            .client
            .post(format!("{}/project/{}/folder", self.host, self.project_id))
            .header(reqwest::header::COOKIE, self.cookie)
            .header("X-Csrf-Token", self.csrf)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({ "name": name }))
            .send()
            .map_err(err)?;
        check_authenticated(&response)?;
        if !response.status().is_success() {
            return Err(format!(
                "Overleaf refused to create a sync folder ({}).",
                response.status()
            ));
        }
        let body: serde_json::Value = response.json().map_err(err)?;
        let id = body
            .get("_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Overleaf's folder response had no _id.".to_string())?
            .to_string();
        self.anchor_folder_id = Some(id.clone());
        Ok(id)
    }

    fn upload(&mut self, rel: &str, bytes: Vec<u8>) -> Result<(), String> {
        let file_name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let mut request = self
            .client
            .post(format!("{}/project/{}/upload", self.host, self.project_id))
            .query(&[("_csrf", self.csrf)]);
        let relative_path = if rel.contains('/') {
            let anchor = self.ensure_anchor()?;
            request = request.query(&[("folder_id", anchor.as_str())]);
            // `../` climbs out of the anchor folder back to the project root;
            // the server normalizes the joined path and mkdirp's the dirname.
            format!("../{rel}")
        } else {
            // Uppy sends the literal string "null" for non-nested files.
            "null".to_string()
        };
        let part = reqwest::blocking::multipart::Part::bytes(bytes).file_name(file_name.clone());
        let form = reqwest::blocking::multipart::Form::new()
            .text("name", file_name)
            .text("relativePath", relative_path)
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

    /// Best-effort removal of the temporary anchor folder.
    fn cleanup(&self) {
        if let Some(id) = &self.anchor_folder_id {
            let _ = self
                .client
                .delete(format!(
                    "{}/project/{}/folder/{}",
                    self.host, self.project_id, id
                ))
                .header(reqwest::header::COOKIE, self.cookie)
                .header("X-Csrf-Token", self.csrf)
                .send();
        }
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
    // A logged-in dashboard always carries the projects blob (or the legacy
    // ol-projects meta); the login page does not.
    if meta_content(&html, "ol-prefetchedProjectsBlob").is_none()
        && meta_content(&html, "ol-projects").is_none()
    {
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
    let session = load_session(config_dir)?;
    let client = http_client(30)?;
    let html = fetch_projects_page(&client, &session.host, &session.cookie)?;
    parse_projects_meta(&html)
}

pub fn clone_project(
    config_dir: &Path,
    project_id: &str,
    project_name: &str,
    dest_parent: &Path,
) -> Result<PathBuf, String> {
    let session = load_session(config_dir)?;
    let folder_name = sanitize_project_name(project_name)?;
    let root = dest_parent.join(&folder_name);
    if root.exists() && fs::read_dir(&root).map_err(err)?.next().is_some() {
        return Err("That folder already exists and is not empty.".to_string());
    }
    let client = http_client(120)?;
    let zip_bytes = download_project_zip(&client, &session.host, &session.cookie, project_id)?;
    let entries = read_zip_entries(&zip_bytes)?;

    fs::create_dir_all(&root).map_err(err)?;
    let mut files = BTreeMap::new();
    for (rel, data) in &entries {
        write_local_file(&root, rel, data)?;
        if !is_excluded(rel) {
            files.insert(rel.clone(), sha256_hex(data));
        }
    }
    let state = SyncState {
        host: session.host,
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        last_sync: Some(now_iso()),
        files,
    };
    save_state(&root, &state)?;
    Ok(root)
}

pub fn project_link(root: &Path) -> Result<Option<OverleafLink>, String> {
    if !state_path(root).exists() {
        return Ok(None);
    }
    let state = load_state(root)?;
    Ok(Some(OverleafLink {
        project_id: state.project_id,
        project_name: state.project_name,
        host: state.host,
        last_sync: state.last_sync,
    }))
}

pub fn sync(config_dir: &Path, root: &Path) -> Result<OverleafSyncResult, String> {
    let session = load_session(config_dir)?;
    let mut state = load_state(root)?;
    state.files.retain(|path, _| !is_excluded(path));
    let host = if state.host.trim().is_empty() {
        session.host.clone()
    } else {
        state.host.clone()
    };

    let client = http_client(30)?;
    let page = fetch_projects_page(&client, &host, &session.cookie)?;
    let csrf = meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;

    let zip_client = http_client(120)?;
    let zip_bytes = download_project_zip(&zip_client, &host, &session.cookie, &state.project_id)?;
    let remote: BTreeMap<String, Vec<u8>> = read_zip_entries(&zip_bytes)?
        .into_iter()
        .filter(|(path, _)| !is_excluded(path))
        .collect();
    let local = read_local_files(root)?;

    let mut all_paths: BTreeSet<String> = BTreeSet::new();
    all_paths.extend(remote.keys().cloned());
    all_paths.extend(local.keys().cloned());
    all_paths.extend(state.files.keys().cloned());

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M").to_string();
    let mut new_files: BTreeMap<String, String> = BTreeMap::new();
    let mut result = OverleafSyncResult::default();
    let mut to_push: Vec<String> = Vec::new();

    for path in &all_paths {
        let remote_bytes = remote.get(path);
        let local_bytes = local.get(path);
        let base_hash = state.files.get(path);
        match (remote_bytes, local_bytes) {
            (Some(rb), Some(lb)) => {
                if rb == lb {
                    new_files.insert(path.clone(), sha256_hex(rb));
                    continue;
                }
                let remote_hash = sha256_hex(rb);
                let local_hash = sha256_hex(lb);
                let remote_changed = base_hash != Some(&remote_hash);
                let local_changed = base_hash != Some(&local_hash);
                if remote_changed && !local_changed {
                    write_local_file(root, path, rb)?;
                    result.pulled.push(path.clone());
                    new_files.insert(path.clone(), remote_hash);
                } else if local_changed && !remote_changed {
                    to_push.push(path.clone());
                    new_files.insert(path.clone(), local_hash);
                } else {
                    // Both sides changed: remote wins the canonical path, the
                    // local version survives beside it. Not uploaded this round.
                    let copy = conflict_copy_name(path, &stamp);
                    write_local_file(root, &copy, lb)?;
                    write_local_file(root, path, rb)?;
                    result.conflicts.push(OverleafConflict {
                        path: path.clone(),
                        local_copy: copy,
                    });
                    new_files.insert(path.clone(), remote_hash);
                }
            }
            (Some(rb), None) => {
                let remote_hash = sha256_hex(rb);
                match base_hash {
                    // Deleted locally while remote is unchanged: we never
                    // delete remote files in v1, but we also stop
                    // resurrecting the file locally — drop it from state.
                    Some(base) if *base == remote_hash => {
                        result.skipped_remote_deletes.push(path.clone());
                    }
                    // New on remote, or deleted locally while remote moved
                    // on (remote wins): pull it.
                    _ => {
                        write_local_file(root, path, rb)?;
                        result.pulled.push(path.clone());
                        new_files.insert(path.clone(), remote_hash);
                    }
                }
            }
            (None, Some(lb)) => {
                let local_hash = sha256_hex(lb);
                match base_hash {
                    // Deleted on remote while local is unchanged: delete it.
                    Some(base) if *base == local_hash => {
                        fs::remove_file(local_disk_path(root, path))
                            .map_err(|e| format!("Could not delete {path}: {e}"))?;
                        result.deleted_local.push(path.clone());
                    }
                    // New locally, or deleted remotely after local edits
                    // (upload restores it remotely): push it.
                    _ => {
                        to_push.push(path.clone());
                        new_files.insert(path.clone(), local_hash);
                    }
                }
            }
            (None, None) => {
                // Present only in state: deleted on both sides, forget it.
            }
        }
    }

    let mut uploader = Uploader::new(&client, &host, &session.cookie, &csrf, &state.project_id);
    let push_outcome = (|| {
        for path in &to_push {
            let bytes = local
                .get(path)
                .cloned()
                .ok_or_else(|| format!("{path} disappeared during sync"))?;
            uploader
                .upload(path, bytes)
                .map_err(|e| format!("Failed to upload \"{path}\" to Overleaf: {e}"))?;
        }
        Ok::<(), String>(())
    })();
    uploader.cleanup();
    push_outcome?;
    result.pushed = to_push;

    state.files = new_files;
    state.last_sync = Some(now_iso());
    save_state(root, &state)?;

    result.pulled.sort();
    result.pushed.sort();
    result.deleted_local.sort();
    result.skipped_remote_deletes.sort();
    result.conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    const CSRF: &str = "csrf-fixture-token";

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
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind mock server");
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => panic!("expected an IP listener"),
        };
        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        std::thread::spawn(move || {
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
                let outcome = if method == "GET" && path == "/project" {
                    request.respond(
                        tiny_http::Response::from_string(html.clone()).with_header(html_header),
                    )
                } else if method == "GET" && path.ends_with("/download/zip") {
                    request.respond(tiny_http::Response::from_data(zip_bytes.clone()))
                } else if method == "POST" && path.ends_with("/upload") {
                    request.respond(
                        tiny_http::Response::from_string(
                            "{\"success\":true,\"entity_id\":\"e1\",\"entity_type\":\"file\"}",
                        )
                        .with_header(json_header),
                    )
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
                    "owner": { "email": "ymingliu@uw.edu", "firstName": "Leo", "lastName": "Liu" }
                },
                {
                    "id": "proj-new",
                    "name": "New Paper",
                    "lastUpdated": "2026-07-01T10:00:00.000Z",
                    "accessLevel": "readAndWrite",
                    "archived": false,
                    "trashed": false,
                    "owner": { "email": "advisor@uw.edu", "firstName": "Ada", "lastName": "Advisor" }
                },
                {
                    "id": "proj-archived",
                    "name": "Archived Paper",
                    "lastUpdated": "2026-03-01T10:00:00.000Z",
                    "accessLevel": "owner",
                    "archived": true,
                    "trashed": false,
                    "owner": { "email": "ymingliu@uw.edu", "firstName": "Leo", "lastName": "Liu" }
                }
            ]
        });
        let user = serde_json::json!({
            "id": "u1",
            "email": "ymingliu@uw.edu",
            "first_name": "Leo",
            "last_name": "Liu"
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

    fn write_session_file(config_dir: &Path, host: &str) {
        save_session(
            config_dir,
            &SessionFile {
                host: host.to_string(),
                cookie: "overleaf_session2=fixture-cookie".to_string(),
                email: Some("ymingliu@uw.edu".to_string()),
                name: Some("Leo Liu".to_string()),
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
                last_sync: Some("2026-07-01T00:00:00Z".to_string()),
                files,
            },
        )
        .unwrap();
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
        let result = sync(&config, &root).unwrap();
        (root, result)
    }

    fn read_local(root: &Path, rel: &str) -> Option<Vec<u8>> {
        fs::read(local_disk_path(root, rel)).ok()
    }

    fn state_files(root: &Path) -> BTreeMap<String, String> {
        load_state(root).unwrap().files
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
        assert_eq!(status.email.as_deref(), Some("ymingliu@uw.edu"));
        assert_eq!(status.name.as_deref(), Some("Leo Liu"));
        assert_eq!(status.host, server.base);
        assert!(session_path(&config).exists());

        // The stored session round-trips through session_status.
        let restored = session_status(&config).unwrap();
        assert!(restored.connected);
        assert_eq!(restored.email.as_deref(), Some("ymingliu@uw.edu"));

        // The validation request carried the full cookie header.
        let recorded = server.recorded();
        assert_eq!(
            recorded[0].cookie_header.as_deref(),
            Some("overleaf_session2=abc123; GCLB=balancer")
        );

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
        assert_eq!(projects[0].owner_email.as_deref(), Some("advisor@uw.edu"));
        assert_eq!(projects[0].owner_name.as_deref(), Some("Ada Advisor"));
        assert!(projects[1].archived);
        assert!(!projects[1].trashed);
        assert!(!projects[0].archived);
        assert_eq!(
            projects[2].last_updated.as_deref(),
            Some("2026-01-02T10:00:00.000Z")
        );
    }

    // ---- clone -------------------------------------------------------------

    #[test]
    fn overleaf_clone_project_extracts_and_writes_state() {
        let zip = build_zip(&[
            ("main.tex", b"\\documentclass{article}".as_slice()),
            ("refs.bib", b"@article{a}".as_slice()),
            ("figures/fig1.pdf", b"%PDF-1.5 fake".as_slice()),
            ("nested/chapter.tex", b"\\section{One}".as_slice()),
        ]);
        let server = start_server(projects_page_html(), zip);
        let config = temp_dir("clone-config");
        let parent = temp_dir("clone-parent");
        write_session_file(&config, &server.base);

        let root = clone_project(&config, "proj-1", "Test: Project", &parent).unwrap();
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

        // Cloning again into the same non-empty folder fails.
        let again = clone_project(&config, "proj-1", "Test: Project", &parent);
        assert!(again.unwrap_err().contains("already exists"));
    }

    #[test]
    fn overleaf_clone_project_rejects_zip_slip() {
        let server = start_server(projects_page_html(), build_malicious_zip());
        let config = temp_dir("slip-config");
        let parent = temp_dir("slip-parent");
        write_session_file(&config, &server.base);
        let outcome = clone_project(&config, "proj-1", "Evil", &parent);
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
        // Root-level file: no folder_id, csrf in both header and query.
        assert!(!upload.url.contains("folder_id="));
        assert!(upload.url.contains(&format!("_csrf={CSRF}")));
        assert_eq!(upload.csrf_header.as_deref(), Some(CSRF));
        let body = upload.body_text();
        assert!(body.contains("name=\"qqfile\"; filename=\"main.tex\""));
        assert!(body.contains("locally edited body"));
        assert!(body.contains("name=\"relativePath\""));
        assert!(body.contains("null"));

        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(b"locally edited body")
        );
    }

    #[test]
    fn overleaf_sync_conflict_keeps_local_copy_and_takes_remote() {
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
        assert_eq!(read_local(&root, "main.tex").unwrap(), b"remote edit");
        assert_eq!(
            read_local(&root, &conflict.local_copy).unwrap(),
            b"local edit"
        );
        // Conflicted files are never uploaded in the same round.
        assert!(server.uploads().is_empty());
        assert!(result.pushed.is_empty());
        assert_eq!(
            state_files(&root).get("main.tex").unwrap(),
            &sha256_hex(b"remote edit")
        );
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
    fn overleaf_sync_pushes_local_new_nested_file_via_anchor_folder() {
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
        // Anchor folder created at project root with the csrf header.
        let folder_posts: Vec<_> = recorded
            .iter()
            .filter(|r| r.method == "POST" && r.url == "/project/proj-1/folder")
            .collect();
        assert_eq!(folder_posts.len(), 1);
        assert_eq!(folder_posts[0].csrf_header.as_deref(), Some(CSRF));
        let folder_body = folder_posts[0].body_text();
        assert!(folder_body.contains("__rw-sync-"));
        assert!(!folder_body.contains("parent_folder_id"));

        // Upload anchored at the temp folder, climbing back out with ../.
        let uploads = server.uploads();
        assert_eq!(uploads.len(), 1);
        assert!(uploads[0].url.contains("folder_id=anchor-folder-1"));
        let body = uploads[0].body_text();
        assert!(body.contains("../nested/new-chapter.tex"));
        assert!(body.contains("name=\"qqfile\"; filename=\"new-chapter.tex\""));
        assert!(body.contains("\\section{New}"));

        // Anchor folder removed afterwards.
        assert!(recorded
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
    }

    #[test]
    fn overleaf_exclusion_rules() {
        assert!(is_excluded(".research/overleaf.json"));
        assert!(is_excluded(".git/HEAD"));
        assert!(is_excluded(".gitignore"));
        assert!(is_excluded("sub/.DS_Store"));
        assert!(is_excluded("main.aux"));
        assert!(is_excluded("main.synctex.gz"));
        assert!(is_excluded("main.pdf")); // compiled output at root
        assert!(!is_excluded("figures/fig1.pdf")); // figure pdfs sync
        assert!(!is_excluded("main.tex"));
        assert!(!is_excluded("nested/chapter.tex"));
    }
}
