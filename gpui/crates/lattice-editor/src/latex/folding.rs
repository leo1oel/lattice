//! What a line of LaTeX folds, as the Tauri app's fold service scans it
//! (`src/editor/latex/latex-language.ts`, `latexFoldRange`): an environment
//! between its `\begin` and `\end`, a heading's section to the line before the
//! next heading at its level or above, the preamble from `\documentclass` to
//! the line before `\begin{document}`, a brace group left open on the line to
//! its closing brace, and a run of two or more comment lines.
//!
//! The scan reads lines only, so the source gutter can ask it about every
//! line it shows. Forward scans give up after a set number of lines, as the
//! app's do, so a long file stays cheap; brace groups, scanned a character at
//! a time, get fewer.
//!
//! Positions are (row, byte column) pairs: a fold hides from its `start` to
//! its `end`, and the gutter shows a marker on the line it starts on.

use std::sync::LazyLock;

use regex::Regex;

/// How far a scan reads past its line.
const MAX_FOLD_SCAN_LINES: u32 = 20_000;
const MAX_GROUP_SCAN_LINES: u32 = 1_000;

/// `\begin{name}` and `\end{name}`.
static ENVIRONMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(begin|end)\s*\{([^{}]+)\}").expect("valid pattern"));

/// The lines a scan reads: the buffer, or a list of lines in tests.
pub trait Lines {
    /// How many lines there are.
    fn count(&self) -> u32;
    /// Line `row`'s text, without its line break.
    fn line(&self, row: u32) -> std::borrow::Cow<'_, str>;
}

impl Lines for [&str] {
    fn count(&self) -> u32 {
        self.len() as u32
    }

    fn line(&self, row: u32) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed(self.get(row as usize).copied().unwrap_or(""))
    }
}

impl Lines for language::BufferSnapshot {
    fn count(&self) -> u32 {
        self.max_point().row + 1
    }

    fn line(&self, row: u32) -> std::borrow::Cow<'_, str> {
        let len = self.line_len(row);
        std::borrow::Cow::Owned(
            self.text_for_range(language::Point::new(row, 0)..language::Point::new(row, len))
                .collect(),
        )
    }
}

pub use crate::folds::FoldRange;

/// The LaTeX fold source, for the adapter's gutter.
pub fn source() -> crate::folds::FoldSource {
    std::rc::Rc::new(|text: &language::BufferSnapshot, row| fold_range(text, row))
}

/// What line `row` folds, if anything.
pub fn fold_range(lines: &(impl Lines + ?Sized), row: u32) -> Option<FoldRange> {
    if row >= lines.count() {
        return None;
    }
    let raw = lines.line(row);
    let text = uncommented(&raw);
    (if text.contains("\\begin") {
        environment_fold(lines, row, &raw, text)
    } else {
        None
    })
    .or_else(|| {
        if text.contains('\\') {
            section_fold(lines, row, &raw, text).or_else(|| preamble_fold(lines, row, &raw, text))
        } else {
            None
        }
    })
    .or_else(|| {
        if text.contains('{') {
            group_fold(lines, row, text)
        } else {
            None
        }
    })
    .or_else(|| comment_fold(lines, row, &raw))
}

/// `text` without its `%` comment (an escaped `\%` is text).
pub fn uncommented(text: &str) -> &str {
    let bytes = text.as_bytes();
    for (index, _) in text.match_indices('%') {
        let backslashes = bytes[..index]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        if backslashes % 2 == 0 {
            return &text[..index];
        }
    }
    text
}

fn line_end(row: u32, raw: &str) -> (u32, u32) {
    (row, raw.len() as u32)
}

/// The rows after `row`, up to the scan limit.
fn rows_after(
    lines: &(impl Lines + ?Sized),
    row: u32,
    limit: u32,
) -> std::ops::RangeInclusive<u32> {
    let last = (lines.count().saturating_sub(1)).min(row.saturating_add(limit));
    row + 1..=last
}

/// The last non-blank row from `start` back to (but excluding) `floor`.
fn last_content_row(lines: &(impl Lines + ?Sized), start: u32, floor: u32) -> u32 {
    let mut row = start;
    while row > floor + 1 && lines.line(row).trim().is_empty() {
        row -= 1;
    }
    row
}

