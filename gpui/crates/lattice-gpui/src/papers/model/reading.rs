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

/// Where a Markdown file's front matter ends (`markdownFrontmatterEnd`):
/// a `---` or `+++` block at its very start (after a byte-order mark, its
/// lines ending in CRLF or not, possibly empty); 0 without one.
fn frontmatter_end(markdown: &str) -> usize {
    let start = if markdown.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    };
    let Some(first_break) = markdown[start..].find('\n').map(|at| at + start) else {
        return 0;
    };
    let delimiter = markdown[start..first_break].trim_end_matches('\r').trim();
    if delimiter != "---" && delimiter != "+++" {
        return 0;
    }
    let mut line_start = first_break + 1;
    while line_start <= markdown.len() {
        let line_break = markdown[line_start..].find('\n').map(|at| at + line_start);
        let line_end = line_break.unwrap_or(markdown.len());
        let line = markdown[line_start..line_end].trim_end_matches('\r').trim();
        if line == delimiter || (delimiter == "---" && line == "...") {
            return line_break.map_or(line_end, |at| at + 1);
        }
        let Some(at) = line_break else {
            break;
        };
        line_start = at + 1;
    }
    0
}

/// The text after a Markdown file's front matter, which is the converter's
/// bookkeeping, not text (`stripFrontmatter`).
pub fn strip_frontmatter(markdown: &str) -> &str {
    match frontmatter_end(markdown) {
        0 => markdown,
        end => markdown[end..].trim_start_matches(['\r', '\n']),
    }
}

/// Whether a link may be handed to the system: a web page or a mail
/// address, never a `file://` or other scheme the system would open or
/// launch. Links come from shared bibliographies, a paper's text and remote
/// records (Crossref, OpenAlex), so every one Papers opens is checked.
pub fn openable_link(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// Open `url` in the browser when it is `openable_link`; any other is
/// ignored. Every link Papers opens goes through here.
pub fn open_link(url: &str, cx: &mut gpui::App) {
    if openable_link(url) {
        cx.open_url(url);
    }
}

/// A use's line from just before its citation command, so the command is
/// in view however long the sentence before it runs (`citeContext`).
pub fn cite_context(snippet: &str, key: &str) -> String {
    let text = snippet.trim();
    // ASCII case only: a full lowercase can change a character's length
    // (İ grows a byte), and the offset is read back in the original.
    let Some(at) = text.to_ascii_lowercase().find(&key.to_ascii_lowercase()) else {
        return text.to_string();
    };
    let anchor = text[..at].rfind('\\').unwrap_or(at);
    // Characters, not bytes: a sentence in Chinese leads with as many.
    const LEAD: usize = 32;
    let Some((from, _)) = text[..anchor].char_indices().rev().nth(LEAD) else {
        return text.to_string();
    };
    let from = from + text[from..].chars().next().map_or(0, char::len_utf8);
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
    fn front_matter_goes_however_it_is_written() {
        assert_eq!(strip_frontmatter("---\ntitle: x\n---\n\nBody"), "Body");
        assert_eq!(strip_frontmatter("---\r\ntitle: x\r\n---\r\nBody"), "Body");
        assert_eq!(
            strip_frontmatter("\u{feff}---\ntitle: x\n---\nBody"),
            "Body"
        );
        assert_eq!(strip_frontmatter("---\n---\nBody"), "Body");
        assert_eq!(strip_frontmatter("+++\na = 1\n+++\nBody"), "Body");
        assert_eq!(strip_frontmatter("Body\n---\nmore"), "Body\n---\nmore");
        assert_eq!(strip_frontmatter("---\nnever closed"), "---\nnever closed");
    }

    #[test]
    fn a_use_leads_with_32_characters_in_any_script() {
        let lead = "很".repeat(40);
        let context = cite_context(&format!("{lead}\\cite{{a}}"), "a");
        assert_eq!(context, format!("…{}\\cite{{a}}", "很".repeat(32)));
        let short = format!("{}\\cite{{a}}", "很".repeat(32));
        assert_eq!(cite_context(&short, "a"), short);
    }

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(openable_link("https://arxiv.org/abs/1706.03762"));
        assert!(openable_link("HTTP://example.com"));
        assert!(openable_link("mailto:a@b.c"));
        assert!(!openable_link("file:///System/Applications/Calculator.app"));
        assert!(!openable_link("smb://server/share"));
        assert!(!openable_link("#section-2"));
    }

    #[test]
    fn a_use_reads_from_just_before_its_citation() {
        let snippet = "A very long sentence that runs on and on before we finally cite \\cite{knuth1984} here.";
        let context = cite_context(snippet, "knuth1984");
        assert!(context.starts_with('…'));
        assert!(context.contains("\\cite{knuth1984}"));
        assert_eq!(cite_context("Short \\cite{a}.", "a"), "Short \\cite{a}.");
        let wide = "İİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİ and then \\cite{a} é";
        // `citeContext` worked by hand: the command stands 48 characters in,
        // the lead starts at the 17th, and the first space after it cuts
        // the word it lands in.
        assert_eq!(cite_context(wide, "A"), "…and then \\cite{a} é");
    }
}
