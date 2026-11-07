//! The signed-in session: the stored cookie, sign-in validation, and the
//! cookie rules the sign-in window relies on. What the account can open is in
//! `projects`.

use super::api::{fetch_projects_page, full_name, http_client, json_str, meta_content};
use crate::overleaf_rt::{NOT_CONNECTED, SESSION_EXPIRED, SESSION_STILL_VALID};
use crate::util::err;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

pub(super) const DEFAULT_HOST: &str = "https://www.overleaf.com";
const SESSION_FILE: &str = "overleaf-session.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafStatus {
    pub connected: bool,
    /// Overleaf turned the stored session away: signed out, but with the
    /// account still known, so Settings can offer to reconnect it.
    pub expired: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub host: String,
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
    pub fn pending(detail: Option<String>) -> Self {
        Self { status: "pending", session: None, detail }
    }
    pub fn cancelled() -> Self {
        Self { status: "cancelled", session: None, detail: None }
    }
    pub fn connected(session: OverleafStatus) -> Self {
        Self { status: "connected", session: Some(session), detail: None }
    }
}

/// The session as stored: the full `Cookie` header value, verbatim
/// (`overleaf_session2=…` on overleaf.com; self-hosted instances may use
/// `sharelatex.sid`), and who it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionFile {
    pub host: String,
    pub cookie: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Our own Overleaf account id. Track changes is stored per account, so
    /// reading whether it is on for us needs to know which one we are.
    #[serde(default)]
    pub user_id: Option<String>,
    /// Set once Overleaf's dashboard turned this cookie away; see
    /// [`settle_session_error`]. Cleared only by signing in again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub expired: bool,
}

impl SessionFile {
    fn status(self) -> OverleafStatus {
        let SessionFile { host, email, name, expired, .. } = self;
        OverleafStatus { connected: !expired, expired, email, name, host }
    }
}

fn session_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SESSION_FILE)
}

/// The stored session, whether or not Overleaf still accepts it.
pub(super) fn read_session(config_dir: &Path) -> Result<SessionFile, String> {
    let raw =
        fs::read_to_string(session_path(config_dir)).map_err(|_| NOT_CONNECTED.to_string())?;
    serde_json::from_str(&raw).map_err(|_| NOT_CONNECTED.to_string())
}

/// The stored session, for a request to Overleaf. One already known to be
/// expired fails here, so every request agrees with Settings instead of
/// asking Overleaf again with a cookie it has turned away.
pub(super) fn load_session(config_dir: &Path) -> Result<SessionFile, String> {
    let session = read_session(config_dir)?;
    if session.expired {
        return Err(SESSION_EXPIRED.to_string());
    }
    Ok(session)
}

pub(super) fn save_session(config_dir: &Path, session: &SessionFile) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(err)?;
    let body = serde_json::to_string_pretty(session).map_err(err)?;
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
            file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(err)?;
        }
        fs::rename(&temporary, session_path(config_dir)).map_err(err)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

/// RFC 6265 domain matching: a cookie scoped to `overleaf.com` belongs on
/// requests to `www.overleaf.com`.
///
/// wry's own `cookies_for_url` filter compares the two domains for *equality*
/// (and the cookie crate strips the leading dot), so on macOS it silently drops
/// every `.overleaf.com` cookie and the sign-in window never appears to log
/// in. We read all cookies and match them ourselves.
pub fn cookie_domain_matches(cookie_domain: &str, host: &str) -> bool {
    let cookie_domain = cookie_domain.trim().trim_start_matches('.').to_ascii_lowercase();
    let host = host.trim().trim_start_matches('.').to_ascii_lowercase();
    if cookie_domain.is_empty() || host.is_empty() {
        return false;
    }
    host == cookie_domain || host.ends_with(&format!(".{cookie_domain}"))
}

/// Does this cookie jar look like a signed-in session for `host`?
/// `overleaf_session2` is overleaf.com; `sharelatex.sid` is self-hosted CE.
pub fn has_session_cookie<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names.into_iter().any(|name| name == "overleaf_session2" || name == "sharelatex.sid")
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

pub fn session_status(config_dir: &Path) -> Result<OverleafStatus, String> {
    let signed_out = || {
        let host = DEFAULT_HOST.to_string();
        OverleafStatus { connected: false, expired: false, email: None, name: None, host }
    };
    Ok(read_session(config_dir).map_or_else(|_| signed_out(), SessionFile::status))
}

/// Whether an error is Overleaf answering as if nobody were signed in,
/// however a step wrapped it ("Failed to upload … to Overleaf: …").
pub fn is_session_rejection(error: &str) -> bool {
    error.ends_with(SESSION_EXPIRED)
}

