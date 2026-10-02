//! Collaboration over REST: the project chat, comment threads and where they
//! are anchored, Overleaf's own project history, tracked-change review, and
//! creating or deleting entities.
//!
//! A comment thread's position lives in the document's own ranges (which also
//! arrive on the realtime channel when a document is joined); the conversation
//! lives here, behind the same session cookie as everything else.

use super::api::{expect_success, full_name, json_str, Remote};
use crate::overleaf_rt::parse_comment_ranges;
use crate::util::err;
use crate::util::url_encode;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

/// One message in the project chat or in a comment thread.
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

/// A comment thread: everything said on one spot in the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafThread {
    pub id: String,
    pub messages: Vec<OverleafMessage>,
    pub resolved: bool,
    pub resolved_by: Option<String>,
    /// ISO 8601, as Overleaf reports it.
    pub resolved_at: Option<String>,
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

/// A mutation on the linked project; `what` completes "Overleaf returned 500
/// when …".
fn project_mutation(
    config_dir: &Path, root: &Path, method: Method, path: &str, body: Option<Value>, what: &str,
) -> Result<(), String> {
    let response = Remote::open(config_dir, root)?.mutate(method, path, body.as_ref())?;
    expect_success(response, &format!("when {what}")).map(drop)
}

/// "Ada Lovelace", or failing that the single `name` field some payloads use.
fn person_name(user: &Value) -> Option<String> {
    full_name(user).or_else(|| json_str(user, &["name"]))
}

/// A chat or comment message. `name_of` reads the author's display name; the
/// address stands in when there is none.
fn parse_message(
    item: &Value, my_email: Option<&str>, name_of: fn(&Value) -> Option<String>,
) -> Option<OverleafMessage> {
    let user = item.get("user");
    let email = user.and_then(|u| json_str(u, &["email"]));
    Some(OverleafMessage {
        id: json_str(item, &["id", "_id"])?,
        content: json_str(item, &["content"]).unwrap_or_default(),
        mine: matches!((my_email, email.as_deref()),
            (Some(mine), Some(theirs)) if mine.eq_ignore_ascii_case(theirs)),
        author_name: (user.and_then(name_of))
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Someone".to_string()),
        author_email: email,
        timestamp: item.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
    })
}

fn as_list<T>(value: Option<&Value>, parse: impl FnMut(&Value) -> Option<T>) -> Vec<T> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse).collect())
        .unwrap_or_default()
}

// ---- Chat ---------------------------------------------------------------------

/// Read the project chat, oldest first.
pub fn chat_messages(
    config_dir: &Path, root: &Path, limit: u32,
) -> Result<Vec<OverleafMessage>, String> {
    let remote = Remote::open(config_dir, root)?;
    let body = remote.get_json(&format!("/messages?limit={limit}"), "for the project chat")?;
    let my_email = remote.session.email.as_deref();
    let mut messages = as_list(Some(&body), |item| parse_message(item, my_email, full_name));
    // Overleaf answers newest-first; a conversation reads the other way.
    messages.reverse();
    Ok(messages)
}

/// Post a message to the project chat.
pub fn send_chat_message(config_dir: &Path, root: &Path, content: &str) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Write a message first.".to_string());
    }
    let body = json!({ "content": content });
    project_mutation(config_dir, root, Method::POST, "/messages", Some(body), "sending the message")
}

// ---- Comment threads ------------------------------------------------------------

/// Every comment thread in the project, oldest message first within a thread.
pub fn threads(config_dir: &Path, root: &Path) -> Result<Vec<OverleafThread>, String> {
    let remote = Remote::open(config_dir, root)?;
    let body = remote.get_json("/threads", "for the project's comments")?;
    Ok(parse_threads(&body, remote.session.email.as_deref()))
}

