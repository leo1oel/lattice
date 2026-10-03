//! What the channel tells the app, and the parsers that read it off the wire.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Events pushed to the app as they arrive.
#[derive(Debug, Clone, PartialEq, Serialize)]
// `rename_all` renames the variants; the fields inside them need their own
// rule, or the app receives `root_folder_id` where it expects `rootFolderId`.
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum RealtimeEvent {
    Connected {
        public_id: String,
    },
    ProjectJoined {
        root_folder_id: String,
        docs: Vec<DocEntry>,
        permission: Permission,
    },
    DocUpdate {
        doc_id: String,
        version: i64,
        ops: Vec<OtOp>,
        /// Who authored it. The server echoes our own updates back, and the
        /// app has to tell its own acknowledgement apart from someone else's
        /// edit — applying your own work twice would duplicate what you typed.
        source: Option<String>,
    },
    OtError {
        doc_id: String,
        message: String,
    },
    /// Overleaf accepted the operation we sent.
    ///
    /// The originating client gets `{doc, v}` with no `op` at all, and everyone
    /// else gets the operation. Treating that bare answer as an acknowledgement
    /// is the whole of the client's send loop: miss it and the operation stays
    /// in flight forever, and every later edit queues behind it unsent.
    DocAck {
        doc_id: String,
        /// The version the operation applied at; the document moves to v + 1.
        version: i64,
    },
    /// A comment thread was anchored to a span of an open document, so the
    /// marker can appear without re-opening it.
    CommentAnchored {
        doc_id: String,
        range: CommentRange,
    },
    /// The project's files changed: something was created, renamed, moved or
    /// deleted, by anyone.
    ///
    /// Carries the whole document list rather than the delta. Overleaf's events
    /// are id-keyed deltas against a tree the client has to maintain itself;
    /// having done that once here, no listener should have to repeat it.
    TreeChanged {
        docs: Vec<DocEntry>,
        entities: Vec<EntityEntry>,
    },
    /// Someone in the project moved, or appeared for the first time.
    ///
    /// Overleaf announces nothing when a client joins — the only thing that
    /// makes anyone visible is a position broadcast, so this doubles as
    /// "someone is here".
    PresenceUpdated {
        user: PresenceUser,
    },
    /// Someone left the project. Carries only their connection id.
    PresenceLeft {
        id: String,
    },
    /// Someone accepted suggestions: those changes are now ordinary text.
    ///
    /// Accepting needs an event of its own precisely because it does not touch
    /// the document — a rejection arrives as an ordinary update carrying the
    /// undo.
    ChangesAccepted {
        doc_id: String,
        change_ids: Vec<String>,
    },
    /// Suggestions were turned on or off for the project.
    TrackChangesToggled {
        on: bool,
    },
    /// A comment thread changed: a reply, an edit, a resolve, a delete.
    ///
    /// This carries no detail on purpose. Overleaf spreads thread state across
    /// six socket events and a REST endpoint, and rebuilding it from partial
    /// events is how panels drift out of step with the browser; re-reading the
    /// threads is both simpler and always right.
    ThreadsChanged,
    /// Someone posted in the project chat. Overleaf sends this to everyone in
    /// the room, the author included.
    ChatMessage {
        id: String,
        content: String,
        author_name: String,
        author_email: Option<String>,
        /// Milliseconds since the epoch, as Overleaf reports it.
        timestamp: i64,
    },
    Disconnected {
        reason: String,
    },
}

/// One entity in the project, with the id Overleaf's own endpoints take.
///
/// Deleting a file over there needs its id, not its path, and nothing in the
/// REST surface hands out ids — the tree the channel gives us is the only
/// place they exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityEntry {
    pub id: String,
    pub path: String,
    /// "doc", "file" or "folder", which is also the path segment its
    /// endpoints use.
    pub kind: String,
}

