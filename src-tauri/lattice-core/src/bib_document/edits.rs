//! The splices that change an entry: its key, type or a field's value; a
//! field added after the others, laid out like them; a field removed with
//! its comma and its line; the entry deleted with the lines it stood on.
//! Everything an edit does not touch stays byte for byte as written.

use super::{BibEntry, BibField};

/// A splice into the .bib text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BibEdit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

pub fn apply_edit(source: &str, edit: &BibEdit) -> String {
    format!("{}{}{}", &source[..edit.from], edit.insert, &source[edit.to..])
}

pub fn replace_value_edit(field: &BibField, raw: &str) -> BibEdit {
    BibEdit { from: field.value_from, to: field.value_to, insert: raw.to_string() }
}

pub fn rename_key_edit(entry: &BibEntry, key: &str) -> BibEdit {
    BibEdit { from: entry.key_from, to: entry.key_to, insert: key.to_string() }
}

pub fn change_type_edit(entry: &BibEntry, entry_type: &str) -> BibEdit {
    BibEdit {
        from: entry.type_from,
        to: entry.type_from + entry.entry_type.len(),
        insert: entry_type.to_string(),
    }
}

/// The start of the line holding `offset`.
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind('\n').map_or(0, |at| at + 1)
}

fn only_indent(text: &str) -> bool {
    text.bytes().all(|byte| byte == b' ' || byte == b'\t')
}

/// How the entry's fields are indented and `name = value` spaced, taken
/// from its first field, and the file's line ending.
struct Layout {
    indent: String,
    equals: String,
    newline: &'static str,
}

fn field_layout(source: &str, entry: &BibEntry) -> Layout {
    let newline = if source.contains("\r\n") { "\r\n" } else { "\n" };
    let Some(first) = entry.fields.first() else {
        return Layout { indent: "  ".into(), equals: " = ".into(), newline };
    };
    let before = &source[line_start(source, first.from)..first.from];
    let name_end = first.from + first.name.len();
    let equals = &source[name_end..first.value_from];
    Layout {
        indent: if only_indent(before) { before.to_string() } else { "  ".into() },
        equals: if equals.is_empty() { " = ".into() } else { equals.to_string() },
        newline,
    }
}

/// Add `name = raw` after the entry's last field, laid out like its other
/// fields.
pub fn add_field_edit(source: &str, entry: &BibEntry, name: &str, raw: &str) -> BibEdit {
    let Layout { indent, equals, newline } = field_layout(source, entry);
    let field = format!("{indent}{name}{equals}{raw}");
    let Some(last) = entry.fields.last() else {
        // After the key and its comma, if it has one; what the body holds
        // (a comment) stays, and an empty body makes room for the field.
        let comma = comma_after(source, entry.key_to);
        let at = comma.map_or(entry.key_to, |comma| comma + 1);
        let close = entry.to - 1;
        let lead = if comma.is_some() { "" } else { "," };
        let tail = if comma.is_some() { "," } else { "" };
        if source[at..close].trim().is_empty() {
            return BibEdit {
                from: at,
                to: close,
                insert: format!("{lead}{newline}{field}{tail}{newline}"),
            };
        }
        return BibEdit { from: at, to: at, insert: format!("{lead}{newline}{field}{tail}") };
    };
    if entry.trailing_comma {
        let comma = comma_after(source, last.value_to).unwrap_or(last.value_to);
        return BibEdit { from: comma + 1, to: comma + 1, insert: format!("{newline}{field},") };
    }
    BibEdit { from: last.value_to, to: last.value_to, insert: format!(",{newline}{field}") }
}

/// The comma that follows `at` past spaces and comments, as the parser reads
/// it.
fn comma_after(source: &str, at: usize) -> Option<usize> {
    let comma = super::skip_gap(source.as_bytes(), at);
    (source.as_bytes().get(comma) == Some(&b',')).then_some(comma)
}

/// The end of `at`'s line, past its line break, when nothing but spaces or
/// a comment is left on it.
fn rest_of_line(source: &str, at: usize) -> Option<usize> {
    let end = source[at..].find('\n').map_or(source.len(), |found| at + found + 1);
    let rest = source[at..end].trim();
    (rest.is_empty() || rest.starts_with('%')).then_some(end)
}

