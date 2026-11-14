//! Operational transformation for Overleaf's text operations, and the client
//! state for one document edited live through it: the Tauri app's
//! `src/overleaf/ot.ts`, moved into Rust beside the socket client so the GPUI
//! app (and later the Tauri app) runs it natively.
//!
//! Overleaf's realtime protocol exchanges positioned inserts and deletes, not
//! whole documents, which is what lets two people type in one paragraph
//! without either version being overwritten. When both edit at once, each
//! side's operation was written against a document the other has already
//! changed; transformation rewrites one so it still means the same thing
//! after the other landed. The semantics match ShareJS's `text` type, which
//! Overleaf's server applies, and everything rests on convergence:
//! a-then-transformed-b equals b-then-transformed-a (the tests check it on
//! thousands of random operations).
//!
//! Positions and lengths are in UTF-16 code units, as Overleaf counts them;
//! the texts here are Rust strings, measured in those units.

use super::changed_runs::{
    changed_runs, code_points, is_high_surrogate, is_low_surrogate, split_lines, ChangedRun,
};
use super::OtOp;

/// At most this many lines added or removed are matched up line by line.
const MAX_CHANGED_LINES: usize = 400;
/// At most this many characters added or removed in one run are matched up
/// one by one.
const MAX_CHANGED_CHARS: usize = 400;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The hash Overleaf checks an update against (`overleafDocHash`): SHA-1 of
/// `blob {UTF-16 length}\0` and the text's UTF-8. Sent with an update that
/// nothing else landed before, it turns a copy that drifted from the
/// server's into a refused update instead of silent divergence.
pub fn doc_hash(text: &str) -> String {
    use sha1::{Digest as _, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", utf16_len(text)).as_bytes());
    hasher.update(text.as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `text`'s length as Overleaf counts it.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// An insert of `text` at `p`.
pub fn insert(p: usize, text: impl Into<String>) -> OtOp {
    OtOp { p, i: Some(text.into()), d: None, u: None }
}

/// A delete of `text` at `p`.
pub fn delete(p: usize, text: impl Into<String>) -> OtOp {
    OtOp { p, i: None, d: Some(text.into()), u: None }
}

/// The change from `before` to `after` as ops.
///
/// Editing is overwhelmingly one contiguous change at a time, so this
/// narrows to the differing middle by matching the common prefix and suffix:
/// exactly the ops the web editor sends for the same keystroke. When the
/// middle spans lines, the unchanged lines inside it are matched too, so
/// changes made far apart in one send stay separate ops.
pub fn diff_to_ops(before: &str, after: &str) -> Vec<OtOp> {
    change_ops(&units(before), &units(after), 0, true, false)
}

/// `diff_to_ops`, with each changed run of lines narrowed to the characters
/// that changed in it: what merging needs, where a span from a line's first
/// change to its last would also stand for the unchanged text between them.
pub fn precise_ops(before: &str, after: &str) -> Vec<OtOp> {
    change_ops(&units(before), &units(after), 0, true, true)
}

fn change_ops(before: &[u16], after: &[u16], at: usize, by_line: bool, by_char: bool) -> Vec<OtOp> {
    if before == after {
        return Vec::new();
    }
    let max_prefix = before.len().min(after.len());
    let mut prefix = 0;
    while prefix < max_prefix && before[prefix] == after[prefix] {
        prefix += 1;
    }
    // Never cut a character in half: two emoji can share the first half of
    // their UTF-16 pair, and an op holding only the second half is a lone
    // surrogate Overleaf turns into U+FFFD.
    if prefix > 0 && is_high_surrogate(before[prefix - 1]) {
        prefix -= 1;
    }
    let max_suffix = max_prefix - prefix;
    let mut suffix = 0;
    while suffix < max_suffix
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    if suffix > 0 && is_low_surrogate(before[before.len() - suffix]) {
        suffix -= 1;
    }
    let removed = &before[prefix..before.len() - suffix];
    let inserted = &after[prefix..after.len() - suffix];
    if by_line && !removed.is_empty() && !inserted.is_empty() {
        let (removed_lines, inserted_lines) = (split_lines(removed), split_lines(inserted));
        // A pure insertion or deletion is one run however many lines it spans.
        if removed_lines.len() > 1 || inserted_lines.len() > 1 {
            if let Some(runs) = changed_runs(&removed_lines, &inserted_lines, MAX_CHANGED_LINES) {
                if runs.len() > 1 {
                    return run_ops(&removed_lines, &inserted_lines, &runs, at + prefix, by_char);
                }
            }
        }
    }
    if by_char && !removed.is_empty() && !inserted.is_empty() {
        let (removed_chars, inserted_chars) = (code_points(removed), code_points(inserted));
        if let Some(runs) = changed_runs(&removed_chars, &inserted_chars, MAX_CHANGED_CHARS) {
            if runs.len() > 1 {
                return run_ops(&removed_chars, &inserted_chars, &runs, at + prefix, false);
            }
        }
    }
    // Delete first: the insert's position is then expressed against the text
    // that remains, which is what the server expects.
    let mut ops = Vec::new();
    if !removed.is_empty() {
        ops.push(delete(at + prefix, text_of(removed)));
    }
    if !inserted.is_empty() {
        ops.push(insert(at + prefix, text_of(inserted)));
    }
    ops
}

/// Ops for `runs` of `removed` pieces that became `inserted` ones, the
/// removed pieces starting at `at`. Each run is trimmed on its own, and lands
/// where the runs before it left the text: ops apply one after another.
fn run_ops(
    removed: &[&[u16]], inserted: &[&[u16]], runs: &[ChangedRun], at: usize, by_char: bool,
) -> Vec<OtOp> {
    let mut starts = vec![0usize];
    for piece in removed {
        starts.push(starts.last().copied().unwrap_or(0) + piece.len());
    }
    let mut ops = Vec::new();
    let mut shift: isize = 0;
    for run in runs {
        let was: Vec<u16> = removed[run.a_from..run.a_to].concat();
        let is: Vec<u16> = inserted[run.b_from..run.b_to].concat();
        let position = (at + starts[run.a_from]) as isize + shift;
        ops.extend(change_ops(&was, &is, position as usize, false, by_char));
        shift += is.len() as isize - was.len() as isize;
    }
    ops
}

/// What Overleaf actually stores for these ops, and whether that differs.
///
/// Its document updater replaces every UTF-16 surrogate in inserted text with
/// U+FFFD (both halves of an emoji, one replacement character each) and still
/// acknowledges the operation as sent. Mirroring the server keeps the two
/// copies identical, and lengths (so every position) stay the same.
pub fn as_overleaf_stores(ops: Vec<OtOp>) -> (Vec<OtOp>, bool) {
    let mut replaced = false;
    let stored = ops
        .into_iter()
        .map(|mut op| {
            let wide =
                op.i.as_deref()
                    .is_some_and(|text| text.chars().any(|character| character.len_utf16() == 2));
            if let (true, Some(text)) = (wide, &op.i) {
                replaced = true;
                op.i = Some(
                    text.chars()
                        .map(|character| {
                            if character.len_utf16() == 2 {
                                "\u{FFFD}\u{FFFD}".to_string()
                            } else {
                                character.to_string()
                            }
                        })
                        .collect(),
                );
            }
            op
        })
        .collect();
    (stored, replaced)
}

/// Apply ops to a document, in order. None when an op does not fit the text
/// (a delete whose content differs, a position past the end): a sign the
/// local copy drifted, which the caller recovers from by re-fetching rather
/// than writing it out.
pub fn apply_ops(content: &str, ops: &[OtOp]) -> Option<String> {
    let mut text = units(content);
    for op in ops {
        if op.p > text.len() {
            return None;
        }
        if let Some(deleted) = &op.d {
            let deleted = units(deleted);
            if op.p + deleted.len() > text.len() || text[op.p..op.p + deleted.len()] != deleted[..]
            {
                return None;
            }
            text.drain(op.p..op.p + deleted.len());
        }
        if let Some(inserted) = &op.i {
            if op.p > text.len() {
                return None;
            }
            text.splice(op.p..op.p, units(inserted));
        }
    }
    Some(text_of(&text))
}

/// Where a span (a comment quote, a suggestion) starting at `from`, `length`
/// long, ends up after `ops`. Text typed at either edge lands outside it; a
/// span whose text is deleted outright collapses to length 0.
pub fn transform_span(from: usize, length: usize, ops: &[OtOp]) -> (usize, usize) {
    let (mut from, mut length) = (from as isize, length as isize);
    for op in ops {
        let p = op.p as isize;
        if let Some(inserted) = &op.i {
            let added = utf16_len(inserted) as isize;
            if p <= from {
                from += added;
            } else if p < from + length {
                length += added;
            }
        } else if let Some(deleted) = &op.d {
            let removed = utf16_len(deleted) as isize;
            let (start, end) = (p, p + removed);
            if end <= from {
                from -= removed;
            } else if start < from + length {
                // Lose the deleted part of the span, and move its start back
                // by however much of the deletion was in front of it.
                length -= end.min(from + length) - start.max(from);
                if start < from {
                    from = start;
                }
            }
        }
    }
    (from.max(0) as usize, length.max(0) as usize)
}

fn inject(source: &str, position: usize, text: &str) -> String {
    let mut source = units(source);
    source.splice(position..position, units(text));
    text_of(&source)
}

/// Add a component, merging it into the previous one when they are adjacent,
/// which keeps operations in the canonical shape the server produces.
fn append(op: &mut Vec<OtOp>, component: OtOp) {
    if component.i.as_deref() == Some("") || component.d.as_deref() == Some("") {
        return;
    }
    if let Some(last) = op.last_mut() {
        if let (Some(last_inserted), Some(inserted)) = (&last.i, &component.i) {
            if last.p <= component.p && component.p <= last.p + utf16_len(last_inserted) {
                *last = insert(last.p, inject(last_inserted, component.p - last.p, inserted));
                return;
            }
        }
        if let (Some(last_deleted), Some(deleted)) = (&last.d, &component.d) {
            if component.p <= last.p && last.p <= component.p + utf16_len(deleted) {
                *last = delete(component.p, inject(deleted, last.p - component.p, last_deleted));
                return;
            }
        }
    }
    op.push(component);
}

/// Where a position ends up after `component`. `insert_after` breaks the tie
/// when an insert lands exactly on it: the two sides must disagree
/// consistently, or concurrent inserts at one spot would never converge.
fn transform_position(position: usize, component: &OtOp, insert_after: bool) -> usize {
    if let Some(inserted) = &component.i {
        return if component.p < position || (component.p == position && insert_after) {
            position + utf16_len(inserted)
        } else {
            position
        };
    }
    let deleted = component.d.as_deref().map_or(0, utf16_len);
    if position <= component.p {
        position
    } else if position <= component.p + deleted {
        component.p
    } else {
        position - deleted
    }
}

/// Transform one component against one other, appending the result.
fn transform_component(destination: &mut Vec<OtOp>, component: &OtOp, other: &OtOp, left: bool) {
    if let Some(inserted) = &component.i {
        append(
            destination,
            insert(transform_position(component.p, other, !left), inserted.clone()),
        );
        return;
    }
    let deleted = units(component.d.as_deref().unwrap_or(""));
    if let Some(other_inserted) = &other.i {
        // Our delete spans text the other side just split with an insert, so
        // it becomes two deletes, one each side of the inserted text, which
        // is left alone because we never meant to remove it.
        let split = other.p.saturating_sub(component.p).min(deleted.len());
        if component.p < other.p {
            append(destination, delete(component.p, text_of(&deleted[..split])));
        }
        if split < deleted.len() {
            append(
                destination,
                delete(component.p + utf16_len(other_inserted), text_of(&deleted[split..])),
            );
        }
        return;
    }
    let other_deleted = other.d.as_deref().map_or(0, utf16_len);
    if component.p >= other.p + other_deleted {
        // Entirely after their delete: shift back by what they removed.
        append(destination, delete(component.p - other_deleted, text_of(&deleted)));
    } else if component.p + deleted.len() <= other.p {
        // Entirely before their delete: unaffected.
        append(destination, component.clone());
    } else {
        // The two deletes overlap: only the parts outside their range remain
        // for us to delete.
        let mut remaining: Vec<u16> = if component.p < other.p {
            deleted[..other.p - component.p].to_vec()
        } else {
            Vec::new()
        };
        if component.p + deleted.len() > other.p + other_deleted {
            remaining.extend_from_slice(&deleted[other.p + other_deleted - component.p..]);
        }
        if !remaining.is_empty() {
            append(
                destination,
                delete(transform_position(component.p, other, false), text_of(&remaining)),
            );
        }
    }
}

/// Transform two concurrent operations against each other, returning each
/// rewritten to apply after the other. The first takes precedence in ties.
///
/// As each of the left op's components is transformed, the right component
/// is carried forward transformed too, or every later position is measured
/// against a document that no longer exists. A component can also split in
/// two (a delete straddling an insert), and then the rest of the work is
/// transformed against both halves, hence the recursion.
pub fn transform_both(left: &[OtOp], right: &[OtOp]) -> (Vec<OtOp>, Vec<OtOp>) {
    let mut left_op = left.to_vec();
    let mut new_right_op = Vec::new();
    for original in right {
        let mut right_component = Some(original.clone());
        let mut new_left_op = Vec::new();
        let mut index = 0;
        while index < left_op.len() {
            let Some(current) = right_component.take() else {
                break;
            };
            let mut split = Vec::new();
            transform_component(&mut new_left_op, &left_op[index], &current, true);
            transform_component(&mut split, &current, &left_op[index], false);
            match split.len() {
                1 => right_component = split.pop(),
                0 => {
                    // The right component vanished (fully deleted by the left
                    // op), so the rest of the left op is unaffected by it.
                    for rest in &left_op[index + 1..] {
                        append(&mut new_left_op, rest.clone());
                    }
                }
                _ => {
                    let (rest_left, rest_right) = transform_both(&left_op[index + 1..], &split);
                    for item in rest_left {
                        append(&mut new_left_op, item);
                    }
                    for item in rest_right {
                        append(&mut new_right_op, item);
                    }
                }
            }
            index += 1;
        }
        if let Some(component) = right_component {
            append(&mut new_right_op, component);
        }
        left_op = new_left_op;
    }
    (left_op, new_right_op)
}

/// `current` is `base` with local typing on top; `remote`, ops on `base`,
/// turned it into `remote_text`. Return `remote_text` with that typing on
/// top, placed the way the server will place it. `typing` is the typing as
/// it was made, when known; otherwise it is worked out to the character. None
/// when the ops do not fit the texts.
pub fn rebase_onto(
    base: &str, current: &str, remote: &[OtOp], remote_text: &str, typing: Option<&[OtOp]>,
) -> Option<String> {
    if current == base {
        return Some(remote_text.to_string());
    }
    let local = match typing {
        Some(typing) if apply_ops(base, typing).as_deref() == Some(current) => typing.to_vec(),
        _ => precise_ops(base, current),
    };
    let (typed, _) = transform_both(&local, remote);
    apply_ops(remote_text, &typed)
}

/// The operation that takes `apply_ops(text, ops)` back to `text`.
pub fn invert_ops(ops: &[OtOp]) -> Vec<OtOp> {
    ops.iter().rev().map(|op| OtOp { p: op.p, i: op.d.clone(), d: op.i.clone(), u: None }).collect()
}

/// Two operations that apply one after the other, as a single one.
pub fn compose_ops(first: &[OtOp], second: &[OtOp]) -> Vec<OtOp> {
    let mut result = first.to_vec();
    for component in second {
        append(&mut result, component.clone());
    }
    result
}

/// What to send: ops built on the server's `version`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OtSend {
    pub version: i64,
    pub ops: Vec<OtOp>,
}

/// The server's view and ours have provably diverged. Recovering means
/// re-fetching the document rather than guessing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OtDesync {
    /// Overleaf acknowledged `version` while this document is at `current`.
    AckAhead { version: i64, current: i64 },
    /// Overleaf sent `version` while this document is at `current`.
    UpdateAhead { version: i64, current: i64 },
    /// An update did not fit this document.
    DidNotFit,
}

impl std::fmt::Display for OtDesync {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OtDesync::AckAhead { version, current } => write!(
                f,
                "Overleaf acknowledged version {version} while this document is at {current}."
            ),
            OtDesync::UpdateAhead { version, current } => {
                write!(f, "Overleaf sent version {version} while this document is at {current}.")
            }
            OtDesync::DidNotFit => write!(
                f,
                "An update from Overleaf did not fit this document; it needs to be reloaded."
            ),
        }
    }
}

