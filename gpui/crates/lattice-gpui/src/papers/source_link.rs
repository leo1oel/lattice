//! Source links into a paper's own PDF, as the Tauri app writes them
//! (`paper-source.ts`): the PDF at a page, the quote's first and last words
//! in the link's title so following it highlights the passage, and how a
//! quote is found again in a page's text (`source-quote.ts`), which is what
//! decides which words name it.
//!
//! The alphaXiv overview writes its links this way; the reader's Copy
//! source link and Add to note, and Zotero's annotations in a note, follow
//! it, so every kind opens the same way.

use std::ops::Range;

use lattice_core::papers::PaperSummary;
use unicode_normalization::UnicodeNormalization as _;

use crate::papers::model::pdf_url;

/// Between a quote's first and last words in a source link's title.
const QUOTE_ANCHOR_SEPARATOR: &str = " … ";

/// A passage's place in the paper's PDF: its 1-based page, and the first
/// and last words that find it there (`PaperSourceCitation`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourcePlace {
    pub page: u32,
    pub first: String,
    pub last: String,
}

/// Backslash-escape what Markdown would read as syntax in link text, a
/// heading or a quote (`markdownLinkText`).
pub fn markdown_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if "\\`*_~$[]<>".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The paper's own PDF at `page` (`paperSourceHref`): the one its bundle
/// keeps, from the project root so the link reads the same from any note,
/// else the one on the web; `None` when it has neither.
pub fn source_href(paper: &PaperSummary, page: u32) -> Option<String> {
    if paper.has_local_pdf {
        return Some(format!(
            "/.research/papers/{}/original.pdf#page={page}",
            paper.arxiv_id
        ));
    }
    let url = pdf_url(paper)?;
    let base = url.split('#').next().unwrap_or(&url);
    Some(format!("{base}#page={page}"))
}

/// The first and last words that name `quote` (`sourceQuoteAnchors`): the
/// fewest, from four words (ten characters of unspaced text, such as
/// Chinese), for which `unique` says the pair finds exactly this passage,
/// else the whole quote as both. `None` for an empty quote.
pub fn source_quote_anchors(
    quote: &str,
    unique: impl Fn(&str, &str) -> bool,
) -> Option<(String, String)> {
    let words: Vec<&str> = quote.split_whitespace().collect();
    // Two or three long "words" are unspaced text, where a word is a whole
    // clause.
    let unspaced = words.len() < 4 && quote.chars().count() > 24;
    let (units, joiner, steps): (Vec<String>, &str, [usize; 4]) = if unspaced {
        let collapsed = words.join(" ");
        (
            collapsed.chars().map(String::from).collect(),
            "",
            [10, 16, 24, 40],
        )
    } else {
        (
            words.iter().map(|word| word.to_string()).collect(),
            " ",
            [4, 6, 9, 14],
        )
    };
    if units.is_empty() {
        return None;
    }
    let pair = |count: usize| {
        (
            units[..count].join(joiner),
            units[units.len().saturating_sub(count)..].join(joiner),
        )
    };
    for count in steps {
        if count * 2 >= units.len() {
            break;
        }
        let anchors = pair(count);
        if unique(&anchors.0, &anchors.1) {
            return Some(anchors);
        }
    }
    // The whole quote as both anchors: `find_source_quote` lets them overlap.
    Some(pair(units.len()))
}

/// The anchors that find `quote` in `text` (one page's) and nothing else
/// there (`quoteAnchorsIn`); `None` when even the whole quote is not found
/// once.
pub fn quote_anchors_in(text: &str, quote: &str) -> Option<(String, String)> {
    let unique = |first: &str, last: &str| find_source_quote(text, first, last).is_some();
    source_quote_anchors(quote, unique).filter(|(first, last)| unique(first, last))
}

