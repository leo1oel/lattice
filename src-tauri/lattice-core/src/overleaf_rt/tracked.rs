//! How Overleaf's suggestions ("tracked changes") and comment anchors move
//! with the text, under ordinary edits and under edits sent as suggestions:
//! the Tauri app's `src/overleaf/overleaf-suggestions.ts` and `anchorsAfter`
//! (`overleaf-realtime-model.ts`), for the GPUI app's live document.
//!
//! Overleaf keeps the two kinds differently. A suggested insertion is text in
//! the document, so it is a span. A suggested deletion is text that has
//! already left the document: it occupies no offsets, only a point where the
//! removed text used to start. Treating it as a span covering its own length
//! strikes through, and quotes, whatever text happens to follow it.
//!
//! An edit sent as a suggestion changes the suggestions too: new text becomes
//! a suggested insertion, and removed text becomes a suggested deletion unless
//! it was itself only suggested, in which case removing it just withdraws that
//! much of the suggestion. The server keeps its own copy of these rules and
//! never tells the sender what it made of an update, so what is computed here
//! is provisional: shown at once, and replaced by the server's ranges as soon
//! as the document is quiet enough to read them back. A provisional change
//! has no id Overleaf knows, so it cannot be accepted until then.
//!
//! Positions and lengths are UTF-16 units, as Overleaf counts them.

use std::sync::atomic::{AtomicU64, Ordering};

use super::ot::transform_span;
use super::{CommentRange, OtOp, Suggester, TrackedChange};

const PROVISIONAL: &str = "provisional:";

/// Whether a change was worked out here rather than read from Overleaf.
pub fn is_provisional(change: &TrackedChange) -> bool {
    change.id.starts_with(PROVISIONAL)
}