/// Decide what one signed-out answer means for the account, and say so once
/// for every surface: the error to report, and whether the session has just
/// been marked expired.
///
/// A login redirect, a 401 or 403, or a page where a zip or a CSRF token
/// should have been all read as [`SESSION_EXPIRED`], and so does the live
/// channel's "invalid session". Only some of them mean the session is gone: a
/// 403 can be one project's permission, and a page can be an error. The
/// dashboard is what sign-in itself is validated against, so it decides. A
/// session it turns away is marked expired in the stored file, which
/// Settings, sync and live editing all read until the next sign-in; one it
/// still accepts makes the error a refusal worth retrying, and a dashboard
/// that cannot be reached says only that.
///
/// Settings used to read the stored file alone while sync reported the
/// rejection, so the two disagreed until the user signed out by hand.
pub fn settle_session_error(config_dir: &Path, error: String) -> (String, bool) {
    if !is_session_rejection(&error) {
        return (error, false);
    }
    let Ok(session) = read_session(config_dir) else { return (error, false) };
    if session.expired {
        return (error, false);
    }
    let checked = http_client(20)
        .and_then(|client| fetch_projects_page(&client, &session.host, &session.cookie));
    match checked {
        Ok(html) if opens_dashboard(&html) => (SESSION_STILL_VALID.to_string(), false),
        Ok(_) => (error, mark_expired(config_dir, &session.cookie)),
        Err(rejected) if rejected == SESSION_EXPIRED => {
            (error, mark_expired(config_dir, &session.cookie))
        }
        Err(unreachable) => (unreachable, false),
    }
}

/// Record that Overleaf turned `cookie` away, unless a sign-in has replaced
/// it since the check began. Answers whether it was recorded.
fn mark_expired(config_dir: &Path, cookie: &str) -> bool {
    let Ok(mut session) = read_session(config_dir) else { return false };
    if session.cookie != cookie || session.expired {
        return false;
    }
    session.expired = true;
    save_session(config_dir, &session).is_ok()
}

/// Whether a dashboard page is a signed-in one. Accept any signed-in marker
/// rather than insisting on the projects blob alone: if Overleaf renames that
/// meta tag, connecting should still succeed and the project list should be
/// the thing that reports a clear parse error.
pub(super) fn opens_dashboard(html: &str) -> bool {
    ["ol-prefetchedProjectsBlob", "ol-projects", "ol-user", "ol-usersEmail"]
        .iter()
        .any(|name| meta_content(html, name).is_some())
}

/// Sign-in attempts, so ending them (Cancel, Sign out) wins over a poll that
/// was still validating a cookie at that moment. Validation is a request to
/// Overleaf that can take 30 s; without this, such a poll saved the session
/// after the user had signed out, or while the UI said the sign-in was
/// cancelled. The lock is held to compare and write, never across that request.
#[derive(Default)]
pub struct LoginAttempts {
    /// How many times attempts were ended; a poll's attempt is the count it began at.
    ended: Mutex<u64>,
}

impl LoginAttempts {
    /// The attempt a poll beginning now belongs to.
    pub fn current(&self) -> u64 {
        *self.lock()
    }

    /// End every attempt so far, and run `then` before a poll of any of them
    /// can save a session.
    pub fn end<T>(&self, then: impl FnOnce() -> T) -> T {
        let mut ended = self.lock();
        *ended += 1;
        then()
    }

