//! Placing text selected on the compiled PDF in its LaTeX source, as the
//! Tauri app's `pdf-source-anchor.ts` does: SyncTeX names the line a point on
//! the page came from, and the selected text is looked for around it. The
//! PDF's text is the source after TeX read it, and a selection reads it back
//! imperfectly (words joined across line breaks, ligatures, hyphenation, a
//! word cut at either end), so both sides are compared as their letters and
//! digits alone, and only the selection's two ends need to be found.

use std::ops::Range;

use super::annotation_place::fold_letters;

/// Lines either side of SyncTeX's line to look in: it may name a
/// paragraph's first line, or a later one.
const LINES_BEFORE: usize = 8;
const LINES_AFTER: usize = 16;
/// How many letters from each end of the selection must match.
const END_LENGTH: usize = 24;

/// The source's prose letters in `window`, folded, each with the bytes of
/// the source character it came from: command names (`\section`) and `%`
/// comments are not prose.
fn prose_letters(source: &str, window: Range<usize>) -> (Vec<char>, Vec<Range<usize>>) {
    let mut letters = Vec::new();
    let mut spans = Vec::new();
    let text = &source[window.clone()];
    let mut chars = text.char_indices().peekable();
    while let Some((at, ch)) = chars.next() {
        if ch == '\\' {
            while chars
                .peek()
                .is_some_and(|(_, next)| next.is_ascii_alphabetic() || *next == '@')
            {
                chars.next();
            }
        } else if ch == '%' && !source[..window.start + at].ends_with('\\') {
            while chars.peek().is_some_and(|(_, next)| *next != '\n') {
                chars.next();
            }
        } else {
            let start = window.start + at;
            for letter in fold_letters(ch).chars() {
                letters.push(letter);
                spans.push(start..start + ch.len_utf8());
            }
        }
    }
    (letters, spans)
}

fn find(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| haystack[at..at + needle.len()] == *needle)
}

/// `range` widened to whole words, so a selection cut mid-word quotes the
/// word.
fn whole_words(source: &str, range: Range<usize>) -> Range<usize> {
    let from = source[..range.start]
        .char_indices()
        .rev()
        .take_while(|(_, ch)| ch.is_alphanumeric())
        .last()
        .map_or(range.start, |(at, _)| at);
    let to = range.end
        + source[range.end..]
            .chars()
            .take_while(|ch| ch.is_alphanumeric())
            .map(char::len_utf8)
            .sum::<usize>();
    from..to
}

/// The bytes of `source` the PDF text `text` came from, looked for around
/// the 1-based `line` SyncTeX gave: from where the selection's first letters
/// are to where its last ones are, nearest that line. When they cannot be
/// found (a formula, a figure's label), the text of `line` itself. `None`
/// when `line` is outside the file or holds nothing.
pub fn source_range_for_pdf_text(source: &str, line: usize, text: &str) -> Option<Range<usize>> {
    let starts: Vec<usize> = std::iter::once(0)
        .chain(source.match_indices('\n').map(|(at, _)| at + 1))
        .collect();
    if line < 1 || line > starts.len() {
        return None;
    }
    let line_start = starts[line - 1];
    let line_end = starts.get(line).map_or(source.len(), |next| next - 1);
    let window_start = starts[line.saturating_sub(1 + LINES_BEFORE)];
    let window_end = starts
        .get(line + LINES_AFTER)
        .map_or(source.len(), |next| next - 1);
    let (letters, spans) = prose_letters(source, window_start..window_end);
    let wanted: Vec<char> = text
        .chars()
        .flat_map(|ch| fold_letters(ch).chars().collect::<Vec<_>>())
        .collect();
    if !wanted.is_empty() {
        let head = &wanted[..wanted.len().min(END_LENGTH)];
        let tail = &wanted[wanted.len().saturating_sub(END_LENGTH)..];
        let mut best: Option<(Range<usize>, usize)> = None;
        let mut from = 0;
        while let Some(start) = find(&letters, head, from) {
            from = start + 1;
            let Some(end) = find(&letters, tail, start) else {
                continue;
            };
            let range = spans[start].start..spans[end + tail.len() - 1].end;
            let distance = range.start.abs_diff(line_start);
            if range.end > range.start && best.as_ref().is_none_or(|(_, best)| distance < *best) {
                best = Some((range, distance));
            }
        }
        if let Some((range, _)) = best {
            return Some(whole_words(source, range));
        }
    }
    let line_text = &source[line_start..line_end];
    let from = line_start + line_text.len() - line_text.trim_start().len();
    let to = line_start + line_text.trim_end().len();
    (to > from).then_some(from..to)
}

#[cfg(test)]
mod tests;
