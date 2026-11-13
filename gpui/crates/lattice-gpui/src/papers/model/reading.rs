//! What the inspector reads out of a saved paper and the manuscript: the
//! abstract of its full text, and a use's line from just before its
//! citation (`paper-inspector.tsx` `paperAbstract`, `citeContext`).

use std::sync::LazyLock;

use regex::Regex;

/// The abstract of a saved paper, read from the "Abstract" section of its
/// full text as paragraphs of plain text; `None` without one. ar5iv repeats
/// the heading as the first word of the text, so that word goes
/// (`paperAbstract`).
pub fn paper_abstract(markdown: &str) -> Option<Vec<String>> {
    static HEADING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?im)^#{1,4}[ \t]*\**Abstract\**[ \t.:]*$").unwrap());
    static NEXT_HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#{1,6}\s").unwrap());
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
    static LINK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap());
    static LEAD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^Abstract\b[\s.:—-]*").unwrap());
    let body = strip_frontmatter(markdown);
    let heading = HEADING.find(body)?;
    let rest = &body[heading.end()..];
    let rest = match NEXT_HEADING.find(rest) {
        Some(next) => &rest[..next.start()],
        None => rest,
    };
    let mut paragraphs: Vec<String> = Regex::new(r"\n\s*\n")
        .unwrap()
        .split(rest)
        .map(|paragraph| {
            let text = TAG.replace_all(paragraph, "");
            let text = LINK.replace_all(&text, "$1");
            text.replace("**", "")
                .replace("__", "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|paragraph| !paragraph.is_empty())
        .collect();
    if let Some(first) = paragraphs.first_mut() {
        *first = LEAD.replace(first, "").into_owned();
    }
    paragraphs.retain(|paragraph| !paragraph.is_empty());
    (!paragraphs.is_empty()).then_some(paragraphs)
}

fn strip_frontmatter(markdown: &str) -> &str {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return markdown;
    };
    match rest.find("\n---") {
        Some(end) => rest[end + 4..].trim_start_matches(['\r', '\n']),
        None => markdown,
    }
}

/// A use's line from just before its citation command, so the command is
/// in view however long the sentence before it runs (`citeContext`).
pub fn cite_context(snippet: &str, key: &str) -> String {
    let text = snippet.trim();
    let Some(at) = text.to_lowercase().find(&key.to_lowercase()) else {
        return text.to_string();
    };
    let anchor = text[..at].rfind('\\').unwrap_or(at);
    const LEAD: usize = 32;
    if anchor <= LEAD {
        return text.to_string();
    }
    let mut from = anchor - LEAD;
    while !text.is_char_boundary(from) {
        from -= 1;
    }
    let start = match text[from..].find(' ').map(|space| space + from) {
        Some(space) if space < anchor => space + 1,
        _ => from,
    };
    format!("…{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_abstract_is_its_section_without_the_repeated_heading() {
        let markdown = "---\ntitle: x\n---\n\n# Title\n\n## Abstract\n\nAbstract. We study **things**.\n\nSecond [part](http://x).\n\n## Introduction\n\nBody.\n";
        assert_eq!(
            paper_abstract(markdown),
            Some(vec![
                "We study things.".to_string(),
                "Second part.".to_string()
            ])
        );
        assert_eq!(paper_abstract("# Title\n\nNo abstract here.\n"), None);
    }

    #[test]
    fn a_use_reads_from_just_before_its_citation() {
        let snippet = "A very long sentence that runs on and on before we finally cite \\cite{knuth1984} here.";
        let context = cite_context(snippet, "knuth1984");
        assert!(context.starts_with('…'));
        assert!(context.contains("\\cite{knuth1984}"));
        assert_eq!(cite_context("Short \\cite{a}.", "a"), "Short \\cite{a}.");
    }
}
