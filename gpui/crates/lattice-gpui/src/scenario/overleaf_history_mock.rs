//! The stand-in Overleaf's own history and chat (`overleaf_mock`), as its
//! REST endpoints carry them; every version the project reaches keeps a
//! snapshot of its files, so a diff, a file tree diff and a restore read the
//! same texts Overleaf's history service would.
//!
//! Under `/project/{id}`:
//! - `GET /filetree/diff?from=&to=`: every file across the range, those
//!   that changed with their `operation` (a removed one with `deletedAtV`).
//! - `POST /revert_file` `{version, pathname}`, `POST /revert-project`
//!   `{version}` and `POST /restore_file` `{version, pathname}`: the files
//!   as they stood then, at a new version marked as a restore.
//! - `POST /labels` `{version, comment}` and `DELETE /labels/{id}`: the
//!   names a version carries, which `GET /updates` lists on it.
//! - `GET /messages?limit=`: the chat, newest first; `POST /messages`
//!   `{content}` posts one, broadcast on the live channel as
//!   `new-chat-message` to everyone, its author included.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::overleaf_mock::{Project, bump_by};
use super::overleaf_realtime_mock::{broadcast, event, is_doc, server_rewrote};

/// Who the stand-in's accounts are, as its history and chat name them.
pub(super) fn person(user: &str) -> Value {
    match user {
        "u-coauthor" => {
            json!({ "id": user, "first_name": "Grace", "last_name": "Hopper", "email": "grace@example.edu" })
        }
        "u-peer" => {
            json!({ "id": user, "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.edu" })
        }
        _ => {
            json!({ "id": user, "first_name": "Robin", "last_name": "Researcher", "email": super::overleaf_mock::EMAIL })
        }
    }
}

/// The files as they stood at `version`: the newest snapshot at or before it.
fn files_at(project: &Project, version: i64) -> BTreeMap<String, Vec<u8>> {
    project
        .snapshots
        .range(..=version)
        .next_back()
        .map(|(_, files)| files.clone())
        .unwrap_or_default()
}