/// `{ "<threadId>": { messages: [...], resolved?, resolved_at?, resolved_by_user? } }`
fn parse_threads(body: &Value, my_email: Option<&str>) -> Vec<OverleafThread> {
    let Some(map) = body.as_object() else {
        return Vec::new();
    };
    let mut threads: Vec<OverleafThread> = (map.iter())
        .map(|(id, thread)| OverleafThread {
            id: id.clone(),
            messages: as_list(thread.get("messages"), |item| {
                parse_message(item, my_email, person_name)
            }),
            resolved: thread.get("resolved").and_then(Value::as_bool).unwrap_or(false),
            resolved_by: thread.get("resolved_by_user").and_then(person_name),
            resolved_at: json_str(thread, &["resolved_at", "resolvedAt"]),
        })
        .collect();
    // Newest conversation first: that is the one someone is waiting on.
    threads.sort_by_key(|thread| {
        std::cmp::Reverse(thread.messages.last().map(|m| m.timestamp).unwrap_or(0))
    });
    threads
}

/// Where every comment in the project is anchored, in one call.
///
/// The editing channel only reveals the ranges of documents that have been
/// joined, so without this a comment on a file nobody has opened has no quoted
/// text, cannot be jumped to, and cannot be resolved or deleted — those
/// endpoints are keyed by the document the thread lives in.
pub fn comment_anchors(
    config_dir: &Path, root: &Path,
) -> Result<Vec<OverleafCommentAnchor>, String> {
    let remote = Remote::open(config_dir, root)?;
    Ok(parse_comment_anchors(&remote.get_json("/ranges", "for the project's comment anchors")?))
}

/// `[{ "id": <docId>, "ranges": { "comments": [...], "changes": [...] } }]`;
/// a document with nothing in it still appears, with empty ranges.
fn parse_comment_anchors(body: &Value) -> Vec<OverleafCommentAnchor> {
    let docs = body.as_array().into_iter().flatten();
    docs.flat_map(|entry| {
        let doc_id = json_str(entry, &["id", "_id"]).unwrap_or_default();
        let ranges = entry.get("ranges").cloned().unwrap_or_default();
        // The same `{ p, c, t }` shape the editing channel sends, so it goes
        // through the same parser — including the transport unpacking the
        // quoted text needs.
        parse_comment_ranges(&ranges).into_iter().map(move |range| OverleafCommentAnchor {
            thread_id: range.thread_id,
            doc_id: doc_id.clone(),
            position: range.position,
            quote: range.quote,
        })
    })
    .filter(|anchor| !anchor.doc_id.is_empty())
    .collect()
}

/// Add a message to an existing thread.
pub fn reply_to_thread(
    config_dir: &Path, root: &Path, thread_id: &str, content: &str,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Write a reply first.".to_string());
    }
    let path = format!("/thread/{thread_id}/messages");
    let body = json!({ "content": content });
    project_mutation(config_dir, root, Method::POST, &path, Some(body), "posting the reply")
}

/// Resolving, reopening and deleting are all keyed by the document the thread
/// sits in — Overleaf needs to know where to clear the marker.
pub fn resolve_thread(
    config_dir: &Path, root: &Path, doc_id: &str, thread_id: &str, resolved: bool,
) -> Result<(), String> {
    let (action, what) = if resolved {
        ("resolve", "resolving the comment")
    } else {
        ("reopen", "reopening the comment")
    };
    let path = format!("/doc/{doc_id}/thread/{thread_id}/{action}");
    project_mutation(config_dir, root, Method::POST, &path, None, what)
}

/// Change what one message says. Overleaf only lets the author do this.
pub fn edit_message(
    config_dir: &Path, root: &Path, thread_id: &str, message_id: &str, content: &str,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A comment cannot be empty. Delete it instead.".to_string());
    }
    let path = format!("/thread/{thread_id}/messages/{message_id}/edit");
    let body = json!({ "content": content });
    project_mutation(config_dir, root, Method::POST, &path, Some(body), "saving the edit")
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
    config_dir: &Path, root: &Path, thread_id: &str, message_id: &str,
) -> Result<(), String> {
    let remote = Remote::open(config_dir, root)?;
    let own_route = format!("/thread/{thread_id}/own-messages/{message_id}");
    let mut response = remote.mutate(Method::DELETE, &own_route, None)?;
    if response.status() == StatusCode::NOT_FOUND {
        let route = format!("/thread/{thread_id}/messages/{message_id}");
        response = remote.mutate(Method::DELETE, &route, None)?;
    }
    expect_success(response, "when deleting the comment").map(drop)
}

pub fn delete_thread(
    config_dir: &Path, root: &Path, doc_id: &str, thread_id: &str,
) -> Result<(), String> {
    let path = format!("/doc/{doc_id}/thread/{thread_id}");
    project_mutation(config_dir, root, Method::DELETE, &path, None, "deleting the comment")
}

