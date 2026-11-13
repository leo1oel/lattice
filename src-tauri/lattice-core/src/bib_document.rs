//! A .bib file as a visual bibliography editor reads and edits it: every
//! entry, field and `@string` macro with the exact source span it came from.
//! This is the Tauri app's `src/papers/bib-document.ts`, for the native app.
//!
//! Edits are splices into those spans, never a reserialization, so whatever
//! an edit does not touch (the writer's indentation and alignment, `%`
//! comments, text between entries, `@preamble`, `@comment`, other entries)
//! stays byte for byte as written. Braces are counted the way BibTeX counts
//! them, literally: `\{` is a brace like any other.
//!
//! Offsets are byte offsets into the UTF-8 source; every delimiter the
//! parser looks for is ASCII, so a span never splits a character.
//!
//! - this module parses (`parse`);
//! - `values` reads a value (macros expanded, LaTeX made plain) and an
//!   entry's summary, and writes a value back in the delimiters it had;
//! - `edits` makes the splices that change a key, type or field, add or
//!   remove a field, and delete an entry;
//! - `names` reads a BibTeX author list as people.

use std::collections::HashMap;

mod compose;
mod edits;
mod names;
mod values;

pub use edits::{
    add_field_edit, apply_edit, change_type_edit, delete_entry_edit, remove_field_edit,
    rename_key_edit, replace_value_edit, BibEdit,
};
pub use names::{author_names, short_authors};
pub use values::{
    balanced_braces, bib_text_to_plain, editable_value, encode_value, entry_values, expand_value,
    self_contained_value, summarize_entry, valid_citation_key, BibSummary, BibValueStyle,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BibField {
    /// The field name as written.
    pub name: String,
    /// The name's first byte.
    pub from: usize,
    /// The value: one or more parts joined by `#`, as written.
    pub value_from: usize,
    pub value_to: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BibEntry {
    /// The entry type as written ("Article"); compare with `kind`.
    pub entry_type: String,
    /// The type, lower-cased.
    pub kind: String,
    pub key: String,
    /// The `@`.
    pub from: usize,
    /// One past the closing delimiter.
    pub to: usize,
    pub type_from: usize,
    pub key_from: usize,
    pub key_to: usize,
    pub fields: Vec<BibField>,
    /// A comma follows the last field (or the key, in an entry without
    /// fields).
    pub trailing_comma: bool,
    /// 1-based line of the `@`.
    pub line: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BibDocument {
    pub entries: Vec<BibEntry>,
    /// `@string` macros by lower-cased name, each a raw value.
    pub macros: HashMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BibParseReason {
    Unclosed,
    MissingKey,
    BadField,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BibParseError {
    pub reason: BibParseReason,
    /// 1-based line where the entry that failed starts.
    pub line: usize,
    /// The citation key, when the parser got that far.
    pub key: Option<String>,
}

impl BibParseError {
    /// Why a visual form cannot show a file that failed this way.
    pub fn message(&self) -> String {
        let line = self.line;
        match (self.reason, &self.key) {
            (BibParseReason::MissingKey, _) => {
                format!("Line {line}: an entry has no citation key.")
            }
            (BibParseReason::Unclosed, Some(key)) => {
                format!("Line {line}: the entry “{key}” is never closed.")
            }
            (BibParseReason::Unclosed, None) => format!("Line {line}: an entry is never closed."),
            (BibParseReason::BadField, Some(key)) => {
                format!("Line {line}: a field of “{key}” could not be read.")
            }
            (BibParseReason::BadField, None) => format!("Line {line}: a field could not be read."),
        }
    }
}

pub(crate) fn is_space(byte: Option<u8>) -> bool {
    matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r'))
}

/// A byte of a name: a field name, a macro or a bare value
/// (`[^\s"#%'(),={}]`).
pub(crate) fn is_name(byte: u8) -> bool {
    !byte.is_ascii_whitespace() && !b"\"#%'(),={}".contains(&byte)
}

/// Line starts, for turning offsets into 1-based line numbers.
fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0).chain(source.match_indices('\n').map(|(at, _)| at + 1)).collect()
}

fn line_at(starts: &[usize], offset: usize) -> usize {
    starts.partition_point(|start| *start <= offset).max(1)
}

/// Index of the brace closing the group opened at `open`.
pub(crate) fn close_brace(source: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (index, byte) in source.iter().enumerate().skip(open) {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// One past the end of the value part starting at `start` (a group, a
/// string, a number or a macro name).
pub(crate) fn value_part_end(source: &[u8], start: usize, close: Option<u8>) -> Option<usize> {
    match source.get(start)? {
        b'{' => close_brace(source, start).map(|end| end + 1),
        b'"' => {
            let mut depth = 0i32;
            for (index, byte) in source.iter().enumerate().skip(start + 1) {
                match byte {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    b'"' if depth == 0 => return Some(index + 1),
                    _ => {}
                }
                if depth < 0 {
                    return None;
                }
            }
            None
        }
        _ => {
            let mut index = start;
            while index < source.len() && is_name(source[index]) && Some(source[index]) != close {
                index += 1;
            }
            (index > start).then_some(index)
        }
    }
}

/// Skip whitespace and `%` line comments between an entry's tokens.
pub(crate) fn skip_gap(source: &[u8], mut index: usize) -> usize {
    loop {
        while is_space(source.get(index).copied()) {
            index += 1;
        }
        if source.get(index) != Some(&b'%') {
            return index;
        }
        while index < source.len() && source[index] != b'\n' {
            index += 1;
        }
    }
}

/// The end (one past the last part) of the `#`-joined value starting at
/// `start`.
pub(crate) fn value_end(source: &[u8], start: usize, close: Option<u8>) -> Option<usize> {
    let mut end = value_part_end(source, start, close)?;
    loop {
        let next = skip_gap(source, end);
        if source.get(next) != Some(&b'#') {
            return Some(end);
        }
        end = value_part_end(source, skip_gap(source, next + 1), close)?;
    }
}

/// The end of a delimited `@comment` / `@preamble` / `@string` body opened
/// at `open`.
fn directive_end(source: &[u8], open: usize) -> Option<usize> {
    if source[open] == b'{' {
        return close_brace(source, open);
    }
    let mut depth = 0i32;
    for (index, byte) in source.iter().enumerate().skip(open + 1) {
        match byte {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b')' if depth == 0 => return Some(index),
            _ => {}
        }
    }
    None
}

/// Parse the whole file. A malformed entry fails the parse: an editor only
/// edits what it can read whole.
pub fn parse(text: &str) -> Result<BibDocument, BibParseError> {
    let source = text.as_bytes();
    let starts = line_starts(text);
    let mut document = BibDocument::default();
    let mut index = 0;
    while index < source.len() {
        // Outside entries BibTeX ignores everything; a `%` line can hide an `@`.
        if source[index] == b'%' {
            while index < source.len() && source[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if source[index] != b'@' {
            index += 1;
            continue;
        }
        let from = index;
        let type_from = skip_gap(source, from + 1);
        let mut type_to = type_from;
        while type_to < source.len()
            && (source[type_to].is_ascii_alphanumeric() || matches!(source[type_to], b'_' | b'-'))
        {
            type_to += 1;
        }
        let open = skip_gap(source, type_to);
        if type_to == type_from || !matches!(source.get(open), Some(b'{' | b'(')) {
            index = from + 1;
            continue;
        }
        let entry_type = text[type_from..type_to].to_string();
        let kind = entry_type.to_lowercase();
        let line = line_at(&starts, from);
        let close = if source[open] == b'{' { b'}' } else { b')' };
        let failure = |reason, key: Option<&str>| BibParseError {
            reason,
            line,
            key: key.map(str::to_string),
        };
        if matches!(kind.as_str(), "comment" | "preamble" | "string") {
            let end = directive_end(source, open).ok_or(failure(BibParseReason::Unclosed, None))?;
            if kind == "string" {
                let name_from = skip_gap(source, open + 1);
                let mut name_to = name_from;
                while name_to < end && is_name(source[name_to]) {
                    name_to += 1;
                }
                let equals = skip_gap(source, name_to);
                if name_to > name_from && source.get(equals) == Some(&b'=') {
                    let value_from = skip_gap(source, equals + 1);
                    let value_to = value_end(source, value_from, Some(close));
                    if let Some(value_to) = value_to.filter(|value_to| *value_to <= end) {
                        document.macros.insert(
                            text[name_from..name_to].to_lowercase(),
                            text[value_from..value_to].to_string(),
                        );
                    }
                }
            }
            index = end + 1;
            continue;
        }
        let key_from = skip_gap(source, open + 1);
        let mut key_to = key_from;
        while key_to < source.len()
            && !is_space(Some(source[key_to]))
            && !b",{}()".contains(&source[key_to])
        {
            key_to += 1;
        }
        // `@misc{,` and `@misc{ title = …` have no key.
        if key_to == key_from
            || source.get(key_to) == Some(&b'=')
            || text[key_from..key_to].contains('=')
        {
            return Err(failure(BibParseReason::MissingKey, None));
        }
        let key = text[key_from..key_to].to_string();
        let mut fields = Vec::new();
        let mut cursor = skip_gap(source, key_to);
        let mut trailing_comma = false;
        loop {
            if source.get(cursor) == Some(&close) {
                break;
            }
            if source.get(cursor) != Some(&b',') {
                let reason = if cursor >= source.len() {
                    BibParseReason::Unclosed
                } else {
                    BibParseReason::BadField
                };
                return Err(failure(reason, Some(&key)));
            }
            cursor = skip_gap(source, cursor + 1);
            trailing_comma = true;
            if source.get(cursor) == Some(&close) {
                break;
            }
            let name_from = cursor;
            while cursor < source.len() && is_name(source[cursor]) {
                cursor += 1;
            }
            let equals = skip_gap(source, cursor);
            if cursor == name_from || source.get(equals) != Some(&b'=') {
                // The next entry's `@` where a field should be: this one was
                // never closed.
                let reason = if cursor >= source.len() || source.get(name_from) == Some(&b'@') {
                    BibParseReason::Unclosed
                } else {
                    BibParseReason::BadField
                };
                return Err(failure(reason, Some(&key)));
            }
            let value_from = skip_gap(source, equals + 1);
            let Some(value_to) = value_end(source, value_from, Some(close)) else {
                // An unclosed field value usually swallows the rest of the
                // file, so name the entry it started in.
                let reason = if value_from >= source.len()
                    || matches!(source.get(value_from), Some(b'{' | b'"'))
                {
                    BibParseReason::Unclosed
                } else {
                    BibParseReason::BadField
                };
                return Err(failure(reason, Some(&key)));
            };
            fields.push(BibField {
                name: text[name_from..cursor].to_string(),
                from: name_from,
                value_from,
                value_to,
            });
            trailing_comma = false;
            cursor = skip_gap(source, value_to);
        }
        document.entries.push(BibEntry {
            entry_type,
            kind,
            key,
            from,
            to: cursor + 1,
            type_from,
            key_from,
            key_to,
            fields,
            trailing_comma,
            line,
        });
        index = cursor + 1;
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "% header\n@string{nips = \"NeurIPS\"}\n\n@Article{vaswani2017,\n  title = {Attention {Is} All You Need},\n  author = \"Vaswani, Ashish and Shazeer, Noam\",\n  journal = nips # { 30},\n  year = 2017,\n}\n\n@comment{ignored @misc{x}}\n@misc(knuth, title={The \\TeX book})\n";

    #[test]
    fn every_entry_and_field_keeps_its_span() {
        let document = parse(SAMPLE).unwrap();
        assert_eq!(document.entries.len(), 2);
        let entry = &document.entries[0];
        assert_eq!(entry.entry_type, "Article");
        assert_eq!(entry.kind, "article");
        assert_eq!(entry.key, "vaswani2017");
        assert_eq!(entry.line, 4);
        assert!(entry.trailing_comma);
        let names: Vec<&str> = entry.fields.iter().map(|field| field.name.as_str()).collect();
        assert_eq!(names, ["title", "author", "journal", "year"]);
        let journal = &entry.fields[2];
        assert_eq!(&SAMPLE[journal.value_from..journal.value_to], "nips # { 30}");
        assert_eq!(
            &SAMPLE[entry.from..entry.to],
            &SAMPLE[SAMPLE.find("@Article").unwrap()..SAMPLE.find("}\n\n@comment").unwrap() + 1]
        );
        assert_eq!(document.macros.get("nips").map(String::as_str), Some("\"NeurIPS\""));
        let knuth = &document.entries[1];
        assert_eq!(knuth.key, "knuth");
        assert!(!knuth.trailing_comma);
    }

    #[test]
    fn a_malformed_entry_fails_the_parse_with_its_line() {
        let unclosed = parse("@article{a,\n  title = {Open\n").unwrap_err();
        assert_eq!(unclosed.reason, BibParseReason::Unclosed);
        assert_eq!(unclosed.key.as_deref(), Some("a"));
        assert_eq!(unclosed.message(), "Line 1: the entry “a” is never closed.");
        let keyless = parse("\n@misc{, title = {x}}").unwrap_err();
        assert_eq!(keyless.reason, BibParseReason::MissingKey);
        assert_eq!(keyless.line, 2);
        let bad = parse("@misc{k, title {x}}").unwrap_err();
        assert_eq!(bad.reason, BibParseReason::BadField);
    }

    #[test]
    fn a_commented_at_sign_is_not_an_entry() {
        let document = parse("% @misc{hidden, title={x}}\n@misc{shown, title={y}}").unwrap();
        assert_eq!(document.entries.len(), 1);
        assert_eq!(document.entries[0].key, "shown");
    }

    #[test]
    fn non_ascii_text_keeps_byte_spans() {
        let source = "@misc{café, title = {Über}}";
        let document = parse(source).unwrap();
        let field = &document.entries[0].fields[0];
        assert_eq!(&source[field.value_from..field.value_to], "{Über}");
        assert_eq!(document.entries[0].key, "café");
    }
}
