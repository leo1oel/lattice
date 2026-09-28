//! Fixtures shared by the Overleaf tests: a mock Overleaf that records every
//! request it is sent, and linked projects on disk to sync against it.

use super::account::{save_session, SessionFile};
use super::files::{disk_path, sha256_hex, write_base_copy};
use super::link::{load_state, save_state, SyncState};
use super::sync::{sync, OverleafSyncResult};
use crate::overleaf_rt::tests::serve_http;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

/// How the mock Overleaf behaves. Its dashboard is always
/// [`projects_page_html`].
#[derive(Default)]
pub(super) struct Mock {
    /// The project download.
    pub zip: Vec<u8>,
    /// Served one per `/updates` request (the last value repeats). An empty
    /// list answers 404, matching an instance without history.
    pub versions: Vec<i64>,
    /// The nth file upload (counting from 1) fails.
    pub fail_upload_at: Option<usize>,
    /// Move and rename requests fail.
    pub fail_relocation: bool,
}

impl Mock {
    pub fn project(files: Files) -> Self {
        Mock { zip: build_zip(files), ..Default::default() }
    }

    pub fn serve(self) -> MockServer {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let mut versions: VecDeque<i64> = self.versions.iter().copied().collect();
        let mut uploads = 0usize;
        let html = projects_page_html();
        let base = serve_http(move |mut request| {
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
                body,
            });
            let path = url.split('?').next().unwrap_or("");
            const JSON: Option<&str> = Some("application/json");
            let (status, content_type, body): (u16, Option<&str>, Vec<u8>) = match (
                method.as_str(),
                path,
            ) {
                ("GET", p) if p.ends_with("/updates") => match versions.front().copied() {
                    None => (404, None, Vec::new()),
                    Some(version) => {
                        if versions.len() > 1 {
                            versions.pop_front();
                        }
                        let body = format!("{{\"updates\":[{{\"fromV\":0,\"toV\":{version}}}]}}");
                        (200, JSON, body.into_bytes())
                    }
                },
                ("GET", "/project") => (200, Some("text/html"), html.clone().into_bytes()),
                ("GET", p) if p.ends_with("/download/zip") => (200, None, self.zip.clone()),
                ("POST", "/project/new/upload") => {
                    let body = "{\"success\":true,\"project_id\":\"published-project-1\"}";
                    (200, JSON, body.into())
                }
                ("POST", p) if p.ends_with("/upload") => {
                    uploads += 1;
                    if self.fail_upload_at == Some(uploads) {
                        (500, None, b"upload failed".to_vec())
                    } else {
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
    let owner = |email: &str, first: &str, last: &str| serde_json::json!({ "email": email, "firstName": first, "lastName": last });
    let project = |id: &str, name: &str, updated: &str, access: &str, archived: bool, owner| {
        serde_json::json!({
            "id": id, "name": name, "lastUpdated": updated, "accessLevel": access,
            "archived": archived, "trashed": false, "owner": owner,
        })
    };
    let researcher = owner("researcher@example.edu", "Robin", "Researcher");
    let projects = serde_json::json!({
        "totalSize": 3,
        "projects": [
            project("proj-old", "Old Paper", "2026-01-02T10:00:00.000Z", "owner", false, researcher.clone()),
            project("proj-new", "New Paper", "2026-07-01T10:00:00.000Z", "readAndWrite", false,
                owner("advisor@example.edu", "Ada", "Advisor")),
            project("proj-archived", "Archived Paper", "2026-03-01T10:00:00.000Z", "owner", true, researcher),
        ]
    });
    let user = serde_json::json!({
        "id": "u1", "email": "researcher@example.edu", "first_name": "Robin", "last_name": "Researcher"
    });
    let attr = |json: &serde_json::Value| {
        html_escape::encode_double_quoted_attribute(&json.to_string()).into_owned()
    };
    format!(
        "<html><head>\
         <meta name=\"ol-csrfToken\" content=\"{CSRF}\">\
         <meta name=\"ol-user\" data-type=\"json\" content=\"{}\">\
         <meta name=\"ol-prefetchedProjectsBlob\" data-type=\"json\" content=\"{}\">\
         </head><body></body></html>",
        attr(&user),
        attr(&projects),
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

pub(super) fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("overleaf-rs-test-{label}-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn write_session_file(config_dir: &Path, host: &str) {
    let session = SessionFile {
        host: host.to_string(),
        cookie: "overleaf_session2=fixture-cookie".to_string(),
        email: Some("researcher@example.edu".to_string()),
        name: Some("Robin Researcher".to_string()),
        user_id: Some("user-1".to_string()),
    };
    save_session(config_dir, &session).unwrap();
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

/// `(config dir, project root)`: a session and a project linked to `server`.
pub(super) fn linked(server: &MockServer, local: Files, base: Files) -> (PathBuf, PathBuf) {
    let (config, root) = (temp_dir("config"), temp_dir("project"));
    write_session_file(&config, &server.base);
    seed_linked_project(&root, &server.base, local, base);
    (config, root)
}

/// Serve `mock`, link a project to it, and sync once.
pub(super) fn run_sync(
    mock: Mock, local: Files, base: Files,
) -> (MockServer, PathBuf, OverleafSyncResult) {
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