// ---- Overleaf's own history -------------------------------------------------------
//
// Separate from Lattice's version timeline, which records what happened on this
// machine. This is the project's history as Overleaf kept it, including
// everything done in the browser while this app was closed — so it is the only
// thing that can answer "put it back the way it was on Tuesday" for work that
// never passed through here.

fn history_get(config_dir: &Path, root: &Path, path: &str) -> Result<Value, String> {
    let response = Remote::open(config_dir, root)?.get(path, 30)?;
    if response.status().as_u16() == 402 {
        return Err("Overleaf's full history needs a paid plan on this project.".to_string());
    }
    expect_success(response, "for the project history")?.json().map_err(err)
}

/// A page of history, newest first. `before` continues from a previous page's
/// `nextBefore` — which is a version number despite Overleaf calling it a
/// timestamp.
pub fn history_updates(
    config_dir: &Path, root: &Path, before: Option<i64>, count: u32,
) -> Result<(Vec<OverleafUpdate>, Option<i64>), String> {
    let before = before.map(|before| format!("&before={before}")).unwrap_or_default();
    let body = history_get(config_dir, root, &format!("/updates?min_count={count}{before}"))?;
    let updates = as_list(body.get("updates"), |item| Some(parse_history_update(item)));
    Ok((updates, body.get("nextBeforeTimestamp").and_then(Value::as_i64)))
}

fn parse_history_update(item: &Value) -> OverleafUpdate {
    let number = |value: Option<&Value>| value.and_then(Value::as_i64).unwrap_or(0);
    let meta = item.get("meta");
    let meta_field = |key: &str| meta.and_then(|m| m.get(key));
    OverleafUpdate {
        from_version: number(item.get("fromV")),
        to_version: number(item.get("toV")),
        start_ts: number(meta_field("start_ts")),
        end_ts: number(meta_field("end_ts")),
        authors: as_list(meta_field("users"), person_name),
        paths: update_paths(item),
        labels: as_list(item.get("labels"), parse_label),
        origin: meta_field("origin").and_then(|origin| json_str(origin, &["kind"])),
    }
}

/// Every file an update touched, from the two places Overleaf keeps them.
///
/// `pathnames` only ever lists documents that were edited. Anything done to
/// the project *tree* — uploading a figure, renaming a file, deleting one —
/// lands in `project_ops` instead, and an update that did only that has an
/// empty `pathnames`. Reading just the one field makes real uploads and
/// deletions show up in the timeline as having changed nothing at all.
fn update_paths(item: &Value) -> Vec<String> {
    let mut paths: Vec<String> =
        as_list(item.get("pathnames"), |path| path.as_str().map(str::to_string));
    for op in item.get("project_ops").and_then(Value::as_array).into_iter().flatten() {
        // A rename is named by where the file ended up, which is what the
        // reader would go looking for now.
        let path = ["rename", "add", "remove"].into_iter().find_map(|kind| {
            op.get(kind).and_then(|body| json_str(body, &["newPathname", "pathname"]))
        });
        if let Some(path) = path.filter(|path| !paths.contains(path)) {
            paths.push(path);
        }
    }
    paths
}

fn parse_label(item: &Value) -> Option<OverleafLabel> {
    Some(OverleafLabel {
        id: json_str(item, &["id", "_id"])?,
        comment: json_str(item, &["comment"]).unwrap_or_default(),
        version: item.get("version").and_then(Value::as_i64)?,
        created_at: json_str(item, &["created_at", "createdAt"]),
        author: json_str(item, &["user_display_name", "userDisplayName"]),
    })
}

/// How one file read at two versions, as insert/delete/unchanged runs.
pub fn history_diff(
    config_dir: &Path, root: &Path, path: &str, from: i64, to: i64,
) -> Result<Value, String> {
    let query = format!("/diff?from={from}&to={to}&pathname={}", url_encode(path));
    history_get(config_dir, root, &query)
}

/// Every file as it stood across a version range. `from == to` lists the tree
/// at one version; entries with no operation existed unchanged at both.
pub fn history_files(config_dir: &Path, root: &Path, from: i64, to: i64) -> Result<Value, String> {
    history_get(config_dir, root, &format!("/filetree/diff?from={from}&to={to}"))
}