/// Someone else in the project, and where they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUser {
    /// Their connection id — the same shape as our own public id. One person
    /// with two tabs open is two of these.
    pub id: String,
    /// Their account. Two tabs share this, which is why colour keys on it.
    pub user_id: Option<String>,
    pub name: String,
    pub email: Option<String>,
    /// The document they are in, when they have said.
    pub doc_id: Option<String>,
    /// Zero-based line and column, as Overleaf counts them.
    pub row: Option<i64>,
    pub column: Option<i64>,
    /// The hue Overleaf's own editor would give them, so the same person is
    /// the same colour in both apps.
    pub hue: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    pub id: String,
    /// Path relative to the project root, forward slashes, no leading slash.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OtOp {
    /// Position in the document (character offset).
    pub p: usize,
    /// Inserted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i: Option<String>,
    /// Deleted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
    /// "This undoes something", which is how a rejected suggestion is
    /// expressed: Overleaf consumes the tracked change instead of recording
    /// the undo as a new suggestion of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub u: Option<bool>,
}

/// One update the server replayed because we asked to join from a version we
/// already had, rather than from scratch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchUpUpdate {
    /// The version this update applied at; the document moves to `v + 1`.
    pub version: i64,
    pub ops: Vec<OtOp>,
    /// Who sent it. Our own work comes back here too, and has to be counted as
    /// an acknowledgement rather than applied a second time.
    pub source: Option<String>,
}

/// A joined document: its text, its version, and where its comments sit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedDoc {
    pub text: String,
    pub version: i64,
    pub comments: Vec<CommentRange>,
    pub changes: Vec<TrackedChange>,
    /// The updates missed while away, when the join asked to resume from a
    /// version we already had. Empty for a join from scratch, and empty when
    /// the server could not reach back that far — `text` is authoritative then.
    pub caught_up: Vec<CatchUpUpdate>,
    /// False when the server would not replay from the version asked for, so
    /// the caller must fall back to `text` and drop anything unsent.
    pub resumed: bool,
}

/// One tracked change in a document: a suggested insertion or deletion that
/// nobody has accepted or rejected yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedChange {
    /// Overleaf's id for the change; what accepting one refers to.
    pub id: String,
    /// Character offset into the document as it currently reads.
    pub position: i64,
    /// The suggested text: inserted when `deletion` is false, removed when it
    /// is true. A tracked deletion is not in the document text, so it occupies
    /// no offsets.
    pub text: String,
    pub deletion: bool,
    /// Who suggested it, when Overleaf knows.
    pub user_id: Option<String>,
    /// ISO 8601, as Overleaf reports it.
    pub timestamp: Option<String>,
    /// Their colour in Overleaf's own palette.
    pub hue: u32,
}

/// Where one comment thread is anchored in a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRange {
    /// The thread id — what the REST endpoints and socket events key on.
    pub thread_id: String,
    /// Character offset of the commented span.
    pub position: i64,
    /// The commented text itself, as Overleaf recorded it.
    pub quote: String,
}

/// What this account may do to the project.
///
/// Overleaf enforces this server-side, but finding out by having an edit
/// rejected is a poor way to learn it: the channel would fail, fall back to
/// syncing, and syncing would then try to upload the same edit over REST.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Owner,
    ReadAndWrite,
    /// Can comment and suggest, but not change the text directly.
    Review,
    ReadOnly,
    /// Overleaf did not say. Mutations fail closed until a fresh role arrives.
    Unknown,
}

impl Permission {
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("owner") => Permission::Owner,
            Some("readAndWrite") => Permission::ReadAndWrite,
            Some("review") => Permission::Review,
            Some("readOnly") => Permission::ReadOnly,
            _ => Permission::Unknown,
        }
    }

    /// True when this account may change the text.
    pub fn can_write(self) -> bool {
        matches!(self, Permission::Owner | Permission::ReadAndWrite)
    }

    pub(super) fn can_suggest(self) -> bool {
        self.can_write() || self == Permission::Review
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Permission::Owner => "owner",
            Permission::ReadAndWrite => "readAndWrite",
            Permission::Review => "review",
            Permission::ReadOnly => "readOnly",
            Permission::Unknown => "unknown",
        }
    }
}

