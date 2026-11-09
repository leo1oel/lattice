//! A Zotero item as a BibTeX entry. Zotero's own BibTeX export runs inside
//! Zotero, so a copy of its database needs this instead: the item type picks
//! the entry type, Zotero's fields map onto BibTeX's, and an arXiv id becomes
//! `eprint`, which is what lets the import fetch the paper's text.

use std::collections::{HashMap, HashSet};

pub(super) struct Creator {
    /// Zotero's creator type: author, editor, …
    pub role: String,
    pub first: String,
    pub last: String,
    /// An institution or a one-field name, written as is.
    pub single_field: bool,
}

/// One item, as read from the database.
pub(super) struct Record<'a> {
    pub item_type: &'a str,
    pub fields: &'a HashMap<String, String>,
    pub creators: &'a [Creator],
}

/// A key a `\cite` can use.
pub(super) fn is_citation_key(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c.is_whitespace() || "{},%\"#'()=\\~".contains(c))
}

/// The value of the `name:` line in Extra (case aside), as Better BibTeX
/// pins a key (`Citation Key: …`) and Zotero records an arXiv id (`arXiv: …`).
pub(super) fn extra_value(extra: &str, name: &str) -> Option<String> {
    extra.lines().find_map(|line| {
        let (field, value) = line.split_once(':')?;
        (field.trim().eq_ignore_ascii_case(name) && !value.trim().is_empty())
            .then(|| value.trim().to_string())
    })
}

fn field<'a>(record: &'a Record, name: &str) -> Option<&'a str> {
    record.fields.get(name).map(|value| value.trim()).filter(|value| !value.is_empty())
}

/// The four-digit year at the start of Zotero's date (`2024-07-18 2024-07-18`,
/// `2019-06-00 June 2019`, or the date as typed).
fn year(record: &Record) -> Option<String> {
    let date = field(record, "date")?;
    let digits: String = date.chars().take(4).collect();
    if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_digit()) && digits != "0000" {
        return Some(digits);
    }
    date.split(|c: char| !c.is_ascii_digit()).find(|part| part.len() == 4).map(str::to_string)
}

/// The arXiv id the item names: its archive id, Extra's `arXiv:` line, an
/// arXiv DOI, or an arXiv URL.
fn arxiv_id(record: &Record) -> Option<String> {
    let from_text = |text: &str| crate::papers::explicit_arxiv_id(text);
    field(record, "archiveID")
        .and_then(|id| id.strip_prefix("arXiv:").map(str::trim).and_then(from_text))
        .or_else(|| {
            extra_value(field(record, "extra").unwrap_or(""), "arxiv").and_then(|id| from_text(&id))
        })
        .or_else(|| {
            let doi = field(record, "DOI")?.to_ascii_lowercase();
            doi.strip_prefix("10.48550/arxiv.").and_then(from_text)
        })
        .or_else(|| {
            field(record, "url").filter(|url| url.contains("arxiv.org/")).and_then(from_text)
        })
}

fn entry_type(record: &Record) -> &'static str {
    match record.item_type {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => "article",
        "conferencePaper" => "inproceedings",
        "book" => "book",
        "bookSection" | "encyclopediaArticle" | "dictionaryEntry" => "incollection",
        "thesis"
            if field(record, "thesisType")
                .is_some_and(|kind| kind.to_lowercase().contains("master")) =>
        {
            "mastersthesis"
        }
        "thesis" => "phdthesis",
        "report" => "techreport",
        "manuscript" => "unpublished",
        _ => "misc",
    }
}

/// A formatting tag of Zotero's rich text at the start of `text`, as
/// (name, the LaTeX that opens it or None for a closing tag, its length).
/// Zotero keeps title formatting as `<i>`, `<b>`, `<sub>`, `<sup>`, `<sc>`,
/// `<span class="nocase">` and `<span style="font-variant:small-caps;">`.
fn markup(text: &str) -> Option<(&str, Option<&'static str>, usize)> {
    let end = text.find('>')?;
    let inner = &text[1..end];
    let (closing, inner) = match inner.strip_prefix('/') {
        Some(name) => (true, name),
        None => (false, inner),
    };
    let (name, attributes) = inner.split_once(char::is_whitespace).unwrap_or((inner, ""));
    let latex = match name {
        "i" => "\\textit{",
        "b" => "\\textbf{",
        "sub" => "\\textsubscript{",
        "sup" => "\\textsuperscript{",
        "sc" => "\\textsc{",
        "span" if attributes.contains("small-caps") => "\\textsc{",
        "span" => "{",
        _ => return None,
    };
    Some((name, (!closing).then_some(latex), end + 1))
}

/// Text as BibTeX reads it: Zotero's formatting tags as their LaTeX commands
/// (a `nocase` span as braces, which keep its case), and the characters TeX
/// treats as commands escaped.
fn tex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut open: Vec<&str> = Vec::new();
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if c == '<' {
            if let Some((name, latex, length)) = markup(rest) {
                match latex {
                    Some(latex) => {
                        open.push(name);
                        out.push_str(latex);
                    }
                    None if open.last() == Some(&name) => {
                        open.pop();
                        out.push('}');
                    }
                    None => {}
                }
                rest = &rest[length..];
                continue;
            }
        }
        match c {
            '&' | '%' | '#' | '_' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '\\' => out.push_str("\\textbackslash{}"),
            '^' => out.push_str("\\^{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '{' | '}' => {}
            '\n' | '\r' => out.push(' '),
            _ => out.push(c),
        }
        rest = &rest[c.len_utf8()..];
    }
    out.extend(open.iter().map(|_| '}'));
    out
}

