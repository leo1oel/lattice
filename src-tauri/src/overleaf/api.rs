//! HTTP plumbing every Overleaf REST call shares: the client, the dead-session
//! check, the dashboard page (which carries the CSRF token mutations need),
//! project downloads, and [`Remote`], the request context for a linked
//! project. Uploads are `upload`'s.

use super::account::{ensure_user_id, load_session, normalize_host, SessionFile};
use super::files::{is_excluded, BuildPdf};
use super::link::{load_state, SyncState, PAUSED};
use crate::overleaf_rt::{SESSION_EXPIRED, USER_AGENT};
use crate::util::err;
use crate::wide_event;
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, RETRY_AFTER};
use reqwest::{Method, StatusCode};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

pub(super) const JSON: &str = "application/json";

pub(super) fn http_client(timeout_secs: u64) -> Result<Client, String> {
    crate::http::blocking_as(USER_AGENT, Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(err)
}

/// A dead session shows up as a redirect to the login page (which reqwest has
/// already followed) or as a flat refusal.
fn check_authenticated(response: &Response) -> Result<(), String> {
    let status = response.status().as_u16();
    if response.url().path().contains("/login") || status == 401 || status == 403 {
        return Err(SESSION_EXPIRED.to_string());
    }
    Ok(())
}

/// Send, naming a transport failure with `failed` and a dead session as such.
/// A transient failure is retried first; see [`retry_wait`].
pub(super) fn send_as(
    request: RequestBuilder, failed: impl FnOnce(reqwest::Error) -> String,
) -> Result<Response, String> {
    let response = send_with_retries(request).map_err(failed)?;
    check_authenticated(&response)?;
    Ok(response)
}

/// Attempts after the first one, for a failure that is likely to pass.
const TRANSIENT_RETRIES: u32 = 2;
/// The first wait between attempts; it doubles each time.
const RETRY_BASE: Duration = Duration::from_secs(1);
/// The longest `Retry-After` honoured. Anything longer fails now instead of
/// leaving a sync hanging with no explanation.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(8);

/// How one attempt ended, as far as deciding on another goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attempt<'a> {
    /// The connection was never made, so the request never reached Overleaf.
    NotConnected,
    /// Sent, but no complete answer came back — the connection was reset.
    NoAnswer,
    Answered(StatusCode, Option<&'a str>),
}

/// How long to wait before trying again, or `None` to give up now.
///
/// A blip — a gateway error while Overleaf restarts an instance, a reset
/// connection, a rate limit — otherwise fails a whole sync or a history read
/// that would have worked a second later. Retrying is only safe when it cannot
/// do something twice, though: anything is retried when it provably never
/// reached Overleaf (no connection, or 429, which refuses before doing
/// anything); a request that may have been carried out only when doing it
/// again changes nothing, which for HTTP is what a safe (read-only) method
/// promises. An idempotent DELETE is not enough: its effect repeats harmlessly
/// but its answer does not — the retry is told 404 for what the first attempt
/// already deleted.
fn retry_wait(attempt: Attempt, safe: bool, retries_done: u32) -> Option<Duration> {
    if retries_done >= TRANSIENT_RETRIES {
        return None;
    }
    let backoff = RETRY_BASE * 2u32.pow(retries_done);
    match attempt {
        Attempt::NotConnected => Some(backoff),
        Attempt::NoAnswer if safe => Some(backoff),
        Attempt::Answered(StatusCode::TOO_MANY_REQUESTS, retry_after) => {
            match retry_after.map(|value| value.trim().parse::<u64>()) {
                Some(Ok(seconds)) if Duration::from_secs(seconds) > MAX_RETRY_WAIT => None,
                Some(Ok(seconds)) => Some(Duration::from_secs(seconds)),
                _ => Some(backoff),
            }
        }
        Attempt::Answered(
            StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT,
            _,
        ) if safe => Some(backoff),
        _ => None,
    }
}

fn send_with_retries(mut request: RequestBuilder) -> reqwest::Result<Response> {
    // A streamed body (a multipart upload) cannot be cloned, and so is never
    // retried: `try_clone` answers `None` for it.
    let safe = (request.try_clone().and_then(|copy| copy.build().ok()))
        .is_some_and(|built| built.method().is_safe());
    let mut retries_done = 0;
    loop {
        let again = request.try_clone();
        wide_event::add("http_requests", 1);
        let outcome = request.send();
        let attempt = match &outcome {
            Ok(response) => Attempt::Answered(
                response.status(),
                response.headers().get(RETRY_AFTER).and_then(|value| value.to_str().ok()),
            ),
            Err(error) if error.is_connect() => Attempt::NotConnected,
            // A timeout already spent the caller's whole budget; tripling it
            // is not a retry. (A project download retries on its own terms.)
            Err(error) if error.is_timeout() => return outcome,
            Err(_) => Attempt::NoAnswer,
        };
        let wait = retry_wait(attempt, safe, retries_done);
        let (Some(wait), Some(again)) = (wait, again) else { return outcome };
        wide_event::add("http_retries", 1);
        std::thread::sleep(wait);
        request = again;
        retries_done += 1;
    }
}

pub(super) fn send(request: RequestBuilder) -> Result<Response, String> {
    send_as(request, |e| format!("Could not reach Overleaf: {e}"))
}

/// `what` completes "Overleaf returned 500 …", e.g. "for the project chat".
pub(super) fn expect_success(response: Response, what: &str) -> Result<Response, String> {
    if !response.status().is_success() {
        return Err(format!("Overleaf returned {} {what}.", response.status()));
    }
    Ok(response)
}

// ---- The dashboard ----------------------------------------------------------

/// `GET {host}/project`, the page whose meta tags carry the account, the
/// project list and the CSRF token.
pub(super) fn fetch_projects_page(
    client: &Client, host: &str, cookie: &str,
) -> Result<String, String> {
    let request = client
        .get(format!("{host}/project"))
        .header(COOKIE, cookie)
        .header(ACCEPT, "text/html,application/xhtml+xml");
    expect_success(send(request)?, "for the project list")?.text().map_err(|error| {
        format!("Could not reach Overleaf while reading the project list: {error}")
    })
}

pub(super) fn csrf_token(client: &Client, host: &str, cookie: &str) -> Result<String, String> {
    let page = fetch_projects_page(client, host, cookie)?;
    meta_content(&page, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())
}

/// Extract the decoded `content` attribute of `<meta name="...">`.
pub(super) fn meta_content(html: &str, name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    for (start, _) in html.match_indices("<meta") {
        let end = start + html[start..].find('>')?;
        let tag = &html[start..end];
        if !tag.contains(&needle) {
            continue;
        }
        let value_start = tag.find("content=\"")? + "content=\"".len();
        let value_end = value_start + tag[value_start..].find('"')?;
        return Some(crate::util::decode_html_attribute(&tag[value_start..value_end]).into_owned());
    }
    None
}

/// The first of `keys` holding a non-blank string, trimmed.
pub(super) fn json_str(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|k| value.get(k).and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
}

/// "Ada Lovelace" from whichever spelling of the name fields this Overleaf
/// uses, or None when both are blank.
pub(super) fn full_name(user: &Value) -> Option<String> {
    let first = json_str(user, &["first_name", "firstName"]).unwrap_or_default();
    let last = json_str(user, &["last_name", "lastName"]).unwrap_or_default();
    Some(format!("{first} {last}").trim().to_string()).filter(|name| !name.is_empty())
}

// ---- Project snapshots ------------------------------------------------------

/// How far a project download has got: bytes received so far, and the whole
/// size when Overleaf says it up front (it streams the zip as it builds it, so
/// usually it does not). Starts again from zero when an attempt is retried.
pub type DownloadProgress<'a> = &'a (dyn Fn(u64, Option<u64>) + Sync);

/// Passed just before a sync downloads the project ZIP, and only then:
/// the app holds downloads to the account-wide gap between them here.
pub type DownloadGate<'a> = &'a (dyn Fn() + Sync);

/// Attempts at a project download in all, for one that breaks off part way.
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// Why one attempt at a download did not produce the zip.
enum Download {
    /// The connection failed, stalled or broke off: the next attempt may well
    /// get through. Overleaf builds the zip afresh for each request, so there
    /// is nothing to resume; the retry starts from the first byte.
    Interrupted(String),
    /// Overleaf answered, and trying again would get the same answer.
    Refused(String),
}

/// `GET {host}/project/{id}/download/zip`, the whole project.
///
/// A project with a few multi-megabyte PDFs is tens of megabytes, which over
/// a slow or distant link takes minutes. So the client's deadline bounds each
/// read of the body (a stall), never the download as a whole: reqwest's
/// blocking `bytes()` gives the entire body one deadline, and a download that
/// was still arriving failed at it, minutes in, as "error decoding response
/// body". An attempt that stalls or breaks off is tried again.
pub(super) fn download_project_zip(
    client: &Client, host: &str, cookie: &str, project_id: &str, progress: DownloadProgress,
) -> Result<Vec<u8>, String> {
    let url = format!("{host}/project/{project_id}/download/zip");
    let mut attempt = 1;
    loop {
        match download_once(client.get(&url).header(COOKIE, cookie), progress) {
            Ok(bytes) => return Ok(bytes),
            Err(Download::Interrupted(error)) if attempt < DOWNLOAD_ATTEMPTS => {
                log::warn!(target: "lattice::overleaf", "Retrying the project download: {error}");
                wide_event::add("download_retries", 1);
                std::thread::sleep(RETRY_BASE * 2u32.pow(attempt));
                attempt += 1;
            }
            Err(Download::Interrupted(error) | Download::Refused(error)) => return Err(error),
        }
    }
}

fn download_once(request: RequestBuilder, progress: DownloadProgress) -> Result<Vec<u8>, Download> {
    let response = send_with_retries(request).map_err(|e| {
        Download::Interrupted(format!("Could not download the project from Overleaf: {e}"))
    })?;
    check_authenticated(&response).map_err(Download::Refused)?;
    let mut response =
        expect_success(response, "for the project download").map_err(Download::Refused)?;
    let content_type = (response.headers().get(CONTENT_TYPE))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let total = response.content_length();
    let mut bytes = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    progress(0, total);
    loop {
        // Each read gets the client's whole deadline (see the blocking
        // `Response`'s `Read`), so this fails only when the bytes stop.
        match response.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                bytes.extend_from_slice(&chunk[..read]);
                progress(bytes.len() as u64, total);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(Download::Interrupted(format!(
                    "Could not reach Overleaf while reading the project download: {error}"
                )));
            }
        }
    }
    if content_type.contains("text/html") || !bytes.starts_with(b"PK") {
        return Err(Download::Refused(SESSION_EXPIRED.to_string()));
    }
    Ok(bytes)
}

