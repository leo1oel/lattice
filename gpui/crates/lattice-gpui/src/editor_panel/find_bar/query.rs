//! What the find bar's query means and where its steps land, as
//! `@codemirror/search` decides them for the Tauri app's panel (its
//! `SearchQuery`, `findNext`, `findPrevious`, `replaceNext` and the seed
//! `openSearchPanel` takes from the selection), with the counter
//! `compactSearchPanel` adds (`src/editor/latex/search-panel.ts`).
//!
//! Matches are byte ranges of the buffer, in order and never overlapping, as
//! the editor's search returns them.

use std::ops::Range;

/// The three toggles, off by default as CodeMirror's are.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct FindOptions {
    pub match_case: bool,
    pub regexp: bool,
    pub whole_word: bool,
}

/// CodeMirror seeds the query from a selection of at most this many
/// characters; a longer one keeps the query there was.
const SEED_LIMIT: usize = 100;

/// The query ⌘F seeds from `selected`: the selection itself, when there is
/// one and it is short, with its line breaks written `\n` (the query field is
/// one line, and the query reads `\n` back as a line break); else `None`,
/// keeping the last query.
pub fn seed(selected: &str) -> Option<String> {
    if selected.is_empty() || selected.chars().count() > SEED_LIMIT {
        return None;
    }
    Some(selected.replace('\n', "\\n"))
}

/// A query or replacement as CodeMirror reads it when it is not literal:
/// `\n`, `\r` and `\t` are those characters and `\\` is one backslash; any
/// other backslash stays as it is.
pub fn unquote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = match chars.peek() {
                Some('n') => Some('\n'),
                Some('r') => Some('\r'),
                Some('t') => Some('\t'),
                Some('\\') => Some('\\'),
                _ => None,
            };
            if let Some(escaped) = escaped {
                chars.next();
                out.push(escaped);
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// A regular expression's replacement in the regex crate's syntax:
/// CodeMirror's `$&` (the whole match) is `${0}`; `$1` and `$$` read the same
/// in both.
pub fn regex_replacement(replacement: &str) -> String {
    let unquoted = unquote(replacement);
    let mut out = String::with_capacity(unquoted.len());
    let mut chars = unquoted.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' {
            match chars.peek() {
                Some('&') => {
                    chars.next();
                    out.push_str("${0}");
                    continue;
                }
                Some('$') => {
                    chars.next();
                    out.push_str("$$");
                    continue;
                }
                _ => {}
            }
        }
        out.push(ch);
    }
    out
}

/// The counter beside the query: `current/total`, the current match being
/// the one the selection is, else the first after the cursor, else the last;
/// `0/0` with none.
pub fn count_label(matches: &[Range<usize>], selection: Range<usize>, head: usize) -> String {
    if matches.is_empty() {
        return "0/0".into();
    }
    let current = matches
        .iter()
        .position(|found| *found == selection)
        .or_else(|| matches.iter().position(|found| found.start >= head))
        .map_or(matches.len(), |ix| ix + 1);
    format!("{current}/{}", matches.len())
}

/// The match the selection is exactly, which is drawn as the current one.
pub fn selected_match(matches: &[Range<usize>], selection: &Range<usize>) -> Option<usize> {
    matches.iter().position(|found| found == selection)
}

/// Find next: the first match starting at or after the selection's end,
/// round to the first. An empty match at the selection itself is passed
/// over, so a step always moves.
pub fn next_match(matches: &[Range<usize>], selection: &Range<usize>) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    matches
        .iter()
        .position(|found| found.start >= selection.end && found != selection)
        .or(Some(0))
}

/// Find previous: the last match ending at or before the selection's start,
/// round to the last.
pub fn previous_match(matches: &[Range<usize>], selection: &Range<usize>) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    matches
        .iter()
        .rposition(|found| found.end <= selection.start && found != selection)
        .or(Some(matches.len() - 1))
}

/// What Replace does: with the selection on a match, replace that one and go
/// on to the next; otherwise only select the first match from the
/// selection's start (round to the first), as a find would.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplaceStep {
    Replace(usize),
    Select(usize),
}

pub fn replace_step(matches: &[Range<usize>], selection: &Range<usize>) -> Option<ReplaceStep> {
    if matches.is_empty() {
        return None;
    }
    let next = matches
        .iter()
        .position(|found| found.start >= selection.start)
        .unwrap_or(0);
    Some(if matches[next] == *selection {
        ReplaceStep::Replace(next)
    } else {
        ReplaceStep::Select(next)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // "alpha alpha alpha"
    fn alphas() -> Vec<Range<usize>> {
        vec![0..5, 6..11, 12..17]
    }

    #[test]
    fn the_counter_reads_as_the_tauri_panel_does() {
        // search-panel.ts: the selection on the second of three is 2/3.
        assert_eq!(count_label(&alphas(), 6..11, 11), "2/3");
        // A caret before the second match counts that one.
        assert_eq!(count_label(&alphas(), 6..6, 6), "2/3");
        // Past the last match the last is current.
        assert_eq!(count_label(&alphas(), 17..17, 17), "3/3");
        assert_eq!(count_label(&[], 0..0, 0), "0/0");
    }

    #[test]
    fn steps_wrap_round_the_document() {
        let matches = alphas();
        assert_eq!(next_match(&matches, &(0..0)), Some(0));
        assert_eq!(next_match(&matches, &(0..5)), Some(1));
        assert_eq!(next_match(&matches, &(12..17)), Some(0));
        assert_eq!(previous_match(&matches, &(6..11)), Some(0));
        assert_eq!(previous_match(&matches, &(0..5)), Some(2));
        assert_eq!(previous_match(&matches, &(3..3)), Some(2));
        assert_eq!(next_match(&[], &(0..0)), None);
    }

    #[test]
    fn replace_takes_the_selected_match_or_selects_the_next() {
        let matches = alphas();
        assert_eq!(
            replace_step(&matches, &(6..11)),
            Some(ReplaceStep::Replace(1))
        );
        assert_eq!(
            replace_step(&matches, &(2..2)),
            Some(ReplaceStep::Select(1))
        );
        assert_eq!(
            replace_step(&matches, &(16..16)),
            Some(ReplaceStep::Select(0))
        );
    }

    #[test]
    fn a_short_selection_seeds_the_query_with_its_line_breaks_escaped() {
        assert_eq!(seed("alpha"), Some("alpha".into()));
        assert_eq!(seed("a\nb"), Some("a\\nb".into()));
        assert_eq!(seed(""), None);
        assert_eq!(seed(&"x".repeat(101)), None);
    }

    #[test]
    fn escapes_read_as_codemirror_reads_them() {
        assert_eq!(unquote(r"a\nb\tc\\d\e"), "a\nb\tc\\d\\e");
        assert_eq!(regex_replacement(r"[$&] $1 $$"), "[${0}] $1 $$");
    }
}
