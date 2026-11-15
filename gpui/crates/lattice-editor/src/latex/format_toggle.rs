//! Formatting the selection toolbar applies to LaTeX source, as toggles, the
//! Tauri app's `src/editor/latex/latex-format-toggle.ts` ported line for line:
//! a selection already in a format loses it, any other selection gains it
//! once, so Bold never wraps bold text again (`\textbf{\textbf{…}}`).
//!
//! Pure text over a window around the selection, so the toolbar can also
//! read which formats a selection already has on every selection change. A
//! group is found only when its braces match outside comments; whatever
//! cannot be read for certain is left as written. Offsets are bytes of the
//! document; every pattern is ASCII.

use std::{collections::HashSet, ops::Range, sync::LazyLock};

use regex::Regex;

use crate::text_edit::{Replace, TextEdit, map_pos, normalize};

/// The inline formats that toggle; each writes one command and recognises
/// its synonyms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InlineFormat {
    Bold,
    Italic,
    Underline,
    Strikethrough,
}

impl InlineFormat {
    fn write(self) -> &'static str {
        match self {
            InlineFormat::Bold => "textbf",
            InlineFormat::Italic => "textit",
            InlineFormat::Underline => "underline",
            InlineFormat::Strikethrough => "sout",
        }
    }

    /// Visual mode draws `\emph` and `\textit` alike, so either is italic to
    /// Italic: neither nests in the other.
    fn reads(self) -> &'static Regex {
        static BOLD: LazyLock<Regex> = LazyLock::new(|| command_pattern("textbf"));
        static ITALIC: LazyLock<Regex> = LazyLock::new(|| command_pattern("textit|emph"));
        static UNDERLINE: LazyLock<Regex> = LazyLock::new(|| command_pattern("underline|uline"));
        static STRIKETHROUGH: LazyLock<Regex> = LazyLock::new(|| command_pattern("sout"));
        match self {
            InlineFormat::Bold => &BOLD,
            InlineFormat::Italic => &ITALIC,
            InlineFormat::Underline => &UNDERLINE,
            InlineFormat::Strikethrough => &STRIKETHROUGH,
        }
    }
}

/// The commands `names` matches, by name.
fn command_pattern(names: &str) -> Regex {
    Regex::new(&format!(r"\\({names})")).expect("command names compile")
}

/// The sectioning commands the heading menu offers, and the deeper ones it
/// may meet.
static HEADING_COMMANDS: LazyLock<Regex> = LazyLock::new(|| {
    command_pattern("part|chapter|section|subsection|subsubsection|paragraph|subparagraph")
});
static HREF: LazyLock<Regex> = LazyLock::new(|| command_pattern("href"));
static QUOTE: LazyLock<Regex> = LazyLock::new(|| environment_pattern("quote"));

/// How far from a selection a group's ends may lie (a formatted paragraph,
/// not a chapter).
const REACH: usize = 4000;

/// A formatted stretch: `from..content_from` opens it (`\textbf{`,
/// `\begin{quote}` and its newline), `content_to..to` closes it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Group {
    from: usize,
    to: usize,
    content_from: usize,
    content_to: usize,
    name: String,
}

fn escaped(text: &[u8], at: usize) -> bool {
    let mut slashes = 0;
    while at > slashes && text[at - 1 - slashes] == b'\\' {
        slashes += 1;
    }
    slashes % 2 == 1
}

/// Whether an unescaped `%` earlier on its line makes `at` a comment.
fn commented(text: &[u8], at: usize) -> bool {
    let start = text[..at].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut index = start;
    while index < at {
        match text[index] {
            b'\\' => index += 1,
            b'%' => return true,
            _ => {}
        }
        index += 1;
    }
    false
}

