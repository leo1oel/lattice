//! The LaTeX source's formatting keys (`latex-format-toggle.ts` in the Tauri
//! app), as toggles: a selection already in a format loses it, any other
//! selection gains it once, so Bold applied twice never nests
//! `\textbf{\textbf{…}}`.
//!
//! Pure text over a window around the selection, in byte offsets. A group is
//! found only when its braces match outside comments; whatever cannot be
//! read for certain is left as written.

use std::ops::Range;

use regex::Regex;

/// The inline formats ⌘B and ⌘I toggle; each writes one command and
/// recognises its synonyms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlineFormat {
    /// ⌘B: `\textbf`.
    Bold,
    /// ⌘I: `\emph`, which reads `\textit` as the same italic, as the
    /// Tauri app's Visual mode draws both alike.
    Emphasis,
}

impl InlineFormat {
    fn write(self) -> &'static str {
        match self {
            InlineFormat::Bold => "textbf",
            InlineFormat::Emphasis => "emph",
        }
    }

    fn reads(self) -> &'static str {
        match self {
            InlineFormat::Bold => "textbf",
            InlineFormat::Emphasis => "emph|textit",
        }
    }
}

/// One replacement in the document, in its offsets before the edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub range: Range<usize>,
    pub insert: String,
}

/// The edits a toggle makes and the selection after them, in the edited
/// document (`anchor == head` for a caret).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatEdit {
    pub changes: Vec<TextEdit>,
    pub anchor: usize,
    pub head: usize,
}

/// A formatted stretch: `[from, content_from)` opens it (`\textbf{`),
/// `[content_to, to)` closes it.
#[derive(Clone, Copy, Debug)]
struct Group {
    from: usize,
    to: usize,
    content_from: usize,
    content_to: usize,
}

/// How far from a selection a group's ends may lie (a formatted paragraph,
/// not a chapter).
const REACH: usize = 4000;

fn escaped(text: &[u8], at: usize) -> bool {
    let mut slashes = 0;
    while at > slashes && text[at - 1 - slashes] == b'\\' {
        slashes += 1;
    }
    slashes % 2 == 1
}