/// Remove a field with its separating comma and, when it stands on its own
/// line, that line. Comment lines around it stay where they are.
pub fn remove_field_edit(source: &str, entry: &BibEntry, field: &BibField) -> BibEdit {
    let index = entry.fields.iter().position(|candidate| candidate == field).unwrap_or(0);
    let previous = index.checked_sub(1).and_then(|before| entry.fields.get(before));
    let own_start = line_start(source, field.from);
    let own_line = only_indent(&source[own_start..field.from]);
    let after = comma_after(source, field.value_to).filter(|after| *after < entry.to);
    let last = index + 1 == entry.fields.len();
    if let Some(comma) = after.filter(|_| !last || entry.trailing_comma) {
        // Its own comma follows it: the field goes up to and with it, and
        // with its line when it has one to itself.
        let end = comma + 1;
        return match rest_of_line(source, end).filter(|_| own_line) {
            Some(line_end) => BibEdit { from: own_start, to: line_end, insert: String::new() },
            None => {
                let spaces =
                    source[end..].len() - source[end..].trim_start_matches([' ', '\t']).len();
                BibEdit { from: field.from, to: end + spaces, insert: String::new() }
            }
        };
    }
    // The last field without a comma of its own: the comma before it goes
    // with it, and its line; what stands between (a comment) stays.
    let before = previous.map_or(entry.key_to, |previous| previous.value_to);
    let Some(comma) = comma_after(source, before) else {
        return BibEdit { from: before, to: field.value_to, insert: String::new() };
    };
    let keep_to = if own_line && own_start > comma + 1 {
        let newline = if source[..own_start].ends_with("\r\n") { 2 } else { 1 };
        own_start - newline
    } else {
        source[..field.from].trim_end_matches([' ', '\t']).len()
    };
    let kept = source.get(comma + 1..keep_to.max(comma + 1)).unwrap_or("");
    BibEdit { from: comma, to: field.value_to, insert: kept.to_string() }
}

/// Remove the entry. Standing on lines of its own, it goes with them and the
/// blank lines after it, so its neighbours keep the spacing between them;
/// the file's last entry takes the blank lines before it instead.
pub fn delete_entry_edit(source: &str, entry: &BibEntry) -> BibEdit {
    let start = line_start(source, entry.from);
    let after = &source[entry.to..];
    let indent = after.len() - after.trim_start_matches([' ', '\t']).len();
    let rest_len = if after[indent..].starts_with("\r\n") {
        Some(indent + 2)
    } else if after[indent..].starts_with('\n') {
        Some(indent + 1)
    } else if indent == after.len() {
        Some(indent)
    } else {
        None
    };
    let alone = source[start..entry.from].trim().is_empty();
    let Some(rest_len) = rest_len.filter(|_| alone) else {
        return BibEdit { from: entry.from, to: entry.to, insert: String::new() };
    };
    let to = entry.to + rest_len;
    // The blank lines after it.
    let mut blanks = 0;
    for line in source[to..].split_inclusive('\n') {
        if line.ends_with('\n') && line.trim().is_empty() {
            blanks += line.len();
        } else {
            break;
        }
    }
    if !source[to..].trim().is_empty() {
        return BibEdit { from: start, to: to + blanks, insert: String::new() };
    }
    // The last entry: the blank lines before it go, keeping what ends the
    // line before them (`(?:\r?\n[\t ]*)+$`).
    let before = &source[..start];
    let trimmed = before.trim_end_matches(['\n', '\r', ' ', '\t']).len();
    let from = before[trimmed..].find('\n').map_or(start, |at| trimmed + at + 1);
    BibEdit { from, to, insert: String::new() }
}

#[cfg(test)]
mod tests {
    use super::super::parse;
    use super::*;

    fn edited(source: &str, edit: impl Fn(&str, &BibEntry) -> BibEdit) -> String {
        let document = parse(source).unwrap();
        apply_edit(source, &edit(source, &document.entries[0]))
    }

    #[test]
    fn an_edit_keeps_everything_else_as_written() {
        let source = "% keep\n@article{old,\n    title   = {T},\n    year    = 2017\n}\n";
        let renamed = edited(source, |_, entry| rename_key_edit(entry, "new"));
        assert_eq!(renamed, source.replace("{old,", "{new,"));
        let retyped = edited(source, |_, entry| change_type_edit(entry, "inproceedings"));
        assert!(retyped.starts_with("% keep\n@inproceedings{old,"));
        let value = edited(source, |_, entry| replace_value_edit(&entry.fields[1], "2018"));
        assert!(value.contains("year    = 2018"));
    }