/// Just past the brace that closes the group opened at `open`.
fn group_end(text: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = open;
    while index < text.len() {
        match text[index] {
            b'\\' => index += 1,
            b'%' => {
                index += text[index..].iter().position(|&b| b == b'\n')?;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Whether `from..to` opens no brace it does not close and closes none it
/// did not open.
fn balanced(text: &[u8], from: usize, to: usize) -> bool {
    let mut depth = 0i32;
    let mut index = from;
    while index < to {
        match text[index] {
            b'\\' => index += 1,
            b'%' => match text[index..].iter().position(|&b| b == b'\n') {
                Some(offset) if index + offset < to => index += offset,
                _ => return false,
            },
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
        index += 1;
    }
    depth == 0
}

/// Every `\name{…}` group in `text` whose name `names` matches
/// (`command_pattern`); `options` also takes a `*` and one `[…]` before the
/// brace, as a sectioning command does.
fn command_groups(text: &str, names: &Regex, options: bool) -> Vec<Group> {
    // The name must not run on into more letters; match it, then read what
    // follows by hand (the regex crate has no lookahead).
    let bytes = text.as_bytes();
    let mut groups = Vec::new();
    for found in names.captures_iter(text) {
        let whole = found.get(0).unwrap();
        let from = whole.start();
        let mut index = whole.end();
        if index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'@') {
            continue;
        }
        if escaped(bytes, from) || commented(bytes, from) {
            continue;
        }
        if options {
            if bytes.get(index) == Some(&b'*') {
                index += 1;
            }
            if bytes.get(index) == Some(&b'[') {
                let Some(close) = bytes[index..]
                    .iter()
                    .position(|&b| b == b']' || b == b'\n')
                    .filter(|&offset| bytes[index + offset] == b']')
                else {
                    continue;
                };
                index += close + 1;
            }
        }
        while matches!(bytes.get(index), Some(b' ' | b'\t')) {
            index += 1;
        }
        if bytes.get(index) != Some(&b'{') {
            continue;
        }
        let open = index;
        if let Some(to) = group_end(bytes, open) {
            groups.push(Group {
                from,
                to,
                content_from: open + 1,
                content_to: to - 1,
                name: found[1].to_string(),
            });
        }
    }
    groups
}

/// `\begin{name}` and `\end{name}`.
fn environment_pattern(name: &str) -> Regex {
    Regex::new(&format!(r"\\(begin|end)\{{{}\}}", regex::escape(name)))
        .expect("environment pattern compiles")
}

/// Every `\begin{name}…\end{name}` that `pattern` (`environment_pattern`)
/// finds; its content leaves out the newline after `\begin` and before
/// `\end`.
fn environment_groups(text: &str, name: &str, pattern: &Regex) -> Vec<Group> {
    let bytes = text.as_bytes();
    let begin = format!("\\begin{{{name}}}");
    let end = format!("\\end{{{name}}}");
    let mut open: Vec<usize> = Vec::new();
    let mut groups = Vec::new();
    for found in pattern.captures_iter(text) {
        let at = found.get(0).unwrap().start();
        if escaped(bytes, at) || commented(bytes, at) {
            continue;
        }
        if &found[1] == "begin" {
            open.push(at);
            continue;
        }
        let Some(from) = open.pop() else {
            continue;
        };
        let mut content_from = from + begin.len();
        if bytes.get(content_from) == Some(&b'\n') {
            content_from += 1;
        }
        let mut content_to = at;
        if content_to > content_from && bytes[content_to - 1] == b'\n' {
            content_to -= 1;
        }
        groups.push(Group {
            from,
            to: at + end.len(),
            content_from,
            content_to,
            name: name.to_string(),
        });
    }
    groups.sort_by_key(|group| group.from);
    groups
}

/// The text around `from..to` and where it starts in the document.
fn window_around(doc: &str, from: usize, to: usize) -> (&str, usize) {
    let mut start = from.saturating_sub(REACH);
    while !doc.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (to + REACH).min(doc.len());
    while !doc.is_char_boundary(end) {
        end += 1;
    }
    (&doc[start..end], start)
}

/// `from..to` without the whitespace at its ends; all of it when it is only
/// whitespace.
fn trimmed(text: &[u8], from: usize, to: usize) -> (usize, usize) {
    let (mut start, mut end) = (from, to);
    while start < end && text[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && text[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    if start < end { (start, end) } else { (from, to) }
}

/// The innermost group that holds `from..to`: the selection lies in its
/// content, or covers its command and nothing outside it.
fn enclosing(groups: &[Group], from: usize, to: usize) -> Option<&Group> {
    let mut best: Option<&Group> = None;
    for group in groups {
        let holds = group.from <= from
            && to <= group.to
            && from.max(group.content_from) < to.min(group.content_to);
        if holds && best.is_none_or(|best| group.to - group.from < best.to - best.from) {
            best = Some(group);
        }
    }
    best
}

/// `group` and the groups that wrap exactly it, outermost last.
fn stacked<'a>(groups: &'a [Group], group: &'a Group) -> Vec<&'a Group> {
    let mut chain = vec![group];
    let mut outer = group;
    while let Some(parent) = groups
        .iter()
        .find(|candidate| candidate.content_from == outer.from && candidate.content_to == outer.to)
    {
        chain.push(parent);
        outer = parent;
    }
    chain
}

/// Window edits as document edits, and the selection after them.
fn finish(
    edits: Vec<Replace>,
    offset: usize,
    select: impl FnOnce(&[Replace]) -> (usize, usize),
) -> TextEdit {
    let changes = normalize(
        edits
            .into_iter()
            .map(|edit| Replace::new(edit.range.start + offset..edit.range.end + offset, edit.insert))
            .collect(),
    );
    let (anchor, head) = select(&changes);
    TextEdit {
        changes,
        anchor,
        head,
    }
}

struct Cut {
    edits: Vec<Replace>,
    from: usize,
    to: usize,
}

/// Take `group` off `from..to` (window offsets). With `split`, a selection
/// inside part of the group's text leaves the rest formatted:
/// `\textbf{a b c}` with `b` selected becomes `\textbf{a} b \textbf{c}`.
fn remove_group(text: &str, groups: &[Group], group: &Group, from: usize, to: usize, split: bool) -> Cut {
    let bytes = text.as_bytes();
    let chain = stacked(groups, group);
    let outer = chain[chain.len() - 1];
    let mut start = from.max(group.content_from);
    let mut end = to.min(group.content_to);
    // A selection that opens or closes a brace of the group's text cannot be
    // cut out of it: the whole group loses the format instead.
    if !split || !balanced(bytes, start, end) {
        start = group.content_from;
        end = group.content_to;
    }
    let opening = &text[group.from..group.content_from];
    let kept = trimmed(bytes, group.content_from, start);
    let before = start > group.content_from && text[kept.0..kept.1].chars().any(|c| !c.is_whitespace());
    let kept_after = trimmed(bytes, end, group.content_to);
    let after = end < group.content_to
        && text[kept_after.0..kept_after.1].chars().any(|c| !c.is_whitespace());
    let mut edits = vec![Replace::new(outer.from..group.content_from, if before { opening } else { "" })];
    if before {
        edits.push(Replace::new(kept.1..kept.1, "}"));
    }
    if after {
        edits.push(Replace::new(kept_after.0..kept_after.0, opening));
    }
    edits.push(Replace::new(group.content_to..outer.to, if after { "}" } else { "" }));
    edits.retain(|edit| edit.insert != text[edit.range.clone()]);
    Cut {
        edits,
        from: start,
        to: end,
    }
}

/// Format `from..to` once with `open` … `close`. A group of the same format
/// the selection overlaps joins it, and every group of that format inside it
/// is taken off, so nothing nests.
fn apply_group(groups: &[Group], from: usize, to: usize, open: &str, close: &str) -> Cut {
    let (mut start, mut end) = (from, to);
    let mut grown = true;
    while grown {
        grown = false;
        for group in groups {
            let overlaps = group.from < end && group.to > start;
            if overlaps && (group.from < start || group.to > end) {
                start = start.min(group.from);
                end = end.max(group.to);
                grown = true;
            }
        }
    }
    let mut edits: Vec<Replace> = Vec::new();
    for group in groups {
        if group.from < start || group.to > end {
            continue;
        }
        edits.push(Replace::new(group.from..group.content_from, ""));
        edits.push(Replace::new(group.content_to..group.to, ""));
    }
    // The new command's ends join a deletion that starts or ends there.
    let first = edits.iter().position(|edit| edit.range.start == start);
    match first {
        Some(index) => edits[index].insert = open.to_string(),
        None => edits.push(Replace::new(start..start, open)),
    }
    let last = edits
        .iter()
        .enumerate()
        .position(|(index, edit)| edit.range.end == end && Some(index) != first);
    match last {
        Some(index) => edits[index].insert = close.to_string(),
        None => edits.push(Replace::new(end..end, close)),
    }
    Cut {
        edits,
        from: start,
        to: end,
    }
}

/// Toggle `groups`' format on the selection `range` (document offsets) of
/// the window `text` at `offset`: the rule behind every toggle here.
fn toggle(
    text: &str,
    offset: usize,
    groups: &[Group],
    range: Range<usize>,
    open: &str,
    close: &str,
    split: bool,
) -> TextEdit {
    let (from, to) = (range.start - offset, range.end - offset);
    if from == to {
        // An empty pair the caret sits in goes; elsewhere the caret gets one
        // to type into.
        if let Some(empty) = groups
            .iter()
            .find(|group| group.content_from == from && group.content_to == from)
        {
            let at = empty.from + offset;
            return finish(vec![Replace::new(empty.from..empty.to, "")], offset, |_| (at, at));
        }
        let caret = range.start + open.len();
        return finish(
            vec![Replace::new(from..to, format!("{open}{close}"))],
            offset,
            |_| (caret, caret),
        );
    }
    let selected = trimmed(text.as_bytes(), from, to);
    if let Some(group) = enclosing(groups, selected.0, selected.1) {
        let removed = remove_group(text, groups, group, selected.0, selected.1, split);
        return finish(removed.edits, offset, |changes| {
            (
                map_pos(changes, removed.from + offset, 1),
                map_pos(changes, removed.to + offset, -1),
            )
        });
    }
    let applied = apply_group(groups, selected.0, selected.1, open, close);
    finish(applied.edits, offset, |changes| {
        (
            map_pos(changes, applied.from + offset, -1) + open.len(),
            map_pos(changes, applied.to + offset, 1) - close.len(),
        )
    })
}

/// Bold, italic and their like on the selection, on or off.
pub fn toggle_inline(doc: &str, range: Range<usize>, format: InlineFormat) -> TextEdit {
    let (text, offset) = window_around(doc, range.start, range.end);
    let groups = command_groups(text, format.reads(), false);
    toggle(
        text,
        offset,
        &groups,
        range,
        &format!("\\{}{{", format.write()),
        "}",
        true,
    )
}

/// A `quote` environment around the selection, on or off; it never splits.
pub fn toggle_quote(doc: &str, range: Range<usize>) -> TextEdit {
    let (text, offset) = window_around(doc, range.start, range.end);
    let groups = environment_groups(text, "quote", &QUOTE);
    toggle(text, offset, &groups, range, "\\begin{quote}\n", "\n\\end{quote}", false)
}

/// Make the selection a heading at `command`'s level: inside a heading of
/// that level it stops being one, inside another level's it changes level.
pub fn set_heading(doc: &str, range: Range<usize>, command: &str) -> TextEdit {
    let (text, offset) = window_around(doc, range.start, range.end);
    let groups = command_groups(text, &HEADING_COMMANDS, true);
    let selected = trimmed(text.as_bytes(), range.start - offset, range.end - offset);
    let heading = (range.start != range.end)
        .then(|| enclosing(&groups, selected.0, selected.1))
        .flatten();
    if let Some(heading) = heading.filter(|heading| heading.name != command) {
        let name = heading.from + 1 + offset..heading.from + 1 + heading.name.len() + offset;
        let shift = command.len() as isize - heading.name.len() as isize;
        let shifted = |at: usize| ((at + offset) as isize + shift) as usize;
        return TextEdit {
            changes: vec![Replace::new(name, command)],
            anchor: shifted(heading.content_from),
            head: shifted(heading.content_to),
        };
    }
    toggle(
        text,
        offset,
        &groups,
        range,
        &format!("\\{command}{{"),
        "}",
        false,
    )
}

/// Every `\href{url}{text}`: the text is its content and `name` the url.
fn link_groups(text: &str) -> Vec<Group> {
    let bytes = text.as_bytes();
    let mut links = Vec::new();
    for target in command_groups(text, &HREF, false) {
        if target.content_from != target.from + "\\href{".len() {
            continue;
        }
        let mut open = target.to;
        while matches!(bytes.get(open), Some(b' ' | b'\t')) {
            open += 1;
        }
        if bytes.get(open) != Some(&b'{') {
            continue;
        }
        if let Some(end) = group_end(bytes, open) {
            links.push(Group {
                from: target.from,
                to: end,
                content_from: open + 1,
                content_to: end - 1,
                name: text[target.content_from..target.content_to].to_string(),
            });
        }
    }
    links
}

/// Link the selection to `url`; inside a link's text it changes where the
/// link goes.
pub fn set_link(doc: &str, range: Range<usize>, url: &str) -> TextEdit {
    let (text, offset) = window_around(doc, range.start, range.end);
    let links = link_groups(text);
    let selected = trimmed(text.as_bytes(), range.start - offset, range.end - offset);
    let link = (range.start != range.end)
        .then(|| enclosing(&links, selected.0, selected.1))
        .flatten();
    if let Some(link) = link {
        let target = link.from + "\\href{".len();
        let shift = url.len() as isize - link.name.len() as isize;
        let shifted = |at: usize| ((at + offset) as isize + shift) as usize;
        return TextEdit {
            changes: vec![Replace::new(
                target + offset..target + link.name.len() + offset,
                url,
            )],
            anchor: shifted(link.content_from),
            head: shifted(link.content_to),
        };
    }
    let open = format!("\\href{{{url}}}{{");
    let insert = format!("{open}{}}}", &doc[range.clone()]);
    TextEdit {
        changes: vec![Replace::new(range.clone(), insert)],
        anchor: range.start + open.len(),
        head: range.end + open.len(),
    }
}

/// The URL the toolbar's Link writes, its backslashes and braces
/// percent-encoded so `\href` reads it.
pub fn link_target(value: &str) -> Option<String> {
    let url = value.trim();
    (!url.is_empty()).then(|| {
        url.replace('\\', "%5C")
            .replace('{', "%7B")
            .replace('}', "%7D")
    })
}

/// What the selection already is, for the toolbar's pressed buttons.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelectionFormats {
    pub inline: HashSet<InlineFormat>,
    /// The sectioning command of the heading the selection is in.
    pub heading: Option<String>,
    pub quote: bool,
    /// The selection is a link's text.
    pub link: bool,
}

/// The formats `range` is wholly in; it reads only the text near it.
pub fn selection_formats(doc: &str, range: Range<usize>) -> SelectionFormats {
    if range.end - range.start > REACH {
        return SelectionFormats::default();
    }
    let (text, offset) = window_around(doc, range.start, range.end);
    let selected = trimmed(text.as_bytes(), range.start - offset, range.end - offset);
    let inside = |groups: &[Group]| -> Option<Group> {
        (selected.0 < selected.1)
            .then(|| enclosing(groups, selected.0, selected.1).cloned())
            .flatten()
    };
    let mut inline = HashSet::new();
    for format in [
        InlineFormat::Bold,
        InlineFormat::Italic,
        InlineFormat::Underline,
        InlineFormat::Strikethrough,
    ] {
        if inside(&command_groups(text, format.reads(), false)).is_some() {
            inline.insert(format);
        }
    }
    SelectionFormats {
        inline,
        heading: inside(&command_groups(text, &HEADING_COMMANDS, true)).map(|group| group.name),
        quote: inside(&environment_groups(text, "quote", &QUOTE)).is_some(),
        link: inside(&link_groups(text)).is_some(),
    }
}

/// Wrap `range` in `before` … `after` (`wrapRange`), the text staying
/// selected.
pub fn wrap_range(doc: &str, range: Range<usize>, before: &str, after: &str) -> TextEdit {
    let selected = &doc[range.clone()];
    let start = range.start + before.len();
    TextEdit {
        changes: vec![Replace::new(range.clone(), format!("{before}{selected}{after}"))],
        anchor: start,
        head: start + selected.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(doc: &str, quote: &str) -> Range<usize> {
        let start = doc.find(quote).unwrap();
        start..start + quote.len()
    }

    fn run(doc: &str, edit: &TextEdit) -> (String, String) {
        let after = edit.apply(doc);
        let selected = after[edit.anchor.min(edit.head)..edit.anchor.max(edit.head)].to_string();
        (after, selected)
    }

    #[test]
    fn bold_toggles_rather_than_nesting() {
        let doc = "a word here";
        let edit = toggle_inline(doc, at(doc, "word"), InlineFormat::Bold);
        let (after, selected) = run(doc, &edit);
        assert_eq!(after, "a \\textbf{word} here");
        assert_eq!(selected, "word");
        let range = at(&after, "word");
        let off = toggle_inline(&after, range, InlineFormat::Bold);
        assert_eq!(run(&after, &off), (doc.to_string(), "word".to_string()));
    }

    #[test]
    fn a_selection_inside_bold_splits_it() {
        let doc = "\\textbf{a b c}";
        let b = doc.find(" b ").unwrap() + 1;
        let edit = toggle_inline(doc, b..b + 1, InlineFormat::Bold);
        assert_eq!(run(doc, &edit).0, "\\textbf{a} b \\textbf{c}");
    }

    #[test]
    fn bold_joins_an_overlapping_group() {
        let doc = "\\textbf{a} b";
        let edit = toggle_inline(doc, 0..doc.len(), InlineFormat::Bold);
        assert_eq!(run(doc, &edit).0, "\\textbf{a b}");
    }

    #[test]
    fn emph_reads_as_italic() {
        let doc = "an \\emph{idea}";
        let formats = selection_formats(doc, at(doc, "idea"));
        assert!(formats.inline.contains(&InlineFormat::Italic));
        let edit = toggle_inline(doc, at(doc, "idea"), InlineFormat::Italic);
        assert_eq!(run(doc, &edit).0, "an idea");
    }

    #[test]
    fn headings_change_level_or_come_off() {
        let doc = "\\section{Intro}";
        let edit = set_heading(doc, at(doc, "Intro"), "subsection");
        assert_eq!(run(doc, &edit), ("\\subsection{Intro}".into(), "Intro".into()));
        let edit = set_heading(doc, at(doc, "Intro"), "section");
        assert_eq!(run(doc, &edit).0, "Intro");
        let formats = selection_formats(doc, at(doc, "Intro"));
        assert_eq!(formats.heading.as_deref(), Some("section"));
    }

    #[test]
    fn quote_wraps_and_unwraps() {
        let doc = "Some text.";
        let edit = toggle_quote(doc, 0..doc.len());
        let (after, _) = run(doc, &edit);
        assert_eq!(after, "\\begin{quote}\nSome text.\n\\end{quote}");
        assert!(selection_formats(&after, at(&after, "Some text.")).quote);
        let off = toggle_quote(&after, at(&after, "Some text."));
        assert_eq!(run(&after, &off).0, doc);
    }

    #[test]
    fn a_link_inside_a_link_changes_its_target() {
        let doc = "see \\href{https://a.org}{the site}";
        let edit = set_link(doc, at(doc, "the site"), "https://b.org");
        assert_eq!(run(doc, &edit), ("see \\href{https://b.org}{the site}".into(), "the site".into()));
        let plain = "see the site";
        let edit = set_link(plain, at(plain, "the site"), "https://b.org");
        assert_eq!(run(plain, &edit).0, doc.replace("a.org", "b.org"));
        assert_eq!(link_target(" a\\b{c} ").as_deref(), Some("a%5Cb%7Bc%7D"));
    }

    #[test]
    fn a_commented_command_is_not_a_group() {
        let doc = "% \\textbf{word}\nword";
        let formats = selection_formats(doc, 16..20);
        assert!(formats.inline.is_empty());
    }
}