/// Text `before` to `after` as Overleaf's chunks: the unchanged lead, what
/// was deleted, what was inserted, the unchanged tail; the edits by `users`.
pub(super) fn chunks(before: &str, after: &str, users: &[Value]) -> Vec<Value> {
    let lead = before
        .chars()
        .zip(after.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let (before_rest, after_rest): (Vec<char>, Vec<char>) = (
        before.chars().skip(lead).collect(),
        after.chars().skip(lead).collect(),
    );
    let tail = before_rest
        .iter()
        .rev()
        .zip(after_rest.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let text = |chars: &[char]| chars.iter().collect::<String>();
    let lead_text: String = before.chars().take(lead).collect();
    let deleted = text(&before_rest[..before_rest.len() - tail]);
    let inserted = text(&after_rest[..after_rest.len() - tail]);
    let tail_text = text(&before_rest[before_rest.len() - tail..]);
    let meta = json!({ "users": users });
    let mut parts = Vec::new();
    if !lead_text.is_empty() {
        parts.push(json!({ "u": lead_text }));
    }
    if !deleted.is_empty() {
        parts.push(json!({ "d": deleted, "meta": meta }));
    }
    if !inserted.is_empty() {
        parts.push(json!({ "i": inserted, "meta": meta }));
    }
    if !tail_text.is_empty() {
        parts.push(json!({ "u": tail_text }));
    }
    parts
}

/// The texts of `pathname` at `from` and at `to`, when both are text.
pub(super) fn texts(project: &Project, pathname: &str, from: i64, to: i64) -> (String, String) {
    let read = |version: i64| {
        files_at(project, version)
            .get(pathname)
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default()
    };
    (read(from), read(to))
}

fn query(url: &str, key: &str) -> Option<String> {
    url.split(['?', '&'])
        .find_map(|pair| pair.strip_prefix(&format!("{key}=")))
        .map(|value| value.replace("%2F", "/"))
}

/// The labels on `to_version`, as `GET /updates` lists them.
pub(super) fn labels_on(project: &Project, to_version: i64) -> Vec<Value> {
    project
        .labels
        .iter()
        .filter(|label| label["version"].as_i64() == Some(to_version))
        .cloned()
        .collect()
}

/// A history or chat request, `rest` the path after `/project/{id}`;
/// `(status, body)`, or none when it is not one.
pub(super) fn rest(
    project: &mut Project,
    method: &str,
    rest: &str,
    url: &str,
    body: &[u8],
) -> Option<(u16, Value)> {
    let parts: Vec<&str> = rest.trim_start_matches('/').split('/').collect();
    let body: Value = serde_json::from_slice(body).unwrap_or_default();
    let version = body["version"].as_i64();
    let pathname = body["pathname"].as_str().map(str::to_string);
    let ok = Some((200, json!({})));
    let answer = match (method, parts.as_slice()) {
        ("GET", ["filetree", "diff"]) => {
            let number = |key: &str| query(url, key).and_then(|value| value.parse().ok());
            let (from, to): (i64, i64) = (number("from")?, number("to")?);
            Some((200, json!({ "diff": file_tree_diff(project, from, to) })))
        }
        ("POST", ["revert_file"]) => {
            let (version, pathname) = (version?, pathname?);
            let Some(bytes) = files_at(project, version).get(&pathname).cloned() else {
                return Some((404, json!({})));
            };
            restore(project, &pathname, bytes);
            bump_by(project, &[pathname], "u-mock", Some("file-restore"));
            ok
        }
        ("POST", ["restore_file"]) => {
            // The version it vanished at; it last stood the one before.
            let (version, pathname) = (version?, pathname?);
            let Some(bytes) = files_at(project, version - 1).get(&pathname).cloned() else {
                return Some((404, json!({})));
            };
            restore(project, &pathname, bytes);
            bump_by(project, &[pathname], "u-mock", Some("file-restore"));
            ok
        }
        ("POST", ["revert-project"]) => {
            let then = files_at(project, version?);
            let touched: BTreeSet<String> =
                project.files.keys().chain(then.keys()).cloned().collect();
            project.files.retain(|path, _| then.contains_key(path));
            for (path, bytes) in then {
                restore(project, &path, bytes);
            }
            let touched: Vec<String> = touched.into_iter().collect();
            bump_by(project, &touched, "u-mock", Some("project-restore"));
            ok
        }
        ("POST", ["labels"]) => {
            project.next_id += 1;
            let id = format!("label-{}", project.next_id);
            project.labels.push(json!({
                "id": id,
                "comment": body["comment"].as_str().unwrap_or_default(),
                "version": version?,
                "created_at": chrono::Utc::now().to_rfc3339(),
                "user_display_name": "Robin Researcher",
            }));
            Some((200, json!({ "id": id })))
        }
        ("DELETE", ["labels", id]) => {
            project
                .labels
                .retain(|label| label["id"].as_str() != Some(id));
            ok
        }
        ("GET", ["messages"]) => {
            let limit = query(url, "limit")
                .and_then(|limit| limit.parse::<usize>().ok())
                .unwrap_or(50);
            let newest_first: Vec<Value> = project.chat.iter().rev().take(limit).cloned().collect();
            Some((200, json!(newest_first)))
        }
        ("POST", ["messages"]) => {
            let content = body["content"].as_str().unwrap_or_default().to_string();
            post_chat(project, "u-mock", &content);
            ok
        }
        _ => None,
    };
    if answer.is_some() {
        project.history_requests.push(format!("{method} {rest}"));
    }
    answer
}

/// `path` back to `bytes`: a document that exists is rewritten in place,
/// on its channel too, as Overleaf's document updater does; anything else
/// is put back as a file.
fn restore(project: &mut Project, path: &str, bytes: Vec<u8>) {
    if is_doc(path) && project.files.contains_key(path) {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let Project { files, live, .. } = project;
        server_rewrote(files, live, path, &text);
    } else {
        project.files.insert(path.to_string(), bytes);
    }
}

/// `user` says `content` in the chat: kept, and sent to the whole room.
pub(super) fn post_chat(project: &mut Project, user: &str, content: &str) {
    project.next_id += 1;
    let message = json!({
        "id": format!("chat-{}", project.next_id),
        "content": content,
        "timestamp": chrono::Utc::now().timestamp_millis(),
        "user": person(user),
    });
    project.chat.push(message.clone());
    broadcast(
        &project.live,
        None,
        &event("new-chat-message", json!([message])),
    );
}

/// Every file across `from..=to`; those the range changed carry how.
fn file_tree_diff(project: &Project, from: i64, to: i64) -> Vec<Value> {
    let (before, after) = (files_at(project, from), files_at(project, to));
    let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    names
        .into_iter()
        .map(|name| match (before.get(name), after.get(name)) {
            (None, Some(_)) => json!({ "pathname": name, "operation": "added" }),
            (Some(_), None) => {
                // The version it vanished at, which restore_file takes.
                let gone = (from + 1..=to)
                    .find(|version| !files_at(project, *version).contains_key(name))
                    .unwrap_or(to);
                json!({ "pathname": name, "operation": "removed", "deletedAtV": gone })
            }
            (Some(old), Some(new)) if old != new => {
                json!({ "pathname": name, "operation": "edited", "editable": true })
            }
            _ => json!({ "pathname": name, "editable": true }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_split_into_lead_deletion_insertion_and_tail() {
        let users = [json!({ "id": "u-coauthor" })];
        let parts = chunks("The quick fox", "The slow fox", &users);
        assert_eq!(parts[0], json!({ "u": "The " }));
        assert_eq!(parts[1]["d"], json!("quick"));
        assert_eq!(parts[2]["i"], json!("slow"));
        assert_eq!(parts[3], json!({ "u": " fox" }));
        assert_eq!(parts[1]["meta"]["users"][0]["id"], json!("u-coauthor"));
    }

    #[test]
    fn identical_texts_are_one_unchanged_run() {
        assert_eq!(chunks("same", "same", &[]), vec![json!({ "u": "same" })]);
    }
}
