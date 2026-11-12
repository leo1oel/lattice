//! Where citations, references and maths sit in LaTeX source: the
//! completion slot before the caret, the key under the pointer, the math
//! region around a position. Ported from the Tauri app's
//! `src/editor/latex/latex-symbols.ts`, `latex-completions.ts` (`keyEnd`),
//! `latex-text.ts` (`bibliographyEntryLine`) and `math-region.ts`, which
//! its tests pin; the tests below repeat their cases.

use std::{ops::Range, sync::LazyLock};

use regex::Regex;

const CITATION_COMMANDS: &str =
    "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const REFERENCE_COMMANDS: &str = "ref|eqref|pageref|autoref|cref|Cref";

static OPEN_CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\\(?:{CITATION_COMMANDS})\*?(?:\[[^\]]*\]){{0,2}}\{{([^}}]*)$"
    ))
    .expect("the citation slot pattern compiles")
});
static OPEN_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"\\(?:{REFERENCE_COMMANDS})\*?\{{([^}}]*)$"))
        .expect("the reference slot pattern compiles")
});
static CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\\(?:{CITATION_COMMANDS})\*?(?:\[[^\]]*\]){{0,2}}\{{([^}}]*)\}}"
    ))
    .expect("the citation pattern compiles")
});
static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"\\(?:{REFERENCE_COMMANDS})\*?\{{([^}}]*)\}}"))
        .expect("the reference pattern compiles")
});
static NOTE_PAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^\s*(?:(?:pp?|pg|pages?)\.?(?:\s|~|\\[ ,])*)?(\d+)(?:\s*(?:-{1,3}|–|—)\s*\d+)?\s*$",
    )
    .expect("the note page pattern compiles")
});
static OPTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]*)\]").expect("the option pattern compiles"));

/// A key in an argument list, in byte offsets of the text it was found in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeySpan {
    pub range: Range<usize>,
    pub key: String,
}

/// A citation key under a position, with the page its note names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitationTarget {
    pub key: KeySpan,
    pub page: Option<u32>,
}

/// A slot being typed: where its key starts and what is typed of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub from: usize,
    pub query: String,
}

struct Argument {
    start: usize,
    end: usize,
    /// Where the final braced argument's content starts.
    from: usize,
    content: String,
}

fn arguments_of(text: &str, pattern: &Regex, offset: usize) -> Vec<Argument> {
    pattern
        .captures_iter(text)
        .filter_map(|captures| {
            let whole = captures.get(0)?;
            let content = captures.get(1)?;
            Some(Argument {
                start: offset + whole.start(),
                end: offset + whole.end(),
                from: offset + content.start(),
                content: content.as_str().to_string(),
            })
        })
        .collect()
}

/// The trimmed, non-empty comma-separated keys of an argument starting at `from`.
fn key_spans(content: &str, from: usize) -> Vec<KeySpan> {
    let mut spans = Vec::new();
    let mut start = 0;
    for piece in content.split(',') {
        let trimmed_start = piece.len() - piece.trim_start().len();
        let key = piece.trim();
        if !key.is_empty() {
            let at = from + start + trimmed_start;
            spans.push(KeySpan {
                range: at..at + key.len(),
                key: key.to_string(),
            });
        }
        start += piece.len() + 1;
    }
    spans
}

fn completion_slot(pattern: &Regex, before: &str, cursor: usize, last_key: bool) -> Option<Slot> {
    let content = pattern.captures(before)?.get(1)?.as_str();
    let query = if last_key {
        let after_comma = content.rfind(',').map_or(content, |at| &content[at + 1..]);
        after_comma.trim_start()
    } else {
        content
    };
    Some(Slot {
        from: cursor - query.len(),
        query: query.to_string(),
    })
}

/// The citation key being typed before `cursor` (`before` ends there).
pub fn citation_slot(before: &str, cursor: usize) -> Option<Slot> {
    completion_slot(&OPEN_CITATION, before, cursor, true)
}

/// The label being typed in a `\ref`-like command before `cursor`.
pub fn reference_slot(before: &str, cursor: usize) -> Option<Slot> {
    completion_slot(&OPEN_REFERENCE, before, cursor, true)
}