impl std::error::Error for OtDesync {}

/// A local edit recorded: what to send now, if anything; whether the text
/// took Overleaf's stored form (`as_overleaf_stores`), which the editor must
/// then show; and the edit itself, for moving anchors with the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalEdit {
    pub send: Option<OtSend>,
    pub replaced: bool,
    pub ops: Vec<OtOp>,
}

/// The operation in flight again, to resend after a reconnect, with the
/// connections it went out on so Overleaf can recognise a duplicate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resend {
    pub version: i64,
    pub ops: Vec<OtOp>,
    pub dup_if_source: Vec<String>,
}

/// An update replayed on catching up: someone else's, or ours landing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replayed {
    pub version: i64,
    pub ops: Vec<OtOp>,
    pub mine: bool,
}

/// Client state for one document edited live through Overleaf, mirroring
/// the ShareJS client Overleaf's own editor uses.
///
/// The server applies operations in a single order and is the authority. A
/// client has one operation in flight at a time, so anything typed while
/// waiting is collected and sent as one operation on acknowledgement.
/// Everything arriving from the server is transformed against whatever this
/// client still owes, and vice versa.
///
/// Every `version` a method takes is the version an operation applied at, as
/// Overleaf reports it; the document then moves to `version + 1`. An older
/// one is the same operation arriving twice and is ignored; a newer one means
/// an operation went missing, which cannot be repaired by guessing.
#[derive(Clone, Debug)]
pub struct OtDocument {
    /// Includes unsent work.
    text: String,
    /// The last server version seen.
    version: i64,
    /// Sent, not yet acknowledged.
    inflight: Option<Vec<OtOp>>,
    /// Typed while `inflight` was outstanding.
    pending: Option<Vec<OtOp>>,
    /// Every connection `inflight` has gone out on: after a reconnect the
    /// replay of an operation sent earlier carries an id that is no longer
    /// ours, and only this list still recognises it as our own.
    submitted: Vec<String>,
    /// See `server_text`.
    at_version: String,
}

