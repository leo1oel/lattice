//! Zotero annotations in a paper's note (`zotero-annotations.ts`,
//! `paper-notes.ts`, `paper-source.ts`). Each highlight, underline, sticky
//! note or comment the writer made in Zotero's PDF reader becomes a quote or
//! a paragraph of `notes/<citation key>.md`, ending with two links: the page
//! in Lattice's own reader (a source link: the paper's PDF at the page, the
//! passage's first and last words as its title) and the annotation in
//! Zotero (`zotero://open-pdf/…`).
//!
//! Bringing them in again adds only the ones the note does not hold yet,
//! found by the annotation key in their Zotero link, so what the writer
//! edited or deleted in the note stays as they left it; nothing is written
//! back to Zotero.

use std::path::Path;

use lattice_core::{papers::PaperSummary, project as core_project, zotero::ZoteroAnnotation};

use crate::papers::model::pdf_url;

/// The words the note is written with, in the interface language: its
/// heading, and a page's name with `{page}` for the page.
#[derive(Clone)]
pub struct Labels {
    pub heading: String,
    pub page: String,
}

/// Between a quote's first and last words in a source link's title.
const QUOTE_ANCHOR_SEPARATOR: &str = " … ";

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

/// `notes/<citation key>.md`, or the library id for a paper the
/// bibliography does not key.
pub fn note_path(paper: &PaperSummary) -> String {
    let source = paper
        .citation_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .unwrap_or(&paper.arxiv_id);
    let mut name = String::new();
    let mut gap = false;
    for ch in source.chars() {
        if ch.is_alphanumeric() || "._-".contains(ch) {
            if gap {
                name.push('-');
                gap = false;
            }
            name.push(ch);
        } else {
            gap = true;
        }
    }
    if gap {
        name.push('-');
    }
    let name = name.trim_start_matches(['-', '.']).trim_end_matches('-');
    format!("notes/{}.md", if name.is_empty() { "paper" } else { name })
}

/// The paper's reading file, from a note at `note` (relative, so any tool
/// resolves it).
fn paper_link_href(note: &str, paper: &PaperSummary) -> String {
    let depth = note
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1);
    let file = if paper.has_full_text { "paper" } else { "blog" };
    format!(
        "{}.research/papers/{}/{file}.md",
        "../".repeat(depth),
        paper.arxiv_id
    )
}

/// The note after adding `entry`: appended after a blank line, or, for a
/// note not yet written, below the paper's title linking to the paper.
fn with_entry(current: Option<&str>, paper: &PaperSummary, entry: &str) -> String {
    let Some(current) = current else {
        let title = markdown_text(if paper.title.trim().is_empty() {
            &paper.arxiv_id
        } else {
            paper.title.trim()
        });
        let href = paper_link_href(&note_path(paper), paper);
        return format!("# {title}\n\n[{title}]({href})\n\n{entry}\n");
    };
    let kept = current.trim_end();
    if kept.is_empty() {
        format!("{entry}\n")
    } else {
        format!("{kept}\n\n{entry}\n")
    }
}

/// The annotation in Zotero's PDF reader: its PDF, at its page, with it
/// selected.
fn zotero_href(annotation: &ZoteroAnnotation) -> String {
    let page = annotation
        .page
        .map(|page| format!("page={page}&"))
        .unwrap_or_default();
    format!(
        "zotero://open-pdf/library/items/{}?{page}annotation={}",
        annotation.attachment, annotation.key
    )
}