/// Whether an unescaped `%` earlier on its line makes `at` a comment.
fn commented(text: &[u8], at: usize) -> bool {
    let start = text[..at]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |line| line + 1);
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
    let mut depth = 0usize;
    let mut index = open;
    while index < text.len() {
        match text[index] {
            b'\\' => index += 1,
            b'%' => index += text[index..].iter().position(|byte| *byte == b'\n')?,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
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

/// Whether `[from, to)` opens no brace it does not close and closes none it
/// did not open.
fn balanced(text: &[u8], from: usize, to: usize) -> bool {
    let mut depth = 0i64;
    let mut index = from;
    while index < to {
        match text[index] {
            b'\\' => index += 1,
            b'%' => match text[index..].iter().position(|byte| *byte == b'\n') {
                Some(end) if index + end < to => index += end,
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

/// Every `\name{…}` group in `text` whose name `names` matches (a regular
/// expression alternation).
fn command_groups(text: &str, names: &str) -> Vec<Group> {
    let pattern = Regex::new(&format!(r"\\({names})[ \t]*\{{")).expect("a valid pattern");
    let bytes = text.as_bytes();
    let mut groups = Vec::new();
    for found in pattern.captures_iter(text) {
        let whole = found.get(0).expect("the match");
        let from = whole.start();
        // `\textbfx{` is another command (`(?![A-Za-z@])`).
        let name_end = found.get(1).expect("the name").end();
        if bytes
            .get(name_end)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'@')
        {
            continue;
        }
        if escaped(bytes, from) || commented(bytes, from) {
            continue;
        }
        let open = whole.end() - 1;
        if let Some(to) = group_end(bytes, open) {
            groups.push(Group {
                from,
                to,
                content_from: open + 1,
                content_to: to - 1,
            });
        }
    }
    groups
}

/// `[from, to)` without the whitespace at its ends; all of it when it is
/// only whitespace.
fn trimmed(text: &str, from: usize, to: usize) -> Range<usize> {
    let inner = &text[from..to];
    let start = from + (inner.len() - inner.trim_start().len());
    let end = to - (inner.len() - inner.trim_end().len());
    if start < end { start..end } else { from..to }
}

/// The innermost group that holds `[from, to)`: the selection lies in its
/// content, or covers its command and nothing outside it.
fn enclosing(groups: &[Group], from: usize, to: usize) -> Option<Group> {
    groups
        .iter()
        .filter(|group| {
            group.from <= from
                && to <= group.to
                && from.max(group.content_from) < to.min(group.content_to)
        })
        .min_by_key(|group| group.to - group.from)
        .copied()
}

/// `group` and the groups that wrap exactly it (`\textbf{\textbf{x}}`),
/// outermost last.
fn stacked(groups: &[Group], group: Group) -> Vec<Group> {
    let mut chain = vec![group];
    let mut outer = group;
    while let Some(parent) = groups
        .iter()
        .find(|candidate| candidate.content_from == outer.from && candidate.content_to == outer.to)
    {
        chain.push(*parent);
        outer = *parent;
    }
    chain
}

/// Where `pos` lands after `edits` (sorted, in the old document), as
/// CodeMirror's `ChangeSet.mapPos` maps it: inside a replaced range it goes
/// to the range's start, and at a pure insertion before it when `assoc` is
/// negative, after it otherwise.
fn map_pos(edits: &[TextEdit], pos: usize, assoc: i8) -> usize {
    let mut shift: isize = 0;
    for edit in edits {
        let (from, to) = (edit.range.start, edit.range.end);
        let inserted = edit.insert.len() as isize;
        if to > pos || (to == pos && from == to && assoc < 0) {
            if from > pos {
                break;
            }
            return if pos == from || assoc < 0 {
                (from as isize + shift) as usize
            } else {
                (from as isize + shift + inserted) as usize
            };
        }
        shift += inserted - (to - from) as isize;
    }
    (pos as isize + shift) as usize
}

/// Window edits as document edits, sorted, without the ones that change
/// nothing.
fn finish(edits: Vec<TextEdit>, offset: usize) -> Vec<TextEdit> {
    let mut changes: Vec<TextEdit> = edits
        .into_iter()
        .filter(|edit| !edit.range.is_empty() || !edit.insert.is_empty())
        .map(|edit| TextEdit {
            range: edit.range.start + offset..edit.range.end + offset,
            insert: edit.insert,
        })
        .collect();
    changes.sort_by_key(|edit| edit.range.start);
    changes
}

fn edit(range: Range<usize>, insert: &str) -> TextEdit {
    TextEdit {
        range,
        insert: insert.to_string(),
    }
}

/// Take `group` off `[from, to)`. A selection inside part of the group's
/// text leaves the rest formatted: `\textbf{a b c}` with `b` selected
/// becomes `\textbf{a} b \textbf{c}`.
fn remove_group(
    text: &str,
    groups: &[Group],
    group: Group,
    from: usize,
    to: usize,
) -> (Vec<TextEdit>, usize, usize) {
    let bytes = text.as_bytes();
    let chain = stacked(groups, group);
    let outer = *chain.last().expect("the group itself");
    let mut start = from.max(group.content_from);
    let mut end = to.min(group.content_to);
    // A selection that opens or closes a brace of the group's text cannot be
    // cut out of it: the whole group loses the format instead.
    if !balanced(bytes, start, end) {
        start = group.content_from;
        end = group.content_to;
    }
    let opening = &text[group.from..group.content_from];
    // What stays formatted on either side keeps the space at the cut outside
    // it, and a side that is only space keeps no command at all.
    let kept = trimmed(text, group.content_from, start);
    let before = start > group.content_from && !text[kept.clone()].trim().is_empty();
    let kept_after = trimmed(text, end, group.content_to);
    let after = end < group.content_to && !text[kept_after.clone()].trim().is_empty();
    let mut edits = vec![edit(
        outer.from..group.content_from,
        if before { opening } else { "" },
    )];
    if before {
        edits.push(edit(kept.end..kept.end, "}"));
    }
    if after {
        edits.push(edit(kept_after.start..kept_after.start, opening));
    }
    edits.push(edit(
        group.content_to..outer.to,
        if after { "}" } else { "" },
    ));
    edits.retain(|edit| edit.insert != text[edit.range.clone()]);
    (edits, start, end)
}

/// Format `[from, to)` once with `open` … `close`. A group of the same
/// format the selection overlaps joins it, and every group of that format
/// inside it is taken off, so nothing nests: `\textbf{a} b` with all of it
/// selected becomes `\textbf{a b}`.
fn apply_group(
    groups: &[Group],
    from: usize,
    to: usize,
    open: &str,
    close: &str,
) -> (Vec<TextEdit>, usize, usize) {
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
    let mut edits = Vec::new();
    for group in groups {
        if group.from < start || group.to > end {
            continue;
        }
        edits.push(edit(group.from..group.content_from, ""));
        edits.push(edit(group.content_to..group.to, ""));
    }
    // The new command's ends join a deletion that starts or ends there, so
    // one change says what happens at each end.
    let first = edits.iter().position(|edit| edit.range.start == start);
    match first {
        Some(index) => edits[index].insert = open.to_string(),
        None => edits.push(edit(start..start, open)),
    }
    let first = first.unwrap_or(edits.len() - 1);
    match edits
        .iter()
        .enumerate()
        .position(|(index, edit)| edit.range.end == end && index != first)
    {
        Some(index) => edits[index].insert = close.to_string(),
        None => edits.push(edit(end..end, close)),
    }
    (edits, start, end)
}

/// Bold or emphasis on the selection `[from, to)` of `doc`, on or off.
pub fn toggle_inline(doc: &str, from: usize, to: usize, format: InlineFormat) -> FormatEdit {
    let floor = |at: usize| {
        (0..=at)
            .rev()
            .find(|at| doc.is_char_boundary(*at))
            .unwrap_or(0)
    };
    let ceil = |at: usize| {
        (at..=doc.len())
            .find(|at| doc.is_char_boundary(*at))
            .unwrap_or(doc.len())
    };
    let offset = floor(from.saturating_sub(REACH));
    let text = &doc[offset..ceil((to + REACH).min(doc.len()))];
    let groups = command_groups(text, format.reads());
    let open = format!("\\{}{{", format.write());
    let close = "}";
    let (start, end) = (from - offset, to - offset);
    if start == end {
        // An empty pair the caret sits in goes; elsewhere the caret gets one
        // to type into.
        if let Some(empty) = groups
            .iter()
            .find(|group| group.content_from == start && group.content_to == start)
        {
            let at = empty.from + offset;
            return FormatEdit {
                changes: finish(vec![edit(empty.from..empty.to, "")], offset),
                anchor: at,
                head: at,
            };
        }
        let caret = from + open.len();
        return FormatEdit {
            changes: finish(vec![edit(start..end, &format!("{open}{close}"))], offset),
            anchor: caret,
            head: caret,
        };
    }
    let selected = trimmed(text, start, end);
    // The text that keeps (or takes) the format stays selected: mapped from
    // just before what opens it to just after what closes it, then stepped in.
    if let Some(group) = enclosing(&groups, selected.start, selected.end) {
        let (edits, from, to) = remove_group(text, &groups, group, selected.start, selected.end);
        let changes = finish(edits, offset);
        return FormatEdit {
            anchor: map_pos(&changes, from + offset, 1),
            head: map_pos(&changes, to + offset, -1),
            changes,
        };
    }
    let (edits, from, to) = apply_group(&groups, selected.start, selected.end, &open, close);
    let changes = finish(edits, offset);
    FormatEdit {
        anchor: map_pos(&changes, from + offset, -1) + open.len(),
        head: map_pos(&changes, to + offset, 1) - close.len(),
        changes,
    }
}

/// `doc` with `changes` (sorted, non-overlapping) made.
pub fn apply(doc: &str, changes: &[TextEdit]) -> String {
    let mut out = String::with_capacity(doc.len());
    let mut at = 0;
    for change in changes {
        out.push_str(&doc[at..change.range.start]);
        out.push_str(&change.insert);
        at = change.range.end;
    }
    out.push_str(&doc[at..]);
    out
}

#[cfg(test)]
mod tests {
    //! The Tauri app's `latex-format-toggle.test.ts`, case for case: the
    //! source marks the selection with `[` and `]` (a caret with `|`), and the
    //! result is the edited text with the selection after the edit marked
    //! the same way.

    use super::*;

    fn run(source: &str, format: InlineFormat) -> String {
        let (from, to) = match source.find('|') {
            Some(caret) => (caret, caret),
            None => (source.find('[').unwrap(), source.find(']').unwrap() - 1),
        };
        let doc: String = source.chars().filter(|c| !"[]|".contains(*c)).collect();
        let result = toggle_inline(&doc, from, to, format);
        let text = apply(&doc, &result.changes);
        let (anchor, head) = (result.anchor, result.head);
        if anchor == head {
            format!("{}|{}", &text[..anchor], &text[anchor..])
        } else {
            format!(
                "{}[{}]{}",
                &text[..anchor],
                &text[anchor..head],
                &text[head..]
            )
        }
    }

    fn plain(source: &str) -> String {
        source.chars().filter(|c| !"[]|".contains(*c)).collect()
    }

    fn each(check: impl Fn(InlineFormat, &dyn Fn(&str) -> String)) {
        for (format, command) in [
            (InlineFormat::Bold, "textbf"),
            (InlineFormat::Emphasis, "emph"),
        ] {
            check(format, &move |text: &str| format!("\\{command}{{{text}}}"));
        }
    }

    #[test]
    fn applies_once_then_the_same_key_takes_it_off() {
        each(|format, wrapped| {
            let formatted = run("Toggle [these words] please.", format);
            assert_eq!(
                formatted,
                format!("Toggle {} please.", wrapped("[these words]"))
            );
            assert_eq!(run(&formatted, format), "Toggle [these words] please.");
        });
    }

    #[test]
    fn never_nests_however_often_it_is_applied() {
        each(|format, wrapped| {
            let mut source = "Toggle [these words] please.".to_string();
            for _ in 0..3 {
                source = run(&source, format);
            }
            assert_eq!(
                plain(&source),
                format!("Toggle {} please.", wrapped("these words"))
            );
        });
    }

    #[test]
    fn takes_the_format_off_a_selection_that_covers_the_command_too() {
        each(|format, wrapped| {
            assert_eq!(
                run(
                    &format!("Toggle [{}] please.", wrapped("these words")),
                    format
                ),
                "Toggle [these words] please."
            );
        });
    }

    #[test]
    fn leaves_the_selections_edge_whitespace_out_of_the_command() {
        each(|format, wrapped| {
            assert_eq!(
                run("Toggle[ these words ]please.", format),
                format!("Toggle {} please.", wrapped("[these words]"))
            );
            assert_eq!(
                run(
                    &format!("Toggle[ {} ]please.", wrapped("these words")),
                    format
                ),
                "Toggle [these words] please."
            );
        });
    }

    #[test]
    fn splits_a_group_when_only_part_of_its_text_is_selected() {
        each(|format, wrapped| {
            assert_eq!(
                run(&wrapped("one [two] three"), format),
                format!("{} [two] {}", wrapped("one"), wrapped("three"))
            );
            assert_eq!(
                run(&wrapped("[one] two"), format),
                format!("[one] {}", wrapped("two"))
            );
            assert_eq!(
                run(&wrapped("one [two]"), format),
                format!("{} [two]", wrapped("one"))
            );
        });
    }

    #[test]
    fn keeps_no_command_around_the_space_a_split_leaves() {
        each(|format, wrapped| {
            assert_eq!(
                run(&format!("these{} please", wrapped(" [words]")), format),
                "these [words] please"
            );
            assert_eq!(
                run(&format!("{}words", wrapped("[these] ")), format),
                "[these] words"
            );
        });
    }

    #[test]
    fn applies_once_over_a_partly_formatted_selection() {
        each(|format, wrapped| {
            assert_eq!(
                run(&format!("[a {} c]", wrapped("b")), format),
                wrapped("[a b c]")
            );
            assert_eq!(
                run(&format!("{} c] d", wrapped("a [b")), format),
                format!("{} d", wrapped("[a b c]"))
            );
            assert_eq!(
                run(&format!("a [b {}", wrapped("c] d")), format),
                format!("a {}", wrapped("[b c d]"))
            );
        });
    }

    #[test]
    fn takes_a_caret_into_an_empty_pair_and_the_pair_away_again() {
        for (format, command) in [
            (InlineFormat::Bold, "textbf"),
            (InlineFormat::Emphasis, "emph"),
        ] {
            assert_eq!(run("a | b", format), format!("a \\{command}{{|}} b"));
            assert_eq!(run(&format!("a \\{command}{{|}} b"), format), "a | b");
        }
    }

    #[test]
    fn collapses_the_nesting_an_old_bold_left_behind() {
        assert_eq!(
            run(
                "Toggle \\textbf{\\textbf{\\textbf{[these words]}}} please.",
                InlineFormat::Bold
            ),
            "Toggle [these words] please."
        );
    }

    #[test]
    fn keeps_other_formats_in_place() {
        assert_eq!(
            run("\\textit{\\textbf{[word]}}", InlineFormat::Bold),
            "\\textit{[word]}"
        );
        assert_eq!(
            run("\\textbf{[word]}", InlineFormat::Emphasis),
            "\\textbf{\\emph{[word]}}"
        );
    }

    #[test]
    fn treats_emph_and_textit_as_one_italic() {
        assert_eq!(run("\\textit{[word]}", InlineFormat::Emphasis), "[word]");
        assert_eq!(
            run("\\emph{one [two]}", InlineFormat::Emphasis),
            "\\emph{one} [two]"
        );
    }

    #[test]
    fn does_not_cut_a_selection_that_crosses_braces_out_of_a_group() {
        assert_eq!(
            run("\\textbf{a \\textit{[b} c]}", InlineFormat::Bold),
            "[a \\textit{b} c]"
        );
    }

    #[test]
    fn ignores_commands_in_comments_and_escaped_backslashes() {
        assert_eq!(
            run("% \\textbf{x}\n[word]", InlineFormat::Bold),
            "% \\textbf{x}\n\\textbf{[word]}"
        );
        assert_eq!(
            run("\\\\textbf{[word]}", InlineFormat::Bold),
            "\\\\textbf{\\textbf{[word]}}"
        );
    }

    #[test]
    fn keeps_the_brace_a_comment_holds_out_of_the_groups_end() {
        assert_eq!(
            run("\\textbf{[a] % }\n}", InlineFormat::Bold),
            "[a] \\textbf{% }\n}"
        );
    }

    #[test]
    fn works_in_byte_offsets_past_non_ascii_text() {
        assert_eq!(
            run("Über [straße] ok", InlineFormat::Bold),
            "Über \\textbf{[straße]} ok"
        );
    }
}
