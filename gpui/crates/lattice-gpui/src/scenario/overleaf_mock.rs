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
//! - `GET /project/{id}/diff`: a file's text between two versions, as
//!   unchanged, deleted and inserted runs, the edits naming who made them.
//! - Overleaf's own history and the chat (`overleaf_history_mock`).
//! - `POST /project/{id}/upload`: one file, which becomes the next version.
//! - `/socket.io/…`: a gateway error, as when the live channel cannot be
//!   reached (syncing carries on without it, and the client keeps retrying),
//!   unless the stand-in was started
//!   [`MockOverleaf::enable_realtime`], when `overleaf_realtime_mock` serves it.
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

use super::overleaf_history_mock as history;
use super::overleaf_realtime_mock::{self as realtime, Live, Store};
use super::overleaf_review_mock as review;

pub const PROJECT_ID: &str = "proj-mock";
pub const PROJECT_NAME: &str = "Mock Paper";
pub const SESSION: &str = "overleaf_session2=mock-session";
pub const EMAIL: &str = "researcher@example.edu";

#[derive(Default)]
pub(super) struct Project {
    pub(super) files: BTreeMap<String, Vec<u8>>,
    version: i64,
    /// Newest first, as Overleaf lists it.
    history: Vec<serde_json::Value>,
    /// The files at each version the project reached.
    pub(super) snapshots: BTreeMap<i64, BTreeMap<String, Vec<u8>>>,
    /// The names versions carry (`POST /labels`).
    pub(super) labels: Vec<serde_json::Value>,
    /// The chat, oldest first.
    pub(super) chat: Vec<serde_json::Value>,
    pub(super) next_id: u64,
    /// Every request, `METHOD path`, for the scenario's checks.
    requests: Vec<String>,
    /// The history and chat requests, `METHOD path` after the project.
    pub(super) history_requests: Vec<String>,
    /// The live channel is served.
    realtime: bool,
    pub(super) live: Live,
}

impl Store for Mutex<Project> {
    fn with<R>(&self, work: impl FnOnce(&mut BTreeMap<String, Vec<u8>>, &mut Live) -> R) -> R {
        let mut project = self.lock().unwrap();
        let Project { files, live, .. } = &mut *project;
        work(files, live)
    }