/// Updates per history page, and how many pages one check may read before it
/// gives up rather than walk a long history on every sync.
const HISTORY_PAGE: u32 = 50;
const HISTORY_PAGES: usize = 20;

/// Where in Overleaf's history a sync's agreed copy stands: changes from here
/// on are not in it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HistoryFrom {
    /// The project version the copy was downloaded at.
    Version(i64),
    /// When the copy was taken (Unix milliseconds), for a sync that could not
    /// learn the version.
    Time(i64),
}

/// How far before a sync's time a change still counts as after it, so clock
/// skew between this machine and Overleaf cannot hide one made just before.
const HISTORY_SLACK_MS: i64 = 10 * 60 * 1000;

/// One entry of Overleaf's history, as far as confirming a download goes.
pub(super) struct HistoryUpdate {
    from_v: Option<i64>,
    to_v: Option<i64>,
    end_ts: Option<i64>,
    /// Documents edited, files uploaded or removed, and both ends of a
    /// rename, so a file renamed away counts as changed at its old path too.
    /// A folder operation names only the folder.
    pub paths: BTreeSet<String>,
}

impl HistoryUpdate {
    /// Whether this update is missing from a copy taken at `from` (`None`:
    /// no copy, so every update is). One that cannot be placed counts.
    pub fn after(&self, from: Option<HistoryFrom>) -> bool {
        match from {
            None => true,
            Some(HistoryFrom::Version(version)) => self.from_v.is_none_or(|v| v >= version),
            Some(HistoryFrom::Time(ms)) => {
                self.end_ts.is_none_or(|end| end >= ms - HISTORY_SLACK_MS)
            }
        }
    }

    /// Whether this update is already part of a write Lattice itself made at
    /// `own`: one that cannot be placed is not.
    pub fn within(&self, own: HistoryFrom) -> bool {
        match own {
            HistoryFrom::Version(version) => self.to_v.is_some_and(|v| v <= version),
            HistoryFrom::Time(ms) => self.end_ts.is_some_and(|end| end <= ms + HISTORY_SLACK_MS),
        }
    }
}

/// Overleaf's history, newest first, up to the first update `wanted` turns
/// down; everything older than that is turned down too.
///
/// This is the evidence a destructive download must have before a sync acts
/// on it (see `sync::settle_destructive`), so an unreadable history is an
/// error, never an empty list the caller might read as "nothing changed".
pub(super) fn history_since(
    remote: &Remote, wanted: impl Fn(&HistoryUpdate) -> bool,
) -> Result<Vec<HistoryUpdate>, String> {
    let mut history = Vec::new();
    let mut before: Option<i64> = None;
    for _ in 0..HISTORY_PAGES {
        let page = before.map(|before| format!("&before={before}")).unwrap_or_default();
        let response = remote.get(&format!("/updates?min_count={HISTORY_PAGE}{page}"), 30)?;
        let body: Value =
            expect_success(response, "for the project history")?.json().map_err(err)?;
        let updates = body.get("updates").and_then(Value::as_array).cloned().unwrap_or_default();
        for update in &updates {
            let mut paths: BTreeSet<String> = update_paths(update).into_iter().collect();
            for op in update.get("project_ops").and_then(Value::as_array).into_iter().flatten() {
                if let Some(from) = op.get("rename").and_then(|body| json_str(body, &["pathname"]))
                {
                    paths.insert(from);
                }
            }
            let update = HistoryUpdate {
                from_v: update.get("fromV").and_then(Value::as_i64),
                to_v: update.get("toV").and_then(Value::as_i64),
                end_ts: update.get("meta").and_then(|meta| meta.get("end_ts")?.as_i64()),
                paths,
            };
            if !wanted(&update) {
                return Ok(history);
            }
            history.push(update);
        }
        match body.get("nextBeforeTimestamp").and_then(Value::as_i64) {
            Some(next) if !updates.is_empty() => before = Some(next),
            _ => return Ok(history),
        }
    }
    Err("Overleaf's history since the last sync is longer than Lattice reads at once.".to_string())
}

