//! Sending a sync's edit to a file Overleaf holds as a document over the live
//! channel, the way Overleaf's own editor does, instead of uploading it.
//!
//! An upload is wrong for a document in three ways. It replaces the whole
//! document, so whatever a co-author typed after the sync last looked is gone
//! from it (Overleaf's history still has it). It makes Overleaf tell everyone
//! with the file open that it was "updated externally". And the upload
//! endpoint decides what a file becomes from its name alone, not from what is
//! already at the path: a `data.csv` made with New file in the browser comes
//! back from an upload as a binary file, no longer editable there, and its
//! comments and tracked changes gone with it.
//!
//! So each document goes like this: join it; check that Overleaf still holds
//! exactly the copy the sync planned against; send the difference between that
//! copy and ours as operations, at the version the join reported; wait for
//! Overleaf to say they applied; leave. Anything a co-author types between the
//! join and our operations landing, Overleaf transforms against them, as it
//! does for any two people typing at once — their keystrokes move, they are
//! never replaced. A document Overleaf has moved past the copy the sync
//! planned against is left alone: the operations were worked out against the
//! wrong text, and from the newer one they would undo a co-author's work. The
//! next sync merges it first.
//!
//! The operations are tracked when the project's track-changes setting is on
//! for this account, as Overleaf does with an upload into a document.

use super::api::Remote;
use crate::overleaf_rt::{OtOp, RealtimeClient, RealtimeConfig, RealtimeEvent, Submission};
use crate::wide_event;
use diffy::{DiffOptions, HunkRange};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};
use tauri::async_runtime as rt;

/// How long Overleaf has to say an edit applied, once it has queued it.
/// Its answer to `applyOtUpdate` means only that: the edit is applied, or
/// refused, afterwards, and said so in a separate message.
const APPLY_TIMEOUT: Duration = Duration::from_secs(20);

/// Extensions an upload reads as text on any Overleaf, so uploading one keeps
/// a document a document. Deliberately short: a document missing from it only
/// costs a trip over the live channel, which is right for every document.
const UPLOADED_AS_TEXT: &[&str] = &["tex", "latex", "ltx", "sty", "cls", "bib", "bst", "txt", "md"];

/// Whether uploading `path` could turn a document there into a binary file.
pub(super) fn may_become_a_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            !UPLOADED_AS_TEXT.contains(&extension.to_ascii_lowercase().as_str())
        }
        _ => true,
    }
}

/// The edit that turns `before` into `after`, positioned the way Overleaf
/// counts: in UTF-16 code units, each operation where the ones before it in
/// the same update left the text.
///
/// Each run of lines that changed is its own operation, rather than one span
/// from the first change to the last. Overleaf transforms a co-author's concurrent typing against these; inside
/// a span that deletes and reinserts everything between two far-apart edits,
/// their sentence would be carried off to one end of it.
pub(super) fn edit_ops(before: &str, after: &str) -> Vec<OtOp> {
    let ops = hunk_ops(before, after);
    // The diff and the position bookkeeping are checked by applying the
    // result; should they ever disagree, the single span is still exact.
    if applied(before, &ops).as_deref() == Some(after) {
        ops
    } else {
        span_ops(before, after, 0)
    }
}

fn hunk_ops(before: &str, after: &str) -> Vec<OtOp> {
    let patch = DiffOptions::new().set_context_len(0).create_patch(before, after);
    let (old_lines, new_lines) = (line_starts(before), line_starts(after));
    // A range names its first line counting from 1, but an empty range names
    // the line it comes after.
    let span = |starts: &[usize], range: HunkRange| {
        let first = if range.is_empty() { range.start() } else { range.start() - 1 };
        starts[first]..starts[first + range.len()]
    };
    let mut ops = Vec::new();
    // How far the operations so far moved the text after them.
    let mut shift = 0isize;
    for hunk in patch.hunks() {
        let (from, to) = (span(&old_lines, hunk.old_range()), span(&new_lines, hunk.new_range()));
        let at = units(&before[..from.start]) as isize + shift;
        for op in span_ops(&before[from], &after[to], at as usize) {
            shift += op.i.as_deref().map_or(0, units) as isize;
            shift -= op.d.as_deref().map_or(0, units) as isize;
            ops.push(op);
        }
    }
    ops
}

