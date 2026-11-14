//! The stand-in Overleaf's review (`overleaf_mock`, `overleaf_realtime_mock`):
//! comment threads and suggestions, as Overleaf's REST endpoints and live
//! channel carry them.
//!
//! - REST, under `/project/{id}`: `GET /threads` (`{threadId: {messages,
//!   resolved, resolved_by_user}}`), `GET /ranges` (each document's comment
//!   anchors), `POST /thread/{t}/messages` (a reply, or a new thread's first
//!   message), `POST /thread/{t}/messages/{m}/edit`, `DELETE
//!   /thread/{t}/own-messages/{m}`, `POST /doc/{d}/thread/{t}/resolve` and
//!   `/reopen`, `DELETE /doc/{d}/thread/{t}`, `POST /doc/{d}/changes/accept`,
//!   and `GET /changes/users`. Each change to a thread is broadcast as the
//!   socket event Overleaf sends for it.
//! - The live channel: `joinDoc` answers each document's ranges; an update
//!   holding a comment op (`{p, c, t}`) anchors its thread; one sent as a
//!   suggestion (`meta.tc`) records what it inserted and removed as
//!   suggestions by its sender, the same rules the app follows
//!   (`lattice_core::overleaf_rt::tracked`) but with ids of the server's
//!   own; one whose ops carry `u` undoes the suggestions it names.
//! - The scripted collaborator comments and suggests.

use std::collections::BTreeMap;

use lattice_core::overleaf_rt::{
    CommentRange, OtOp, Suggester, TrackedChange, ot, presence_hue, tracked,
};
use serde_json::{Value, json};

use super::overleaf_realtime_mock::{Live, PEER_ID, PEER_USER, broadcast, doc_id, event, packed};

/// The account signed in to the stand-in, as Overleaf names it.
pub const OWN_USER: &str = "u-mock";

#[derive(Default)]
pub(super) struct ReviewMock {
    threads: BTreeMap<String, Thread>,
    /// Each document's comment anchors and suggestions, by path.
    comments: BTreeMap<String, Vec<CommentRange>>,
    changes: BTreeMap<String, Vec<TrackedChange>>,
    next_id: u64,
    /// Every REST request on review, `METHOD path`.
    pub(super) requests: Vec<String>,
}

#[derive(Default)]
struct Thread {
    messages: Vec<Value>,
    resolved: bool,
}

impl ReviewMock {
    fn mint(&mut self, kind: &str) -> String {
        self.next_id += 1;
        format!("{kind}-{}", self.next_id)
    }

    /// `path`'s suggestions, as the scenario reads them.
    pub(super) fn changes(&self, path: &str) -> Vec<TrackedChange> {
        self.changes.get(path).cloned().unwrap_or_default()
    }

    pub(super) fn comments(&self, path: &str) -> Vec<CommentRange> {
        self.comments.get(path).cloned().unwrap_or_default()
    }

    /// Thread `id`'s messages' contents, and whether it is resolved.
    pub(super) fn thread(&self, id: &str) -> Option<(Vec<String>, bool)> {
        let thread = self.threads.get(id)?;
        let contents = thread
            .messages
            .iter()
            .map(|message| message["content"].as_str().unwrap_or_default().to_string())
            .collect();
        Some((contents, thread.resolved))
    }
}