// ---- Parsers ----------------------------------------------------------------

pub(super) fn json_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| value.get(*key).and_then(Value::as_str)).map(str::to_string)
}

/// Undo the packing Overleaf applies to text on its way into a `joinDoc`
/// answer.
///
/// The server sends `unescape(encodeURIComponent(text))`, which is the UTF-8
/// bytes of the text reinterpreted one-per-code-point. Left alone, every
/// document with an accent or a Chinese character in it arrives as mojibake —
/// and worse, the character offsets our operations are built on would be
/// counting bytes while Overleaf counts characters.
///
/// Text that is not packed this way (a code point above U+00FF, or bytes that
/// are not valid UTF-8) is returned untouched: some deployments do not encode,
/// and mangling their text would be the same bug in the other direction.
pub(super) fn decode_packed_utf8(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }
    let bytes: Option<Vec<u8>> = text.chars().map(|ch| u8::try_from(u32::from(ch)).ok()).collect();
    bytes.and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_else(|| text.to_string())
}

/// `{ comments: [{ id, op: { p, c, t } }], changes: [...] }`.
///
/// Shared with the REST client, which reads the same shape from the
/// project-wide ranges endpoint to learn where comments in documents nobody
/// has opened are anchored.
pub(crate) fn parse_comment_ranges(ranges: &Value) -> Vec<CommentRange> {
    let comments = ranges.get("comments").and_then(Value::as_array).into_iter().flatten();
    comments.filter_map(|comment| parse_comment_range(comment.get("op")?)).collect()
}

/// `{ p, c, t }`: position, the commented text, and the thread it belongs to.
fn parse_comment_range(op: &Value) -> Option<CommentRange> {
    Some(CommentRange {
        thread_id: op.get("t").and_then(Value::as_str)?.to_string(),
        position: op.get("p").and_then(Value::as_i64).unwrap_or(0),
        quote: op.get("c").and_then(Value::as_str).map(decode_packed_utf8).unwrap_or_default(),
    })
}

/// `{ changes: [{ id, op: {p, i} | {p, d}, metadata: {user_id, ts} }] }`.
pub(super) fn parse_tracked_changes(ranges: &Value) -> Vec<TrackedChange> {
    let changes = ranges.get("changes").and_then(Value::as_array).into_iter().flatten();
    changes
        .filter_map(|change| {
            let op = change.get("op")?;
            let (text, deletion) = match (op.get("i"), op.get("d")) {
                (Some(inserted), _) => (inserted.as_str()?, false),
                (_, Some(deleted)) => (deleted.as_str()?, true),
                _ => return None,
            };
            let metadata = change.get("metadata");
            let user_id = metadata.and_then(|m| json_field(m, &["user_id"]));
            Some(TrackedChange {
                id: json_field(change, &["id"])?,
                position: op.get("p").and_then(Value::as_i64).unwrap_or(0),
                // Packed the same way the document's own lines are.
                text: decode_packed_utf8(text),
                deletion,
                timestamp: metadata.and_then(|m| json_field(m, &["ts"])),
                hue: presence_hue(user_id.as_deref()),
                user_id,
            })
        })
        .collect()
}