/// The byte offset each line starts at, and the text's length after them.
fn line_starts(text: &str) -> Vec<usize> {
    let ends = text.split_inclusive('\n').scan(0, |end, line| {
        *end += line.len();
        Some(*end)
    });
    std::iter::once(0).chain(ends).collect()
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The single delete-and-insert turning `before` into `after`, both trimmed of
/// what they share at either end, for text that starts at `at`.
fn span_ops(before: &str, after: &str, at: usize) -> Vec<OtOp> {
    let common = |a: &mut dyn Iterator<Item = char>, b: &mut dyn Iterator<Item = char>| -> usize {
        a.zip(b).take_while(|(x, y)| x == y).map(|(c, _)| c.len_utf8()).sum()
    };
    let prefix = common(&mut before.chars(), &mut after.chars());
    let (before_rest, after_rest) = (&before[prefix..], &after[prefix..]);
    let suffix = common(&mut before_rest.chars().rev(), &mut after_rest.chars().rev());
    let removed = &before_rest[..before_rest.len() - suffix];
    let inserted = &after_rest[..after_rest.len() - suffix];
    let p = at + units(&before[..prefix]);
    let op = |i: Option<&str>, d: Option<&str>| OtOp {
        p,
        i: i.map(str::to_string),
        d: d.map(str::to_string),
        u: None,
    };
    let mut ops = Vec::new();
    if !removed.is_empty() {
        ops.push(op(None, Some(removed)));
    }
    if !inserted.is_empty() {
        ops.push(op(Some(inserted), None));
    }
    ops
}

/// `text` with `ops` applied in order, as Overleaf applies an update; `None`
/// when one does not fit, deleting text that is not there.
pub(super) fn applied(text: &str, ops: &[OtOp]) -> Option<String> {
    let mut doc: Vec<u16> = text.encode_utf16().collect();
    for op in ops {
        if let Some(deleted) = &op.d {
            let deleted: Vec<u16> = deleted.encode_utf16().collect();
            let end = op.p + deleted.len();
            if doc.get(op.p..end) != Some(&deleted[..]) {
                return None;
            }
            doc.drain(op.p..end);
        }
        if let Some(inserted) = &op.i {
            if op.p > doc.len() {
                return None;
            }
            doc.splice(op.p..op.p, inserted.encode_utf16());
        }
    }
    String::from_utf16(&doc).ok()
}

/// What Overleaf's document updater hashes a document to,
/// `sha1("blob {UTF-16 length}\0{UTF-8 text}")`.
pub(super) fn doc_hash(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", units(text)).as_bytes());
    hasher.update(text.as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether Overleaf stores what `ops` insert exactly as sent. Its document
/// updater replaces every UTF-16 surrogate in inserted text with U+FFFD, and
/// a carriage return has no place in a document's lines. An upload has always
/// carried both as the upload endpoint makes of them, so such an edit still
/// goes that way, unless an upload could turn the document into a file.
fn lands_as_sent(ops: &[OtOp]) -> bool {
    (ops.iter().filter_map(|op| op.i.as_deref()))
        .all(|text| !text.contains('\r') && text.chars().all(|c| c.len_utf16() == 1))
}

/// What became of the documents sent over the live channel.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct LivePush {
    /// Took their edit as operations, and Overleaf said they applied.
    pub sent: BTreeSet<String>,
    /// Overleaf had moved past the copy the edit was worked out against, so
    /// nothing was sent; the next sync merges the newer work in first.
    pub stale: BTreeSet<String>,
}

/// The live channel, open for the documents of one sync.
pub(super) struct LiveDocs {
    client: RealtimeClient,
    events: Receiver<RealtimeEvent>,
    /// What it takes: each path, with its document's id.
    docs: BTreeMap<String, String>,
}

impl LiveDocs {
    /// Open the live channel for those of `files` Overleaf holds as documents.
    /// `held` is Overleaf's copy of the project the sync planned against.
    ///
    /// `None` when the channel cannot be reached, or nothing would go over it:
    /// a new file, a binary one, and a path that is a binary file on Overleaf
    /// are uploaded, and so is everything when the channel is unreachable.
    pub fn open(
        remote: &Remote, files: &BTreeMap<String, Vec<u8>>, held: &BTreeMap<String, Vec<u8>>,
    ) -> Option<LiveDocs> {
        // A document only ever holds text.
        let candidates: BTreeSet<&String> = (files.iter())
            .filter(|(path, bytes)| {
                let Ok(text) = std::str::from_utf8(bytes) else { return false };
                match held.get(*path).map(|bytes| std::str::from_utf8(bytes)) {
                    Some(Ok(base)) => {
                        may_become_a_file(path) || lands_as_sent(&edit_ops(base, text))
                    }
                    // A document there now is one Overleaf moved past
                    // (`push`). Only an upload that could turn a new
                    // document into a file is worth the channel to find out;
                    // any other new file goes up while Overleaf holds still.
                    Some(Err(_)) | None => may_become_a_file(path),
                }
            })
            .map(|(path, _)| path)
            .collect();
        if candidates.is_empty() {
            return None;
        }
        let Ok((client, events)) = connect_channel(remote) else {
            wide_event::record("doc_push_unreachable", true);
            return None;
        };
        let docs: BTreeMap<String, String> = (client.project().docs.iter())
            .filter(|doc| candidates.contains(&doc.path))
            .map(|doc| (doc.path.clone(), doc.id.clone()))
            .collect();
        let live = LiveDocs { client, events, docs };
        (!live.docs.is_empty()).then_some(live)
    }

    /// Whether `path` goes over this channel rather than up as an upload.
    pub fn takes(&self, path: &str) -> bool {
        self.docs.contains_key(path)
    }

    /// Send each document this channel takes its edit from `files`.
    ///
    /// A document that fails to take its edit fails the sync, like a failed
    /// upload. Falling back to the upload is exactly what replaces what a
    /// co-author just typed, and for some documents loses the document; and
    /// an edit whose outcome is unknown may have landed, so the sync records
    /// nothing and the next one merges against whatever Overleaf then holds.
    pub fn push(
        &self, files: &BTreeMap<String, Vec<u8>>, held: &BTreeMap<String, Vec<u8>>,
    ) -> Result<LivePush, String> {
        let tracked = self.client.project().track_changes;
        let mut pushed = LivePush::default();
        for (path, id) in &self.docs {
            let failed = |error: String| format!("Failed to send \"{path}\" to Overleaf: {error}");
            let text = files.get(path).and_then(|bytes| std::str::from_utf8(bytes).ok());
            let text = text.ok_or_else(|| failed("it is not text".into()))?;
            let joined = rt::block_on(self.client.join_doc(id, None)).map_err(failed)?;
            let base = held.get(path).and_then(|bytes| std::str::from_utf8(bytes).ok());
            if base == Some(joined.text.as_str()) {
                let ops = edit_ops(&joined.text, text);
                if !ops.is_empty() {
                    // When nothing lands before it, Overleaf checks the result
                    // against this and refuses the edit on a mismatch.
                    let hash = lands_as_sent(&ops).then(|| doc_hash(text));
                    let submission = Submission { hash: hash.as_deref(), ..Submission::default() };
                    let sent = self.client.send_ops(id, joined.version, ops, tracked, submission);
                    rt::block_on(sent).map_err(failed)?;
                    await_applied(&self.events, id).map_err(failed)?;
                }
                pushed.sent.insert(path.clone());
            } else {
                pushed.stale.insert(path.clone());
            }
            rt::block_on(self.client.leave_doc(id)).map_err(failed)?;
        }
        wide_event::record("docs_pushed_live", pushed.sent.len());
        if !pushed.stale.is_empty() {
            wide_event::record("docs_stale_live", pushed.stale.len());
        }
        Ok(pushed)
    }
}

/// A live connection of our own to `remote`'s project, apart from the one the
/// editor holds, with its events to read in order.
pub(super) fn connect_channel(
    remote: &Remote,
) -> Result<(RealtimeClient, Receiver<RealtimeEvent>), String> {
    let config = RealtimeConfig {
        user_id: remote.session.user_id.clone(),
        host: remote.host.clone(),
        cookie: remote.session.cookie.clone(),
        project_id: remote.state.project_id.clone(),
    };
    let (tell, events) = channel();
    let client = rt::block_on(RealtimeClient::connect(config, move |event| {
        let _ = tell.send(event);
    }))?;
    Ok((client, events))
}

/// Wait for Overleaf to say the update just sent to document `id` applied,
/// reading the channel's `events`. Also how a comment anchored in the
/// background (`doc_comment`) knows it landed.
pub(super) fn await_applied(events: &Receiver<RealtimeEvent>, id: &str) -> Result<(), String> {
    let deadline = Instant::now() + APPLY_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left) {
            Ok(RealtimeEvent::DocAck { doc_id, .. }) if doc_id == id => return Ok(()),
            // Its shape is undocumented, so one naming no document is
            // taken to be about the only edit in flight.
            Ok(RealtimeEvent::OtError { doc_id, message }) if doc_id == id || doc_id.is_empty() => {
                return Err(message)
            }
            Ok(RealtimeEvent::Disconnected { reason }) => return Err(reason),
            Ok(_) => {}
            Err(_) => return Err("Overleaf did not say whether the edit applied.".into()),
        }
    }
}

impl Drop for LiveDocs {
    fn drop(&mut self) {
        self.client.shutdown();
    }
}

#[cfg(test)]
mod tests;