fn person(user: &str) -> Value {
    if user == PEER_USER {
        json!({ "id": PEER_USER, "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.edu" })
    } else {
        json!({ "id": OWN_USER, "first_name": "Mock", "last_name": "Researcher", "email": super::overleaf_mock::EMAIL })
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The ranges `joinDoc` answers for `path`.
pub(super) fn ranges(live: &Live, path: &str) -> Value {
    let comments: Vec<Value> = live
        .review
        .comments(path)
        .iter()
        .map(|range| json!({ "id": range.thread_id, "op": { "p": range.position, "c": packed(&range.quote), "t": range.thread_id } }))
        .collect();
    let changes: Vec<Value> = live
        .review
        .changes(path)
        .iter()
        .map(|change| {
            let key = if change.deletion { "d" } else { "i" };
            json!({
                "id": change.id,
                "op": { "p": change.position, key: packed(&change.text) },
                "metadata": { "user_id": change.user_id, "ts": change.timestamp },
            })
        })
        .collect();
    json!({ "comments": comments, "changes": changes })
}

/// The comment ops among an update's raw ops, as `(p, quote, thread)`.
pub(super) fn comment_ops(raw: &Value) -> Vec<(i64, String, String)> {
    raw.as_array()
        .into_iter()
        .flatten()
        .filter_map(|op| {
            Some((
                op.get("p")?.as_i64()?,
                op.get("c")?.as_str()?.to_string(),
                op.get("t")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

/// A comment op from `source` landed in `path`: its thread is anchored.
pub(super) fn anchored(live: &mut Live, path: &str, position: i64, quote: &str, thread: &str) {
    let quote = decode_packed(quote);
    let comments = live.review.comments.entry(path.to_string()).or_default();
    comments.retain(|range| range.thread_id != thread);
    comments.push(CommentRange {
        thread_id: thread.to_string(),
        position,
        quote,
    });
}

fn decode_packed(text: &str) -> String {
    let bytes: Vec<u8> = text.chars().map(|c| c as u32 as u8).collect();
    String::from_utf8(bytes).unwrap_or_else(|_| text.to_string())
}

/// `ops` landed in `path`, from `user`, as suggestions when `tracked`:
/// what they make of its suggestions and comment anchors.
pub(super) fn landed(live: &mut Live, path: &str, ops: &[OtOp], user: &str, tracked: bool) {
    let review = &mut live.review;
    let mut changes = review.changes.remove(path).unwrap_or_default();
    // An undo of a suggestion (a rejection) consumes it.
    let undone: Vec<&OtOp> = ops.iter().filter(|op| op.u == Some(true)).collect();
    changes.retain(|change| {
        !undone.iter().any(|op| {
            op.p as i64 == change.position
                && if change.deletion {
                    op.i.as_deref() == Some(change.text.as_str())
                } else {
                    op.d.as_deref() == Some(change.text.as_str())
                }
        })
    });
    let by = (tracked && undone.is_empty()).then(|| Suggester {
        user_id: Some(user.to_string()),
        hue: presence_hue(Some(user)),
    });
    let now = chrono::Utc::now().to_rfc3339();
    let mut changes = tracked::changes_after(&changes, ops, by.as_ref(), &now);
    for change in &mut changes {
        if tracked::is_provisional(change) {
            change.id = review.mint("change");
        }
    }
    review.changes.insert(path.to_string(), changes);
    if let Some(comments) = review.comments.get_mut(path) {
        *comments = tracked::comments_after(comments, ops);
    }
}

/// The scripted collaborator suggests `ops` in `path`; false when they do
/// not fit.
pub(super) fn peer_suggested(
    files: &mut BTreeMap<String, Vec<u8>>,
    live: &mut Live,
    path: &str,
    ops: Vec<OtOp>,
) -> bool {
    let Some(text) = files
        .get(path)
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    else {
        return false;
    };
    let Some(next) = ot::apply_ops(&text, &ops) else {
        return false;
    };
    files.insert(path.to_string(), next.into_bytes());
    let history = &mut live.docs.entry(path.to_string()).or_default().history;
    let version = history.len();
    history.push((ops.clone(), PEER_ID.to_string()));
    landed(live, path, &ops, PEER_USER, true);
    let update = json!([{ "doc": doc_id(path), "v": version, "op": ops, "meta": { "source": PEER_ID, "user_id": PEER_USER, "tc": "a1b2c3d4e5f6a7b8c9" } }]);
    broadcast(live, None, &event("otUpdateApplied", update));
    true
}

/// The scripted collaborator starts a thread on `quote` at `position` of
/// `path`, saying `content`; its id.
pub(super) fn peer_commented(
    live: &mut Live,
    path: &str,
    position: i64,
    quote: &str,
    content: &str,
) -> String {
    let thread = live.review.mint("thread");
    let message = json!({ "id": live.review.mint("message"), "content": content, "timestamp": now_ms(), "user": person(PEER_USER) });
    live.review.threads.insert(
        thread.clone(),
        Thread {
            messages: vec![message.clone()],
            resolved: false,
        },
    );
    anchored(live, path, position, &packed(quote), &thread);
    let history = &mut live.docs.entry(path.to_string()).or_default().history;
    let version = history.len();
    history.push((Vec::new(), PEER_ID.to_string()));
    let op = json!([{ "p": position, "c": packed(quote), "t": thread }]);
    let update = json!([{ "doc": doc_id(path), "v": version, "op": op, "meta": { "source": PEER_ID, "user_id": PEER_USER } }]);
    broadcast(live, None, &event("otUpdateApplied", update));
    broadcast(live, None, &event("new-comment", json!([thread, message])));
    thread
}

/// A REST request on review, `rest` the path after `/project/{id}`;
/// `(status, body)`, or none when it is not one.
pub(super) fn rest(
    live: &mut Live,
    files: &BTreeMap<String, Vec<u8>>,
    method: &str,
    rest: &str,
    body: &[u8],
) -> Option<(u16, Value)> {
    let parts: Vec<&str> = rest.trim_start_matches('/').split('/').collect();
    let body: Value = serde_json::from_slice(body).unwrap_or_default();
    let ok = Some((200, json!({})));
    let answer = match (method, parts.as_slice()) {
        ("GET", ["threads"]) => {
            let threads: serde_json::Map<String, Value> = live
                .review
                .threads
                .iter()
                .map(|(id, thread)| {
                    let mut value = json!({ "messages": thread.messages });
                    if thread.resolved {
                        value["resolved"] = json!(true);
                        value["resolved_by_user"] = person(OWN_USER);
                        value["resolved_at"] = json!(chrono::Utc::now().to_rfc3339());
                    }
                    (id.clone(), value)
                })
                .collect();
            Some((200, Value::Object(threads)))
        }
        ("GET", ["ranges"]) => {
            let docs: Vec<Value> = files
                .keys()
                .filter(|path| super::overleaf_realtime_mock::is_doc(path))
                .map(|path| json!({ "id": doc_id(path), "ranges": ranges(live, path) }))
                .collect();
            Some((200, json!(docs)))
        }
        ("GET", ["changes", "users"]) => Some((200, json!([person(PEER_USER), person(OWN_USER)]))),
        ("POST", ["thread", thread, "messages"]) => {
            let content = body["content"].as_str().unwrap_or_default().to_string();
            let message = json!({ "id": live.review.mint("message"), "content": content, "timestamp": now_ms(), "user": person(OWN_USER) });
            live.review
                .threads
                .entry(thread.to_string())
                .or_default()
                .messages
                .push(message.clone());
            broadcast(live, None, &event("new-comment", json!([thread, message])));
            ok
        }
        ("POST", ["thread", thread, "messages", message, "edit"]) => {
            let content = body["content"].as_str().unwrap_or_default().to_string();
            let found = live.review.threads.get_mut(*thread).and_then(|thread| {
                thread
                    .messages
                    .iter_mut()
                    .find(|m| m["id"].as_str() == Some(message))
            });
            let Some(found) = found else {
                return Some((404, json!({})));
            };
            found["content"] = json!(content);
            broadcast(
                live,
                None,
                &event("edit-message", json!([thread, message, content])),
            );
            ok
        }
        ("DELETE", ["thread", thread, "own-messages", message]) => {
            if let Some(found) = live.review.threads.get_mut(*thread) {
                found.messages.retain(|m| m["id"].as_str() != Some(message));
            }
            broadcast(
                live,
                None,
                &event("delete-message", json!([thread, message])),
            );
            ok
        }
        ("POST", ["doc", _, "thread", thread, verb @ ("resolve" | "reopen")]) => {
            let Some(found) = live.review.threads.get_mut(*thread) else {
                return Some((404, json!({})));
            };
            found.resolved = *verb == "resolve";
            let name = if *verb == "resolve" {
                "resolve-thread"
            } else {
                "reopen-thread"
            };
            broadcast(live, None, &event(name, json!([thread])));
            ok
        }
        ("DELETE", ["doc", doc, "thread", thread]) => {
            live.review.threads.remove(*thread);
            for (path, comments) in &mut live.review.comments {
                if doc_id(path) == *doc {
                    comments.retain(|range| range.thread_id != *thread);
                }
            }
            broadcast(live, None, &event("delete-thread", json!([thread])));
            ok
        }
        ("POST", ["doc", doc, "changes", "accept"]) => {
            let ids: Vec<String> =
                serde_json::from_value(body["change_ids"].clone()).unwrap_or_default();
            for (path, changes) in &mut live.review.changes {
                if doc_id(path) == *doc {
                    changes.retain(|change| !ids.contains(&change.id));
                }
            }
            broadcast(live, None, &event("accept-changes", json!([doc, ids])));
            ok
        }
        _ => None,
    };
    if answer.is_some() {
        live.review.requests.push(format!("{method} {rest}"));
    }
    answer
}