    fn lock(&self) -> MutexGuard<'_, u64> {
        self.ended.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Validate `cookie` against the dashboard and save it as the session, unless
/// `attempt` ended meanwhile: then nothing is saved and the answer is `None`.
pub fn store_session_cookie(
    config_dir: &Path, host: &str, cookie: &str, logins: &LoginAttempts, attempt: u64,
) -> Result<Option<OverleafStatus>, String> {
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
    // The page fetch already rejects anything that redirected to the login
    // page, so reaching here means the cookie works.
    if !opens_dashboard(&html) {
        return Err(
            "That cookie did not open the Overleaf dashboard. Copy a fresh session cookie from a logged-in browser and try again."
                .to_string(),
        );
    }
    let (email, name) = parse_user_meta(&html);
    let user_id = meta_content(&html, "ol-user_id");
    let session = SessionFile { host, cookie, email, name, user_id, expired: false };
    let ended = logins.lock();
    if *ended != attempt {
        return Ok(None);
    }
    save_session(config_dir, &session)?;
    drop(ended);
    Ok(Some(session.status()))
}

pub fn disconnect(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(session_path(config_dir)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

/// Our own Overleaf account id, fetched once if the session predates our
/// storing it.
///
/// Sessions signed in before this was recorded have no id, and there is no
/// second chance to read it from the sign-in response. Everything stored per
/// account then reads as if we were an anonymous guest. Backfilling on the project list was not enough: someone who opens a
/// project they already linked never goes near it.
pub(super) fn ensure_user_id(config_dir: &Path, session: &mut SessionFile) -> Option<String> {
    if session.user_id.is_some() {
        return session.user_id.clone();
    }
    let client = http_client(20).ok()?;
    let html = fetch_projects_page(&client, &session.host, &session.cookie).ok()?;
    let user_id = meta_content(&html, "ol-user_id").or_else(|| {
        serde_json::from_str::<Value>(&meta_content(&html, "ol-user")?)
            .ok()
            .and_then(|user| json_str(&user, &["_id", "id"]))
    })?;
    session.user_id = Some(user_id.clone());
    let _ = save_session(config_dir, session);
    Some(user_id)
}

fn parse_user_meta(html: &str) -> (Option<String>, Option<String>) {
    match meta_content(html, "ol-user").and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) {
        Some(user) => (json_str(&user, &["email"]), full_name(&user)),
        None => (meta_content(html, "ol-usersEmail"), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::test_support::*;

    #[test]
    fn cookie_domain_matching_covers_overleaf_subdomains() {
        // Overleaf scopes its session cookie to `.overleaf.com` while the
        // sign-in window is on `www.overleaf.com`; an equality check drops it.
        for (cookie_domain, host, matches) in [
            (".overleaf.com", "www.overleaf.com", true),
            ("overleaf.com", "www.overleaf.com", true),
            ("www.overleaf.com", "www.overleaf.com", true),
            ("Overleaf.com", "WWW.Overleaf.com", true),
            ("latex.example.edu", "latex.example.edu", true),
            // Must not leak cookies across unrelated sites.
            ("evil.com", "www.overleaf.com", false),
            ("notoverleaf.com", "www.overleaf.com", false),
            ("www.overleaf.com", "overleaf.com", false),
            ("", "www.overleaf.com", false),
        ] {
            assert_eq!(
                cookie_domain_matches(cookie_domain, host),
                matches,
                "{cookie_domain} on {host}"
            );
        }
    }

    #[test]
    fn session_cookie_detection_accepts_cloud_and_self_hosted_names() {
        assert!(has_session_cookie(["GCLB", "overleaf_session2"]));
        assert!(has_session_cookie(["sharelatex.sid"]));
        assert!(!has_session_cookie(["GCLB", "_ga"]));
    }

    #[test]
    fn overleaf_store_session_cookie_validates_and_persists_privately() {
        let server = Mock::default().serve();
        let config = TempDir::new("store-session");
        // Nothing stored yet reads as disconnected from the default host.
        let absent = session_status(&config).unwrap();
        assert!(!absent.connected && absent.email.is_none());
        assert_eq!(absent.host, DEFAULT_HOST);

        let cookie = "overleaf_session2=abc123; GCLB=balancer";
        let logins = LoginAttempts::default();
        let status = store_session_cookie(&config, &server.base, cookie, &logins, logins.current())
            .unwrap()
            .expect("an attempt nothing ended");
        assert!(status.connected);
        assert_eq!(status.email.as_deref(), Some("researcher@example.edu"));
        assert_eq!(status.name.as_deref(), Some("Robin Researcher"));
        assert_eq!(status.host, server.base);
        // The validation request carried the full cookie header.
        assert_eq!(server.recorded()[0].cookie_header.as_deref(), Some(cookie));

        // Stored verbatim, privately, and without a partial file left behind.
        assert_eq!(load_session(&config).unwrap().cookie, cookie);
        assert!(!config.join(format!(".{SESSION_FILE}.tmp")).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(session_path(&config)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // The stored session round-trips through session_status.
        let restored = session_status(&config).unwrap();
        assert!(restored.connected);
        assert_eq!(restored.email.as_deref(), Some("researcher@example.edu"));

        disconnect(&config).unwrap();
        assert!(!session_status(&config).unwrap().connected);
        disconnect(&config).unwrap(); // idempotent
    }

    #[test]
    fn signing_out_while_a_sign_in_validates_its_cookie_saves_nothing() {
        let config = TempDir::new("sign-out-race");
        let logins = std::sync::Arc::new(LoginAttempts::default());
        // Sign out (or Cancel) arrives while Overleaf has not yet answered
        // the poll's validation request.
        let (during, ending) = (config.to_path_buf(), std::sync::Arc::clone(&logins));
        let server = Mock {
            on_request: Some(Box::new(move |_, _| ending.end(|| disconnect(&during)).unwrap())),
            ..Default::default()
        }
        .serve();
        let cookie = "overleaf_session2=abc123";
        let attempt = logins.current();
        assert!(store_session_cookie(&config, &server.base, cookie, &logins, attempt)
            .unwrap()
            .is_none());
        assert!(!session_status(&config).unwrap().connected);

        // A sign-in begun after that one ended is saved.
        let server = Mock::default().serve();
        let next = logins.current();
        let saved = store_session_cookie(&config, &server.base, cookie, &logins, next).unwrap();
        assert!(saved.is_some_and(|status| status.connected));
        assert!(session_status(&config).unwrap().connected);
    }
}