/// Roll one file, or the whole project, back to a version.
///
/// Reverting is delete-then-add on Overleaf's side, so the entity's id changes
/// and the file tree events report a removal followed by a creation. That is
/// expected, not a sign something went wrong.
pub fn history_revert(
    config_dir: &Path, root: &Path, version: i64, path: Option<&str>,
) -> Result<(), String> {
    let (endpoint, body) = match path {
        Some(path) => ("/revert_file", json!({ "version": version, "pathname": path })),
        None => ("/revert-project", json!({ "version": version })),
    };
    project_mutation(config_dir, root, Method::POST, endpoint, Some(body), "restoring from history")
}

/// Bring back a file that was deleted, using the version it vanished at.
pub fn history_restore_file(
    config_dir: &Path, root: &Path, version: i64, path: &str,
) -> Result<(), String> {
    let body = Some(json!({ "version": version, "pathname": path }));
    project_mutation(config_dir, root, Method::POST, "/restore_file", body, "restoring the file")
}

pub fn history_add_label(
    config_dir: &Path, root: &Path, version: i64, comment: &str,
) -> Result<(), String> {
    let body = json!({ "version": version, "comment": comment });
    project_mutation(config_dir, root, Method::POST, "/labels", Some(body), "naming this version")
}

pub fn history_delete_label(config_dir: &Path, root: &Path, label_id: &str) -> Result<(), String> {
    let path = format!("/labels/{label_id}");
    project_mutation(config_dir, root, Method::DELETE, &path, None, "removing the name")
}

// ---- Tracked changes ----------------------------------------------------------------

/// Accept tracked changes: the suggested text becomes ordinary text.
///
/// Accepting is the one half of reviewing that does not change the document,
/// which is why it has an endpoint of its own rather than travelling as an
/// operation the way rejecting does.
pub fn accept_changes(
    config_dir: &Path, root: &Path, doc_id: &str, change_ids: &[String],
) -> Result<(), String> {
    if change_ids.is_empty() {
        return Ok(());
    }
    let path = format!("/doc/{doc_id}/changes/accept");
    let body = json!({ "change_ids": change_ids });
    project_mutation(config_dir, root, Method::POST, &path, Some(body), "accepting the suggestion")
}

/// Who wrote the suggestions in this project.
///
/// Kept separate from the project's member list because the author of an old
/// change may have left the project since, and a suggestion with no name on it
/// is one nobody can judge.
pub fn change_authors(config_dir: &Path, root: &Path) -> Result<Value, String> {
    Remote::open(config_dir, root)?.get_json("/changes/users", "for the suggestion authors")
}

// ---- Entities -------------------------------------------------------------------------

