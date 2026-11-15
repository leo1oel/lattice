//! A proofread suggestion as the edits a writer chooses from, the Tauri
//! app's `src/agent/proofread-edits.ts` ported line for line, with the
//! `heldRuns` helper of `src/canvas/proofread-card.tsx`.
//!
//! The suggestion is diffed token by token (words, LaTeX control sequences,
//! runs of spaces, line breaks), the token changes are joined into the
//! phrases a writer would name, and every phrase that would alter protected
//! LaTeX ([`crate::latex::protected`]) is held back instead of offered.
//!
//! Offsets are bytes of the selection's text. Tokens are whole characters
//! and every protected span ends on a character boundary, so every edit's
//! `from` and `to` do too. "Whitespace" is Unicode's `White_Space`, which
//! differs from JavaScript's `\s` only in U+0085 (whitespace here) and U+FEFF
//! (whitespace there).

use std::{collections::BTreeSet, ops::Range, sync::LazyLock};

use regex::Regex;

use super::{Reason, ReasonLine};
use crate::latex::protected::{
    ProtectedKind, protected_difference, protected_latex_signature, protected_latex_spans_until,
};

/// A replacement of `range` of a text with `inserted`: what [`apply_edits`]
/// applies, whether offered, held or a bare diff hunk.
pub trait Replacement {
    fn range(&self) -> Range<usize>;
    fn inserted(&self) -> &str;
}

impl<T: Replacement> Replacement for &T {
    fn range(&self) -> Range<usize> {
        (**self).range()
    }

    fn inserted(&self) -> &str {
        (**self).inserted()
    }
}

/// One token-level change: replace `[from, to)` of the original with
/// `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

impl Replacement for Hunk {
    fn range(&self) -> Range<usize> {
        self.from..self.to
    }

    fn inserted(&self) -> &str {
        &self.insert
    }
}

/// One logical change a proofread suggests: replace `[from, to)` of the
/// original selection with `insert`. Edits of one suggestion are ordered and
/// never overlap, so any subset of them applies to the original as is.
/// Offered and held edits share one `id` sequence, in the excerpt's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub reason: Option<Reason>,
}

impl Replacement for Edit {
    fn range(&self) -> Range<usize> {
        self.from..self.to
    }

    fn inserted(&self) -> &str {
        &self.insert
    }
}

/// An edit that would have altered protected LaTeX of `kind`, and so is never
/// offered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldEdit {
    pub edit: Edit,
    pub kind: ProtectedKind,
}

impl Replacement for HeldEdit {
    fn range(&self) -> Range<usize> {
        self.edit.range()
    }

    fn inserted(&self) -> &str {
        &self.edit.insert
    }
}

/// A suggestion split into the edits the writer may choose from and the ones
/// held back.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Review {
    pub edits: Vec<Edit>,
    pub held: Vec<HeldEdit>,
}

/// The document text around a selection that its protected LaTeX needs to
/// parse the same way: from the start of a span the selection begins inside
/// (math, a `\cite{…}`) and to the end of one it ends inside. Each is empty
/// when the selection edge sits in prose.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub before: String,
    pub after: String,
}

/// The context of the selection `[from, to)` of `doc`, in bytes on character
/// boundaries.
pub fn context(doc: &str, from: usize, to: usize) -> Context {
    let mut start = from;
    let mut end = to;
    // A span ending exactly at an edge counts too: text typed against `\foo`
    // would become part of the command's name.
    for span in protected_latex_spans_until(doc, to + 1) {
        if span.from < from && span.to >= from {
            start = start.min(span.from);
        }
        if span.from <= to && span.to > to {
            end = end.max(span.to);
        }
    }
    Context {
        before: doc[start..from].to_string(),
        after: doc[to..end].to_string(),
    }
}

/// Words, LaTeX control sequences, runs of spaces, line breaks, and single
/// other characters. Every character is in some token, so the tokens tile
/// the text.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\\(?:[A-Za-z@]+|.)|[\p{L}\p{N}\p{M}]+|[^\S\n]+|\n|.").unwrap()
});

#[derive(Clone, Copy)]
struct Token<'a> {
    text: &'a str,
    from: usize,
}

/// Where token `index` of `text` starts; the text's end past the last.
fn offset_of(tokens: &[Token<'_>], text: &str, index: usize) -> usize {
    tokens.get(index).map_or(text.len(), |token| token.from)
}

fn texts<'a>(tokens: &[Token<'a>]) -> Vec<&'a str> {
    tokens.iter().map(|token| token.text).collect()
}

fn tokenize(text: &str) -> Vec<Token<'_>> {
    TOKEN
        .find_iter(text)
        .map(|found| Token {
            text: found.as_str(),
            from: found.start(),
        })
        .collect()
}