/// Read a project zip into path → bytes, rejecting zip-slip entries.
pub(super) fn read_zip_entries(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Overleaf sent an unreadable zip archive: {e}"))?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(err)?;
        if file.is_dir() {
            continue;
        }
        let name = crate::project::safe_zip_entry_name(&file).ok_or_else(|| {
            format!(
                "Refusing unsafe path in Overleaf zip: {}",
                crate::project::zip_entry_display_name(&file)
            )
        })?;
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(err)?;
        entries.insert(name, data);
    }
    Ok(entries)
}

/// Best-effort read of the project's newest history version. A failure here
/// only costs the next probe a redundant sync, so it never fails a sync.
pub(super) fn fetch_remote_version(
    client: &Client, host: &str, cookie: &str, project_id: &str,
) -> Option<i64> {
    fetch_history_version(client, host, cookie, project_id).map(HistoryVersion::value)
}

/// [`fetch_remote_version`], saying which kind of number Overleaf gave.
fn fetch_history_version(
    client: &Client, host: &str, cookie: &str, project_id: &str,
) -> Option<HistoryVersion> {
    wide_event::add("http_requests", 1);
    let response = client
        .get(format!("{host}/project/{project_id}/updates?min_count=1"))
        .header(COOKIE, cookie)
        .header(ACCEPT, JSON)
        // A sync shares one long-deadline client so every request reuses the
        // connection; this small read still gives up as early as it used to.
        .timeout(Duration::from_secs(30))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    latest_update(&response.json::<Value>().ok()?)
}