/// `\begin{name}` on this line whose `\end{name}` is on a later line: fold
/// between them.
fn environment_fold(
    lines: &(impl Lines + ?Sized),
    row: u32,
    raw: &str,
    text: &str,
) -> Option<FoldRange> {
    let mut opened: Vec<&str> = Vec::new();
    for captures in ENVIRONMENT.captures_iter(text) {
        let name = captures.get(2).map_or("", |name| name.as_str());
        if &captures[1] == "begin" {
            opened.push(name);
        } else if opened.last() == Some(&name) {
            opened.pop();
        }
    }
    let name = *opened.first()?;
    let mut depth = opened.iter().filter(|open| **open == name).count() as i64;
    for next in rows_after(lines, row, MAX_FOLD_SCAN_LINES) {
        let line = lines.line(next);
        if !line.contains("\\begin") && !line.contains("\\end") {
            continue;
        }
        for captures in ENVIRONMENT.captures_iter(uncommented(&line)) {
            if &captures[2] != name {
                continue;
            }
            depth += if &captures[1] == "begin" { 1 } else { -1 };
            if depth == 0 {
                let at = captures.get(0).map_or(0, |whole| whole.start());
                return Some(FoldRange {
                    start: line_end(row, raw),
                    end: (next, at as u32),
                });
            }
        }
    }
    None
}

/// The sectioning commands, by depth (`SECTION_LEVELS`).
fn section_level(name: &str) -> Option<u8> {
    Some(match name {
        "part" => 0,
        "chapter" => 1,
        "section" => 2,
        "subsection" => 3,
        "subsubsection" => 4,
        "paragraph" => 5,
        "subparagraph" => 6,
        _ => return None,
    })
}

/// The command a line opens with (after its indentation), and what follows
/// its name: `\section*{…}` is `("section", "*{…}")`. A name runs over
/// letters and `@`, so `\sectionmark` is not `\section`.
fn leading_command(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim_start().strip_prefix('\\')?;
    let end = rest
        .find(|c: char| !(c.is_ascii_alphabetic() || c == '@'))
        .unwrap_or(rest.len());
    Some((&rest[..end], &rest[end..]))
}

/// A heading's level (`SECTION`).
fn heading_level(text: &str) -> Option<u8> {
    leading_command(text).and_then(|(name, _)| section_level(name))
}

/// Where a section's body stops even without a following heading
/// (`SECTION_STOP`).
fn stops_section(text: &str) -> bool {
    if text.trim_start().starts_with("\\end{document}") {
        return true;
    }
    leading_command(text)
        .is_some_and(|(name, _)| matches!(name, "appendix" | "bibliography" | "printbibliography"))
}

/// A heading folds to the line before the next heading at its level or above.
fn section_fold(
    lines: &(impl Lines + ?Sized),
    row: u32,
    raw: &str,
    text: &str,
) -> Option<FoldRange> {
    let level = heading_level(text)?;
    let mut end = row;
    for next in rows_after(lines, row, MAX_FOLD_SCAN_LINES) {
        let line = lines.line(next);
        if !line.contains('\\') {
            end = next;
            continue;
        }
        if heading_level(&line).is_some_and(|heading| heading <= level) || stops_section(&line) {
            break;
        }
        end = next;
    }
    let end = last_content_row(lines, end, row);
    (end > row).then(|| FoldRange {
        start: line_end(row, raw),
        end: line_end(end, &lines.line(end)),
    })
}

/// The preamble folds from `\documentclass` to the line before
/// `\begin{document}`.
fn preamble_fold(
    lines: &(impl Lines + ?Sized),
    row: u32,
    raw: &str,
    text: &str,
) -> Option<FoldRange> {
    if leading_command(text).is_none_or(|(name, _)| name != "documentclass") {
        return None;
    }
    let mut end = row;
    for next in rows_after(lines, row, MAX_FOLD_SCAN_LINES) {
        let line = lines.line(next);
        if begins_document(&line) {
            let end = last_content_row(lines, end, row);
            return (end > row).then(|| FoldRange {
                start: line_end(row, raw),
                end: line_end(end, &lines.line(end)),
            });
        }
        end = next;
    }
    None
}

/// `^\s*\\begin\s*\{document\}`.
fn begins_document(text: &str) -> bool {
    text.trim_start()
        .strip_prefix("\\begin")
        .map(str::trim_start)
        .is_some_and(|rest| rest.starts_with("{document}"))
}

