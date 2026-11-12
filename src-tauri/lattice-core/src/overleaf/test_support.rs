//! Fixtures shared by the Overleaf tests: a mock Overleaf that records every
//! request it is sent, and linked projects on disk to sync against it.

use super::account::{save_session, SessionFile};
use super::files::{disk_path, sha256_hex, write_base_copy};
use super::link::{load_state, save_state, SyncState};
use super::sync::{sync, OverleafSyncResult};
use crate::overleaf_rt::mock_server::{answer_realtime, serve_http, set_project, MockState};
pub(super) use crate::test_support::TempDir;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub(super) const CSRF: &str = "csrf-fixture-token";

/// A file list as the tests write it: `(relative path, bytes)`.
pub(super) type Files<'a> = &'a [(&'a str, &'a [u8])];

#[derive(Debug, Clone)]
pub(super) struct RecordedRequest {
    pub method: String,
    pub url: String,
    pub csrf_header: Option<String>,
    pub cookie_header: Option<String>,
    pub body: Vec<u8>,
}

impl RecordedRequest {
    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

pub(super) struct MockServer {
    pub base: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl MockServer {
    pub fn recorded(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub fn with_method(&self, method: &str) -> Vec<RecordedRequest> {
        self.recorded().into_iter().filter(|r| r.method == method).collect()
    }

    pub fn uploads(&self) -> Vec<RecordedRequest> {
        self.with_method("POST").into_iter().filter(|r| r.url.contains("/upload")).collect()
    }
}

/// Called with each request's method and URL as it arrives.
pub(super) type OnRequest = Box<dyn FnMut(&str, &str) + Send>;

/// How the mock Overleaf behaves.
#[derive(Default)]
pub(super) struct Mock {
    /// The dashboard page; [`projects_page_html`] when unset.
    pub dashboard: Option<String>,
    /// `(method, path, status, JSON body)` answers that take precedence over
    /// the built-in ones.
    pub routes: Vec<(&'static str, &'static str, u16, String)>,
    /// The project download.
    pub zip: Vec<u8>,
    /// What every download after the first serves instead, when set: the
    /// project as it stands once someone has edited it.
    pub later_zip: Option<Vec<u8>>,
    /// Served one per version read, a `/updates?min_count=1` request (the
    /// last value repeats). An empty list answers 404, matching an instance
    /// without history.
    pub versions: Vec<i64>,
    /// Serve each of `versions` as the newest edit's timestamp, with no
    /// history version, as a history that keeps versions per document does.
    pub stamped: bool,
    /// How far each upload moves the version served after it, by the
    /// uploaded file's name; unset, only `versions` moves it.
    pub upload_moves: Option<fn(&str) -> i64>,
    /// The names Overleaf keeps as file entities, whose diff says binary.
    pub file_entities: Vec<&'static str>,
    /// `(pathname, from, to, parts)`: what a diff of one file between two
    /// versions answers. Any other diff of a document shows it unchanged.
    pub diffs: Vec<(&'static str, i64, i64, serde_json::Value)>,
    /// The project history, newest first, served whole to every other
    /// `/updates` request: the page reads that confirm a destructive pull.
    pub history: Vec<serde_json::Value>,
    /// Every page of `history` says older pages follow, so a read that wants
    /// all of it runs into the most pages Lattice reads at once.
    pub endless_history: bool,
    /// The nth file upload (counting from 1) fails.
    pub fail_upload_at: Option<usize>,
    /// The failed upload's status and body, instead of a plain 500.
    pub upload_failure: Option<(u16, &'static str)>,
    /// Move and rename requests fail.
    pub fail_relocation: bool,
    /// Runs as each request arrives, before it is answered, with its method
    /// and URL: the moment to change something while a sync waits on Overleaf.
    pub on_request: Option<OnRequest>,
    /// The live channel, kept as `overleaf_rt::mock_server` keeps it; without
    /// it the channel's handshake is refused, as when it cannot be reached.
    pub realtime: Option<Arc<Mutex<MockState>>>,
    /// A project the test changes between syncs, served instead of `zip`,
    /// `versions` and `history`, and to the live channel when there is one.
    pub shared: Option<Arc<Mutex<SharedProject>>>,
}

/// A project on the mock Overleaf as a co-author leaves it: served alike by
/// the project download, the file route, version and history reads, and the
/// live channel's tree and documents.
#[derive(Default)]
pub(super) struct SharedProject {
    pub files: BTreeMap<String, Vec<u8>>,
    pub version: i64,
    /// Newest first, as Overleaf lists it.
    pub history: Vec<serde_json::Value>,
}

impl SharedProject {
    pub fn new(files: &[(String, Vec<u8>)], version: i64) -> Arc<Mutex<Self>> {
        let files = files.iter().cloned().collect();
        Arc::new(Mutex::new(SharedProject { files, version, history: Vec::new() }))
    }

    /// Record an update to the next version, naming `pathnames` (documents
    /// edited) and `project_ops` (tree operations).
    pub fn update(&mut self, pathnames: &[&str], project_ops: serde_json::Value) {
        let (from, to) = (self.version, self.version + 1);
        let update = serde_json::json!({ "fromV": from, "toV": to, "pathnames": pathnames,
            "project_ops": project_ops, "meta": { "end_ts": 0 } });
        self.history.insert(0, update);
        self.version = to;
    }

    /// The project as `joinProject` gives it: documents and files with ids,
    /// files with their content hash, nested in folders.
    fn tree(&self) -> (serde_json::Value, Vec<(String, String)>) {
        fn folder(name: &str, id: &str) -> serde_json::Value {
            serde_json::json!({ "_id": id, "name": name, "docs": [], "fileRefs": [], "folders": [] })
        }
        let mut root = folder("rootFolder", "root-1");
        let mut texts = Vec::new();
        for (path, bytes) in &self.files {
            let mut at = &mut root;
            let mut parts: Vec<&str> = path.split('/').collect();
            let name = parts.pop().unwrap();
            for (depth, part) in parts.iter().enumerate() {
                let id = entity_id(&parts[..=depth].join("/"));
                let folders = at["folders"].as_array_mut().unwrap();
                let index = match folders.iter().position(|f| f["name"] == *part) {
                    Some(index) => index,
                    None => {
                        folders.push(folder(part, &id));
                        folders.len() - 1
                    }
                };
                at = &mut at["folders"][index];
            }
            let id = entity_id(path);
            if is_doc(path) {
                texts.push((id.clone(), String::from_utf8(bytes.clone()).unwrap()));
                at["docs"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({ "_id": id, "name": name }));
            } else {
                let entry =
                    serde_json::json!({ "_id": id, "name": name, "hash": blob_sha1(bytes) });
                at["fileRefs"].as_array_mut().unwrap().push(entry);
            }
        }
        (serde_json::json!({ "_id": "proj-1", "name": "Paper", "rootFolder": [root] }), texts)
    }

    fn answer(&self, url: &str, path: &str) -> Option<(u16, Vec<u8>)> {
        if path.ends_with("/updates") && url.ends_with("?min_count=1") {
            let body = format!("{{\"updates\":[{{\"fromV\":0,\"toV\":{}}}]}}", self.version);
            return Some((200, body.into_bytes()));
        }
        if path.ends_with("/updates") {
            return Some((200, serde_json::json!({ "updates": self.history }).to_string().into()));
        }
        if path.ends_with("/download/zip") {
            let files: Vec<(&str, &[u8])> =
                self.files.iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect();
            return Some((200, build_zip(&files)));
        }
        let id = path.strip_prefix("/project/proj-1/file/")?;
        let found = self.files.iter().find(|(path, _)| entity_id(path) == id);
        Some(found.map_or((404, Vec::new()), |(_, bytes)| (200, bytes.clone())))
    }
}

/// The id the mock gives the entity at `path`.
pub(super) fn entity_id(path: &str) -> String {
    format!("e{}", &sha256_hex(path.as_bytes())[..16])
}

/// What the mock serves as a document rather than a file.
pub(super) fn is_doc(path: &str) -> bool {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension);
    matches!(extension, Some("tex" | "bib" | "sty" | "cls" | "bst" | "txt" | "md"))
}

/// Git's blob SHA-1, the hash Overleaf keeps a file under.
pub(super) fn blob_sha1(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Mock {
    pub fn project(files: Files) -> Self {
        Mock { zip: build_zip(files), ..Default::default() }
    }

    pub fn serve(mut self) -> MockServer {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let mut versions: VecDeque<i64> = self.versions.iter().copied().collect();
        let mut uploads = 0usize;
        let mut downloads = 0usize;
        let mut moved = 0i64;
        let html = self.dashboard.take().unwrap_or_else(projects_page_html);
        let routes = std::mem::take(&mut self.routes);
        let realtime = self.realtime.take();
        let shared = self.shared.take();
        let base = serve_http(move |mut request| {
            if let Some(realtime) =
                realtime.as_ref().filter(|_| request.url().starts_with("/socket.io/"))
            {
                // The handshake: connect to the project as it now stands.
                if let Some(shared) =
                    shared.as_ref().filter(|_| !request.url().contains("/websocket/"))
                {
                    let (project, texts) = shared.lock().unwrap().tree();
                    set_project(realtime, project, &texts);
                }
                return answer_realtime(request, realtime, 60);
            }
            let mut body = Vec::new();
            let _ = request.as_reader().read_to_end(&mut body);
            let method = request.method().as_str().to_string();
            let url = request.url().to_string();
            let header = |name: &'static str| {
                (request.headers().iter())
                    .find(|h| h.field.equiv(name))
                    .map(|h| h.value.as_str().to_string())
            };
            recorded.lock().unwrap().push(RecordedRequest {
                method: method.clone(),
                url: url.clone(),
                csrf_header: header("X-Csrf-Token"),
                cookie_header: header("Cookie"),
                body: body.clone(),
            });
            if let Some(hook) = self.on_request.as_mut() {
                hook(&method, &url);
            }
            let path = url.split('?').next().unwrap_or("");
            const JSON: Option<&str> = Some("application/json");
            let route = routes.iter().find(|(m, p, ..)| *m == method && *p == path);
            let shared_answer = (shared.as_ref())
                .filter(|_| method == "GET")
                .and_then(|shared| shared.lock().unwrap().answer(&url, path));
            let (status, content_type, body): (u16, Option<&str>, Vec<u8>) = match (
                method.as_str(),
                path,
            ) {
                _ if route.is_some() => {
                    let (.., status, body) = route.unwrap();
                    (*status, JSON, body.clone().into_bytes())
                }
                _ if shared_answer.is_some() => {
                    let (status, body) = shared_answer.unwrap();
                    (status, None, body)
                }
                ("GET", p) if p.ends_with("/updates") && !url.ends_with("?min_count=1") => {
                    let mut body = serde_json::json!({ "updates": self.history });
                    if self.endless_history {
                        body["nextBeforeTimestamp"] = serde_json::json!(1);
                    }
                    (200, JSON, body.to_string().into_bytes())
                }
                ("GET", p) if p.ends_with("/updates") => match versions.front().copied() {
                    None => (404, None, Vec::new()),
                    Some(version) => {
                        let version = version + moved;
                        if versions.len() > 1 {
                            versions.pop_front();
                        }
                        let update = match self.stamped {
                            true => serde_json::json!({ "meta": { "end_ts": version } }),
                            false => serde_json::json!({ "fromV": 0, "toV": version }),
                        };
                        let body = serde_json::json!({ "updates": [update] });
                        (200, JSON, body.to_string().into_bytes())
                    }
                },
                ("GET", p) if p.ends_with("/diff") => {
                    let query = reqwest::Url::parse(&format!("http://mock{url}")).unwrap();
                    let arg = |key: &str| {
                        let pairs = query.query_pairs();
                        pairs.into_iter().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
                    };
                    let (pathname, from, to) = (arg("pathname"), arg("from"), arg("to"));
                    let pathname = pathname.unwrap_or_default();
                    let version = |v: Option<String>| v.and_then(|v| v.parse::<i64>().ok());
                    let (from, to) = (version(from), version(to));
                    let name = pathname.rsplit('/').next().unwrap_or_default();
                    let scripted = (self.diffs.iter())
                        .find(|(p, f, t, _)| *p == pathname && Some(*f) == from && Some(*t) == to);
                    let diff = match scripted {
                        Some((.., parts)) => parts.clone(),
                        None if self.file_entities.contains(&name) => {
                            serde_json::json!({ "binary": true })
                        }
                        None => serde_json::json!([{ "u": "" }]),
                    };
                    (200, JSON, serde_json::json!({ "diff": diff }).to_string().into_bytes())
                }
                ("GET", "/project") => (200, Some("text/html"), html.clone().into_bytes()),
                ("GET", p) if p.ends_with("/download/zip") => {
                    downloads += 1;
                    let later = self.later_zip.as_ref().filter(|_| downloads > 1);
                    (200, None, later.unwrap_or(&self.zip).clone())
                }
                ("POST", "/project/new/upload") => {
                    let body = "{\"success\":true,\"project_id\":\"published-project-1\"}";
                    (200, JSON, body.into())
                }
                ("POST", p) if p.ends_with("/upload") => {
                    uploads += 1;
                    if self.fail_upload_at == Some(uploads) {
                        let (status, body) = self.upload_failure.unwrap_or((500, "upload failed"));
                        (status, JSON, body.into())
                    } else {
                        let body = String::from_utf8_lossy(&body);
                        let name = body.split("filename=\"").nth(1);
                        let name = name.and_then(|rest| rest.split('"').next()).unwrap_or_default();
                        if let Some(moves) = self.upload_moves {
                            moved += moves(name);
                        }
                        let body =
                            "{\"success\":true,\"entity_id\":\"e1\",\"entity_type\":\"file\"}";
                        (200, JSON, body.into())
                    }
                }
                ("POST", p) if p.ends_with("/folder") => {
                    let body = "{\"_id\":\"anchor-folder-1\",\"name\":\"tmp\",\"folders\":[],\"docs\":[],\"fileRefs\":[]}";
                    (200, JSON, body.into())
                }
                ("POST", p) if p.ends_with("/move") || p.ends_with("/rename") => {
                    (if self.fail_relocation { 500 } else { 204 }, None, Vec::new())
                }
                ("DELETE", _) => (204, None, Vec::new()),
                _ => (404, None, Vec::new()),
            };
            let mut response = tiny_http::Response::from_data(body).with_status_code(status);
            if let Some(content_type) = content_type {
                let header = format!("Content-Type: {content_type}").parse::<tiny_http::Header>();
                response = response.with_header(header.unwrap());
            }
            let _ = request.respond(response);
        });
        MockServer { base, requests }
    }
}

/// The dashboard: CSRF token, the signed-in user, and three projects.
pub(super) fn projects_page_html() -> String {
    dashboard_html(&default_projects(), &serde_json::json!([]))
}

/// The prefetched blob of [`projects_page_html`].
pub(super) fn default_projects() -> serde_json::Value {
    let owner = |email: &str, first: &str, last: &str| serde_json::json!({ "email": email, "firstName": first, "lastName": last });
    let project = |id: &str, name: &str, updated: &str, access: &str, archived: bool, owner| {
        serde_json::json!({
            "id": id, "name": name, "lastUpdated": updated, "accessLevel": access,
            "archived": archived, "trashed": false, "owner": owner,
        })
    };
    let researcher = owner("researcher@example.edu", "Robin", "Researcher");
    serde_json::json!({
        "totalSize": 3,
        "projects": [
            project("proj-old", "Old Paper", "2026-01-02T10:00:00.000Z", "owner", false, researcher.clone()),
            project("proj-new", "New Paper", "2026-07-01T10:00:00.000Z", "readAndWrite", false,
                owner("advisor@example.edu", "Ada", "Advisor")),
            project("proj-archived", "Archived Paper", "2026-03-01T10:00:00.000Z", "owner", true, researcher),
        ]
    })
}

/// A dashboard page carrying `projects` as its prefetched blob (left out when
/// null, as when Overleaf's background listing failed) and `notifications`.
pub(super) fn dashboard_html(
    projects: &serde_json::Value, notifications: &serde_json::Value,
) -> String {
    let user = serde_json::json!({
        "id": "u1", "email": "researcher@example.edu", "first_name": "Robin", "last_name": "Researcher"
    });
    let attr = |json: &serde_json::Value| {
        json.to_string().replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
    };
    let blob = match projects.is_null() {
        true => String::new(),
        false => format!(
            "<meta name=\"ol-prefetchedProjectsBlob\" data-type=\"json\" content=\"{}\">",
            attr(projects)
        ),
    };
    format!(
        "<html><head>\
         <meta name=\"ol-csrfToken\" content=\"{CSRF}\">\
         <meta name=\"ol-user\" data-type=\"json\" content=\"{}\">\
         <meta name=\"ol-notifications\" data-type=\"json\" content=\"{}\">\
         {blob}</head><body></body></html>",
        attr(&user),
        attr(notifications),
    )
}

pub(super) fn build_zip(entries: Files) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// Zip with a `../evil.tex` entry. The writer refuses `..` in names, so build
/// a same-length placeholder and patch the raw bytes (local header and central
/// directory both carry the name).
pub(super) fn build_malicious_zip() -> Vec<u8> {
    let mut bytes = build_zip(&[("xx/evil.tex", b"gotcha")]);
    let needle = b"xx/evil.tex";
    for index in 0..=bytes.len() - needle.len() {
        if &bytes[index..index + needle.len()] == needle {
            bytes[index..index + 2].copy_from_slice(b"..");
        }
    }
    bytes
}

/// A config dir holding a session signed in to `host`.
pub(super) fn signed_in(host: &str) -> TempDir {
    let config = TempDir::new("overleaf-config");
    let session = SessionFile {
        host: host.to_string(),
        cookie: "overleaf_session2=fixture-cookie".to_string(),
        email: Some("researcher@example.edu".to_string()),
        name: Some("Robin Researcher".to_string()),
        user_id: Some("user-1".to_string()),
        expired: false,
    };
    save_session(&config, &session).unwrap();
    config
}

/// A linked local project: files on disk plus a state file whose hashes (and
/// base copies, as a real clone records) describe the given base contents.
pub(super) fn seed_linked_project(root: &Path, host: &str, local_files: Files, base_files: Files) {
    for (rel, data) in local_files {
        let path = disk_path(root, rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
    }
    for (rel, data) in base_files {
        write_base_copy(root, rel, data).unwrap();
    }
    let state = SyncState {
        host: host.to_string(),
        project_id: "proj-1".to_string(),
        project_name: "Test Project".to_string(),
        root_folder_id: Some("root-folder-1".to_string()),
        last_sync: Some("2026-07-01T00:00:00Z".to_string()),
        permission: Some("readAndWrite".to_string()),
        files: base_files.iter().map(|(rel, data)| (rel.to_string(), sha256_hex(data))).collect(),
        ..Default::default()
    };
    save_state(root, &state).unwrap();
}

/// A project linked to overleaf.com, for tests that never reach the network.
pub(super) fn linked_root(local: Files, base: Files) -> TempDir {
    let root = TempDir::new("overleaf-project");
    seed_linked_project(&root, "https://www.overleaf.com", local, base);
    root
}

/// Link `root` to `server`, returning a config dir signed in to it.
pub(super) fn link_to(server: &MockServer, root: &Path, local: Files, base: Files) -> TempDir {
    seed_linked_project(root, &server.base, local, base);
    signed_in(&server.base)
}

/// `(config dir, project root)`: a session and a project linked to `server`.
pub(super) fn linked(server: &MockServer, local: Files, base: Files) -> (TempDir, TempDir) {
    let root = TempDir::new("overleaf-project");
    (link_to(server, &root, local, base), root)
}

/// Serve `mock`, link a project to it, and sync once.
pub(super) fn run_sync(
    mock: Mock, local: Files, base: Files,
) -> (MockServer, TempDir, OverleafSyncResult) {
    let server = mock.serve();
    let (config, root) = linked(&server, local, base);
    let result = sync(&config, &root, &BTreeSet::new(), None).unwrap();
    (server, root, result)
}

pub(super) fn edit_state(root: &Path, edit: impl FnOnce(&mut SyncState)) {
    let mut state = load_state(root).unwrap();
    edit(&mut state);
    save_state(root, &state).unwrap();
}

pub(super) fn read_local(root: &Path, rel: &str) -> Option<Vec<u8>> {
    fs::read(disk_path(root, rel)).ok()
}

pub(super) fn state_files(root: &Path) -> BTreeMap<String, String> {
    load_state(root).unwrap().files
}
