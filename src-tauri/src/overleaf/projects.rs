//! What the signed-in account can open from Overleaf: the dashboard's project
//! list, the invitations still waiting on Overleaf, and a pasted project or
//! share link.
//!
//! A project someone shares with you is in the dashboard list only once you
//! are a member: an invitation counts after you accept it, and a share link
//! after you open it and choose Join project. Until then Overleaf's own
//! dashboard does not list it either. The list is not cut short: the
//! dashboard's prefetched blob holds every project the account can access
//! (its server-side paging is still a TODO in Overleaf's
//! `ProjectListController._sortAndPaginate`). Invitations ride along as the
//! dashboard's `notification_project_invite` notifications; share links the
//! user has not joined are only known when pasted.

use super::account::{load_session, normalize_host, opens_dashboard, save_session, SessionFile};
use super::api::{
    expect_success, fetch_projects_page, http_client, json_str, meta_content, send, JSON,
};
use crate::overleaf_rt::SESSION_EXPIRED;
use crate::util::err;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, COOKIE};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

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

/// An invitation to a project that has not been accepted yet. Accepting is
/// the user's to do on Overleaf; `url` is Overleaf's own invitation page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafInvite {
    pub project_id: String,
    pub project_name: String,
    pub inviter_name: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafProjectList {
    /// Newest first, the order of Overleaf's own dashboard.
    pub projects: Vec<OverleafProject>,
    pub invites: Vec<OverleafInvite>,
}

/// What a pasted link opens for this account.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PastedLink {
    /// A project the account can open now.
    Project { project: Box<OverleafProject> },
    /// A share link this account has not joined. Overleaf asks before it adds
    /// anyone through a link, so that answer is the user's, in the browser.
    NeedsJoin { project_name: Option<String>, url: String },
    /// A project the account was invited to but has not accepted yet.
    Invited { project_name: Option<String>, url: String },
    /// A project this account cannot open.
    NoAccess,
    /// A share link Overleaf does not know, or one whose sharing was turned off.
    NotFound,
    /// A link to another Overleaf server than the one signed in to.
    OtherHost { host: String },
    /// Not a project or share link.
    Unrecognized,
}

pub fn list_projects(config_dir: &Path) -> Result<OverleafProjectList, String> {
    let (session, client, html) = open_dashboard(config_dir)?;
    read_dashboard(&client, &session, &html)
}

/// The session, a client, and the dashboard page it opens.
fn open_dashboard(config_dir: &Path) -> Result<(SessionFile, Client, String), String> {
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
    Ok((session, client, html))
}

fn read_dashboard(
    client: &Client, session: &SessionFile, html: &str,
) -> Result<OverleafProjectList, String> {
    let mut projects = parse_projects(&dashboard_projects(client, session, html)?);
    projects.sort_by(|a, b| b.last_updated.cmp(&a.last_updated).then(a.name.cmp(&b.name)));
    let invites = parse_invites(html, &session.host)
        .into_iter()
        .filter(|invite| projects.iter().all(|project| project.id != invite.project_id))
        .collect();
    Ok(OverleafProjectList { projects, invites })
}

/// The dashboard's raw project entries.
///
/// Overleaf's own dashboard reads the prefetched blob, and asks
/// `POST /api/project` only when the blob is missing (the background listing
/// failed). Do the same, and ask too when the blob holds fewer projects than
/// its `totalSize`, so a prefetch that Overleaf one day pages cannot hide the
/// rest. Very old instances inlined the list as `ol-projects`.
fn dashboard_projects(
    client: &Client, session: &SessionFile, html: &str,
) -> Result<Vec<Value>, String> {
    let parse_error =
        |e: serde_json::Error| format!("Could not parse the Overleaf project list: {e}");
    if let Some(blob) = meta_content(html, "ol-prefetchedProjectsBlob") {
        let value: Value = serde_json::from_str(&blob).map_err(parse_error)?;
        let listed = project_entries(&value);
        let total = value.get("totalSize").and_then(Value::as_u64).unwrap_or(0);
        if total as usize <= listed.len() {
            return Ok(listed);
        }
        return fetch_all_projects(client, session, html);
    }
    if let Some(blob) = meta_content(html, "ol-projects") {
        return serde_json::from_str(&blob).map_err(parse_error);
    }
    if opens_dashboard(html) {
        return fetch_all_projects(client, session, html);
    }
    Err(SESSION_EXPIRED.to_string())
}