/// `{ id, content, timestamp, user: { first_name, last_name, email } }`.
/// Overleaf has shipped both snake_case and camelCase name fields over the
/// years, so read either rather than showing a blank author.
pub(super) fn chat_event(value: &Value) -> Option<RealtimeEvent> {
    let user = value.get("user");
    let first = user.and_then(|u| json_field(u, &["first_name", "firstName"])).unwrap_or_default();
    let last = user.and_then(|u| json_field(u, &["last_name", "lastName"])).unwrap_or_default();
    let author_email = user.and_then(|u| json_field(u, &["email"]));
    let name = Some(format!("{first} {last}").trim().to_string()).filter(|name| !name.is_empty());
    Some(RealtimeEvent::ChatMessage {
        id: json_field(value, &["id", "_id"])?,
        content: json_field(value, &["content"]).unwrap_or_default(),
        author_name: name.or_else(|| author_email.clone()).unwrap_or_else(|| "Someone".to_string()),
        author_email,
        timestamp: value.get("timestamp").and_then(Value::as_i64).unwrap_or_default(),
    })
}

/// `clientTracking.clientUpdated`: `{row, column, doc_id, id, user_id, email, name}`.
///
/// The broadcast and the roster answer describe the same thing with different
/// keys — `id` here against `client_id` there, one joined `name` here against
/// `first_name`/`last_name` there — so they are parsed separately rather than
/// through one forgiving reader that would quietly accept either.
pub(super) fn parse_presence_broadcast(value: &Value) -> Option<PresenceUser> {
    let id = value.get("id").and_then(Value::as_str)?;
    let name = json_field(value, &["name"]).unwrap_or_default();
    Some(presence_user(value, id, name, Some(value)))
}

/// One entry from `clientTracking.getConnectedUsers`.
///
/// Redis hands these back as strings, so everything but `cursorData` arrives
/// quoted even when it is a number.
pub(super) fn parse_presence_roster(value: &Value) -> Option<PresenceUser> {
    let id = value.get("client_id").and_then(Value::as_str)?;
    if value.get("connected").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let first = json_field(value, &["first_name"]).unwrap_or_default();
    let last = json_field(value, &["last_name"]).unwrap_or_default();
    let name = format!("{first} {last}").trim().to_string();
    Some(presence_user(value, id, name, value.get("cursorData")))
}

/// The fields both presence shapes agree on, with the caret read from
/// `cursor`, and the colour keyed on the account.
fn presence_user(value: &Value, id: &str, name: String, cursor: Option<&Value>) -> PresenceUser {
    let user_id = json_field(value, &["user_id"]).filter(|id| id != "anonymous-user");
    PresenceUser {
        id: id.to_string(),
        hue: presence_hue(user_id.as_deref()),
        user_id,
        name,
        email: json_field(value, &["email"]),
        doc_id: cursor.and_then(|c| json_field(c, &["doc_id"])),
        row: cursor.and_then(|c| c.get("row")).and_then(Value::as_i64),
        column: cursor.and_then(|c| c.get("column")).and_then(Value::as_i64),
    }
}

/// The hue Overleaf's editor gives a user: the first eight hex digits of the
/// MD5 of their account id, modulo the palette, with a gap left around the
/// blue that Overleaf reserves for "you".
///
/// Reproducing it exactly is the point — the same collaborator should be the
/// same colour whether you are looking at Lattice or at the browser.
pub(super) fn presence_hue(user_id: Option<&str>) -> u32 {
    const ANONYMOUS_HUE: u32 = 100;
    const OWN_HUE: u32 = 200;
    const OWN_HUE_BLOCKED_SIZE: u32 = 20;
    const TOTAL_HUES: u32 = 360;

    let Some(user_id) = user_id else {
        return ANONYMOUS_HUE;
    };
    let digest = format!("{:x}", md5::compute(user_id.as_bytes()));
    let prefix = u32::from_str_radix(&digest[..8], 16).unwrap_or(0);
    let hue = prefix % (TOTAL_HUES - OWN_HUE_BLOCKED_SIZE * 2);
    if hue > OWN_HUE - OWN_HUE_BLOCKED_SIZE && hue < OWN_HUE + OWN_HUE_BLOCKED_SIZE {
        hue - OWN_HUE + TOTAL_HUES - OWN_HUE_BLOCKED_SIZE
    } else {
        hue
    }
}