/// Past this many token edits a suggestion is a rewrite; it is reviewed as
/// one change.
const MAX_DIFF_DISTANCE: i32 = 1_500;

/// Index pairs of the tokens `a` and `b` share, in order (Myers' shortest
/// edit script). `None` when the two differ by more than
/// [`MAX_DIFF_DISTANCE`]. Each round keeps only the diagonals it could reach,
/// so memory is the square of the edit distance rather than of the text
/// length.
fn common_tokens(a: &[&str], b: &[&str]) -> Option<Vec<(usize, usize)>> {
    let n = a.len() as i32;
    let m = b.len() as i32;
    let offset = n + m + 1;
    let mut frontier = vec![0i32; (2 * offset + 1) as usize];
    let at = |frontier: &[i32], diagonal: i32| frontier[(offset + diagonal) as usize];
    let mut trace: Vec<Vec<i32>> = Vec::new();
    for distance in 0..=(n + m).min(MAX_DIFF_DISTANCE) {
        trace.push(frontier[(offset - distance) as usize..=(offset + distance) as usize].to_vec());
        for diagonal in (-distance..=distance).step_by(2) {
            let down = diagonal == -distance
                || (diagonal != distance
                    && at(&frontier, diagonal - 1) < at(&frontier, diagonal + 1));
            let mut x = if down {
                at(&frontier, diagonal + 1)
            } else {
                at(&frontier, diagonal - 1) + 1
            };
            let mut y = x - diagonal;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[(offset + diagonal) as usize] = x;
            if x >= n && y >= m {
                return Some(backtrack(&trace, distance, n, m));
            }
        }
    }
    None
}

fn backtrack(trace: &[Vec<i32>], distance: i32, n: i32, m: i32) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let (mut x, mut y) = (n, m);
    for round in (1..=distance).rev() {
        // The frontier before `round`, indexed from diagonal -round.
        let frontier = &trace[round as usize];
        let at = |diagonal: i32| frontier[(diagonal + round) as usize];
        let diagonal = x - y;
        let down = diagonal == -round || (diagonal != round && at(diagonal - 1) < at(diagonal + 1));
        let previous = if down { diagonal + 1 } else { diagonal - 1 };
        let previous_x = at(previous);
        let previous_y = previous_x - previous;
        let start_x = if down { previous_x } else { previous_x + 1 };
        while x > start_x {
            x -= 1;
            y -= 1;
            pairs.push((x as usize, y as usize));
        }
        x = previous_x;
        y = previous_y;
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        pairs.push((x as usize, y as usize));
    }
    pairs.reverse();
    pairs
}

/// The token-level changes from `original` to `revised`, in original
/// offsets: words, LaTeX commands, spaces and line breaks. A revision round's
/// compare draws two versions of a paragraph from these.
pub fn token_hunks(original: &str, revised: &str) -> Vec<Hunk> {
    let a = tokenize(original);
    let b = tokenize(revised);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start].text == b[start].text {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1].text == b[end_b - 1].text {
        end_a -= 1;
        end_b -= 1;
    }
    // The tokens tile the text, so a run of them is one slice.
    let text_of =
        |from: usize, to: usize| &revised[offset_of(&b, revised, from)..offset_of(&b, revised, to)];
    let pairs =
        common_tokens(&texts(&a[start..end_a]), &texts(&b[start..end_b])).unwrap_or_default();
    let mut hunks = Vec::new();
    let (mut i, mut j) = (start, start);
    let shifted = pairs.into_iter().map(|(x, y)| (x + start, y + start));
    for (x, y) in shifted.chain([(end_a, end_b)]) {
        if x > i || y > j {
            hunks.push(Hunk {
                from: offset_of(&a, original, i),
                to: offset_of(&a, original, x),
                insert: text_of(j, y).to_string(),
            });
        }
        i = x + 1;
        j = y + 1;
    }
    hunks
}

fn has_space(text: &str) -> bool {
    text.chars().any(char::is_whitespace)
}

/// A change that swaps one word for another, as a spelling or agreement fix
/// does.
fn swaps_word(original: &str, hunk: &Hunk) -> bool {
    let deleted = &original[hunk.from..hunk.to];
    !deleted.is_empty()
        && !hunk.insert.is_empty()
        && !has_space(deleted)
        && !has_space(&hunk.insert)
}

