//! Commenting on a document the editor does not have open, the way a comment
//! made on the PDF lands on whichever file its passage came from, or does not
//! hold live just then: the open file the live channel let go of after an
//! outside write, until a sync settles it, or while the channel reconnects.
//!
//! Overleaf anchors a comment with an update on the live channel, and its
//! real-time server applies an update only to a document the sending
//! connection has joined: `joinDoc` is what authorizes the document. Nothing
//! about the editor is involved. So this joins the document on a connection
//! of its own, as a sync sending an edit does (`doc_push`), sends the anchor
//! at the version the join reported, waits for Overleaf to say it applied,
//! and leaves. The connection the editor holds is left alone: leaving a
//! document there would leave it for the editor too, should the writer open
//! that file meanwhile.
//!
//! The passage was found in Lattice's copy of the file, which can be behind or
//! ahead of Overleaf's: a co-author typed since the last sync, or the file
//! holds edits not sent yet. It is placed in Overleaf's copy through the
//! difference between the two, and only where Overleaf's copy reads the same
//! words there. A passage that difference rewrote is placed only where both
//! copies read it once; one either copy holds in several places comes back as
//! not found, before any thread exists, so the app can open the file and let
//! the writer place it.

use super::api::Remote;
use super::doc_push::{await_applied, connect_channel, edit_ops};
use crate::overleaf_rt::{RealtimeClient, RealtimeEvent};
use std::path::Path;
use std::sync::mpsc::Receiver;
use tauri::async_runtime as rt;

/// What became of a comment on a document the editor does not hold live.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommentPlacement {
    /// The thread exists and is anchored to the passage.
    Placed,
    /// Overleaf's copy does not hold the passage in one place Lattice can
    /// tell, so nothing was posted.
    NotFound,
}

/// Start thread `thread_id` saying `content` on the passage `quote`, which
/// starts at UTF-16 offset `from` in `ours`, Lattice's copy of document
/// `doc_id`.
#[allow(clippy::too_many_arguments)]
pub fn comment_in_document(
    config_dir: &Path, root: &Path, doc_id: &str, ours: &str, from: usize, quote: &str,
    thread_id: &str, content: &str,
) -> Result<CommentPlacement, String> {
    let remote = Remote::open(config_dir, root)?;
    let (client, events) = connect_channel(&remote)?;
    let post = || super::reply_to_thread(config_dir, root, thread_id, content);
    let placed = anchor(&client, &events, doc_id, ours, from, quote, thread_id, post);
    client.shutdown();
    placed
}

/// Join `doc_id`, place the passage in Overleaf's copy, `post` the thread's
/// first message, anchor the thread, and leave. The message goes first, the
/// order Overleaf's own editor uses, so a thread never shows on the page with
/// nothing in it.
#[allow(clippy::too_many_arguments)]
fn anchor(
    client: &RealtimeClient, events: &Receiver<RealtimeEvent>, doc_id: &str, ours: &str,
    from: usize, quote: &str, thread_id: &str, post: impl FnOnce() -> Result<(), String>,
) -> Result<CommentPlacement, String> {
    let joined = rt::block_on(client.join_doc(doc_id, None))?;
    let Some(position) = place(ours, from, quote, &joined.text) else {
        let _ = rt::block_on(client.leave_doc(doc_id));
        return Ok(CommentPlacement::NotFound);
    };
    post()?;
    // Sent at the version joined: anything a co-author typed since, Overleaf
    // transforms the anchor past, as it does for any two people at once.
    let position = i64::try_from(position).map_err(|error| error.to_string())?;
    rt::block_on(client.send_comment(doc_id, joined.version, position, quote, thread_id))?;
    await_applied(events, doc_id)?;
    // On current Overleaf leaving is a no-op, and the connection closes next.
    let _ = rt::block_on(client.leave_doc(doc_id));
    Ok(CommentPlacement::Placed)
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Where in `held` the passage `quote`, at UTF-16 offset `from` of `ours`,
/// is: carried through the edit that turns `ours` into `held`, or failing
/// that its one occurrence in `held` when `ours` also reads it only there.
/// `None` when `ours` does not read `quote` there, or either copy reads it in
/// more than one place: a comment on the wrong one of two alike sentences is
/// worse than letting the writer place it.
pub(super) fn place(ours: &str, from: usize, quote: &str, held: &str) -> Option<usize> {
    let (ours, held, quote) = (units(ours), units(held), units(quote));
    let len = quote.len();
    if len == 0 || ours.get(from..from + len) != Some(&quote[..]) {
        return None;
    }
    let reads_quote = |at: usize| held.get(at..at + len) == Some(&quote[..]);
    if let Some(at) = carried(&ours, &held, from, len).filter(|&at| reads_quote(at)) {
        return Some(at);
    }
    occurs_once(&ours, &quote)?;
    occurs_once(&held, &quote)
}

/// The one offset at which `text` reads `quote`, if it reads it exactly once.
fn occurs_once(text: &[u16], quote: &[u16]) -> Option<usize> {
    let mut found = text.windows(quote.len()).enumerate().filter(|(_, window)| *window == quote);
    match (found.next(), found.next()) {
        (Some((at, _)), None) => Some(at),
        _ => None,
    }
}

/// `from` carried through the edit from `ours` to `held` (both UTF-16), for a
/// passage `len` long; `None` when the edit changes the passage itself.
fn carried(ours: &[u16], held: &[u16], from: usize, len: usize) -> Option<usize> {
    if ours == held {
        return Some(from);
    }
    let (ours, held) = (String::from_utf16(ours).ok()?, String::from_utf16(held).ok()?);
    let mut at = from;
    // Each operation is positioned where the ones before it left the text.
    for op in edit_ops(&ours, &held) {
        let end = at + len;
        if let Some(deleted) = op.d.as_deref() {
            let deleted = deleted.encode_utf16().count();
            if op.p + deleted <= at {
                at -= deleted;
            } else if op.p < end {
                return None;
            }
        }
        if let Some(inserted) = op.i.as_deref() {
            if op.p <= at {
                at += inserted.encode_utf16().count();
            } else if op.p < end {
                return None;
            }
        }
    }
    Some(at)
}

#[cfg(test)]
mod tests;