/// `text` with Zotero's formatting tags taken out.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        match (c == '<').then(|| markup(rest)).flatten() {
            Some((.., length)) => rest = &rest[length..],
            None => {
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out
}

fn names(record: &Record, role: &str) -> Option<String> {
    let names: Vec<String> = record
        .creators
        .iter()
        .filter(|creator| creator.role == role)
        .map(|creator| match (creator.single_field, creator.first.trim()) {
            (true, _) | (false, "") => format!("{{{}}}", tex(creator.last.trim())),
            (false, first) => format!("{}, {}", tex(creator.last.trim()), tex(first)),
        })
        .collect();
    (!names.is_empty()).then(|| names.join(" and "))
}

/// The entry for `record` under `key`.
pub(super) fn entry(record: &Record, key: &str) -> String {
    let kind = entry_type(record);
    let mut out: Vec<(&str, String)> = Vec::new();
    let mut push = |name: &'static str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            out.push((name, value));
        }
    };
    let text = |name: &str| field(record, name).map(tex);
    let raw = |name: &str| field(record, name).map(str::to_string);
    push("title", text("title"));
    push("author", names(record, "author"));
    push("editor", names(record, "editor"));
    let container = match kind {
        "article" => ("journal", text("publicationTitle")),
        "inproceedings" => {
            ("booktitle", text("proceedingsTitle").or_else(|| text("conferenceName")))
        }
        "incollection" => (
            "booktitle",
            text("bookTitle")
                .or_else(|| text("encyclopediaTitle"))
                .or_else(|| text("dictionaryTitle")),
        ),
        _ => ("", None),
    };
    if !container.0.is_empty() {
        push(container.0, container.1);
    }
    push("year", year(record));
    push("volume", text("volume"));
    push("number", text("issue").or_else(|| text("reportNumber")));
    push(
        "pages",
        field(record, "pages").map(|pages| {
            tex(&pages.replace(['–', '—'], "-").replace('-', "--").replace("----", "--"))
        }),
    );
    match kind {
        "phdthesis" | "mastersthesis" => {
            push("school", text("university").or_else(|| text("publisher")))
        }
        "techreport" => push("institution", text("institution").or_else(|| text("publisher"))),
        _ => push("publisher", text("publisher")),
    }
    push("address", text("place"));
    push("edition", text("edition"));
    push("series", text("series"));
    push("isbn", raw("ISBN"));
    push("issn", raw("ISSN"));
    push("doi", raw("DOI").filter(|doi| !doi.to_ascii_lowercase().starts_with("10.48550/arxiv.")));
    if let Some(id) = arxiv_id(record) {
        push("eprint", Some(id));
        push("archiveprefix", Some("arXiv".to_string()));
    }
    push("url", raw("url"));
    if kind == "misc" {
        push(
            "howpublished",
            text("websiteTitle").or_else(|| text("repository")).or_else(|| text("blogTitle")),
        );
    }
    let body: Vec<String> =
        out.iter().map(|(name, value)| format!("  {name} = {{{value}}}")).collect();
    format!("@{kind}{{{key},\n{}\n}}", body.join(",\n"))
}

/// Zotero's own export key shape, `lastname_firstword_year`, lower-case ASCII.
pub(super) fn generated_key(record: &Record) -> String {
    let ascii = |text: &str| -> String {
        text.chars()
            .filter_map(|c| {
                let plain = deunicode_char(c);
                plain.filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase())
            })
            .collect()
    };
    let creator = record
        .creators
        .iter()
        .find(|creator| creator.role == "author")
        .or_else(|| record.creators.first())
        .map(|creator| ascii(&creator.last))
        .unwrap_or_default();
    const SKIP: &[&str] =
        &["a", "an", "the", "of", "on", "in", "for", "and", "to", "with", "is", "are"];
    let word = field(record, "title")
        .and_then(|title| {
            plain(title)
                .split(|c: char| c.is_whitespace() || c == ':' || c == '-')
                .map(ascii)
                .find(|word| !word.is_empty() && !SKIP.contains(&word.as_str()))
        })
        .unwrap_or_default();
    let key = [creator, word, year(record).unwrap_or_default()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if key.is_empty() {
        "zotero".to_string()
    } else {
        key
    }
}

/// Latin letters with their marks taken off; anything else is dropped.
fn deunicode_char(c: char) -> Option<char> {
    if c.is_ascii() {
        return Some(c);
    }
    let base = match c {
        'à'..='å' | 'À'..='Å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'Ç' | 'ć' | 'č' => 'c',
        'è'..='ë' | 'È'..='Ë' | 'ē' | 'ę' | 'ě' => 'e',
        'ì'..='ï' | 'Ì'..='Ï' | 'ī' => 'i',
        'ñ' | 'Ñ' | 'ń' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'Ò'..='Ö' | 'Ø' | 'ō' | 'ő' => 'o',
        'ù'..='ü' | 'Ù'..='Ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' | 'Ý' => 'y',
        'š' | 'ś' | 'Š' => 's',
        'ž' | 'ź' | 'ż' | 'Ž' => 'z',
        'ł' | 'Ł' => 'l',
        'ß' => 's',
        _ => return None,
    };
    Some(base)
}

/// `key`, or `key` with the first free letter after it (b, c, …) when it is
/// already taken.
pub(super) fn unique_key(key: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(&key.to_lowercase()) {
        return key.to_string();
    }
    ('b'..='z')
        .map(|suffix| format!("{key}{suffix}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or_else(|| format!("{key}{}", taken.len()))
}