/// A brace group left open on this line folds to its closing brace.
fn group_fold(lines: &(impl Lines + ?Sized), row: u32, text: &str) -> Option<FoldRange> {
    let mut open: Vec<usize> = Vec::new();
    let mut chars = text.char_indices();
    while let Some((index, character)) = chars.next() {
        match character {
            '\\' => {
                chars.next();
            }
            '{' => open.push(index),
            '}' => {
                open.pop();
            }
            _ => {}
        }
    }
    let first = *open.first()?;
    let mut depth = open.len();
    for next in rows_after(lines, row, MAX_GROUP_SCAN_LINES) {
        let line = lines.line(next);
        let next_text = uncommented(&line);
        let mut chars = next_text.char_indices();
        while let Some((index, character)) = chars.next() {
            match character {
                '\\' => {
                    chars.next();
                }
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        // The first brace still open on the starting line
                        // closes here.
                        return Some(FoldRange {
                            start: (row, first as u32 + 1),
                            end: (next, index as u32),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn is_comment_line(text: &str) -> bool {
    text.trim_start().starts_with('%')
}

/// A run of two or more comment lines folds to the end of its last line.
fn comment_fold(lines: &(impl Lines + ?Sized), row: u32, raw: &str) -> Option<FoldRange> {
    if !is_comment_line(raw) || (row > 0 && is_comment_line(&lines.line(row - 1))) {
        return None;
    }
    let mut end = row;
    for next in rows_after(lines, row, MAX_FOLD_SCAN_LINES) {
        if !is_comment_line(&lines.line(next)) {
            break;
        }
        end = next;
    }
    (end > row).then(|| FoldRange {
        start: line_end(row, raw),
        end: line_end(end, &lines.line(end)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(lines: &[&str], row: u32) -> Option<((u32, u32), (u32, u32))> {
        fold_range(lines, row).map(|range| (range.start, range.end))
    }

    #[test]
    fn an_environment_folds_between_its_begin_and_its_end() {
        let lines = [
            r"\begin{itemize} % list",
            r"  \item a",
            r"  \begin{itemize}\item nested\end{itemize}",
            r"  % \end{itemize} in a comment",
            r"\end{itemize}",
        ];
        assert_eq!(fold(&lines, 0), Some(((0, 22), (4, 0))));
        // Opened and closed on one line: nothing to fold.
        assert_eq!(fold(&lines, 2), None);
    }

    #[test]
    fn a_heading_folds_to_the_next_heading_at_its_level_or_above() {
        let lines = [
            r"\section{One}",
            "Text.",
            r"\subsection{Inner}",
            "More.",
            "",
            r"\section*{Two}",
            "Last.",
            r"\end{document}",
        ];
        assert_eq!(fold(&lines, 0), Some(((0, 13), (3, 5))));
        assert_eq!(fold(&lines, 2), Some(((2, 18), (3, 5))));
        assert_eq!(fold(&lines, 5), Some(((5, 14), (6, 5))));
        // A command whose name only starts with a heading's is not one.
        assert_eq!(fold(&[r"\sectionmark{x}", "a"], 0), None);
    }

    #[test]
    fn the_preamble_folds_to_the_line_before_the_document() {
        let lines = [
            r"\documentclass{article}",
            r"\usepackage{amsmath}",
            "",
            r"\begin{document}",
            "Hello.",
            r"\end{document}",
        ];
        assert_eq!(fold(&lines, 0), Some(((0, 23), (1, 20))));
        // The document environment itself folds too.
        assert_eq!(fold(&lines, 3), Some(((3, 16), (5, 0))));
    }

    #[test]
    fn an_open_brace_group_folds_to_its_closing_brace() {
        let lines = [r"\newcommand{\x}{%", r"  \textbf{y} \{", "}"];
        assert_eq!(fold(&lines, 0), Some(((0, 16), (2, 0))));
        assert_eq!(fold(&[r"\{ escaped", "}"], 0), None);
    }

    #[test]
    fn a_run_of_comment_lines_folds_from_its_first_line() {
        let lines = ["% one", "  % two", "% three", "text"];
        assert_eq!(fold(&lines, 0), Some(((0, 5), (2, 7))));
        assert_eq!(fold(&lines, 1), None, "only the run's first line");
        assert_eq!(fold(&["% alone", "text"], 0), None);
    }

    #[test]
    fn an_escaped_percent_is_text() {
        assert_eq!(uncommented(r"50\% done % note"), r"50\% done ");
        assert_eq!(uncommented(r"a\\% comment"), r"a\\");
    }
}