fn provisional_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("{PROVISIONAL}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn len(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

/// `text` with `inserted` put `at` UTF-16 units in.
fn splice(text: &str, at: i64, inserted: &str) -> String {
    let mut all = units(text);
    let at = (at.max(0) as usize).min(all.len());
    all.splice(at..at, inserted.encode_utf16());
    text_of(&all)
}

/// UTF-16 units `from..to` of `text`.
fn slice(text: &str, from: i64, to: i64) -> String {
    let all = units(text);
    let to = (to.max(0) as usize).min(all.len());
    let from = (from.max(0) as usize).min(to);
    text_of(&all[from..to])
}

/// The suggestions after `ops`: ordinary edits when `by` is none, edits sent
/// as suggestions by `by` otherwise. Each op applies to the text the
/// previous one left, as in any OT operation. `timestamp` is what a new
/// provisional change records.
pub fn changes_after(
    changes: &[TrackedChange], ops: &[OtOp], by: Option<&Suggester>, timestamp: &str,
) -> Vec<TrackedChange> {
    let mut current = changes.to_vec();
    for op in ops {
        let at = op.p as i64;
        if let Some(inserted) = op.i.as_deref().filter(|text| !text.is_empty()) {
            current = after_insert(current, at, inserted, by, timestamp);
        } else if let Some(removed) = op.d.as_deref().filter(|text| !text.is_empty()) {
            current = after_delete(current, at, removed, by, timestamp);
        }
    }
    current
}

fn after_insert(
    changes: Vec<TrackedChange>, at: i64, text: &str, by: Option<&Suggester>, timestamp: &str,
) -> Vec<TrackedChange> {
    let added = len(text);
    // Typing inside, or at either edge of, one's own suggested insertion
    // extends it rather than starting another beside it.
    let host = by.and_then(|by| {
        changes.iter().position(|change| {
            !change.deletion
                && change.user_id == by.user_id
                && change.position <= at
                && at <= change.position + len(&change.text)
        })
    });
    let mut next = Vec::with_capacity(changes.len() + 2);
    for (index, change) in changes.into_iter().enumerate() {
        if Some(index) == host {
            let text = splice(&change.text, at - change.position, text);
            next.push(TrackedChange { text, ..change });
            continue;
        }
        // Text typed at a deletion's point follows the removed text, the way
        // a replacement reads; typed at the start of an insertion it goes in
        // front. Either way it was not part of what that suggestion proposed.
        if change.deletion {
            let position =
                if at < change.position { change.position + added } else { change.position };
            next.push(TrackedChange { position, ..change });
            continue;
        }
        if at <= change.position {
            let position = change.position + added;
            next.push(TrackedChange { position, ..change });
            continue;
        }
        let offset = at - change.position;
        if offset >= len(&change.text) {
            next.push(change);
            continue;
        }
        // An ordinary edit inside a suggested insertion becomes part of it,
        // as the server treats it; a suggestion inside someone else's splits
        // theirs.
        if by.is_none() {
            let text = splice(&change.text, offset, text);
            next.push(TrackedChange { text, ..change });
            continue;
        }
        let whole = len(&change.text);
        next.push(TrackedChange { text: slice(&change.text, 0, offset), ..change.clone() });
        next.push(TrackedChange {
            id: provisional_id(),
            position: at + added,
            text: slice(&change.text, offset, whole),
            ..change
        });
    }
    if let (Some(by), None) = (by, host) {
        next.push(TrackedChange {
            id: provisional_id(),
            position: at,
            text: text.to_string(),
            deletion: false,
            user_id: by.user_id.clone(),
            timestamp: Some(timestamp.to_string()),
            hue: by.hue,
        });
    }
    next
}

fn after_delete(
    changes: Vec<TrackedChange>, at: i64, removed: &str, by: Option<&Suggester>, timestamp: &str,
) -> Vec<TrackedChange> {
    let removed_units = units(removed);
    let removed_len = removed_units.len() as i64;
    let end = at + removed_len;
    // Units of `removed` that were only ever suggested: deleting them
    // withdraws them.
    let mut withdrawn = vec![false; removed_units.len()];
    // The suggester's own deletions the range reached, by offset into
    // `removed`, to fold into one.
    let mut folded: Vec<(i64, String)> = Vec::new();
    let mut next = Vec::with_capacity(changes.len() + 1);
    for change in changes {
        if change.deletion {
            let point = change.position;
            if point < at {
                next.push(change);
            } else if point > end {
                let position = point - removed_len;
                next.push(TrackedChange { position, ..change });
            } else if by.is_some_and(|by| change.user_id == by.user_id) {
                // Deleting up to or across one's own deletion makes one
                // longer deletion, the way backspacing through a word reads
                // as one removal.
                folded.push((point - at, change.text));
            } else {
                next.push(TrackedChange { position: at, ..change });
            }
            continue;
        }
        let start = change.position;
        let stop = start + len(&change.text);
        if stop <= at {
            next.push(change);
            continue;
        }
        if start >= end {
            let position = start - removed_len;
            next.push(TrackedChange { position, ..change });
            continue;
        }
        let from = start.max(at);
        let to = stop.min(end);
        for flag in &mut withdrawn[(from - at) as usize..(to - at) as usize] {
            *flag = true;
        }
        let whole = len(&change.text);
        let text = slice(&change.text, 0, from - start) + &slice(&change.text, to - start, whole);
        // A suggestion whose text was deleted outright has nothing left to
        // accept or reject; dropping it is better than offering a button
        // that would act on whatever moved into its place.
        if !text.is_empty() {
            next.push(TrackedChange { position: start.min(at), text, ..change });
        }
    }
    let Some(by) = by else {
        return next;
    };
    let mut text: Vec<u16> = Vec::new();
    for offset in 0..=removed_units.len() {
        for (at_offset, fold) in &folded {
            if *at_offset == offset as i64 {
                text.extend(fold.encode_utf16());
            }
        }
        if offset < removed_units.len() && !withdrawn[offset] {
            text.push(removed_units[offset]);
        }
    }
    if !text.is_empty() {
        next.push(TrackedChange {
            id: provisional_id(),
            position: at,
            text: text_of(&text),
            deletion: true,
            user_id: by.user_id.clone(),
            timestamp: Some(timestamp.to_string()),
            hue: by.hue,
        });
    }
    next
}

/// Carry the open document's comment anchors across `ops`. Overleaf states
/// where comments sit when the document is joined and never mentions them
/// again: they ride along on the operations that move the text. Only the
/// position moves; the quote is what Overleaf recorded.
pub fn comments_after(comments: &[CommentRange], ops: &[OtOp]) -> Vec<CommentRange> {
    comments
        .iter()
        .map(|comment| {
            let length = len(&comment.quote).max(0) as usize;
            let (from, _) = transform_span(comment.position.max(0) as usize, length, ops);
            CommentRange { position: from as i64, ..comment.clone() }
        })
        .collect()
}

#[cfg(test)]
#[path = "tracked_tests.rs"]
mod tests;