impl OtDocument {
    pub fn new(text: impl Into<String>, version: i64) -> Self {
        let text = text.into();
        Self {
            at_version: text.clone(),
            text,
            version,
            inflight: None,
            pending: None,
            submitted: Vec::new(),
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn version(&self) -> i64 {
        self.version
    }

    /// Overleaf's text at `version`: everything the server has applied that
    /// this side has heard about, and none of the work still owed to it. The
    /// one text both sides provably held, which a merge needs as its ancestor.
    pub fn server_text(&self) -> &str {
        &self.at_version
    }

    /// The server still owes us an acknowledgement.
    pub fn waiting(&self) -> bool {
        self.inflight.is_some()
    }

    /// The connections the operation in flight has been sent on, oldest
    /// first.
    pub fn submitted_via(&self) -> &[String] {
        &self.submitted
    }

    /// Record that the operation in flight went out on connection
    /// `public_id`.
    pub fn note_submitted(&mut self, public_id: Option<&str>) {
        if let Some(public_id) = public_id {
            if self.inflight.is_some() && !self.submitted.iter().any(|id| id == public_id) {
                self.submitted.push(public_id.to_string());
            }
        }
    }

    /// The operation in flight again, after a replay has brought `version`
    /// up to date. A replay that cancelled it out entirely settles it here,
    /// and anything typed meanwhile goes out in its place as a fresh one.
    pub fn resend(&mut self) -> Option<Resend> {
        let inflight = self.inflight.as_ref()?;
        if !inflight.is_empty() {
            return Some(Resend {
                version: self.version,
                ops: inflight.clone(),
                dup_if_source: self.submitted.clone(),
            });
        }
        self.inflight = None;
        self.submitted.clear();
        let pending = self.pending.take()?;
        self.inflight = Some(pending.clone());
        Some(Resend { version: self.version, ops: pending, dup_if_source: Vec::new() })
    }

    /// The text the server will hold once the operation in flight lands
    /// exactly as sent (what Overleaf's update `hash` describes). None when
    /// nothing is in flight, or later work is queued on top of it.
    pub fn sent_text(&self) -> Option<&str> {
        (self.inflight.is_some() && self.pending.is_none()).then_some(self.text.as_str())
    }

    /// Everything typed here has reached the server.
    pub fn settled(&self) -> bool {
        self.inflight.is_none() && self.pending.is_none()
    }

    /// Record a local edit. While an operation is in flight the new work
    /// waits: the server would reject a second operation built on a version
    /// it has not confirmed.
    pub fn local(&mut self, next_text: &str) -> LocalEdit {
        let typed = diff_to_ops(&self.text, next_text);
        let (ops, replaced) = as_overleaf_stores(typed);
        self.text = if replaced {
            apply_ops(&self.text, &ops).unwrap_or_else(|| next_text.to_string())
        } else {
            next_text.to_string()
        };
        if ops.is_empty() {
            return LocalEdit { send: None, replaced, ops };
        }
        if self.inflight.is_some() {
            self.pending = Some(match self.pending.take() {
                Some(pending) => compose_ops(&pending, &ops),
                None => ops.clone(),
            });
            return LocalEdit { send: None, replaced, ops };
        }
        self.inflight = Some(ops.clone());
        LocalEdit { send: Some(OtSend { version: self.version, ops: ops.clone() }), replaced, ops }
    }

    /// Send `ops` exactly as given (a rejected suggestion's inverse, whose
    /// `u` flag Overleaf needs to see), when nothing is outstanding. None when
    /// work is in flight or queued, or the ops do not fit the text.
    pub fn local_ops(&mut self, ops: Vec<OtOp>) -> Option<OtSend> {
        if !self.settled() || ops.is_empty() {
            return None;
        }
        self.text = apply_ops(&self.text, &ops)?;
        self.inflight = Some(ops.clone());
        Some(OtSend { version: self.version, ops })
    }

    /// Reserve the wire for an operation that carries no text (a comment
    /// anchor). None when something is already in flight.
    pub fn anchor(&mut self) -> Option<i64> {
        if self.inflight.is_some() {
            return None;
        }
        self.inflight = Some(Vec::new());
        Some(self.version)
    }

    /// The server accepted our in-flight operation (applied at `version`,
    /// when given). Anything typed since goes out now, as a single operation.
    pub fn acknowledge(&mut self, version: Option<i64>) -> Result<Option<OtSend>, OtDesync> {
        if let Some(version) = version {
            if version < self.version {
                return Ok(None);
            }
            if version != self.version {
                return Err(OtDesync::AckAhead { version, current: self.version });
            }
        }
        let Some(inflight) = self.inflight.take() else {
            return Ok(None);
        };
        // The operation in flight was kept transformed to apply at `version`,
        // so it is exactly what the server applied to its copy.
        let Some(at_version) = apply_ops(&self.at_version, &inflight) else {
            self.inflight = Some(inflight);
            return Err(OtDesync::DidNotFit);
        };
        self.at_version = at_version;
        self.submitted.clear();
        self.version += 1;
        let Some(pending) = self.pending.take() else {
            return Ok(None);
        };
        // Work typed while waiting can cancel out against someone else's
        // edit. Sending an empty operation stalls every later edit (the
        // server never answers it), so it is dropped, as Overleaf's own
        // client drops it.
        if pending.is_empty() {
            return Ok(None);
        }
        self.inflight = Some(pending.clone());
        Ok(Some(OtSend { version: self.version, ops: pending }))
    }

    /// Apply work from someone else, applied on the server at `version`. Our
    /// outstanding operations are rewritten to account for it, and it for
    /// them. Returns the ops applied to `text`, for moving the caret and
    /// anchors.
    pub fn remote(&mut self, ops: &[OtOp], version: i64) -> Result<Vec<OtOp>, OtDesync> {
        if version < self.version {
            return Ok(Vec::new());
        }
        if version != self.version {
            return Err(OtDesync::UpdateAhead { version, current: self.version });
        }
        // Ours goes on the left, as ShareJS's own client puts it: the server
        // transforms ours as the left side against everything applied since,
        // so at a tie ours lands first there and has to land first here. The
        // server's own copy takes the operation as sent.
        let at_version = apply_ops(&self.at_version, ops).ok_or(OtDesync::DidNotFit)?;
        let mut incoming = ops.to_vec();
        let mut inflight = self.inflight.clone();
        let mut pending = self.pending.clone();
        if let Some(ours) = &inflight {
            let (ours, theirs) = transform_both(ours, &incoming);
            inflight = Some(ours);
            incoming = theirs;
        }
        if let Some(ours) = &pending {
            let (ours, theirs) = transform_both(ours, &incoming);
            // Cancelled out entirely: nothing is left to send.
            pending = (!ours.is_empty()).then_some(ours);
            incoming = theirs;
        }
        let next = apply_ops(&self.text, &incoming).ok_or(OtDesync::DidNotFit)?;
        self.inflight = inflight;
        self.pending = pending;
        self.text = next;
        self.at_version = at_version;
        self.version = version + 1;
        Ok(incoming)
    }

    /// Replay the work the server did while this document was not being
    /// watched: someone else's, transformed against our outstanding work, or
    /// our own landing, which acknowledges it. Returns the ops applied to
    /// `text` (each in the space the ones before it left) and whatever became
    /// sendable.
    pub fn catch_up(
        &mut self, updates: &[Replayed],
    ) -> Result<(Vec<OtOp>, Option<OtSend>), OtDesync> {
        let mut applied = Vec::new();
        let mut send = None;
        for update in updates {
            if update.mine {
                if let Some(next) = self.acknowledge(Some(update.version))? {
                    send = Some(next);
                }
            } else {
                applied.extend(self.remote(&update.ops, update.version)?);
            }
        }
        Ok((applied, send))
    }

    /// Start again from the server's copy, dropping unsent work.
    pub fn reset(&mut self, text: impl Into<String>, version: i64) {
        let text = text.into();
        self.at_version = text.clone();
        self.text = text;
        self.version = version;
        self.inflight = None;
        self.pending = None;
        self.submitted.clear();
    }
}

#[cfg(test)]
#[path = "ot_tests.rs"]
mod tests;