/// A source link as Markdown: `label` to `href`, the quote's anchors as its
/// title (what `paperSourceCitation` reads back).
pub fn source_link(label: &str, href: &str, anchors: &(String, String)) -> String {
    let title = format!("{}{QUOTE_ANCHOR_SEPARATOR}{}", anchors.0, anchors.1)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    // A destination with spaces or parentheses needs CommonMark's angle
    // brackets.
    let destination = if href.contains(|ch: char| ch.is_whitespace() || "()<>".contains(ch)) {
        format!("<{}>", href.replace('<', "%3C").replace('>', "%3E"))
    } else {
        href.to_string()
    };
    format!("[{}]({destination} \"{title}\")", markdown_text(label))
}

/// A leading `#`, `-`, `+` or `1.` would make a heading or list item.
pub fn escape_line_start(line: &str) -> String {
    if line.starts_with(['#', '+', '-']) {
        return format!("\\{line}");
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if (1..=9).contains(&digits) && line[digits..].starts_with(['.', ')']) {
        return format!("{}\\{}", &line[..digits], &line[digits..]);
    }
    line.to_string()
}

/// A quote for a note: one line, its syntax escaped, as a block quote
/// ending with its source link (`sourceQuoteMarkdown`).
pub fn quote_markdown(quote: &str, link: &str) -> String {
    let text = markdown_text(&quote.split_whitespace().collect::<Vec<_>>().join(" "));
    format!("> {} {link}", escape_line_start(&text))
}

/// `value` with its whitespace collapsed to single spaces, compatibility
/// forms folded (NFKC: a ligature is its letters) and a hyphen ending a
/// line joined to the word it breaks; each byte of the result knows the
/// bytes of `value` it came from (`normalizeWithOffsets`).
struct Normalized {
    text: String,
    starts: Vec<usize>,
    ends: Vec<usize>,
}

fn normalize(value: &str) -> Normalized {
    let mut out = Normalized {
        text: String::new(),
        starts: Vec::new(),
        ends: Vec::new(),
    };
    let mut offset = 0;
    while let Some(ch) = value[offset..].chars().next() {
        let next = offset + ch.len_utf8();
        // A hyphen just before an actual line end is layout, not prose; an
        // ordinary hyphen and space is the author's.
        if ch == '-' {
            let rest = &value[next..];
            let spaces = rest.len() - rest.trim_start_matches(['\t', ' ', '\x0c', '\x0b']).len();
            let after = &rest[spaces..];
            let broken = after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'));
            if let Some(after) = broken {
                offset = value.len() - after.trim_start().len();
                continue;
            }
        }
        if ch.is_whitespace() {
            let end = value.len() - value[next..].trim_start().len();
            if !out.text.is_empty() && !out.text.ends_with(' ') {
                out.text.push(' ');
                out.starts.push(offset);
                out.ends.push(end);
            }
            offset = end;
            continue;
        }
        for folded in std::iter::once(ch).nfkc() {
            for _ in 0..folded.len_utf8() {
                out.starts.push(offset);
                out.ends.push(next);
            }
            out.text.push(folded);
        }
        offset = next;
    }
    if out.text.ends_with(' ') {
        out.text.pop();
        out.starts.pop();
        out.ends.pop();
    }
    out
}

/// Every place `needle` starts in `haystack` at or after `from`.
fn occurrences<'a>(
    haystack: &'a str,
    needle: &'a str,
    from: usize,
) -> impl Iterator<Item = usize> + 'a {
    let mut at = Some(from);
    std::iter::from_fn(move || {
        let start = at?;
        let found = haystack
            .get(start..)?
            .find(needle)
            .map(|index| start + index);
        // The next search starts one character on.
        at = found.and_then(|found| {
            haystack[found..]
                .chars()
                .next()
                .map(|ch| found + ch.len_utf8())
        });
        found
    })
}