/// A number that only moves forward when the project changes.
///
/// Overleaf's history has reported this under more than one name, so try each
/// in turn and fall back to the newest edit's timestamp. Returning `None` here
/// means we genuinely cannot tell whether anything changed — and the caller
/// must then not guess "yes", or it would re-download the project on every
/// poll and get itself rate-limited.
pub(super) fn latest_update_version(body: &Value) -> Option<i64> {
    latest_update(body).map(HistoryVersion::value)
}

/// Where the project's history stands, in one of the two kinds of number
/// [`latest_update_version`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HistoryVersion {
    /// Overleaf's history version, one step per change.
    Counted(i64),
    /// The newest edit's timestamp, when the history reports no version. It
    /// moves for any change, ours included, by no telling how much.
    Stamped(i64),
}

impl HistoryVersion {
    pub fn value(self) -> i64 {
        match self {
            HistoryVersion::Counted(value) | HistoryVersion::Stamped(value) => value,
        }
    }
}

fn latest_update(body: &Value) -> Option<HistoryVersion> {
    let updates = body.get("updates")?.as_array()?;
    let version = |update: &Value| update.get("toV").or_else(|| update.get("v"))?.as_i64();
    let end_ts = |update: &Value| {
        let meta = update.get("meta")?;
        meta.get("end_ts").or_else(|| meta.get("endTs"))?.as_i64()
    };
    let counted = updates.iter().filter_map(version).max().map(HistoryVersion::Counted);
    counted.or_else(|| updates.iter().filter_map(end_ts).max().map(HistoryVersion::Stamped))
}