/// The edits in an update, leaving comment anchors out.
///
/// Overleaf sends both kinds of operation down the same channel: `{p, i}` and
/// `{p, d}` change the document, while `{p, c, t}` anchors a comment thread to
/// a span without altering a character. Transformed as if they were edits the
/// anchors would come back as empty deletes, and the OT state machine should
/// only ever see real edits.
fn text_ops(update: &Value) -> Vec<OtOp> {
    let ops = update.get("op").and_then(Value::as_array).into_iter().flatten();
    ops.filter(|op| op.get("t").and_then(Value::as_str).is_none())
        .filter_map(|op| serde_json::from_value::<OtOp>(op.clone()).ok())
        .filter(|op| op.i.is_some() || op.d.is_some())
        .collect()
}

fn update_source(update: &Value) -> Option<String> {
    update.get("meta")?.get("source")?.as_str().map(str::to_string)
}

/// The updates the server replayed for a join that resumed from a version.
///
/// Each entry is the same `{doc, meta, op, v}` shape a live update arrives in,
/// so it splits the same way: comment anchors never reach the text stream, and
/// an update that turns out to hold nothing but anchors still counts, because
/// the version moved either way.
pub(super) fn parse_catch_up(value: &Value) -> Vec<CatchUpUpdate> {
    let updates = value.as_array().into_iter().flatten();
    updates
        .filter_map(|update| {
            Some(CatchUpUpdate {
                version: update.get("v").and_then(Value::as_i64)?,
                ops: text_ops(update),
                source: update_source(update),
            })
        })
        .collect()
}

/// One `otUpdateApplied` payload: the text update first, then one event per
/// comment anchor riding in it.
pub(super) fn doc_update_events(value: &Value) -> Vec<RealtimeEvent> {
    let Some(doc_id) = value.get("doc").and_then(Value::as_str).map(str::to_string) else {
        return Vec::new();
    };
    let version = value.get("v").and_then(Value::as_i64).unwrap_or(-1);
    // No operation at all: this is the server telling us our own update landed.
    if value.get("op").is_none() {
        return match version {
            -1 => Vec::new(),
            version => vec![RealtimeEvent::DocAck { doc_id, version }],
        };
    }
    let anchors: Vec<RealtimeEvent> = (value.get("op").and_then(Value::as_array).into_iter())
        .flatten()
        .filter_map(parse_comment_range)
        .map(|range| RealtimeEvent::CommentAnchored { doc_id: doc_id.clone(), range })
        .collect();
    // The version moves whatever the operation was, so this goes out even when
    // nothing in the text changed.
    let update = RealtimeEvent::DocUpdate {
        doc_id,
        version,
        ops: text_ops(value),
        source: update_source(value),
    };
    std::iter::once(update).chain(anchors).collect()
}

/// `otUpdateError` does not have a documented shape; dig a doc id out of
/// whatever the server sent so the app can at least point at a file.
pub(super) fn doc_id_hint(args: &[Value]) -> String {
    let keyed = args
        .iter()
        .filter(|arg| arg.is_object())
        .find_map(|arg| ["doc", "doc_id", "docId"].iter().find_map(|key| arg.get(*key)?.as_str()));
    keyed.or_else(|| args.iter().skip(1).find_map(Value::as_str)).unwrap_or_default().to_string()
}

/// Read the project-wide track-changes setting as it applies to one account.
///
/// Overleaf stores `true` for everyone, `false` for nobody, or a map naming
/// the accounts it is on for — with the literal key `__guests__` covering
/// anonymous sessions. The field is absent entirely when the project's owner
/// does not have the feature, which reads as off.
pub(super) fn track_changes_for(state: Option<&Value>, user_id: Option<&str>) -> bool {
    match state {
        Some(Value::Bool(on)) => *on,
        Some(Value::Object(map)) => {
            map.get(user_id.unwrap_or("__guests__")).and_then(Value::as_bool).unwrap_or(false)
        }
        _ => false,
    }
}