/// Delete an entity from the project. `kind` is "doc", "file" or "folder".
///
/// Syncing has never done this — a file deleted here simply stayed on
/// Overleaf — which is safe but leaves the two sides permanently different.
pub fn delete_entity(
    config_dir: &Path, root: &Path, kind: &str, entity_id: &str,
) -> Result<(), String> {
    if !matches!(kind, "doc" | "file" | "folder") {
        return Err(format!("{kind} is not something Overleaf can delete."));
    }
    let remote = Remote::open(config_dir, root)?;
    let (client, csrf) = remote.csrf_client(20)?;
    let request =
        remote.request(&client, Method::DELETE, &format!("/{kind}/{entity_id}"), Some(&csrf));
    let response = super::api::send(request)?;
    expect_success(response, &format!("when deleting the {kind}")).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `/ranges` payload, taken verbatim from overleaf.com with one
    /// comment in the project: every document is listed whether or not it has
    /// anything in it, and the comment's `op` is the same `{p, c, t}` shape
    /// the editing channel sends.
    #[test]
    fn comment_anchors_name_the_document_each_thread_lives_in() {
        let body = json!([
            { "id": "6a5acedf2b1182598e0ae369", "ranges": {} },
            { "id": "6a5acedf2b1182598e0ae36a", "ranges": { "comments": [] } },
            { "id": "6a5acedf2b1182598e0ae36b", "ranges": { "comments": [{
                "id": "6a18a500005eedc0ffee1234",
                "metadata": { "ts": "2026-07-25T01:55:50.719Z", "user_id": "65103fad2765" },
                "op": { "c": "\\documentcla", "p": 0, "t": "6a18a500005eedc0ffee1234" },
            }] } },
        ]);
        assert_eq!(
            parse_comment_anchors(&body),
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
        let chinese = json!([{ "id": "d1", "ranges": { "comments": [{ "op": { "c": packed, "p": 12, "t": "t1" } }] } }]);
        assert_eq!(parse_comment_anchors(&chinese)[0].quote, "第三节");
    }

    /// Both halves of a real `/updates` entry, taken verbatim from
    /// overleaf.com: an upload leaves `pathnames` empty and records what it
    /// did in `project_ops`, so a timeline reading only `pathnames` shows it
    /// as an update that touched nothing.
    #[test]
    fn history_update_paths_include_file_operations() {
        let doc_edit =
            json!({ "fromV": 65, "toV": 67, "pathnames": ["neurips_2026.tex"], "labels": [] });
        let upload = json!({
            "fromV": 43, "toV": 45, "pathnames": [], "labels": [],
            "project_ops": [
                { "atV": 44, "add": { "pathname": "figures/loss.png" } },
                { "atV": 43, "remove": { "pathname": "figures/old.png" } },
            ],
        });
        // A rename is listed under where the file ended up, and a path that
        // appears in both fields is only listed once.
        let mixed = json!({
            "fromV": 1, "toV": 3, "pathnames": ["main.tex"], "labels": [],
            "project_ops": [
                { "atV": 2, "rename": { "pathname": "draft.tex", "newPathname": "final.tex" } },
                { "atV": 3, "add": { "pathname": "main.tex" } },
            ],
        });
        for (update, expected) in [
            (doc_edit, vec!["neurips_2026.tex"]),
            (upload, vec!["figures/loss.png", "figures/old.png"]),
            (mixed, vec!["main.tex", "final.tex"]),
        ] {
            assert_eq!(update_paths(&update), expected);
        }
    }

    #[test]
    fn overleaf_threads_parse_with_resolution_and_authorship() {
        let body = json!({
            "thread-old": {
                "messages": [
                    {"id": "c1", "content": "tighten this", "timestamp": 1_000i64,
                     "user": {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.edu"}},
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
        let (new, old) = (&threads[0], &threads[1]);
        assert_eq!(new.id, "thread-new");
        assert!(!new.resolved);
        assert_eq!(new.messages.len(), 2);
        // No name at all falls back to the address rather than showing blank.
        assert_eq!(new.messages[0].author_name, "sam@example.edu");
        assert!(!new.messages[0].mine);
        // Our own message is ours regardless of how the address is cased.
        assert!(new.messages[1].mine);

        assert_eq!(old.id, "thread-old");
        assert!(old.resolved);
        assert_eq!(old.resolved_by.as_deref(), Some("Robin"));
        assert_eq!(old.resolved_at.as_deref(), Some("2026-07-01T10:00:00Z"));
        assert_eq!(old.messages[0].author_name, "Ada Lovelace");

        // An Overleaf without the review panel answers with nothing at all.
        assert!(parse_threads(&json!({}), None).is_empty());
        assert!(parse_threads(&json!(null), None).is_empty());
    }

    /// Reads the real project's Overleaf history. This is the surface that is
    /// least visible in the open source — several endpoints only exist as
    /// calls the browser makes — so its shapes are worth confirming.
    #[test]
    #[ignore = "reads overleaf.com with the signed-in session"]
    fn reads_the_real_project_history() {
        let (config, root) = crate::overleaf_rt::tests::live_project();
        let (updates, next) = history_updates(&config, &root, None, 10).expect("updates");
        println!("{} updates, next page before {next:?}", updates.len());
        assert!(!updates.is_empty(), "a synced project has history");
        let newest = &updates[0];
        assert!(newest.to_version >= newest.from_version);
        assert!(newest.end_ts > 0, "timestamps should be milliseconds");

        // The file tree as it stood at one version.
        let files = history_files(&config, &root, newest.from_version, newest.to_version)
            .expect("filetree diff");
        let listed = files.get("diff").and_then(Value::as_array).map_or(0, Vec::len);
        assert!(listed > 0, "entries in the tree across that range");

        // And the text diff for one file it touched.
        if let Some(path) = newest.paths.first() {
            let diff = history_diff(&config, &root, path, newest.from_version, newest.to_version)
                .expect("diff");
            assert!(diff.get("diff").is_some());
        }
    }
}