/// Every folder above `path`, outermost first: `a/b/c.tex` → `a`, `a/b`.
pub(super) fn folders_above(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(index, _)| &path[..index])
}

// ---- A linked project's endpoints -------------------------------------------

/// The exact Overleaf origin this project belongs to.
///
/// A session cookie is valid only for the origin that issued it. Refuse the
/// request before constructing an HTTP client when the globally signed-in
/// account belongs to a different self-hosted Overleaf instance.
pub(super) fn sync_host(state: &SyncState, session: &SessionFile) -> Result<String, String> {
    let canonical = |host: &str| {
        let normalized = normalize_host(host);
        reqwest::Url::parse(&normalized)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| normalized.to_ascii_lowercase())
    };
    let session_host = canonical(&session.host);
    let linked_host =
        if state.host.trim().is_empty() { session_host.clone() } else { canonical(&state.host) };
    if linked_host != session_host {
        return Err(format!(
            "This project is linked to {linked_host}. Sign out and connect to that Overleaf host to continue."
        ));
    }
    Ok(linked_host)
}

/// A linked project reached through the signed-in session: what every
/// per-project REST call starts from.
pub(super) struct Remote {
    pub session: SessionFile,
    pub state: SyncState,
    /// The origin the session and the link agree on.
    pub host: String,
    /// This copy's build output, left out of the copy fetched from Overleaf.
    pub build_pdf: BuildPdf,
}

impl Remote {
    pub fn open(config_dir: &Path, root: &Path) -> Result<Self, String> {
        let session = load_session(config_dir)?;
        let state = load_state(root)?;
        let host = sync_host(&state, &session)?;
        Ok(Remote { session, state, host, build_pdf: BuildPdf::of(root) })
    }

    /// The linked project, ready to sync: not paused, and with the file table
    /// reduced to paths that still take part (the rules may have changed since
    /// it was written).
    ///
    /// A sync can send a document's edit over the live channel (see
    /// `doc_push`), which reads the project's track-changes setting for our
    /// account, so a session stored before the account id was recorded gets
    /// it here, as the live connection does. Without it the setting reads as
    /// an anonymous guest's and the edit goes in untracked.
    pub fn open_for_sync(config_dir: &Path, root: &Path) -> Result<Self, String> {
        let mut session = load_session(config_dir)?;
        let mut state = load_state(root)?;
        if state.paused {
            return Err(PAUSED.to_string());
        }
        let build_pdf = BuildPdf::of(root);
        // Dropped from the table, not deleted: a file the last sync agreed on
        // that now takes no part stays where it is on both sides.
        state.files.retain(|path, _| !is_excluded(path) && !build_pdf.is(path));
        let host = sync_host(&state, &session)?;
        ensure_user_id(config_dir, &mut session);
        Ok(Remote { session, state, host, build_pdf })
    }

    /// See [`fetch_remote_version`].
    pub fn version(&self, client: &Client) -> Option<i64> {
        self.history_version(client).map(HistoryVersion::value)
    }

    /// See [`HistoryVersion`].
    pub fn history_version(&self, client: &Client) -> Option<HistoryVersion> {
        fetch_history_version(client, &self.host, &self.session.cookie, &self.state.project_id)
    }