/// Token changes joined into the edits a writer would name. Changes touching
/// the same run of non-space characters belong together (`state of the art`
/// → `state-of-the-art` is one edit, not three). Across a single space, two
/// word swaps stay separate (`teh` and `wich` are two fixes), but a word
/// added or dropped joins its neighbour: `In this` → `This` is one rewording.
fn logical_groups(original: &str, hunks: Vec<Hunk>) -> Vec<Vec<Hunk>> {
    let mut groups: Vec<Vec<Hunk>> = Vec::new();
    for hunk in hunks {
        if let Some(group) = groups.last_mut()
            && let Some(last) = group.last()
        {
            let gap = &original[last.to..hunk.from];
            let spaces_only =
                !gap.is_empty() && gap.chars().all(|char| char.is_whitespace() && char != '\n');
            let joins = !has_space(gap)
                || (spaces_only && !(swaps_word(original, last) && swaps_word(original, &hunk)));
            if joins {
                group.push(hunk);
                continue;
            }
        }
        groups.push(vec![hunk]);
    }
    groups
}

fn join_hunks(original: &str, hunks: &[Hunk]) -> Hunk {
    let mut insert = String::new();
    for (index, hunk) in hunks.iter().enumerate() {
        if index > 0 {
            insert.push_str(&original[hunks[index - 1].to..hunk.from]);
        }
        insert.push_str(&hunk.insert);
    }
    Hunk {
        from: hunks[0].from,
        to: hunks[hunks.len() - 1].to,
        insert,
    }
}

/// `hunk` without the whitespace it deletes and inserts alike at either end
/// (`In this␠` → `This␠`).
fn trim_shared_space(original: &str, hunk: Hunk) -> Hunk {
    let Hunk {
        mut from,
        mut to,
        mut insert,
    } = hunk;
    while to > from {
        let Some(last) = insert.chars().next_back() else {
            break;
        };
        if !last.is_whitespace() || !original[from..to].ends_with(last) {
            break;
        }
        to -= last.len_utf8();
        insert.pop();
    }
    let mut skipped = 0;
    while to > from {
        let Some(first) = insert[skipped..].chars().next() else {
            break;
        };
        if !first.is_whitespace() || !original[from..to].starts_with(first) {
            break;
        }
        from += first.len_utf8();
        skipped += first.len_utf8();
    }
    insert.drain(..skipped);
    Hunk { from, to, insert }
}

/// The changes from `original` to `revised` as the phrases a writer would
/// name, the way a proofread offers them: `one.` → `.` reads as one deletion,
/// not a word dropped and a full stop kept. An opened version reads its
/// changes from these.
pub fn phrase_hunks(original: &str, revised: &str) -> Vec<Hunk> {
    logical_groups(original, token_hunks(original, revised))
        .iter()
        .map(|group| trim_shared_space(original, join_hunks(original, group)))
        .collect()
}

/// The offered edits the writer has not rejected (by `id`), in order.
pub fn chosen_edits(review: &Review, rejected: &BTreeSet<usize>) -> Vec<Edit> {
    review
        .edits
        .iter()
        .filter(|edit| !rejected.contains(&edit.id))
        .cloned()
        .collect()
}

/// `original` with `edits` applied; the edits must come from one review (or
/// one diff), in any order.
pub fn apply_edits<R: Replacement>(original: &str, edits: &[R]) -> String {
    let mut sorted: Vec<&R> = edits.iter().collect();
    sorted.sort_by_key(|edit| edit.range().start);
    let mut result = String::with_capacity(original.len());
    let mut cursor = 0;
    for edit in sorted {
        let range = edit.range();
        result.push_str(&original[cursor..range.start]);
        result.push_str(edit.inserted());
        cursor = range.end;
    }
    result.push_str(&original[cursor..]);
    result
}

fn in_context(context: &Context, text: &str) -> String {
    [context.before.as_str(), text, context.after.as_str()].concat()
}

/// Which protected LaTeX `revised` changed relative to `original`, read in
/// the selection's context; `None` when math, citations, comments, commands
/// and structure all survived byte for byte.
pub fn protected_change(original: &str, revised: &str, context: &Context) -> Option<ProtectedKind> {
    let before = in_context(context, original);
    let after = in_context(context, revised);
    protected_difference(
        &protected_latex_signature(&before),
        &protected_latex_signature(&after),
    )
}

