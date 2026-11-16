//! Review mode's tracked changes, worked out rather than recorded
//! (`src/history/review-mode-diff.ts`): every difference between the base
//! (the text when review mode was turned on, plus whatever was accepted
//! since) and the text now is one change. Nothing is logged keystroke by
//! keystroke, so an undo, a paste, the Agent's edit or a file changed on
//! disk all read the way they leave the text, and a change typed and then
//! typed away is simply gone.
//!
//! A difference is found in two passes: the lines that changed (Myers), then
//! the words inside them, so a corrected word reads as that word, not as its
//! whole line removed and retyped. A replacement is a deletion and an
//! insertion at the same place, drawn as both and accepted or rejected as
//! one.
//!
//! Offsets here are bytes of the texts, which always have `\n` line breaks.

use std::ops::Range;

use similar::{Algorithm, DiffOp, capture_diff_slices};

/// `base[base_from..base_to]` became `current[from..to]`. Either side may be
/// empty, never both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub base_from: usize,
    pub base_to: usize,
    pub from: usize,
    pub to: usize,
}

impl Hunk {
    pub fn removed<'a>(&self, base: &'a str) -> &'a str {
        &base[self.base_from..self.base_to]
    }

    pub fn added<'a>(&self, current: &'a str) -> &'a str {
        &current[self.from..self.to]
    }
}

/// An edit to a text: `range` becomes `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub range: Range<usize>,
    pub insert: String,
}

/// Past this many lines in the changed middle, or tokens in one changed
/// stretch, the stretch is one change: matching costs more than one broad
/// change saves.
const LINE_LIMIT: usize = 4_000;
const WORD_LIMIT: usize = 1_500;

/// Lines of `text`, each keeping its own line break, so they join back into
/// it (`splitLines`).
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// Han, kana and Hangul have no spaces between words, so each character
/// stands alone.
fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x2E80..=0x2FDF | 0x3005..=0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B
        | 0x3040..=0x30FF | 0x3131..=0x318E | 0x31F0..=0x31FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xF900..=0xFAFF
        | 0xFF66..=0xFF9F | 0xFFA0..=0xFFDC | 0x20000..=0x323AF)
}

fn is_word(character: char) -> bool {
    !is_cjk(character) && (character.is_alphanumeric() || character == '_' || is_mark(character))
}

/// A combining mark, which belongs to the word it follows.
fn is_mark(character: char) -> bool {
    matches!(character as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

fn is_space(character: char) -> bool {
    character.is_whitespace() && character != '\n'
}

/// Words, runs of spaces, and single marks (`TOKEN`). A backslash is its own
/// mark, so `\emph` → `\textbf` changes the command's name, not its slash.
fn tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((start, character)) = chars.next() {
        let mut end = start + character.len_utf8();
        let run: Option<fn(char) -> bool> = if is_word(character) {
            Some(is_word)
        } else if is_space(character) {
            Some(is_space)
        } else {
            None
        };
        if let Some(run) = run {
            while let Some(&(at, next)) = chars.peek() {
                if !run(next) {
                    break;
                }
                end = at + next.len_utf8();
                chars.next();
            }
        }
        out.push(&text[start..end]);
    }
    out
}

/// A run of `a`'s items `[a_from, a_to)` that became `b`'s `[b_from, b_to)`.
struct Run {
    a_from: usize,
    a_to: usize,
    b_from: usize,
    b_to: usize,
}

/// The runs where `a` and `b` differ, in order (`changedRuns`), or one run
/// over both when they are past `limit`.
fn changed_runs(a: &[&str], b: &[&str], limit: usize) -> Vec<Run> {
    if a.len() + b.len() > limit * 2 {
        return vec![Run {
            a_from: 0,
            a_to: a.len(),
            b_from: 0,
            b_to: b.len(),
        }];
    }
    let mut runs: Vec<Run> = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, a, b) {
        let (old, new) = match op {
            DiffOp::Equal { .. } => continue,
            DiffOp::Delete {
                old_index,
                old_len,
                new_index,
            } => (old_index..old_index + old_len, new_index..new_index),
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => (old_index..old_index, new_index..new_index + new_len),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => (
                old_index..old_index + old_len,
                new_index..new_index + new_len,
            ),
        };
        match runs.last_mut() {
            Some(last) if last.a_to == old.start && last.b_to == new.start => {
                last.a_to = old.end;
                last.b_to = new.end;
            }
            _ => runs.push(Run {
                a_from: old.start,
                a_to: old.end,
                b_from: new.start,
                b_to: new.end,
            }),
        }
    }
    runs
}

