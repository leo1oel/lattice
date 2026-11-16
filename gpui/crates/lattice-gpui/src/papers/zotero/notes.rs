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

use lattice_core::{papers::PaperSummary, zotero::ZoteroAnnotation};

use crate::papers::{
    paper_note::{update_note, with_entry},
    source_link::{
        escape_line_start, markdown_text, quote_markdown, source_href, source_link,
        source_quote_anchors,
    },
};

/// The words the note is written with, in the interface language: its
/// heading, and a page's name with `{page}` for the page.
#[derive(Clone)]
pub struct Labels {
    pub heading: String,
    pub page: String,
}

/// The annotation in Zotero's PDF reader: its PDF, at its page, with it
/// selected.
fn zotero_href(annotation: &ZoteroAnnotation) -> String {
    let page = page_of(annotation)
        .map(|page| format!("page={page}&"))
        .unwrap_or_default();
    format!(
        "zotero://open-pdf/library/items/{}?{page}annotation={}",
        annotation.attachment, annotation.key
    )
}

/// The annotation's page; Zotero's 0 names none.
fn page_of(annotation: &ZoteroAnnotation) -> Option<u32> {
    annotation.page.filter(|page| *page > 0)
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
        .or_else(|| page_of(annotation).map(|page| page.to_string()))
        .unwrap_or_default();
    let label = if page_name.is_empty() {
        String::new()
    } else {
        labels.page.replace("{page}", &page_name)
    };
    let href = page_of(annotation).and_then(|page| source_href(paper, page));
    let anchors = (!annotation.text.is_empty())
        // Zotero's page text is not at hand: the shortest pair names it.
        .then(|| source_quote_anchors(&annotation.text, |_, _| true))
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
    let mut added = 0;
    let path = update_note(root, paper, |current| {
        let (content, fresh) = with_annotations(current, paper, annotations, labels);
        added = fresh;
        (fresh > 0).then_some(content)
    })?;
    Ok((path, added))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};
    use crate::papers::paper_note::note_path;

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
        // `paperNotePath`'s rule: only letters, digits and `._-` stay, so a
        // combining vowel sign (a mark, not a letter) is a gap too.
        let marked = with(paper("x"), |p| {
            p.citation_key = Some("\u{915}\u{93f}2020".into())
        });
        assert_eq!(note_path(&marked), "notes/\u{915}-2020.md");
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
        // Page 0 is no page, as in the Tauri app.
        let (unpaged, _) = with_annotations(
            None,
            &attention,
            &[annotation("ANNOT003", "Quoted", "", Some(0))],
            &labels(),
        );
        assert!(
            unpaged.ends_with(
                "> Quoted [Zotero](zotero://open-pdf/library/items/ATTACH01?annotation=ANNOT003)\n"
            ),
            "{unpaged}"
        );
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