    /// `{host}/project/{id}{path}`, carrying the session cookie, the CSRF token
    /// when there is one, and `Accept: application/json`.
    pub fn request(
        &self, client: &Client, method: Method, path: &str, csrf: Option<&str>,
    ) -> RequestBuilder {
        let url = format!("{}/project/{}{path}", self.host, self.state.project_id);
        let mut request = client.request(method, url).header(COOKIE, &self.session.cookie);
        if let Some(csrf) = csrf {
            request = request.header("X-Csrf-Token", csrf);
        }
        request.header(ACCEPT, JSON)
    }

    pub fn get(&self, path: &str, timeout_secs: u64) -> Result<Response, String> {
        send(self.request(&http_client(timeout_secs)?, Method::GET, path, None))
    }

    /// `what` names the resource for the error, as in [`expect_success`].
    pub fn get_json(&self, path: &str, what: &str) -> Result<Value, String> {
        expect_success(self.get(path, 20)?, what)?.json().map_err(err)
    }

    /// A client together with the CSRF token every mutation must carry.
    pub fn csrf_client(&self, timeout_secs: u64) -> Result<(Client, String), String> {
        let client = http_client(timeout_secs)?;
        let csrf = csrf_token(&client, &self.host, &self.session.cookie)?;
        Ok((client, csrf))
    }