fn starts(items: &[&str]) -> Vec<usize> {
    let mut starts = Vec::with_capacity(items.len() + 1);
    starts.push(0);
    for item in items {
        starts.push(starts.last().copied().unwrap_or(0) + item.len());
    }
    starts
}

/// Every place `base` and `current` differ, in document order.
pub fn hunks(base: &str, current: &str) -> Vec<Hunk> {
    if base == current {
        return Vec::new();
    }
    let a = split_lines(base);
    let b = split_lines(current);
    // Most of a long paper is untouched: trim it before matching what is left.
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head
        && tail < b.len() - head
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    let a_middle = &a[head..a.len() - tail];
    let b_middle = &b[head..b.len() - tail];
    let a_starts = starts(&a);
    let b_starts = starts(&b);
    let mut out = Vec::new();
    for run in changed_runs(a_middle, b_middle, LINE_LIMIT) {
        let base_from = a_starts[head + run.a_from];
        let from = b_starts[head + run.b_from];
        word_hunks(
            &base[base_from..a_starts[head + run.a_to]],
            &current[from..b_starts[head + run.b_to]],
            base_from,
            from,
            &mut out,
        );
    }
    out
}

/// The word-level changes inside one changed stretch of lines, offset to
/// where it sits.
fn word_hunks(before: &str, after: &str, base_offset: usize, offset: usize, out: &mut Vec<Hunk>) {
    let a = tokens(before);
    let b = tokens(after);
    let a_starts = starts(&a);
    let b_starts = starts(&b);
    let first = out.len();
    for run in changed_runs(&a, &b, WORD_LIMIT) {
        let hunk = Hunk {
            base_from: base_offset + a_starts[run.a_from],
            base_to: base_offset + a_starts[run.a_to],
            from: offset + b_starts[run.b_from],
            to: offset + b_starts[run.b_to],
        };
        // "a b c" → "x y z" matches the spaces and nothing else; three
        // changes a space apart read as the one phrase that was rewritten.
        if out.len() > first
            && let Some(previous) = out.last_mut()
            && previous.to < hunk.from
            && after[previous.to - offset..hunk.from - offset]
                .chars()
                .all(is_space)
        {
            previous.base_to = hunk.base_to;
            previous.to = hunk.to;
        } else {
            out.push(hunk);
        }
    }
    // Two words replaced by one also match up a space either way round; the
    // space both sides keep is not part of the change.
    let space_at =
        |text: &str, at: usize| text[at..].chars().next().is_some_and(char::is_whitespace);
    for hunk in &mut out[first..] {
        while hunk.base_to > hunk.base_from && hunk.to > hunk.from {
            let (Some(x), Some(y)) = (
                before[..hunk.base_to - base_offset].chars().next_back(),
                after[..hunk.to - offset].chars().next_back(),
            ) else {
                break;
            };
            if x != y || !y.is_whitespace() {
                break;
            }
            hunk.base_to -= x.len_utf8();
            hunk.to -= y.len_utf8();
        }
        while hunk.base_to > hunk.base_from && hunk.to > hunk.from {
            let (Some(x), Some(y)) = (
                before[hunk.base_from - base_offset..].chars().next(),
                after[hunk.from - offset..].chars().next(),
            ) else {
                break;
            };
            if x != y || !space_at(after, hunk.from - offset) {
                break;
            }
            hunk.base_from += x.len_utf8();
            hunk.from += y.len_utf8();
        }
    }
}

