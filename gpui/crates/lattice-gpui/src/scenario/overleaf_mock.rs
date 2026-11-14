//! A local stand-in for Overleaf, for the e2e scenario's Overleaf steps: a
//! small HTTP server on 127.0.0.1 answering what the GPUI app and
//! lattice-core ask of Overleaf, and nothing reaching the real one.
//!
//! - `GET /login`: a sign-in page that sets the session cookie, as
//!   Overleaf's does once the writer has signed in.
//! - `GET /project`: the dashboard, with the CSRF token, the account and
//!   the project list in its meta tags, for a request carrying the session.
//! - `GET /project/{id}/updates`: the history (`?min_count=1`: the newest
//!   version alone).
//! - `GET /project/{id}/download/zip`: the project, zipped.
//! - `GET /project/{id}/diff`: who changed a file between two versions.
//! - `POST /project/{id}/upload`: one file, which becomes the next version.
//! - `/socket.io/…`: refused, as when the live channel cannot be reached;
//!   syncing carries on without it.
//!
//! The test changes the project between syncs as a co-author would
//! ([`MockOverleaf::edit`]).

use std::{
    collections::BTreeMap,
    io::{BufRead as _, BufReader, Read as _, Write as _},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
};

use serde_json::json;

pub const PROJECT_ID: &str = "proj-mock";
pub const PROJECT_NAME: &str = "Mock Paper";
pub const SESSION: &str = "overleaf_session2=mock-session";
pub const EMAIL: &str = "researcher@example.edu";

#[derive(Default)]
struct Project {
    files: BTreeMap<String, Vec<u8>>,
    version: i64,
    /// Newest first, as Overleaf lists it.
    history: Vec<serde_json::Value>,
    /// Every request, `METHOD path`, for the scenario's checks.
    requests: Vec<String>,
}

#[derive(Clone)]
pub struct MockOverleaf {
    pub base: String,
    project: Arc<Mutex<Project>>,
}

impl MockOverleaf {
    /// Serve a project holding `files`, at version 1.
    pub fn start(files: &[(&str, &str)]) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let project = Arc::new(Mutex::new(Project {
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_string(), text.as_bytes().to_vec()))
                .collect(),
            version: 1,
            history: vec![json!({ "fromV": 0, "toV": 1,
                "pathnames": files.iter().map(|(path, _)| *path).collect::<Vec<_>>(),
                "project_ops": [], "meta": { "end_ts": 0, "users": [{ "id": ME }] } })],
            requests: Vec::new(),
        }));
        let served = Arc::clone(&project);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let project = Arc::clone(&served);
                std::thread::spawn(move || {
                    let _ = answer(stream, &project);
                });
            }
        });
        Ok(Self { base, project })
    }

    /// A co-author's edit: `path` now reads `text`, at the next version.
    pub fn edit(&self, path: &str, text: &str) {
        let mut project = self.project.lock().unwrap();
        project
            .files
            .insert(path.to_string(), text.as_bytes().to_vec());
        bump(&mut project, path, CO_AUTHOR);
    }

    pub fn file(&self, path: &str) -> Option<String> {
        let project = self.project.lock().unwrap();
        project
            .files
            .get(path)
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }

    pub fn version(&self) -> i64 {
        self.project.lock().unwrap().version
    }

    /// How many requests matched `prefix` (`"POST /project/…/upload"`).
    pub fn requests(&self, prefix: &str) -> usize {
        let project = self.project.lock().unwrap();
        project
            .requests
            .iter()
            .filter(|request| request.starts_with(prefix))
            .count()
    }
}

/// The account a co-author's edits are by; the signed-in one is `u-mock`.
const CO_AUTHOR: &str = "u-coauthor";
const ME: &str = "u-mock";

fn bump(project: &mut Project, path: &str, author: &str) {
    let (from, to) = (project.version, project.version + 1);
    project.history.insert(
        0,
        json!({ "fromV": from, "toV": to, "pathnames": [path], "project_ops": [],
            "meta": { "end_ts": to, "users": [{ "id": author }] } }),
    );
    project.version = to;
}