/// Where the key under the caret ends, when the rest of the argument is a
/// key list that closes: keys separated by commas, with whitespace, line
/// breaks and `%` comments between them, then `}`. Anything else means the
/// `{` was left open before prose, so nothing after the caret is replaced
/// (`keyEnd`). `after` is the text from the caret on; the answer is how much
/// of it the key covers.
pub fn key_end(after: &str) -> usize {
    #[derive(PartialEq)]
    enum State {
        CursorKey,
        AfterComma,
        LaterKey,
        AwaitingSeparator,
    }
    let key_character = |c: char| !matches!(c, ',' | '{' | '}' | '%') && !c.is_whitespace();
    let mut end = 0;
    let mut state = State::CursorKey;
    let mut in_comment = false;
    for character in after.chars() {
        if in_comment {
            in_comment = character != '\n';
            continue;
        }
        if key_character(character) {
            match state {
                State::AwaitingSeparator => return 0,
                State::CursorKey => end += character.len_utf8(),
                _ => state = State::LaterKey,
            }
            continue;
        }
        if character == '}' {
            return end;
        }
        if matches!(state, State::CursorKey | State::LaterKey) {
            state = State::AwaitingSeparator;
        }
        if character == ',' {
            state = State::AfterComma;
        } else if character == '%' {
            in_comment = true;
        } else if !character.is_whitespace() {
            return 0;
        }
    }
    0
}

