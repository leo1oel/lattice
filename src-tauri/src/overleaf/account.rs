//! The signed-in session: the stored cookie, sign-in validation, the account's
//! project list, and the cookie rules the sign-in window relies on.

use super::api::{fetch_projects_page, full_name, http_client, json_str, meta_content};
use crate::overleaf_rt::{NOT_CONNECTED, SESSION_EXPIRED};
use crate::util::err;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const DEFAULT_HOST: &str = "https://www.overleaf.com";
const SESSION_FILE: &str = "overleaf-session.json";

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
}

impl SessionFile {
    fn status(self) -> OverleafStatus {
        OverleafStatus { connected: true, email: self.email, name: self.name, host: self.host }
    }
}

fn session_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SESSION_FILE)
}

pub(super) fn load_session(config_dir: &Path) -> Result<SessionFile, String> {
    let raw =
        fs::read_to_string(session_path(config_dir)).map_err(|_| NOT_CONNECTED.to_string())?;
    serde_json::from_str(&raw).map_err(|_| NOT_CONNECTED.to_string())
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
        OverleafStatus { connected: false, email: None, name: None, host }
    };
    Ok(load_session(config_dir).map_or_else(|_| signed_out(), SessionFile::status))
}

pub fn store_session_cookie(
    config_dir: &Path, host: &str, cookie: &str,
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
    // The page fetch already rejects anything that redirected to the login
    // page, so reaching here means the cookie works. Accept any signed-in
    // marker rather than insisting on the projects blob alone: if Overleaf
    // renames that meta tag, connecting should still succeed and the project
    // list should be the thing that reports a clear parse error.
    let signed_in = ["ol-prefetchedProjectsBlob", "ol-projects", "ol-user", "ol-usersEmail"]
        .iter()
        .any(|name| meta_content(&html, name).is_some());
    if !signed_in {
        return Err(
            "That cookie did not open the Overleaf dashboard. Copy a fresh session cookie from a logged-in browser and try again."
                .to_string(),
        );
    }
    let (email, name) = parse_user_meta(&html);
    let user_id = meta_content(&html, "ol-user_id");
    let session = SessionFile { host, cookie, email, name, user_id };
    save_session(config_dir, &session)?;
    Ok(session.status())
}

pub fn disconnect(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(session_path(config_dir)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
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

fn parse_projects_meta(html: &str) -> Result<Vec<OverleafProject>, String> {
    let parse_error =
        |e: serde_json::Error| format!("Could not parse the Overleaf project list: {e}");
    let raw_projects: Vec<Value> =
        if let Some(blob) = meta_content(html, "ol-prefetchedProjectsBlob") {
            let value: Value = serde_json::from_str(&blob).map_err(parse_error)?;
            value.get("projects").and_then(|p| p.as_array()).cloned().unwrap_or_default()
        } else if let Some(blob) = meta_content(html, "ol-projects") {
            serde_json::from_str(&blob).map_err(parse_error)?
        } else {
            return Err(SESSION_EXPIRED.to_string());
        };

    let mut projects: Vec<OverleafProject> = (raw_projects.iter())
        .filter_map(|value| {
            let owner = value.get("owner");
            let owner_name = owner.map(|o| {
                let first = json_str(o, &["firstName", "first_name"]).unwrap_or_default();
                let last = json_str(o, &["lastName", "last_name"]).unwrap_or_default();
                format!("{first} {last}").trim().to_string()
            });
            Some(OverleafProject {
                id: json_str(value, &["id", "_id"])?,
                name: json_str(value, &["name"])?,
                last_updated: json_str(value, &["lastUpdated"]),
                owner_email: owner.and_then(|o| json_str(o, &["email"])),
                owner_name: owner_name.filter(|n| !n.is_empty()),
                access_level: json_str(value, &["accessLevel"]),
                archived: json_flag(value, "archived"),
                trashed: json_flag(value, "trashed"),
            })
        })
        .collect();
    projects.sort_by(|a, b| b.last_updated.cmp(&a.last_updated).then(a.name.cmp(&b.name)));
    Ok(projects)
}

/// Overleaf encodes archived/trashed as booleans today; very old instances
/// used per-user id arrays.
fn json_flag(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .is_some_and(|v| v.as_bool().unwrap_or_else(|| v.as_array().is_some_and(|a| !a.is_empty())))
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
        let status = store_session_cookie(&config, &server.base, cookie).unwrap();
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
    fn overleaf_list_projects_parses_and_sorts() {
        let server = Mock::default().serve();
        let config = signed_in(&server.base);
        let projects = list_projects(&config).unwrap();
        // Sorted by lastUpdated descending.
        let ids: Vec<&str> = projects.iter().map(|project| project.id.as_str()).collect();
        assert_eq!(ids, ["proj-new", "proj-archived", "proj-old"]);
        assert_eq!(projects[0].name, "New Paper");
        assert_eq!(projects[0].access_level.as_deref(), Some("readAndWrite"));
        assert_eq!(projects[0].owner_email.as_deref(), Some("advisor@example.edu"));
        assert_eq!(projects[0].owner_name.as_deref(), Some("Ada Advisor"));
        assert!(!projects[0].archived && projects[1].archived && !projects[1].trashed);
        assert_eq!(projects[2].last_updated.as_deref(), Some("2026-01-02T10:00:00.000Z"));
    }
}