    fn bump(&self, path: &str, author: &str) {
        bump(&mut self.lock().unwrap(), path, author);
    }
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
        let files: BTreeMap<String, Vec<u8>> = files
            .iter()
            .map(|(path, text)| ((*path).to_string(), text.as_bytes().to_vec()))
            .collect();
        let project = Arc::new(Mutex::new(Project {
            version: 1,
            history: vec![json!({ "fromV": 0, "toV": 1,
                "pathnames": files.keys().collect::<Vec<_>>(),
                "project_ops": [], "meta": { "end_ts": chrono::Utc::now().timestamp_millis(), "users": [history::person(ME)] } })],
            snapshots: BTreeMap::from([(1, files.clone())]),
            files,
            ..Default::default()
        }));
        let served = Arc::clone(&project);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let project = Arc::clone(&served);
                std::thread::spawn(move || {
                    let _ = answer(stream, project);
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

    /// Serve the live channel from now on (`overleaf_realtime_mock`).
    pub fn enable_realtime(&self) {
        self.project.lock().unwrap().realtime = true;
    }

    /// Refuse the live channel's handshake again (an open socket stays).
    pub fn disable_realtime(&self) {
        self.project.lock().unwrap().realtime = false;
    }

    /// The scripted collaborator is in `path` at the zero-based `row` and
    /// UTF-16 `column`.
    pub fn peer_at(&self, path: &str, row: i64, column: i64) {
        realtime::peer_at(&mut self.project.lock().unwrap().live, path, row, column);
    }

    /// The scripted collaborator leaves.
    pub fn peer_left(&self) {
        realtime::peer_left(&mut self.project.lock().unwrap().live);
    }

    /// The scripted collaborator types `ops` into `path` over the live
    /// channel; false when they do not fit.
    pub fn peer_typed(&self, path: &str, ops: Vec<lattice_core::overleaf_rt::OtOp>) -> bool {
        let typed = {
            let mut project = self.project.lock().unwrap();
            let Project { files, live, .. } = &mut *project;
            realtime::peer_typed(files, live, path, ops).is_some()
        };
        if typed {
            bump(&mut self.project.lock().unwrap(), path, CO_AUTHOR);
        }
        typed
    }

    /// Drop the live socket at the app's next update, after it lands
    /// (`landed`, its acknowledgement lost) or before it does.
    pub fn sever(&self, landed: bool) {
        self.project.lock().unwrap().live.sever = Some(landed);
    }

    /// The scripted collaborator suggests `ops` in `path` (tracked
    /// changes); false when they do not fit.
    pub fn peer_suggested(&self, path: &str, ops: Vec<lattice_core::overleaf_rt::OtOp>) -> bool {
        let suggested = {
            let mut project = self.project.lock().unwrap();
            let Project { files, live, .. } = &mut *project;
            review::peer_suggested(files, live, path, ops)
        };
        if suggested {
            bump(&mut self.project.lock().unwrap(), path, CO_AUTHOR);
        }
        suggested
    }

    /// The scripted collaborator starts a thread on `quote` at UTF-16
    /// `position` of `path`; its id.
    pub fn peer_commented(&self, path: &str, position: i64, quote: &str, content: &str) -> String {
        let mut project = self.project.lock().unwrap();
        review::peer_commented(&mut project.live, path, position, quote, content)
    }

    /// Turn the project's track changes on or off for everyone, as the
    /// browser's toggle does.
    pub fn set_track_changes(&self, on: bool) {
        let mut project = self.project.lock().unwrap();
        project.live.track_changes = on;
        realtime::broadcast(
            &project.live,
            None,
            &realtime::event("toggle-track-changes", serde_json::json!([on])),
        );
    }

    /// `path`'s suggestions on the stand-in.
    pub fn changes(&self, path: &str) -> Vec<lattice_core::overleaf_rt::TrackedChange> {
        self.project.lock().unwrap().live.review.changes(path)
    }

    /// `path`'s comment anchors on the stand-in.
    pub fn comments(&self, path: &str) -> Vec<lattice_core::overleaf_rt::CommentRange> {
        self.project.lock().unwrap().live.review.comments(path)
    }

    /// Thread `id`'s messages and whether it is resolved.
    pub fn thread(&self, id: &str) -> Option<(Vec<String>, bool)> {
        self.project.lock().unwrap().live.review.thread(id)
    }

    /// The review REST requests, `METHOD path` after the project.
    pub fn review_requests(&self) -> Vec<String> {
        self.project.lock().unwrap().live.review.requests.clone()
    }

    /// Every caret position the app published, as sent.
    pub fn positions(&self) -> Vec<serde_json::Value> {
        self.project.lock().unwrap().live.positions.clone()
    }

    /// Every live update the app sent, as sent.
    pub fn updates(&self) -> Vec<serde_json::Value> {
        self.project.lock().unwrap().live.updates.clone()
    }

    /// The live channel's requests, as `METHOD path realtime=… signed_in=…`.
    pub fn socket_requests(&self) -> Vec<String> {
        let project = self.project.lock().unwrap();
        project
            .requests
            .iter()
            .filter(|request| request.contains("/socket.io/"))
            .cloned()
            .collect()
    }

    /// Every live update the stand-in refused, with the text it met.
    pub fn rejected(&self) -> Vec<serde_json::Value> {
        self.project.lock().unwrap().live.rejected.clone()
    }

    pub fn version(&self) -> i64 {
        self.project.lock().unwrap().version
    }

    /// The scripted collaborator says `content` in the project chat.
    pub fn peer_chats(&self, content: &str) {
        history::post_chat(&mut self.project.lock().unwrap(), "u-peer", content);
    }

    /// The chat's messages, oldest first, as `(author id, content)`.
    pub fn chat(&self) -> Vec<(String, String)> {
        let project = self.project.lock().unwrap();
        project
            .chat
            .iter()
            .map(|message| {
                let text =
                    |value: &serde_json::Value| value.as_str().unwrap_or_default().to_string();
                (text(&message["user"]["id"]), text(&message["content"]))
            })
            .collect()
    }

    /// The labels' comments, by the version each names.
    pub fn labels(&self) -> Vec<(i64, String)> {
        let project = self.project.lock().unwrap();
        project
            .labels
            .iter()
            .map(|label| {
                let version = label["version"].as_i64().unwrap_or_default();
                (
                    version,
                    label["comment"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect()
    }

    /// The history and chat REST requests, `METHOD path` after the project.
    pub fn history_requests(&self) -> Vec<String> {
        self.project.lock().unwrap().history_requests.clone()
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
    bump_by(project, &[path.to_string()], author, None);
}

/// The project reached its next version, `author` changing `paths`, from
/// `origin` when not the editor ("file-restore", "project-restore").
pub(super) fn bump_by(project: &mut Project, paths: &[String], author: &str, origin: Option<&str>) {
    let (from, to) = (project.version, project.version + 1);
    let now = chrono::Utc::now().timestamp_millis();
    let mut meta = json!({ "start_ts": now, "end_ts": now, "users": [history::person(author)] });
    if let Some(origin) = origin {
        meta["origin"] = json!({ "kind": origin });
    }
    project.history.insert(
        0,
        json!({ "fromV": from, "toV": to, "pathnames": paths, "project_ops": [], "meta": meta }),
    );
    project.version = to;
    project.snapshots.insert(to, project.files.clone());
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
    let touching: Vec<&serde_json::Value> = project
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
        .collect();
    let users: Vec<serde_json::Value> = touching
        .iter()
        .flat_map(|update| {
            update["meta"]["users"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    let (before, after) = history::texts(project, &pathname, from, to);
    let mut parts = history::chunks(&before, &after, &users);
    let edited = parts
        .iter()
        .any(|part| part.get("i").or(part.get("d")).is_some());
    if !edited {
        // Edits that left the text as it was still name who made them.
        parts.extend(touching.iter().map(
            |update| json!({ "i": "", "meta": { "users": update["meta"]["users"].clone() } }),
        ));
    }
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

fn answer(stream: TcpStream, project: Arc<Mutex<Project>>) -> std::io::Result<()> {
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
    if path.starts_with("/socket.io/1/") {
        let mut project = project.lock().unwrap();
        let line = format!(
            "{method} {path} realtime={} signed_in={signed_in}",
            project.realtime
        );
        project.requests.push(line);
    }
    if path.starts_with("/socket.io/1/") && signed_in && !project.lock().unwrap().realtime {
        // Unreachable, as a load balancer with no live-channel backend says:
        // a gateway error, which the client retries with its backoff.
        let mut stream = stream;
        write!(
            stream,
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?;
        return stream.flush();
    }
    if path.starts_with("/socket.io/1/") && signed_in {
        if path.starts_with("/socket.io/1/websocket/") {
            let key = headers
                .get("sec-websocket-key")
                .cloned()
                .unwrap_or_default();
            return realtime::upgrade(stream, &key, project);
        }
        let mut stream = stream;
        let body = realtime::handshake();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(&body)?;
        return stream.flush();
    }
    let (status, content_type, extra, body): (u16, &str, Option<String>, Vec<u8>) = {
        let mut project = project.lock().unwrap();
        project.requests.push(format!("{method} {path}"));
        // Comment threads and suggestions (`overleaf_review_mock`).
        let mut review = path
            .strip_prefix(&project_path)
            .filter(|_| signed_in)
            .and_then(|rest| {
                let Project { files, live, .. } = &mut *project;
                review::rest(live, files, &method, rest, &body)
            })
            .or_else(|| {
                let rest = path.strip_prefix(&project_path).filter(|_| signed_in)?;
                history::rest(&mut project, &method, rest, &url, &body)
            });
        match (method.as_str(), path.as_str()) {
            _ if review.is_some() => {
                let (status, answer) = review.take().unwrap_or_default();
                (
                    status,
                    "application/json",
                    None,
                    answer.to_string().into_bytes(),
                )
            }
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
                    let updates: Vec<serde_json::Value> = project
                        .history
                        .iter()
                        .map(|update| {
                            let mut update = update.clone();
                            let to = update["toV"].as_i64().unwrap_or_default();
                            update["labels"] = json!(history::labels_on(&project, to));
                            update
                        })
                        .collect();
                    json!({ "updates": updates })
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