    /// A POST or DELETE with a JSON body, or an explicitly empty one.
    pub fn mutate(
        &self, method: Method, path: &str, body: Option<&Value>,
    ) -> Result<Response, String> {
        let (client, csrf) = self.csrf_client(20)?;
        let request = self.request(&client, method, path, Some(&csrf));
        send(match body {
            Some(body) => request.json(body),
            // Overleaf answers 411 Length Required to a POST with no length at
            // all, which is what a bodyless `reqwest` request sends. Browsers
            // set this themselves; we have to say it out loud.
            None => request.header(CONTENT_LENGTH, "0"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::test_support::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn retries_only_what_cannot_happen_twice() {
        let answered = |code: u16| Attempt::Answered(StatusCode::from_u16(code).unwrap(), None);
        let second = Some(Duration::from_secs(2));
        // Never reached Overleaf: safe for anything.
        assert_eq!(retry_wait(Attempt::NotConnected, false, 0), Some(RETRY_BASE));
        assert_eq!(retry_wait(answered(429), false, 1), second);
        // May have been carried out: only a read goes again.
        for attempt in [Attempt::NoAnswer, answered(502), answered(503), answered(504)] {
            assert_eq!(retry_wait(attempt, true, 0), Some(RETRY_BASE), "{attempt:?}");
            assert_eq!(retry_wait(attempt, false, 0), None, "{attempt:?}");
        }
        // Not transient, out of attempts, or told to wait too long.
        for code in [200, 400, 404, 500] {
            assert_eq!(retry_wait(answered(code), true, 0), None, "{code}");
        }
        assert_eq!(retry_wait(Attempt::NotConnected, true, TRANSIENT_RETRIES), None);
        let rate_limited = |after| Attempt::Answered(StatusCode::TOO_MANY_REQUESTS, Some(after));
        assert_eq!(retry_wait(rate_limited("3"), false, 0), Some(Duration::from_secs(3)));
        assert_eq!(retry_wait(rate_limited("600"), false, 0), None);
    }

    #[test]
    fn a_read_survives_a_gateway_blip_and_a_mutation_is_not_repeated() {
        let hits = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = Arc::clone(&hits);
        let base = crate::overleaf_rt::mock_server::serve_http(move |request| {
            let method = request.method().as_str().to_string();
            let first = {
                let mut seen = seen.lock().unwrap();
                seen.push(method.clone());
                seen.iter().filter(|m| **m == method).count() == 1
            };
            let status = if first { 503 } else { 200 };
            let _ =
                request.respond(tiny_http::Response::from_string("ok").with_status_code(status));
        });
        let client = http_client(10).unwrap();
        let read = send(client.get(format!("{base}/project/p/updates"))).unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        // A 503 to a POST may still have done its work: report it, never resend.
        let write = send(client.post(format!("{base}/project/p/thread")).body("{}")).unwrap();
        assert_eq!(write.status(), StatusCode::SERVICE_UNAVAILABLE);
        // Nor a DELETE: a retry would be told 404 for what the first one did.
        let delete = send(client.delete(format!("{base}/project/p/thread/t"))).unwrap();
        assert_eq!(delete.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(*hits.lock().unwrap(), ["GET", "GET", "POST", "DELETE"]);
    }

    #[test]
    fn a_garbled_answer_reads_as_reqwests_decode_error() {
        // The UI retries a sync on this wording (RESPONSE_BODY_UNDECODABLE in
        // overleaf-sync-failures.ts), and it is reqwest's text, not ours: a
        // reqwest upgrade that rewords it must fail here.
        let base = crate::overleaf_rt::mock_server::serve_http(|request| {
            let _ = request.respond(tiny_http::Response::from_string("<html>"));
        });
        let response = send(http_client(10).unwrap().get(format!("{base}/project"))).unwrap();
        let error = response.json::<Value>().map_err(err).unwrap_err();
        assert!(error.contains("error decoding response body"), "{error}");
    }

    #[test]
    fn linked_host_matching_uses_url_origins() {
        let session = SessionFile {
            host: "HTTPS://OVERLEAF.EXAMPLE:443/".to_string(),
            cookie: "overleaf_session2=fixture-cookie".to_string(),
            email: None,
            name: None,
            user_id: None,
            expired: false,
        };
        let state = SyncState {
            host: "https://overleaf.example/project-path".to_string(),
            project_id: "proj-1".to_string(),
            project_name: "Test Project".to_string(),
            ..Default::default()
        };
        assert_eq!(sync_host(&state, &session).unwrap(), "https://overleaf.example");
    }

    #[test]
    fn project_requests_reject_a_session_from_another_overleaf_host() {
        let (config, root) = (signed_in("https://overleaf-b.example"), TempDir::new("mismatch"));
        let files: Files = &[("main.tex", b"linked project")];
        seed_linked_project(&root, "https://overleaf-a.example", files, files);

        let error = crate::overleaf::realtime_config(&config, &root)
            .expect_err("a foreign session must be rejected");
        assert!(error.contains("https://overleaf-a.example"));
        assert!(error.contains("Sign out and connect"));
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use crate::overleaf::test_support::build_zip;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn big_zip() -> Vec<u8> {
        // Incompressible, like the figures and PDFs that make a project big.
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        let figure: Vec<u8> = (0..96 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed as u8
            })
            .collect();
        build_zip(&[("main.tex", b"\\documentclass{article}"), ("figures/plot.pdf", &figure)])
    }

    /// A server sending `zip` in 8 KiB pieces 150 ms apart: a download that
    /// keeps moving but takes longer than a short deadline. With `cut_first`,
    /// the first attempt's connection drops a third of the way through.
    fn serve_trickle(zip: Vec<u8>, cut_first: bool) -> (String, Arc<AtomicUsize>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&attempts);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let (mut stream, zip) = (stream.unwrap(), zip.clone());
                let attempt = seen.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                    }
                    let length = zip.len();
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                    );
                    stream.write_all(header.as_bytes()).unwrap();
                    let stop = if cut_first && attempt == 0 { length / 3 } else { length };
                    for piece in zip[..stop].chunks(8 * 1024) {
                        std::thread::sleep(Duration::from_millis(150));
                        if stream.write_all(piece).is_err() {
                            return;
                        }
                    }
                    let _ = stream.flush();
                });
            }
        });
        (base, attempts)
    }

    #[test]
    fn a_download_slower_than_the_deadline_finishes_while_it_keeps_moving() {
        // ~13 chunks of 150 ms: about two seconds against a one-second deadline.
        let zip = big_zip();
        let (base, _) = serve_trickle(zip.clone(), false);
        let client = http_client(1).unwrap();
        let bytes = download_project_zip(&client, &base, "c=1", "p", &|_, _| {}).unwrap();
        assert_eq!(bytes, zip);
    }

    #[test]
    fn a_download_cut_off_part_way_is_tried_again() {
        let zip = big_zip();
        let (base, attempts) = serve_trickle(zip.clone(), true);
        let client = http_client(5).unwrap();
        let bytes = download_project_zip(&client, &base, "c=1", "p", &|_, _| {}).unwrap();
        assert_eq!(bytes, zip);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
