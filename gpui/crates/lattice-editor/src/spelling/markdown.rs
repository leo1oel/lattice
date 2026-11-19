//! The prose a spell check reads out of a Markdown source: everything but
//! the writing is replaced with spaces, as [`crate::latex::prose`] does for
//! LaTeX, so every offset still matches the source. Masked are a front
//! matter block, fenced code, inline code, math (`$…$`, `$$…$$`), a link's or
//! an image's target, a reference definition's URL, autolinks and bare URLs,
//! e-mail addresses, and HTML tags and comments; a link's text and an
//! image's alt text stay prose.

use std::{ops::Range, sync::LazyLock};

use regex::Regex;

use crate::latex::prose::Masked;

/// `source`'s prose for the spell check, as long as the source in UTF-16
/// units.
pub fn mask(source: &str) -> Masked {
    static SPANS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
            r"\$\$[\s\S]*?\$\$",
            r"|``[^\n]*?``",
            r"|`[^`\n]*`",
            r"|\$[^$\n]+\$",
            r"|<!--[\s\S]*?-->",
            r"|</?[A-Za-z][^>\n]*>",
            r"|\]\([^)\n]*\)",
            r"|(?m:^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*)",
            r"|[A-Za-z][A-Za-z0-9+.-]*://[^\s)>\]]+",
            r"|[\w.+-]+@[\w-]+\.[\w.-]+",
        ))
        .unwrap()
    });
    let mut masked = fenced_code(source);
    // A link's target keeps its `]` as prose: the text before it is the
    // link's own words.
    masked.extend(SPANS.find_iter(source).map(|span| {
        let start = span.start() + usize::from(span.as_str().starts_with(']'));
        start..span.end()
    }));
    masked.sort_by_key(|range| range.start);

    let mut prose = String::with_capacity(source.len());
    let mut syntax = Vec::with_capacity(source.len());
    let mut spans = masked.iter().peekable();
    for (at, character) in source.char_indices() {
        while spans.next_if(|span| span.end <= at).is_some() {}
        let hidden =
            spans.peek().is_some_and(|span| span.start <= at) && !matches!(character, '\n' | '\r');
        for _ in 0..character.len_utf16() {
            syntax.push(hidden);
        }
        if hidden {
            prose.extend(std::iter::repeat_n(' ', character.len_utf16()));
        } else {
            prose.push(character);
        }
    }
    Masked { prose, syntax }
}

/// The front matter and every fenced code block, fences included, in bytes.
fn fenced_code(source: &str) -> Vec<Range<usize>> {
    let mut blocks = Vec::new();
    let mut open: Option<(usize, char, usize)> = None;
    let mut at = 0;
    for line in source.split_inclusive('\n') {
        let start = at;
        at += line.len();
        let body = line.trim_end_matches(['\n', '\r']);
        if start == 0 && body == "---" {
            open = Some((start, '-', 3));
            continue;
        }
        let fence = body.trim_start_matches(' ');
        let indent = body.len() - fence.len();
        let marker = fence.chars().next().filter(|&c| c == '`' || c == '~');
        let run = marker.map_or(0, |marker| {
            fence.chars().take_while(|&c| c == marker).count()
        });
        match open {
            Some((from, '-', _)) if body == "---" || body == "..." => {
                blocks.push(from..at);
                open = None;
            }
            Some((from, opened, length))
                if opened != '-'
                    && indent <= 3
                    && marker == Some(opened)
                    && run >= length
                    && fence[run..].trim().is_empty() =>
            {
                blocks.push(from..at);
                open = None;
            }
            None if indent <= 3 && run >= 3 => open = marker.map(|marker| (start, marker, run)),
            _ => {}
        }
    }
    if let Some((from, _, _)) = open {
        blocks.push(from..source.len());
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(source: &str) -> String {
        let masked = mask(source);
        let units = source.encode_utf16().count();
        assert_eq!(masked.prose.encode_utf16().count(), units);
        assert_eq!(masked.syntax.len(), units);
        masked.prose
    }

    #[test]
    fn code_math_targets_and_markup_are_masked() {
        let source = "---\ntitle: Dokument\n---\n# A headng\n\nSee [the docs](https://exmple.test/pth \"Ttle\") and `fn mian()`.\n\n```rust\nlet vlaue = 1;\n```\n\nMath $x_teh$ and $$\\fracc{a}{b}$$ stay. <span class=\"hlight\">Kept wrds</span> <!-- hiden --> mail nme@exmple.org or https://exmple.test.\n\n[ref]: https://exmple.test/rf\n";
        let prose = shown(source);
        for hidden in [
            "Dokument", "exmple", "Ttle", "mian", "vlaue", "teh", "fracc", "hlight", "hiden",
            "nme@", "rf\n",
        ] {
            assert!(!prose.contains(hidden), "{hidden} shows in {prose:?}");
        }
        for kept in ["# A headng", "See [the docs]", "Kept wrds", "Math", "stay."] {
            assert!(prose.contains(kept), "{kept} missing from {prose:?}");
        }
    }

    #[test]
    fn an_unclosed_fence_masks_to_the_end_and_lines_stay_lines() {
        let source = "Prose here.\n~~~~\ncode wrd\n~~~\nstill cod\n";
        let prose = shown(source);
        assert!(prose.starts_with("Prose here.\n"));
        assert!(!prose.contains("wrd") && !prose.contains("cod"));
        assert_eq!(prose.matches('\n').count(), source.matches('\n').count());
    }

    #[test]
    fn offsets_count_utf16_units() {
        let source = "中文 😀 `cöde` wrd";
        let masked = mask(source);
        let prose: Vec<u16> = masked.prose.encode_utf16().collect();
        let at = prose.len() - 3;
        assert_eq!(String::from_utf16_lossy(&prose[at..]), "wrd");
        assert!(!masked.prose.contains("cöde"));
    }
}