/// The comma-separated key under `position` in a citation or reference
/// command, and that command's argument.
fn key_at(text: &str, pattern: &Regex, position: usize) -> Option<(KeySpan, Argument)> {
    let start = floor_boundary(text, position.saturating_sub(800));
    let end = floor_boundary(text, (position + 800).min(text.len()));
    arguments_of(&text[start..end], pattern, start)
        .into_iter()
        .filter(|argument| position >= argument.start && position <= argument.end)
        .find_map(|argument| {
            let hovered = key_spans(&argument.content, argument.from)
                .into_iter()
                .find(|key| position >= key.range.start && position <= key.range.end)?;
            Some((hovered, argument))
        })
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// The page a citation's note names: `p.~5`, `p. 5`, `pp.~5--7` (its first
/// page), `page 5`, or a bare `5`.
pub fn citation_note_page(note: &str) -> Option<u32> {
    let page: u32 = NOTE_PAGE.captures(note)?.get(1)?.as_str().parse().ok()?;
    (page >= 1).then_some(page)
}

/// The citation key under `position`, with the page its note names. The
/// note is the last optional argument.
pub fn citation_target(text: &str, position: usize) -> Option<CitationTarget> {
    let (key, argument) = key_at(text, &CITATION, position)?;
    let options = &text[argument.start..argument.from.saturating_sub(1)];
    let page = OPTION
        .captures_iter(options)
        .last()
        .and_then(|captures| citation_note_page(captures.get(1)?.as_str()));
    Some(CitationTarget { key, page })
}

/// The label under `position` in a `\ref`-like command.
pub fn reference_target(text: &str, position: usize) -> Option<KeySpan> {
    key_at(text, &REFERENCE, position).map(|(key, _)| key)
}

/// The 1-based line of `key`'s entry in a bibliography source.
pub fn bibliography_entry_line(source: &str, key: &str) -> Option<u32> {
    let pattern = Regex::new(&format!(
        r"(?i)@[A-Za-z]+\s*\{{\s*{}\s*,",
        regex::escape(key)
    ))
    .ok()?;
    let found = pattern.find(source)?;
    Some(source[..found.start()].matches('\n').count() as u32 + 1)
}

/// Math delimiters in search order: `$$` before `$`, every other form
/// before a bare `$`.
const DELIMITERS: &[(&str, &str)] = &[
    ("$$", "$$"),
    ("\\[", "\\]"),
    ("\\(", "\\)"),
    ("\\begin{equation}", "\\end{equation}"),
    ("\\begin{equation*}", "\\end{equation*}"),
    ("\\begin{align}", "\\end{align}"),
    ("\\begin{align*}", "\\end{align*}"),
    ("\\begin{gather}", "\\end{gather}"),
    ("\\begin{gather*}", "\\end{gather*}"),
    ("\\begin{multline}", "\\end{multline}"),
    ("\\begin{multline*}", "\\end{multline*}"),
    ("$", "$"),
];

fn is_blank(line: &str) -> bool {
    line.chars().all(|c| matches!(c, ' ' | '\t' | '\r'))
}

/// The paragraph around `position`: the lines between the nearest blank
/// lines. TeX refuses a blank line inside math, so no region crosses one.
fn paragraph_around(text: &str, position: usize) -> Range<usize> {
    let line_start = |at: usize| text[..at].rfind('\n').map_or(0, |n| n + 1);
    let line_end = |at: usize| text[at..].find('\n').map_or(text.len(), |n| at + n);
    let mut from = line_start(position);
    let mut to = line_end(position);
    if is_blank(&text[from..to]) {
        return from..to;
    }
    while from > 0 {
        let previous = line_start(from - 1);
        if is_blank(&text[previous..from - 1]) {
            break;
        }
        from = previous;
    }
    while to < text.len() {
        let next = line_end(to + 1);
        if is_blank(&text[to + 1..next]) {
            break;
        }
        to = next;
    }
    from..to
}

fn find_delimited(
    text: &str,
    position: usize,
    (open, close): (&str, &str),
) -> Option<Range<usize>> {
    let mut start = text.find(open)?;
    while start <= position {
        let end = start + open.len() + text[start + open.len()..].find(close)?;
        if position <= end + close.len() {
            return Some(start..end + close.len());
        }
        start = end + close.len() + text[end + close.len()..].find(open)?;
    }
    None
}

/// The math region `position` is in, if any (`mathRegionAt`).
pub fn math_region_at(text: &str, position: usize) -> Option<Range<usize>> {
    let position = floor_boundary(text, position.min(text.len()));
    let paragraph = paragraph_around(text, position);
    let inner = &text[paragraph.clone()];
    DELIMITERS.iter().find_map(|delimiter| {
        let region = find_delimited(inner, position - paragraph.start, *delimiter)?;
        Some(region.start + paragraph.start..region.end + paragraph.start)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn citation_slots_complete_the_last_key() {
        let before = r"See \citep[p.~2]{vaswani2017, dev";
        let slot = citation_slot(before, before.len()).expect("a slot");
        assert_eq!(slot.query, "dev");
        assert_eq!(slot.from, before.len() - 3);
        assert_eq!(citation_slot(r"\cite{a}", 8), None);
        assert!(citation_slot(r"\textbf{a", 9).is_none());
        let empty = citation_slot(r"\cite{", 6).expect("an empty slot");
        assert_eq!(
            empty,
            Slot {
                from: 6,
                query: String::new()
            }
        );
        assert!(reference_slot(r"\eqref{eq:", 10).is_some());
    }

    #[test]
    fn key_end_stops_at_prose_after_an_open_brace() {
        assert_eq!(key_end("ani2017}"), 7);
        assert_eq!(key_end("ani2017, other}"), 7);
        assert_eq!(key_end("ani2017 % note\n, b}"), 7);
        // `{` left open before prose: nothing after the caret is replaced.
        assert_eq!(key_end("ani2017 is great"), 0);
        assert_eq!(key_end(""), 0);
    }

    #[test]
    fn hover_targets_find_the_key_under_the_pointer() {
        let text = r"As \citet[p.~5]{vaswani2017, devlin2019} show in \cref{fig:model}.";
        let at = text.find("devlin").unwrap() + 2;
        let target = citation_target(text, at).expect("a citation");
        assert_eq!(target.key.key, "devlin2019");
        assert_eq!(&text[target.key.range.clone()], "devlin2019");
        assert_eq!(target.page, Some(5));
        let first = citation_target(text, text.find("vaswani").unwrap()).unwrap();
        assert_eq!(first.key.key, "vaswani2017");
        let reference = reference_target(text, text.find("fig:").unwrap() + 3).unwrap();
        assert_eq!(reference.key, "fig:model");
        assert_eq!(citation_target(text, 1), None);
        assert_eq!(reference_target(text, text.find("devlin").unwrap()), None);
    }

    #[test]
    fn note_pages_read_as_biblatex_does() {
        assert_eq!(citation_note_page("p.~5"), Some(5));
        assert_eq!(citation_note_page("pp. 5--7"), Some(5));
        assert_eq!(citation_note_page("12"), Some(12));
        assert_eq!(citation_note_page("Theorem 2"), None);
        assert_eq!(citation_note_page("0"), None);
    }

    #[test]
    fn entry_lines_are_one_based() {
        let source = "% refs\n@article{other,\n}\n@InProceedings{ Vaswani2017 ,\n title={x}}\n";
        assert_eq!(bibliography_entry_line(source, "vaswani2017"), Some(4));
        assert_eq!(bibliography_entry_line(source, "other"), Some(2));
        assert_eq!(bibliography_entry_line(source, "missing"), None);
    }

    #[test]
    fn math_regions_stay_in_their_paragraph() {
        let text = "Text $a+b$ more.\n\\begin{equation}\nx^2\n\\end{equation}\n\nAfter $ lone.";
        assert!(math_region_at(text, text.find("a+b").unwrap() + 1).is_some());
        assert!(math_region_at(text, text.find("x^2").unwrap()).is_some());
        assert!(math_region_at(text, text.find("more").unwrap()).is_none());
        // An unpaired `$` past a blank line opens nothing.
        assert!(math_region_at(text, text.find("lone").unwrap()).is_none());
    }
}