/// The paper's own PDF at `page`: the one its bundle keeps, from the
/// project root, else the one on the web.
fn source_href(paper: &PaperSummary, page: u32) -> Option<String> {
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

/// The first and last words that name a quote: four of each (ten
/// characters of unspaced text), else the whole quote.
fn quote_anchors(quote: &str) -> Option<(String, String)> {
    let words: Vec<&str> = quote.split_whitespace().collect();
    let unspaced = words.len() < 4 && quote.chars().count() > 24;
    let (units, joiner, count): (Vec<String>, &str, usize) = if unspaced {
        let collapsed = words.join(" ");
        (collapsed.chars().map(String::from).collect(), "", 10)
    } else {
        (words.iter().map(|word| word.to_string()).collect(), " ", 4)
    };
    if units.is_empty() {
        return None;
    }
    let take = if count * 2 < units.len() {
        count
    } else {
        units.len()
    };
    Some((
        units[..take].join(joiner),
        units[units.len() - take..].join(joiner),
    ))
}

/// A source link as Markdown: `label` to `href`, the quote's anchors as its
/// title.
fn source_link(label: &str, href: &str, anchors: &(String, String)) -> String {
    let title = format!("{}{QUOTE_ANCHOR_SEPARATOR}{}", anchors.0, anchors.1)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let destination = if href.contains(|ch: char| ch.is_whitespace() || "()<>".contains(ch)) {
        format!("<{}>", href.replace('<', "%3C").replace('>', "%3E"))
    } else {
        href.to_string()
    };
    format!("[{}]({destination} \"{title}\")", markdown_text(label))
}

/// A leading `#`, `-`, `+` or `1.` would make a heading or list item.
fn escape_line_start(line: &str) -> String {
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
/// ending with its source link.
fn quote_markdown(quote: &str, link: &str) -> String {
    let text = markdown_text(&quote.split_whitespace().collect::<Vec<_>>().join(" "));
    format!("> {} {link}", escape_line_start(&text))
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let decoded = after.find(';').filter(|end| *end <= 10).and_then(|end| {
            let name = &after[..end];
            let ch = match name.to_ascii_lowercase().as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => {
                    let code = if let Some(hex) =
                        name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        name.strip_prefix('#').and_then(|dec| dec.parse().ok())
                    };
                    code.filter(|code| *code > 0).and_then(char::from_u32)
                }
            };
            ch.map(|ch| (ch, end))
        });
        match decoded {
            Some((ch, end)) => {
                out.push(ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A Zotero comment as Markdown: its words escaped, its bold and italic
/// kept, a blank line between its paragraphs (`zoteroCommentMarkdown`).
pub fn comment_markdown(comment: &str) -> String {
    // Only a tag's shape is a tag: `p<0.05` and `<p2>` are words.
    static TAG: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)</?[a-z]+(?:\s[^<>]*)?/?>").unwrap());
    let mut out = String::new();
    let mut rest = comment;
    while let Some(found) = TAG.find(rest) {
        out.push_str(&markdown_text(&decode_entities(&rest[..found.start()])));
        let tag = &rest[found.start() + 1..found.end() - 1];
        rest = &rest[found.end()..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphabetic)
            .collect::<String>()
            .to_ascii_lowercase();
        match name.as_str() {
            "b" | "strong" => out.push_str("**"),
            "i" | "em" => out.push('*'),
            "br" => out.push('\n'),
            "p" | "div" if closing => out.push('\n'),
            "sub" | "sup" | "span" | "p" | "div" => {}
            // Not one of Zotero's tags: its text, as written.
            _ => out.push_str(&markdown_text(&decode_entities(&format!("<{tag}>")))),
        }
    }
    out.push_str(&markdown_text(&decode_entities(rest)));
    let lines: Vec<String> = out
        .split('\n')
        .map(|line| escape_line_start(line.trim()))
        .collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
}

/// One annotation as the note writes it: a passage as a quote, a comment
/// as a paragraph, the links after them.
fn annotation_markdown(
    paper: &PaperSummary,
    annotation: &ZoteroAnnotation,
    labels: &Labels,
) -> String {
    let page_name = annotation
        .page_label
        .clone()
        .filter(|label| !label.is_empty())
        .or_else(|| annotation.page.map(|page| page.to_string()))
        .unwrap_or_default();
    let label = if page_name.is_empty() {
        String::new()
    } else {
        labels.page.replace("{page}", &page_name)
    };
    let href = annotation.page.and_then(|page| source_href(paper, page));
    let anchors = (!annotation.text.is_empty())
        .then(|| quote_anchors(&annotation.text))
        .flatten();
    let reader = match (&href, label.is_empty(), &anchors) {
        (Some(href), false, Some(anchors)) => source_link(&label, href, anchors),
        (Some(href), false, None) => format!("[{}]({href})", markdown_text(&label)),
        _ => markdown_text(&label),
    };
    let links = [reader, format!("[Zotero]({})", zotero_href(annotation))]
        .into_iter()
        .filter(|link| !link.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let comment = comment_markdown(&annotation.comment);
    if !annotation.text.is_empty() {
        let quote = quote_markdown(&annotation.text, &links);
        return if comment.is_empty() {
            quote
        } else {
            format!("{quote}\n\n{comment}")
        };
    }
    if comment.is_empty() {
        links
    } else {
        format!("{comment} {links}")
    }
}

/// Whether `note` holds the annotation `key`: its Zotero link names it.
fn holds(note: &str, key: &str) -> bool {
    let needle = format!("annotation={key}");
    note.match_indices(&needle).any(|(at, _)| {
        let before = note[..at].chars().next_back();
        let after = note[at + needle.len()..].chars().next();
        matches!(before, Some('?' | '&'))
            && !after.is_some_and(|ch| ch.is_alphanumeric() || ch == '_' || ch == '%')
    })
}

/// The note with the annotations it does not hold yet added at its end,
/// below a heading the first time any come in; and how many were added.
pub fn with_annotations(
    current: Option<&str>,
    paper: &PaperSummary,
    annotations: &[ZoteroAnnotation],
    labels: &Labels,
) -> (String, usize) {
    let note = current.unwrap_or("");
    let mut seen = std::collections::HashSet::new();
    let fresh: Vec<&ZoteroAnnotation> = annotations
        .iter()
        .filter(|annotation| !holds(note, &annotation.key) && seen.insert(annotation.key.clone()))
        .collect();
    if fresh.is_empty() {
        return (note.to_string(), 0);
    }
    let entries = fresh
        .iter()
        .map(|annotation| annotation_markdown(paper, annotation, labels))
        .collect::<Vec<_>>()
        .join("\n\n");
    let first = !note.to_lowercase().contains("(zotero://open-pdf/");
    let entry = if first {
        format!("## {}\n\n{entries}", markdown_text(&labels.heading))
    } else {
        entries
    };
    (with_entry(current, paper, &entry), fresh.len())
}

/// Add `annotations` to the paper's note in the project at `root`; a note
/// that holds them all is left alone. The note's path and how many were
/// added.
pub fn add_annotations(
    root: &Path,
    paper: &PaperSummary,
    annotations: &[ZoteroAnnotation],
    labels: &Labels,
) -> Result<(String, usize), String> {
    let path = note_path(paper);
    let current = root
        .join(&path)
        .is_file()
        .then(|| core_project::read_file(root, &path))
        .transpose()?;
    let (content, added) = with_annotations(current.as_deref(), paper, annotations, labels);
    if added > 0 {
        // The text read is the base: an edit that lands meanwhile is merged.
        core_project::apply_editor_transaction(root, path.clone(), content, current, None)?;
    }
    Ok((path, added))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    fn annotation(key: &str, text: &str, comment: &str, page: Option<u32>) -> ZoteroAnnotation {
        ZoteroAnnotation {
            key: key.into(),
            attachment: "ATTACH01".into(),
            kind: "highlight",
            text: text.into(),
            comment: comment.into(),
            page,
            page_label: None,
            color: None,
        }
    }

    fn labels() -> Labels {
        Labels {
            heading: "Zotero annotations".into(),
            page: "p. {page}".into(),
        }
    }

    #[test]
    fn a_note_is_named_by_the_key_and_starts_with_the_paper() {
        let attention = with(paper("Attention Is All You Need"), |p| {
            p.arxiv_id = "1706.03762".into();
            p.citation_key = Some("vaswani 2017".into());
            p.has_full_text = true;
        });
        assert_eq!(note_path(&attention), "notes/vaswani-2017.md");
        let (note, added) = with_annotations(
            None,
            &attention,
            &[annotation(
                "ANNOT001",
                "We propose a new simple network architecture, the Transformer",
                "<b>Key</b> idea",
                Some(2),
            )],
            &labels(),
        );
        assert_eq!(added, 1);
        assert_eq!(
            note,
            "# Attention Is All You Need\n\n[Attention Is All You Need](../.research/papers/1706.03762/paper.md)\n\n## Zotero annotations\n\n> We propose a new simple network architecture, the Transformer [p. 2](https://arxiv.org/pdf/1706.03762#page=2 \"We propose a new … network architecture, the Transformer\") · [Zotero](zotero://open-pdf/library/items/ATTACH01?page=2&annotation=ANNOT001)\n\n**Key** idea\n"
        );
        // Brought in again, nothing is added twice.
        let (again, added) = with_annotations(
            Some(&note),
            &attention,
            &[
                annotation("ANNOT001", "x", "", Some(2)),
                annotation("ANNOT002", "", "Later", None),
            ],
            &labels(),
        );
        assert_eq!(added, 1);
        assert!(again.ends_with(
            "Later [Zotero](zotero://open-pdf/library/items/ATTACH01?annotation=ANNOT002)\n"
        ));
        assert_eq!(again.matches("## Zotero annotations").count(), 1);
    }

    #[test]
    fn a_comment_keeps_its_emphasis_and_escapes_the_rest() {
        assert_eq!(
            comment_markdown("<p>Costs $5 &amp; <i>more</i></p><p># not a heading</p>"),
            "Costs \\$5 & *more*\n\\# not a heading"
        );
        let bold = comment_markdown("p<0.05, <b>significant</b>");
        assert!(bold.ends_with(", **significant**"), "{bold}");
        assert_eq!(comment_markdown("<p2>x"), "\\<p2\\>x");
        assert_eq!(
            comment_markdown("<x title=\"a &amp;amp; b\">"),
            "\\<x title=\"a &amp; b\"\\>"
        );
    }
}