fn project_entries(page: &Value) -> Vec<Value> {
    page.get("projects").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Every project, from the endpoint Overleaf's dashboard itself pages through.
fn fetch_all_projects(
    client: &Client, session: &SessionFile, html: &str,
) -> Result<Vec<Value>, String> {
    let csrf = meta_content(html, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let request = client
        .post(format!("{}/api/project", session.host))
        .header(COOKIE, &session.cookie)
        .header("X-Csrf-Token", csrf)
        .header(ACCEPT, JSON)
        .json(&serde_json::json!({ "sort": { "by": "lastUpdated", "order": "desc" } }));
    let page: Value =
        expect_success(send(request)?, "for the project list")?.json().map_err(err)?;
    Ok(project_entries(&page))
}

fn parse_projects(raw: &[Value]) -> Vec<OverleafProject> {
    (raw.iter())
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
        .collect()
}

/// Overleaf encodes archived/trashed as booleans today; very old instances
/// used per-user id arrays.
fn json_flag(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .is_some_and(|v| v.as_bool().unwrap_or_else(|| v.as_array().is_some_and(|a| !a.is_empty())))
}

/// Invitations from the dashboard's notifications. Overleaf creates one for
/// an invitee who already has an account, and shows it above the list with
/// a Join project button; an invitation sent to an address with no account
/// lives only in that email.
fn parse_invites(html: &str, host: &str) -> Vec<OverleafInvite> {
    let notifications = meta_content(html, "ol-notifications")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    (notifications.iter())
        .filter(|n| {
            n.get("templateKey").and_then(Value::as_str) == Some("notification_project_invite")
        })
        .filter_map(|notification| {
            let options = notification.get("messageOpts")?;
            let project_id = json_str(options, &["projectId"]).filter(|id| is_slug(id))?;
            let token = json_str(options, &["token"]).filter(|token| is_slug(token))?;
            Some(OverleafInvite {
                url: format!("{host}/project/{project_id}/invite/token/{token}"),
                project_name: json_str(options, &["projectName"]).unwrap_or_default(),
                inviter_name: json_str(options, &["userName"]),
                project_id,
            })
        })
        .collect()
}

fn is_slug(value: &str) -> bool {
    value.chars().all(|c| c.is_ascii_alphanumeric())
}

// ---- Pasted links -----------------------------------------------------------

/// The links Overleaf hands out for a project, by what they name.
#[derive(Debug, PartialEq, Eq)]
enum Link {
    /// `/project/<id>`: the editor's address bar.
    Project(String),
    /// `/project/<id>/invite/token/<token>`: the invitation email.
    Invite { project_id: String, url: String },
    /// `/read/<token>` (view) or `/<digits><letters>` (edit): link sharing.
    /// `grant` is the path Overleaf's own link page asks about access.
    Share { grant: String, url: String, hash: Option<String> },
}

/// Read a pasted link against the session's server. `Err` carries the answer
/// for a link that names nothing to look up.
fn parse_link(pasted: &str, host: &str) -> Result<Link, PastedLink> {
    let pasted = pasted.trim();
    if is_object_id(pasted) {
        return Ok(Link::Project(pasted.to_string()));
    }
    let lower = pasted.to_ascii_lowercase();
    let absolute = if lower.starts_with("http://") || lower.starts_with("https://") {
        pasted.to_string()
    } else {
        format!("https://{pasted}")
    };
    let url = Url::parse(&absolute).map_err(|_| PastedLink::Unrecognized)?;
    let server = Url::parse(&normalize_host(host)).map_err(|_| PastedLink::Unrecognized)?;
    let bare = |url: &Url| {
        let name = url.host_str().unwrap_or_default().to_ascii_lowercase();
        (name.strip_prefix("www.").map(str::to_string).unwrap_or(name), url.port())
    };
    let Some(link_host) = url.host_str() else { return Err(PastedLink::Unrecognized) };
    if bare(&url) != bare(&server) {
        // Text that only parses once given a scheme ("my paper") is no link.
        return Err(match link_host.contains('.') {
            true => PastedLink::OtherHost { host: link_host.to_string() },
            false => PastedLink::Unrecognized,
        });
    }
    let segments: Vec<&str> =
        url.path_segments().map(|s| s.filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let hash = url.fragment().filter(|f| !f.is_empty()).map(|f| format!("#{f}"));
    // Opened on the signed-in server, with the share link's own fragment.
    let page = format!(
        "{}{}{}",
        server.as_str().trim_end_matches('/'),
        url.path(),
        hash.as_deref().unwrap_or("")
    );
    match segments.as_slice() {
        ["project", id, "invite", "token", token] if is_object_id(id) && is_slug(token) => {
            Ok(Link::Invite { project_id: id.to_string(), url: page })
        }
        ["project", id, ..] if is_object_id(id) => Ok(Link::Project(id.to_string())),
        ["read", token] if is_read_token(token) => {
            Ok(Link::Share { grant: format!("/read/{token}/grant"), url: page, hash })
        }
        [token] if is_edit_token(token) => {
            Ok(Link::Share { grant: format!("/{token}/grant"), url: page, hash })
        }
        _ => Err(PastedLink::Unrecognized),
    }
}

/// A MongoDB ObjectId, which every Overleaf project id is.
fn is_object_id(value: &str) -> bool {
    value.len() == 24 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// `READ_ONLY_TOKEN_PATTERN` in Overleaf's TokenAccessHandler: `[a-z]{12}`.
fn is_read_token(token: &str) -> bool {
    token.len() == 12 && token.chars().all(|c| c.is_ascii_lowercase())
}

/// `READ_AND_WRITE_TOKEN_PATTERN`: `[0-9]+[a-z]{6,12}`.
fn is_edit_token(token: &str) -> bool {
    let letters = token.trim_start_matches(|c: char| c.is_ascii_digit());
    letters.len() < token.len()
        && (6..=12).contains(&letters.len())
        && letters.chars().all(|c| c.is_ascii_lowercase())
}

/// What a pasted Overleaf link opens for this account, found the way
/// Overleaf's own pages find it. Nothing here joins a project or accepts an
/// invitation: those ask the user on Overleaf, and the answer says so.
pub fn resolve_link(config_dir: &Path, pasted: &str) -> Result<PastedLink, String> {
    let session = load_session(config_dir)?;
    let link = match parse_link(pasted, &session.host) {
        Ok(link) => link,
        Err(answer) => return Ok(answer),
    };
    let (session, client, html) = open_dashboard(config_dir)?;
    let list = read_dashboard(&client, &session, &html)?;
    let (project_id, invite_url) = match link {
        Link::Project(id) => (id, None),
        Link::Invite { project_id, url } => (project_id, Some(url)),
        Link::Share { grant, url, hash } => {
            match ask_share_link(&client, &session, &html, &grant, hash)? {
                Grant::Member(id) => (id, None),
                Grant::NeedsJoin(project_name) => {
                    return Ok(PastedLink::NeedsJoin { project_name, url })
                }
                Grant::NoAccess => return Ok(PastedLink::NoAccess),
                Grant::NotFound => return Ok(PastedLink::NotFound),
            }
        }
    };
    if let Some(project) = list.projects.into_iter().find(|p| p.id == project_id) {
        return Ok(PastedLink::Project { project: Box::new(project) });
    }
    let invite = list.invites.into_iter().find(|invite| invite.project_id == project_id);
    Ok(match (invite, invite_url) {
        (Some(invite), _) => {
            PastedLink::Invited { project_name: Some(invite.project_name), url: invite.url }
        }
        (None, Some(url)) => PastedLink::Invited { project_name: None, url },
        (None, None) => PastedLink::NoAccess,
    })
}

/// Overleaf's answer about a share link, before anyone has agreed to join.
#[derive(Debug, PartialEq, Eq)]
enum Grant {
    /// Already a member, with at least the access the link gives.
    Member(String),
    NeedsJoin(Option<String>),
    NoAccess,
    NotFound,
}

/// Ask the question Overleaf's own link page asks the moment it opens:
/// `POST …/grant` without `confirmedByUser`. For a signed-in user who is
/// already a member that answers with the project; for anyone else it answers
/// `requireAccept` and adds nobody, because joining waits for a second post
/// that says the user confirmed. We never send that one.
fn ask_share_link(
    client: &Client, session: &SessionFile, html: &str, grant: &str, hash: Option<String>,
) -> Result<Grant, String> {
    let csrf = meta_content(html, "ol-csrfToken").ok_or_else(|| SESSION_EXPIRED.to_string())?;
    let body = match hash {
        Some(hash) => serde_json::json!({ "confirmedByUser": false, "tokenHashPrefix": hash }),
        None => serde_json::json!({ "confirmedByUser": false }),
    };
    let request = client
        .post(format!("{}{grant}", session.host))
        .header(COOKIE, &session.cookie)
        .header("X-Csrf-Token", csrf)
        .header(ACCEPT, JSON)
        .json(&body);
    let response = send(request)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Grant::NotFound);
    }
    let answer: Value = expect_success(response, "for the share link")?.json().map_err(err)?;
    Ok(read_grant(&answer))
}

fn read_grant(answer: &Value) -> Grant {
    if let Some(require) = answer.get("requireAccept") {
        return Grant::NeedsJoin(json_str(require, &["projectName"]));
    }
    let redirect = json_str(answer, &["redirect"]).unwrap_or_default();
    match redirect.strip_prefix("/project/") {
        Some(id) if is_object_id(id) => Grant::Member(id.to_string()),
        _ => Grant::NoAccess,
    }
}

#[cfg(test)]
#[path = "projects/tests.rs"]
mod tests;