    #[test]
    fn a_new_field_is_laid_out_like_the_others() {
        let source = "@article{a,\n    title   = {T},\n    year    = 2017\n}\n";
        assert_eq!(
            edited(source, |text, entry| add_field_edit(text, entry, "doi", "{10.1/x}")),
            "@article{a,\n    title   = {T},\n    year    = 2017,\n    doi   = {10.1/x}\n}\n"
        );
        let trailing = "@article{a,\n  title = {T},\n}\n";
        assert_eq!(
            edited(trailing, |text, entry| add_field_edit(text, entry, "year", "2020")),
            "@article{a,\n  title = {T},\n  year = 2020,\n}\n"
        );
        let bare = "@misc{k}";
        assert_eq!(
            edited(bare, |text, entry| add_field_edit(text, entry, "title", "{X}")),
            "@misc{k,\n  title = {X}\n}"
        );
    }

    #[test]
    fn a_removed_field_takes_its_comma_and_line() {
        let source = "@article{a,\n  title = {T},\n  year = 2017,\n  doi = {d}\n}\n";
        assert_eq!(
            edited(source, |text, entry| remove_field_edit(text, entry, &entry.fields[1])),
            "@article{a,\n  title = {T},\n  doi = {d}\n}\n"
        );
        assert_eq!(
            edited(source, |text, entry| remove_field_edit(text, entry, &entry.fields[2])),
            "@article{a,\n  title = {T},\n  year = 2017\n}\n"
        );
        let trailing = "@article{a,\n  title = {T},\n  year = 2017,\n}\n";
        assert_eq!(
            edited(trailing, |text, entry| remove_field_edit(text, entry, &entry.fields[1])),
            "@article{a,\n  title = {T},\n}\n"
        );
    }

    #[test]
    fn a_comment_s_comma_is_not_the_field_s() {
        let source = "@article{a,\n  title = {T},\n  year = 2017 % see p, 3\n  ,\n}\n";
        // The new field goes after the comma that ends `year`, below its
        // comment, and the entry keeps its trailing comma.
        let added = edited(source, |text, entry| add_field_edit(text, entry, "doi", "{d}"));
        assert_eq!(
            added,
            "@article{a,\n  title = {T},\n  year = 2017 % see p, 3\n  ,\n  doi = {d},\n}\n"
        );
        // `year` goes with its comment and the line holding its comma.
        let removed =
            edited(source, |text, entry| remove_field_edit(text, entry, &entry.fields[1]));
        assert_eq!(removed, "@article{a,\n  title = {T},\n}\n");
    }

    #[test]
    fn a_field_edit_keeps_the_comment_lines_around_it() {
        // A field between others goes with its own line only.
        let middle = "@article{a,\n  title = {T},\n  % why\n  year = 2017,\n  doi = {d}\n}\n";
        assert_eq!(
            edited(middle, |text, entry| remove_field_edit(text, entry, &entry.fields[0])),
            "@article{a,\n  % why\n  year = 2017,\n  doi = {d}\n}\n"
        );
        // The last field takes the comma before it, not the comment between.
        let last = "@article{a,\n  title = {T},\n  % why\n  year = 2017\n}\n";
        assert_eq!(
            edited(last, |text, entry| remove_field_edit(text, entry, &entry.fields[1])),
            "@article{a,\n  title = {T}\n  % why\n}\n"
        );
        // A first field goes in after the key, the body's comment kept.
        let empty = "@misc{k, % fill in later\n}";
        let added = edited(empty, |text, entry| add_field_edit(text, entry, "title", "{X}"));
        assert_eq!(added, "@misc{k,\n  title = {X}, % fill in later\n}");
        assert_eq!(parse(&added).unwrap().entries[0].fields.len(), 1);
    }

    #[test]
    fn a_deleted_entry_takes_its_lines() {
        let source = "@misc{a, title={A}}\n\n@misc{b, title={B}}\n";
        assert_eq!(edited(source, delete_entry_edit), "@misc{b, title={B}}\n");
        let document = parse(source).unwrap();
        let last = apply_edit(source, &delete_entry_edit(source, &document.entries[1]));
        assert_eq!(last, "@misc{a, title={A}}\n");
        let spaced = "@misc{a,t={A}} \n\n@misc{b,t={B}}\n";
        let document = parse(spaced).unwrap();
        let last = apply_edit(spaced, &delete_entry_edit(spaced, &document.entries[1]));
        assert_eq!(last, "@misc{a,t={A}} \n");
    }
}