/// The one range of `text` running from `first` to `last`, after
/// normalizing whitespace, compatibility forms and line-end hyphenation
/// (`findSourceQuote`): `None` when either is empty or missing, or the pair
/// finds more than one passage. The two may overlap; the range is in bytes
/// of `text`.
pub fn find_source_quote(text: &str, first: &str, last: &str) -> Option<Range<usize>> {
    let haystack = normalize(text);
    let first = normalize(first).text;
    let last = normalize(last).text;
    if first.is_empty() || last.is_empty() || haystack.text.is_empty() {
        return None;
    }
    let mut found: Option<Range<usize>> = None;
    for first_at in occurrences(&haystack.text, &first, 0) {
        for last_at in occurrences(&haystack.text, &last, first_at) {
            let end = (first_at + first.len()).max(last_at + last.len());
            let range = haystack.starts[first_at]..haystack.ends[end - 1];
            match &found {
                Some(seen) if *seen != range => return None,
                _ => found = Some(range),
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTE: &str = "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms";

    // `pdf-quote-page.test.ts`: the page that holds it, across the PDF's
    // line breaks and hyphenation.
    #[test]
    fn a_quote_is_found_across_line_breaks_and_hyphenation() {
        let page = "The dominant sequence transduction models are complex. We propose a new\nsimple network architecture, the Trans-\nformer, based solely on attention mechanisms, dispensing\nwith recurrence.\n";
        assert_eq!(
            quote_anchors_in(page, QUOTE),
            Some((
                "We propose a new".into(),
                "solely on attention mechanisms".into()
            ))
        );
        assert_eq!(quote_anchors_in("Something else entirely", QUOTE), None);
    }

    // The anchors grow until they find only this passage on its page.
    #[test]
    fn the_anchors_grow_until_they_name_one_passage() {
        let page = "We propose a new loss. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.";
        let (first, _) = quote_anchors_in(page, QUOTE).unwrap();
        assert_ne!(first, "We propose a new");
        assert!(page.find(&first).unwrap() > 0);
    }

    // `source-quote.test.ts`'s rules: ligatures fold, an ambiguous pair
    // finds nothing, the range addresses the original text.
    #[test]
    fn a_quote_range_addresses_the_original_text() {
        let text = "An e\u{FB03}cient   model.";
        let range = find_source_quote(text, "efficient model", "model.").unwrap();
        assert_eq!(&text[range], "e\u{FB03}cient   model.");
        assert_eq!(find_source_quote("a b a b", "a", "b"), None);
        assert_eq!(find_source_quote("text", "", "text"), None);
    }

    // Without a uniqueness test the shortest pair names a quote; unspaced
    // text is named by characters.
    #[test]
    fn short_quotes_are_named_whole_and_unspaced_ones_by_characters() {
        assert_eq!(
            source_quote_anchors("one two three", |_, _| true),
            Some(("one two three".into(), "one two three".into()))
        );
        let chinese = "我们提出了一种新的简单网络架构完全基于注意力机制摒弃了循环和卷积";
        let (first, last) = source_quote_anchors(chinese, |_, _| true).unwrap();
        assert_eq!(first.chars().count(), 10);
        assert!(chinese.ends_with(&last));
        assert_eq!(source_quote_anchors("  ", |_, _| true), None);
    }

    // `paper-selection-actions.test.tsx`'s copied link, from the PDF at
    // page 3 with the anchors the PDF found.
    #[test]
    fn a_source_link_names_the_page_and_the_quote() {
        let mut paper = crate::papers::model::test_support::paper("Attention");
        paper.arxiv_id = "1706.03762".into();
        let href = source_href(&paper, 3).unwrap();
        assert_eq!(
            source_link(
                "p. 3",
                &href,
                &(
                    "We propose a new".into(),
                    "solely on attention mechanisms".into()
                )
            ),
            "[p. 3](https://arxiv.org/pdf/1706.03762#page=3 \"We propose a new … solely on attention mechanisms\")"
        );
        paper.has_local_pdf = true;
        assert_eq!(
            source_href(&paper, 2).as_deref(),
            Some("/.research/papers/1706.03762/original.pdf#page=2")
        );
        assert_eq!(
            quote_markdown("# a *b*", "[l](u)"),
            "> \\# a \\*b\\* [l](u)"
        );
    }
}