/// `{"diff": parts}` for `pathname` between `from` and `to`, each edit
/// part naming who made it.
fn diff(project: &Project, url: &str) -> serde_json::Value {
    let arg = |key: &str| {
        url.split(['?', '&'])
            .find_map(|pair| pair.strip_prefix(&format!("{key}=")))
            .map(|value| value.replace("%2F", "/"))
    };
    let pathname = arg("pathname").unwrap_or_default();
    let number = |key: &str| {
        arg(key)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let (from, to) = (number("from"), number("to"));
    let parts: Vec<serde_json::Value> = project
        .history
        .iter()
        .filter(|update| {
            let at = update["toV"].as_i64().unwrap_or(0);
            at > from
                && at <= to
                && update["pathnames"]
                    .as_array()
                    .is_some_and(|paths| paths.iter().any(|path| path == pathname.as_str()))
        })
        .map(|update| json!({ "i": "text", "meta": { "users": update["meta"]["users"].clone() } }))
        .collect();
    json!({ "diff": if parts.is_empty() { vec![json!({ "u": "" })] } else { parts } })
}

fn dashboard() -> String {
    let attr = |value: &serde_json::Value| {
        value
            .to_string()
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
    };
    let user =
        json!({ "id": "u-mock", "email": EMAIL, "first_name": "Robin", "last_name": "Researcher" });
    let projects = json!({
        "totalSize": 2,
        "projects": [
            { "id": PROJECT_ID, "name": PROJECT_NAME, "lastUpdated": "2026-11-12T10:00:00.000Z",
              "accessLevel": "owner", "archived": false, "trashed": false,
              "owner": { "email": EMAIL, "firstName": "Robin", "lastName": "Researcher" } },
            { "id": "proj-shelved", "name": "Shelved Draft", "lastUpdated": "2026-01-02T10:00:00.000Z",
              "accessLevel": "owner", "archived": true, "trashed": false,
              "owner": { "email": EMAIL, "firstName": "Robin", "lastName": "Researcher" } },
        ],
    });
    format!(
        "<html><head>\
         <meta name=\"ol-csrfToken\" content=\"mock-csrf\">\
         <meta name=\"ol-user_id\" content=\"u-mock\">\
         <meta name=\"ol-user\" data-type=\"json\" content=\"{}\">\
         <meta name=\"ol-notifications\" data-type=\"json\" content=\"[]\">\
         <meta name=\"ol-prefetchedProjectsBlob\" data-type=\"json\" content=\"{}\">\
         </head><body>Projects</body></html>",
        attr(&user),
        attr(&projects),
    )
}

fn zip(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .expect("a zip entry");
        writer.write_all(bytes).expect("zip bytes");
    }
    writer.finish().expect("the zip").into_inner()
}

/// A multipart form's text field `name`, and its file part's bytes.
fn multipart(body: &[u8], content_type: &str) -> Option<(String, Vec<u8>)> {
    let boundary = content_type.split("boundary=").nth(1)?.trim_matches('"');
    let delimiter = format!("--{boundary}");
    let text = body;
    let mut relative = None;
    let mut file = None;
    let mut rest = text;
    while let Some(at) = find(rest, delimiter.as_bytes()) {
        rest = &rest[at + delimiter.len()..];
        let Some(head_end) = find(rest, b"\r\n\r\n") else {
            break;
        };
        let head = String::from_utf8_lossy(&rest[..head_end]).to_string();
        let content = &rest[head_end + 4..];
        let end = find(content, delimiter.as_bytes()).unwrap_or(content.len());
        let value = content[..end]
            .strip_suffix(b"\r\n")
            .unwrap_or(&content[..end]);
        if head.contains("name=\"relativePath\"") {
            relative = Some(String::from_utf8_lossy(value).into_owned());
        } else if head.contains("name=\"qqfile\"") {
            file = Some(value.to_vec());
        }
    }
    Some((relative?, file?))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn answer(stream: TcpStream, project: &Mutex<Project>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, url) = (
        parts.next().unwrap_or_default().to_string(),
        parts.next().unwrap_or_default().to_string(),
    );
    let mut headers = BTreeMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|length| length.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let path = url.split('?').next().unwrap_or_default().to_string();
    let signed_in = headers
        .get("cookie")
        .is_some_and(|cookie| cookie.contains(SESSION));
    let project_path = format!("/project/{PROJECT_ID}");
    let (status, content_type, extra, body): (u16, &str, Option<String>, Vec<u8>) = {
        let mut project = project.lock().unwrap();
        project.requests.push(format!("{method} {path}"));
        match (method.as_str(), path.as_str()) {
            ("GET", "/login") => (
                200,
                "text/html",
                Some(format!("Set-Cookie: {SESSION}; Path=/")),
                b"<html><body><h1>Signed in to the mock Overleaf</h1></body></html>".to_vec(),
            ),
            ("GET", "/project") if signed_in => (200, "text/html", None, dashboard().into_bytes()),
            ("GET", "/project") => (
                302,
                "text/html",
                Some("Location: /login".into()),
                Vec::new(),
            ),
            (_, _) if !signed_in => (
                302,
                "text/html",
                Some("Location: /login".into()),
                Vec::new(),
            ),
            ("GET", p) if p == format!("{project_path}/updates") => {
                let body = if url.contains("min_count=1") {
                    json!({ "updates": [{ "fromV": project.version - 1, "toV": project.version }] })
                } else {
                    json!({ "updates": project.history })
                };
                (200, "application/json", None, body.to_string().into_bytes())
            }
            ("GET", p) if p == format!("{project_path}/diff") => (
                200,
                "application/json",
                None,
                diff(&project, &url).to_string().into_bytes(),
            ),
            ("GET", p) if p == format!("{project_path}/download/zip") => {
                (200, "application/zip", None, zip(&project.files))
            }
            ("POST", p) if p == format!("{project_path}/upload") => {
                let content_type = headers.get("content-type").cloned().unwrap_or_default();
                match multipart(&body, &content_type) {
                    Some((relative, bytes)) => {
                        project.files.insert(relative.clone(), bytes);
                        bump(&mut project, &relative, ME);
                        (
                            200,
                            "application/json",
                            None,
                            json!({ "success": true, "entity_id": "e-upload", "entity_type": "doc" })
                                .to_string()
                                .into_bytes(),
                        )
                    }
                    None => (
                        400,
                        "application/json",
                        None,
                        b"{\"success\":false}".to_vec(),
                    ),
                }
            }
            _ => (404, "text/plain", None, b"not found".to_vec()),
        }
    };
    let reason = match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let mut stream = stream;
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )?;
    if let Some(extra) = extra {
        write!(stream, "{extra}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(&body)?;
    stream.flush()
}
