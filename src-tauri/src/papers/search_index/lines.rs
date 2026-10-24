//! What the index reads from a paper's Markdown, and what a hit shows of it.
//!
//! Each body line is indexed as the reader sees it: Markdown syntax is
//! dropped, so highlights fall on words and a snippet does not open with
//! `## ` or a link target. The frontmatter (the title is indexed on its own),
//! the converter's table of contents (its entries repeat every heading and
//! link to the contents, not the section) and image lines are skipped.

use regex::Regex;
use std::sync::LazyLock;

/// The longest snippet a hit shows, in characters, before ellipses.
const SNIPPET_CHARS: usize = 200;
/// How much of the line before the first highlight a long snippet keeps.
const SNIPPET_LEAD_CHARS: usize = 48;

static TOC_ENTRY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[-*+]\s+\[[^\]]*\]\(#[^)]*\)\s*$").unwrap());
static IMAGE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$").unwrap());
static BLOCK_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap());
static EMPHASIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*|__|`").unwrap());
static ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\([\\`*_{}\[\]()#+.!|-])").unwrap());

/// Every line worth searching, as `(1-based line number, display text)`.
pub(super) fn searchable_lines(content: &str) -> Vec<(u32, String)> {
    let mut lines = content.lines().enumerate().peekable();
    if lines.peek().is_some_and(|(_, line)| line.trim_end() == "---") {
        lines.next();
        for (_, line) in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
        }
    }
    lines
        .filter(|(_, line)| !TOC_ENTRY.is_match(line) && !IMAGE_LINE.is_match(line))
        .map(|(index, line)| (index as u32 + 1, display_text(line)))
        .filter(|(_, text)| !text.is_empty())
        .collect()
}

fn display_text(line: &str) -> String {
    let text = BLOCK_PREFIX.replace(line, "");
    let text = LINK.replace_all(&text, "$1");
    let text = EMPHASIS.replace_all(&text, "");
    ESCAPE.replace_all(&text, "$1").trim().to_string()
}

/// A window of `text` around its first highlight, with each highlight's
/// range in UTF-16 code units of the window (what a JavaScript string
/// indexes). `highlights` are sorted, disjoint byte ranges into `text`.
pub(super) fn snippet(text: &str, highlights: &[(usize, usize)]) -> (String, Vec<[u32; 2]>) {
    let char_count = text.chars().count();
    let first = highlights.first().map_or(0, |(from, _)| text[..*from].chars().count());
    let (mut start, mut end) = (0, char_count);
    if char_count > SNIPPET_CHARS {
        start = first.saturating_sub(SNIPPET_LEAD_CHARS).min(char_count - SNIPPET_CHARS);
        end = start + SNIPPET_CHARS;
    }
    let byte_of = |chars: usize| text.char_indices().nth(chars).map_or(text.len(), |(at, _)| at);
    let (from, to) = (byte_of(start), byte_of(end));
    let mut window = String::new();
    if start > 0 {
        window.push('…');
    }
    let lead = window.len();
    window.push_str(text[from..to].trim_end());
    let window_end = from + window.len() - lead;
    if end < char_count {
        window.push('…');
    }
    let utf16 = |byte: usize| window[..byte].encode_utf16().count() as u32;
    let ranges = highlights
        .iter()
        .filter(|(start, stop)| *stop > from && *start < window_end)
        .map(|(start, stop)| {
            let start = lead + start.max(&from) - from;
            let stop = lead + stop.min(&window_end) - from;
            [utf16(start), utf16(stop)]
        })
        .collect();
    (window, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_body_lines_as_read_and_skips_frontmatter_contents_and_images() {
        let markdown = "---\ntitle: \"A paper\"\n---\n\n## Contents\n\n- [1 Intro](#1-intro)\n  - [1.1 Setup](#1-1-setup)\n\n## 1 Intro\n\nWe use **scaled** `dot` products, see [the code](https://x.y) \\#3.\n\n![Figure 1](paper_assets/fig1.png)\n> A quote\n";
        assert_eq!(
            searchable_lines(markdown),
            [
                (5, "Contents".to_string()),
                (10, "1 Intro".to_string()),
                (12, "We use scaled dot products, see the code #3.".to_string()),
                (15, "A quote".to_string()),
            ]
        );
    }

    #[test]
    fn snippets_keep_highlights_in_utf16_units_around_the_first_match() {
        assert_eq!(snippet("短 short", &[(4, 9)]), ("短 short".to_string(), vec![[2, 7]]));
        let long = format!("{}needle{}", "x ".repeat(150), " y".repeat(150));
        let at = long.find("needle").unwrap();
        let (window, ranges) = snippet(&long, &[(at, at + 6)]);
        assert!(window.starts_with('…') && window.ends_with('…'), "{window}");
        assert_eq!(window.chars().count(), SNIPPET_CHARS + 2);
        let [from, to] = ranges[0];
        let units: Vec<u16> = window.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[from as usize..to as usize]).unwrap(), "needle");
    }
}