/// The base once `hunk` is accepted: what the text has there replaces what
/// the base had. A replacement is accepted or rejected whole.
pub fn accepted_base(base: &str, current: &str, hunk: &Hunk) -> String {
    let mut out = String::with_capacity(base.len() + hunk.to - hunk.from);
    out.push_str(&base[..hunk.base_from]);
    out.push_str(hunk.added(current));
    out.push_str(&base[hunk.base_to..]);
    out
}

/// The edit to the text that rejects `hunk`: what the base had there comes
/// back.
pub fn reject_edit(base: &str, hunk: &Hunk) -> Edit {
    Edit {
        range: hunk.from..hunk.to,
        insert: hunk.removed(base).to_string(),
    }
}

/// The edits that put every hunk back as the base has it: Reject all.
pub fn reject_all_edits(base: &str, hunks: &[Hunk]) -> Vec<Edit> {
    hunks.iter().map(|hunk| reject_edit(base, hunk)).collect()
}

/// `text` with `edits` (in its offsets, in order, not overlapping) made.
pub fn apply(text: &str, edits: &[Edit]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for edit in edits {
        out.push_str(&text[at..edit.range.start]);
        out.push_str(&edit.insert);
        at = edit.range.end;
    }
    out.push_str(&text[at..]);
    out
}

/// The base after someone else's edit to the text: `remote`, made to the
/// text `before` (which differs from `base` by `hunks`), carried over to the
/// base, so a co-author's words become part of what is reviewed against
/// rather than the writer's own tracked changes (`advancedBase`).
///
/// A point inside one of the writer's changes, or at either end of one,
/// lands after what the base has there, except the end of a co-author's
/// range that stops where the writer's change starts, which stays before it: text the co-author typed inside the
/// writer's insertion lands in the base at that insertion, so rejecting the
/// insertion keeps it; text they deleted that only the writer had added
/// never was in the base. Whether `remote` touched one of the writer's
/// changes comes back too, so that can be said aloud.
pub fn advanced_base(base: &str, hunks: &[Hunk], remote: &[Edit]) -> (String, bool) {
    let map = |at: usize, closes: bool| -> usize {
        let mut delta: isize = 0;
        for hunk in hunks {
            if at < hunk.from {
                break;
            }
            if closes && at == hunk.from {
                return hunk.base_from;
            }
            if at <= hunk.to {
                return hunk.base_to;
            }
            delta = hunk.base_to as isize - hunk.to as isize;
        }
        (at as isize + delta) as usize
    };
    let touched = remote.iter().any(|edit| {
        hunks
            .iter()
            .any(|hunk| edit.range.start <= hunk.to && edit.range.end >= hunk.from)
    });
    let mut mapped: Vec<Edit> = remote
        .iter()
        .map(|edit| {
            let start = map(edit.range.start, false);
            let closes = edit.range.end > edit.range.start;
            Edit {
                range: start..map(edit.range.end, closes).max(start),
                insert: edit.insert.clone(),
            }
        })
        .collect();
    mapped.sort_by_key(|edit| edit.range.start);
    // Two edits mapped onto one point keep their order and never overlap.
    let mut at = 0;
    for edit in &mut mapped {
        edit.range.start = edit.range.start.max(at);
        edit.range.end = edit.range.end.max(edit.range.start);
        at = edit.range.end;
    }
    (apply(base, &mapped), touched)
}

/// The edit that turned `before` into `after`, worked out from the two.
pub fn edits_between(before: &str, after: &str) -> Vec<Edit> {
    hunks(before, after)
        .into_iter()
        .map(|hunk| Edit {
            range: hunk.base_from..hunk.base_to,
            insert: hunk.added(after).to_string(),
        })
        .collect()
}

/// The base after a file went from `before` to `after` through someone
/// else (an Overleaf sync pulled a co-author's edits into it), and whether
/// that touched the writer's changes (`baseAfterSync`).
pub fn base_after(base: &str, before: &str, after: &str) -> (String, bool) {
    advanced_base(base, &hunks(base, before), &edits_between(before, after))
}

/// What a hunk did, for its hover card: inserted, deleted or replaced text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Described {
    Inserted(String),
    Deleted(String),
    Replaced(String, String),
}