/// Split a suggestion into logical edits and hold back every one that would
/// alter protected LaTeX. An unsafe edit joined from several token changes
/// is re-checked change by change, so a safe spelling fix is still offered
/// when the model also touched a citation next to it.
pub fn review(original: &str, revised: &str, context: &Context) -> Review {
    let reference_source = in_context(context, original);
    let reference = protected_latex_signature(&reference_source);
    let breaks = |hunk: &Hunk| {
        let edited = in_context(context, &apply_edits(original, std::slice::from_ref(hunk)));
        protected_difference(&reference, &protected_latex_signature(&edited))
    };
    let mut review = Review::default();
    let mut record = |hunk: Hunk, kind: Option<ProtectedKind>| {
        let Hunk { from, to, insert } = trim_shared_space(original, hunk);
        let edit = Edit {
            id: review.edits.len() + review.held.len(),
            from,
            to,
            insert,
            reason: None,
        };
        match kind {
            Some(kind) => review.held.push(HeldEdit { edit, kind }),
            None => review.edits.push(edit),
        }
    };
    for group in logical_groups(original, token_hunks(original, revised)) {
        let joined = join_hunks(original, &group);
        let kind = breaks(&joined);
        let parts: Vec<Option<ProtectedKind>> = if kind.is_some() && group.len() > 1 {
            group.iter().map(&breaks).collect()
        } else {
            Vec::new()
        };
        // Split only to rescue a safe part; an edit unsafe throughout is held
        // whole.
        if parts.iter().any(Option::is_none) {
            for (hunk, kind) in group.into_iter().zip(parts) {
                record(hunk, kind);
            }
        } else {
            record(joined, kind);
        }
    }
    review
}

/// `text` with every whitespace run one space, trimmed.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `review` with the agent's reasons attached to the edits they describe.
/// Lattice splits the suggestion into edits itself, so a reason belongs to
/// the edit whose removed and inserted words its quote contains. Both run in
/// the excerpt's order, so each edit looks from the last match onwards first.
/// An edit no reason describes (a whitespace change, a terse reply) has
/// none.
pub fn with_reasons(mut review: Review, original: &str, reasons: &[ReasonLine]) -> Review {
    if reasons.is_empty() {
        return review;
    }
    let quotes: Vec<(String, String)> = reasons
        .iter()
        .map(|line| (squash(&line.from), squash(&line.to)))
        .collect();
    let mut used = vec![false; reasons.len()];
    let mut cursor = 0;
    // Offered and held edits share one id sequence in the excerpt's order.
    let mut all: Vec<&mut Edit> = review
        .edits
        .iter_mut()
        .chain(review.held.iter_mut().map(|held| &mut held.edit))
        .collect();
    all.sort_by_key(|edit| edit.from);
    for edit in all {
        let deleted = squash(&original[edit.from..edit.to]);
        let inserted = squash(&edit.insert);
        if deleted.is_empty() && inserted.is_empty() {
            continue;
        }
        let found = (0..reasons.len())
            .map(|index| (index + cursor) % reasons.len())
            .find(|&index| {
                let (from, to) = &quotes[index];
                !used[index] && from.contains(&deleted) && to.contains(&inserted)
            });
        let Some(index) = found else { continue };
        used[index] = true;
        cursor = index + 1;
        let ReasonLine { category, note, .. } = &reasons[index];
        if category.is_some() || !note.is_empty() {
            edit.reason = Some(Reason {
                category: *category,
                note: note.clone(),
            });
        }
    }
    review
}

/// How far apart two held edits of one kind may be and still read as one, in
/// UTF-16 code units as the Tauri app measures it.
const HELD_RUN_GAP: usize = 24;

/// Held edits as the paragraph draws them: see [`held_runs`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldRun {
    /// The first held edit's id.
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub kind: ProtectedKind,
}

impl Replacement for HeldRun {
    fn range(&self) -> Range<usize> {
        self.from..self.to
    }

    fn inserted(&self) -> &str {
        &self.insert
    }
}

/// The held edits as the paragraph shows them: a construct the agent changed
/// in two places (`$q k$` → `$\hat{q k}$`) is one locked span with one tag,
/// not a tag on each end. Held edits never show their insertion, so joining
/// them changes nothing but the drawing. Two held edits join when they are of
/// one kind, no offered edit lies between them, and the gap is short and on
/// one line.
pub fn held_runs(original: &str, review: &Review) -> Vec<HeldRun> {
    let mut held: Vec<&HeldEdit> = review.held.iter().collect();
    held.sort_by_key(|held| held.edit.from);
    let mut runs: Vec<HeldRun> = Vec::new();
    for HeldEdit { edit, kind } in held {
        if let Some(last) = runs.last_mut() {
            let gap = &original[last.to..edit.from];
            let offered_between = review
                .edits
                .iter()
                .any(|offered| offered.from >= last.to && offered.to <= edit.from);
            if last.kind == *kind
                && !offered_between
                && gap.encode_utf16().count() <= HELD_RUN_GAP
                && !gap.contains('\n')
            {
                last.to = edit.to;
                last.insert.push_str(gap);
                last.insert.push_str(&edit.insert);
                continue;
            }
        }
        runs.push(HeldRun {
            id: edit.id,
            from: edit.from,
            to: edit.to,
            insert: edit.insert.clone(),
            kind: *kind,
        });
    }
    runs
}

#[cfg(test)]
mod tests;