pub fn describe(base: &str, current: &str, hunk: &Hunk) -> Described {
    let (removed, added) = (hunk.removed(base), hunk.added(current));
    match (removed.is_empty(), added.is_empty()) {
        (true, _) => Described::Inserted(added.to_string()),
        (_, true) => Described::Deleted(removed.to_string()),
        _ => Described::Replaced(removed.to_string(), added.to_string()),
    }
}

/// The hunk at `at` (touching either end counts), or with `after` the first
/// after it.
pub fn hunk_at(hunks: &[Hunk], at: usize, after: bool) -> Option<usize> {
    hunks
        .iter()
        .position(|hunk| hunk.from <= at && at <= hunk.to)
        .or_else(|| {
            after
                .then(|| hunks.iter().position(|hunk| hunk.from > at))
                .flatten()
        })
}

/// The change after (`forward`) or before the selection `from..to`,
/// wrapping round at the ends (`moveToChange`).
pub fn step(hunks: &[Hunk], from: usize, to: usize, forward: bool) -> Option<usize> {
    if hunks.is_empty() {
        return None;
    }
    let found = if forward {
        hunks
            .iter()
            .position(|hunk| hunk.from > from || (hunk.from == from && hunk.to > to))
    } else {
        hunks.iter().rposition(|hunk| hunk.from < from)
    };
    Some(found.unwrap_or(if forward { 0 } else { hunks.len() - 1 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changes(base: &str, current: &str) -> Vec<(bool, String)> {
        hunks(base, current)
            .iter()
            .flat_map(|hunk| {
                let mut out = Vec::new();
                if hunk.base_to > hunk.base_from {
                    out.push((true, hunk.removed(base).to_string()));
                }
                if hunk.to > hunk.from {
                    out.push((false, hunk.added(current).to_string()));
                }
                out
            })
            .collect()
    }

    #[test]
    fn nothing_when_the_text_is_the_base() {
        assert!(hunks("Same text.\n", "Same text.\n").is_empty());
    }

    #[test]
    fn a_corrected_word_not_its_whole_line() {
        let base = "\\section{Intro}\nAttention lets a decoder look at encoder states.\nMore.\n";
        let current =
            "\\section{Intro}\nAttention lets a decoder retrieve encoder states.\nMore.\n";
        let found = hunks(base, current);
        assert_eq!(found.len(), 1);
        assert_eq!(
            changes(base, current),
            vec![(true, "look at".into()), (false, "retrieve".into())]
        );
        assert_eq!(found[0].from, current.find("retrieve").unwrap());
    }

    #[test]
    fn distant_paragraphs_stay_apart() {
        let base = "One two three.\n\nFour five six.\n";
        let current = "One 2 three.\n\nFour five 6.\n";
        let inserted: Vec<_> = changes(base, current)
            .into_iter()
            .filter(|(deleted, _)| !deleted)
            .map(|(_, text)| text)
            .collect();
        assert_eq!(inserted, ["2", "6"]);
    }

    #[test]
    fn chinese_reads_a_character_at_a_time() {
        let base = "我们提出了一种新方法。\n";
        let current = "我们提出了一种简单方法。\n";
        assert_eq!(
            changes(base, current),
            vec![(true, "新".into()), (false, "简单".into())]
        );
    }

    #[test]
    fn a_command_name_changes_not_its_slash() {
        let base = "See \\emph{this}.\n";
        let current = "See \\textbf{this}.\n";
        assert_eq!(
            changes(base, current),
            vec![(true, "emph".into()), (false, "textbf".into())]
        );
    }

    #[test]
    fn accept_and_reject_a_replacement() {
        let base = "We look at states.\nThen more.\n";
        let current = "We retrieve states.\nThen more.\n";
        let hunk = hunks(base, current)[0];
        let accepted = accepted_base(base, current, &hunk);
        assert_eq!(accepted, current);
        assert!(hunks(&accepted, current).is_empty());
        assert_eq!(apply(current, &[reject_edit(base, &hunk)]), base);
    }

    #[test]
    fn one_accepted_of_several() {
        let base = "Alpha beta.\n\nGamma delta.\n";
        let current = "Alpha BETA.\n\nGamma DELTA.\n";
        let found = hunks(base, current);
        let accepted = accepted_base(base, current, &found[0]);
        assert_eq!(accepted, "Alpha BETA.\n\nGamma delta.\n");
        assert_eq!(
            changes(&accepted, current),
            vec![(true, "delta".into()), (false, "DELTA".into())]
        );
    }

    #[test]
    fn reject_all_goes_back_to_the_base() {
        let base = "Alpha beta.\n\nGamma delta.\n\nEpsilon.\n";
        let current = "Alpha BETA.\n\nGamma.\n\nEpsilon zeta.\n\nNew paragraph.\n";
        assert_eq!(
            apply(current, &reject_all_edits(base, &hunks(base, current))),
            base
        );
    }

    #[test]
    fn a_coauthors_edit_moves_the_base() {
        let base = "The model is fast.\nIt is small.\n";
        let before = "The model is quick.\nIt is small.\n";
        let at = before.find("small").unwrap();
        let remote = [Edit {
            range: at..at + 5,
            insert: "tiny".into(),
        }];
        let after = apply(before, &remote);
        let (advanced, touched) = advanced_base(base, &hunks(base, before), &remote);
        assert_eq!(advanced, "The model is fast.\nIt is tiny.\n");
        assert!(!touched);
        assert_eq!(
            changes(&advanced, &after),
            vec![(true, "fast".into()), (false, "quick".into())]
        );
        assert_eq!(base_after(base, before, &after), (advanced, false));
    }

    #[test]
    fn coauthor_words_inside_the_writers_insertion_survive_its_reject() {
        let base = "Results.\n";
        let before = "Results are strong.\n";
        let at = before.find("strong").unwrap();
        let remote = [Edit {
            range: at..at,
            insert: "very ".into(),
        }];
        let after = apply(before, &remote);
        let (advanced, touched) = advanced_base(base, &hunks(base, before), &remote);
        assert!(touched);
        assert!(advanced.contains("very "));
        let rejected = apply(
            &after,
            &reject_all_edits(&advanced, &hunks(&advanced, &after)),
        );
        assert_eq!(rejected, advanced);
    }

    #[test]
    fn a_coauthors_deletion_up_to_the_writers_replacement_keeps_its_base_text() {
        let base = "The old cat.\n";
        let before = "The new cat.\n";
        assert_eq!(hunks(base, before).len(), 1);
        let remote = [Edit {
            range: 0..4,
            insert: String::new(),
        }];
        let after = apply(before, &remote);
        let (advanced, _) = advanced_base(base, &hunks(base, before), &remote);
        assert_eq!(advanced, "old cat.\n");
        let rejected = apply(
            &after,
            &reject_all_edits(&advanced, &hunks(&advanced, &after)),
        );
        assert_eq!(rejected, "old cat.\n");
    }

    #[test]
    fn a_coauthors_deletion_up_to_the_writers_deletion_keeps_its_base_text() {
        let base = "The old cat.\n";
        let before = "The cat.\n";
        let found = hunks(base, before);
        assert_eq!(found.len(), 1);
        let remote = [Edit {
            range: 0..found[0].from,
            insert: String::new(),
        }];
        let after = apply(before, &remote);
        let (advanced, _) = advanced_base(base, &found, &remote);
        assert_eq!(advanced, &base[found[0].from..]);
        let rejected = apply(
            &after,
            &reject_all_edits(&advanced, &hunks(&advanced, &after)),
        );
        assert_eq!(rejected, advanced);
    }

    #[test]
    fn stepping_wraps_round() {
        let found = hunks("a b c d\n", "a B c D\n");
        assert_eq!(found.len(), 2);
        assert_eq!(step(&found, 0, 0, true), Some(0));
        assert_eq!(step(&found, found[1].from, found[1].to, true), Some(0));
        assert_eq!(step(&found, 0, 0, false), Some(1));
        assert_eq!(hunk_at(&found, found[1].to, false), Some(1));
        assert_eq!(hunk_at(&found, 1, true), Some(0));
    }
}
