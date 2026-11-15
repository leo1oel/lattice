//! Formatting for the Markdown source editor's selection toolbar, the Tauri
//! app's `src/editor/markdown/markdown-source-format.ts` ported line for
//! line: the inline formats and block types the visual editor's toolbar
//! offers, written as the Markdown the visual editor writes. Every command
//! toggles: a selection already in the format loses it.
//!
//! Inline formats work line by line, so a selection over several paragraphs
//! wraps each one rather than opening a marker no paragraph closes, and keep
//! the selection's edge whitespace outside the markers (`** bold**` is not
//! bold). Offsets are bytes; every marker is ASCII.

use std::{collections::HashSet, ops::Range, sync::LazyLock};

use regex::Regex;

use crate::text_edit::{Replace, TextEdit, map_pos, normalize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InlineFormat {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Highlight,
    Math,
    Link,
}

impl InlineFormat {
    pub const ALL: [InlineFormat; 8] = [
        InlineFormat::Bold,
        InlineFormat::Italic,
        InlineFormat::Underline,
        InlineFormat::Strike,
        InlineFormat::Code,
        InlineFormat::Highlight,
        InlineFormat::Math,
        InlineFormat::Link,
    ];

    fn wraps(self) -> (&'static str, &'static str) {
        match self {
            InlineFormat::Bold => ("**", "**"),
            InlineFormat::Italic => ("*", "*"),
            InlineFormat::Underline => ("<u>", "</u>"),
            InlineFormat::Strike => ("~~", "~~"),
            InlineFormat::Code => ("`", "`"),
            InlineFormat::Highlight => ("==", "=="),
            InlineFormat::Math => ("$", "$"),
            InlineFormat::Link => ("[", "]()"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlockType {
    Text,
    Heading(u8),
    BulletList,
    OrderedList,
    TaskList,
    Quote,
    CodeBlock,
}

/// What the selection already is, for the toolbar's pressed buttons and
/// ticked block type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionFormat {
    pub inline: HashSet<InlineFormat>,
    pub block: BlockType,
    /// Inside a fenced code block, where inline formats mean nothing.
    pub in_code: bool,
}

/// The lines of `text`, each its start and end (without the newline).
fn lines(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            out.push(start..index);
            start = index + 1;
        }
    }
    out.push(start..text.len());
    out
}

/// The 0-based line holding `at`.
fn line_of(lines: &[Range<usize>], at: usize) -> usize {
    lines
        .iter()
        .position(|line| at <= line.end)
        .unwrap_or(lines.len() - 1)
}

/// The non-blank part of each line the selection touches.
fn segments(text: &str, from: usize, to: usize) -> Vec<Range<usize>> {
    let all = lines(text);
    let (first, last) = (line_of(&all, from), line_of(&all, to));
    let mut out = Vec::new();
    for line in &all[first..=last] {
        let start = from.max(line.start);
        let end = to.min(line.end);
        if start > end {
            continue;
        }
        let slice = &text[start..end];
        let lead = slice.len() - slice.trim_start().len();
        let trail = slice.len() - slice.trim_end().len();
        if start + lead < end - trail {
            out.push(start + lead..end - trail);
        }
    }
    out
}

/// How many `ch`s run backwards from `at` (exclusive) or forwards from it.
fn run(text: &[u8], at: usize, ch: u8, backwards: bool) -> usize {
    let mut count = 0;
    if backwards {
        while at > count && text[at - count - 1] == ch {
            count += 1;
        }
    } else {
        while at + count < text.len() && text[at + count] == ch {
            count += 1;
        }
    }
    count
}

type Markers = (Range<usize>, Range<usize>);

/// Emphasis markers around `from..to`: `*` (or `_`) runs on both sides.
/// Bold takes two and italic one; a run of three is both.
fn emphasis_markers(text: &str, from: usize, to: usize, bold: bool) -> Option<Markers> {
    let bytes = text.as_bytes();
    let width = if bold { 2 } else { 1 };
    let holds = |depth: usize| if bold { depth >= 2 } else { depth == 1 || depth == 3 };
    for ch in *b"*_" {
        let before = run(bytes, from, ch, true);
        let after = run(bytes, to, ch, false);
        if before > 0 || after > 0 {
            if holds(before.min(after)) {
                return Some((from - width..from, to..to + width));
            }
            continue;
        }
        // Selected with its markers.
        let inner = &bytes[from..to];
        let lead = inner.iter().take_while(|&&b| b == ch).count();
        let trail = inner.iter().rev().take_while(|&&b| b == ch).count();
        if lead + trail < inner.len() && holds(lead.min(trail)) {
            return Some((
                from + lead - width..from + lead,
                to - trail..to - trail + width,
            ));
        }
    }
    None
}

fn wrap_markers(text: &str, from: usize, to: usize, open: &str, close: &str) -> Option<Markers> {
    if from >= open.len()
        && text.get(from - open.len()..from) == Some(open)
        && text.get(to..to + close.len()) == Some(close)
    {
        return Some((from - open.len()..from, to..to + close.len()));
    }
    let inner = &text[from..to];
    (inner.len() > open.len() + close.len() && inner.starts_with(open) && inner.ends_with(close))
        .then(|| (from..from + open.len(), to - close.len()..to))
}

static DESTINATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\]\([^()\s]*(?:\s+"[^"]*")?\)"#).unwrap());
static WHOLE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\[([^\]]*)\]\([^()\s]*(?:\s+"[^"]*")?\)$"#).unwrap());

/// `[text](url)` around the selection (or selected whole).
fn link_markers(text: &str, from: usize, to: usize) -> Option<Markers> {
    let line_end = text[to..].find('\n').map_or(text.len(), |at| to + at);
    if from > 0
        && &text[from - 1..from] == "["
        && let Some(found) = DESTINATION.find(&text[to..line_end])
    {
        return Some((from - 1..from, to..to + found.end()));
    }
    let whole = WHOLE_LINK.captures(&text[from..to])?;
    let label = whole[1].len();
    Some((from..from + 1, from + 1 + label..to))
}

fn markers(text: &str, segment: &Range<usize>, format: InlineFormat) -> Option<Markers> {
    match format {
        InlineFormat::Bold | InlineFormat::Italic => {
            emphasis_markers(text, segment.start, segment.end, format == InlineFormat::Bold)
        }
        InlineFormat::Link => link_markers(text, segment.start, segment.end),
        _ => {
            let (open, close) = format.wraps();
            wrap_markers(text, segment.start, segment.end, open, close)
        }
    }
}

/// Toggle `format` on `range`; `None` when it has nothing to format.
pub fn toggle_inline(text: &str, range: Range<usize>, format: InlineFormat) -> Option<TextEdit> {
    let parts = segments(text, range.start, range.end);
    if parts.is_empty() {
        return None;
    }
    let found: Vec<Option<Markers>> = parts.iter().map(|part| markers(text, part, format)).collect();
    if found.iter().all(Option::is_some) {
        let changes = normalize(
            found
                .iter()
                .flatten()
                .flat_map(|(open, close)| [Replace::new(open.clone(), ""), Replace::new(close.clone(), "")])
                .collect(),
        );
        let first = found[0].as_ref().unwrap().0.end;
        let last = found[found.len() - 1].as_ref().unwrap().1.start;
        let anchor = map_pos(&changes, range.start.max(first), 1);
        let head = map_pos(&changes, range.end.min(last), -1);
        return Some(TextEdit { changes, anchor, head });
    }
    if format == InlineFormat::Link {
        // The destination is typed next: the caret waits between the parentheses.
        let (from, to) = (parts[0].start, parts[parts.len() - 1].end);
        let changes = vec![Replace::new(from..from, "["), Replace::new(to..to, "]()")];
        let caret = map_pos(&changes, to, 1) - 1;
        return Some(TextEdit { changes, anchor: caret, head: caret });
    }
    let (open, close) = format.wraps();
    let changes = normalize(
        parts
            .iter()
            .zip(&found)
            .filter(|(_, found)| found.is_none())
            .flat_map(|(part, _)| {
                [
                    Replace::new(part.start..part.start, open),
                    Replace::new(part.end..part.end, close),
                ]
            })
            .collect(),
    );
    let anchor = map_pos(&changes, parts[0].start, 1);
    let head = map_pos(&changes, parts[parts.len() - 1].end, -1);
    Some(TextEdit { changes, anchor, head })
}

/// A line's leading syntax: indent, `>` quote markers, then a heading or
/// list marker.
static LINE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\s*)((?:>[ \t]?)*)(#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)?")
        .unwrap()
});
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").unwrap());
static TASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*+][ \t]+\[").unwrap());

struct Prefix {
    indent: String,
    quote: String,
    marker: String,
    length: usize,
}

fn line_prefix(line: &str) -> Prefix {
    let found = LINE_PREFIX.captures(line).unwrap();
    Prefix {
        indent: found[1].to_string(),
        quote: found[2].to_string(),
        marker: found.get(3).map_or(String::new(), |m| m.as_str().to_string()),
        length: found.get(0).unwrap().end(),
    }
}

fn marker_type(marker: &str) -> Option<BlockType> {
    if marker.is_empty() {
        return None;
    }
    if marker.starts_with('#') {
        return Some(BlockType::Heading(marker.trim_end().len() as u8));
    }
    if TASK.is_match(marker) {
        return Some(BlockType::TaskList);
    }
    Some(if marker.starts_with(|c: char| c.is_ascii_digit()) {
        BlockType::OrderedList
    } else {
        BlockType::BulletList
    })
}

/// The fenced code block holding line `number`: its fence lines, the close
/// `None` for an unclosed one.
fn fence_around(text: &str, all: &[Range<usize>], number: usize) -> Option<(usize, Option<usize>)> {
    let mut open: Option<(usize, String)> = None;
    for (current, line) in all.iter().enumerate() {
        let line = &text[line.clone()];
        let fence = FENCE.captures(line).map(|found| found[1].to_string());
        match &open {
            None => {
                if current > number {
                    return None;
                }
                if let Some(fence) = fence {
                    open = Some((current, fence));
                }
            }
            Some((start, opening)) => {
                if let Some(fence) = fence
                    && fence.as_bytes()[0] == opening.as_bytes()[0]
                    && fence.len() >= opening.len()
                    && line[line.find(&fence).unwrap() + fence.len()..].trim().is_empty()
                {
                    if current >= number {
                        return Some((*start, Some(current)));
                    }
                    open = None;
                }
            }
        }
    }
    open.map(|(start, _)| (start, None))
}

fn block_of_line(line: &str) -> BlockType {
    let prefix = line_prefix(line);
    marker_type(&prefix.marker).unwrap_or(if prefix.quote.is_empty() {
        BlockType::Text
    } else {
        BlockType::Quote
    })
}

/// The selection's inline formats (every line has them) and the block type
/// of its first line.
pub fn selection_format(text: &str, range: Range<usize>) -> SelectionFormat {
    let all = lines(text);
    let first = line_of(&all, range.start);
    if fence_around(text, &all, first).is_some() {
        return SelectionFormat {
            inline: HashSet::new(),
            block: BlockType::CodeBlock,
            in_code: true,
        };
    }
    let parts = segments(text, range.start, range.end);
    let mut inline = HashSet::new();
    if !parts.is_empty() {
        for format in InlineFormat::ALL {
            if parts.iter().all(|part| markers(text, part, format).is_some()) {
                inline.insert(format);
            }
        }
    }
    SelectionFormat {
        inline,
        block: block_of_line(&text[all[first].clone()]),
        in_code: false,
    }
}

fn marker_for(block: BlockType, index: usize) -> String {
    match block {
        BlockType::Heading(level) => format!("{} ", "#".repeat(level as usize)),
        BlockType::BulletList => "- ".into(),
        BlockType::TaskList => "- [ ] ".into(),
        BlockType::OrderedList => format!("{}. ", index + 1),
        _ => String::new(),
    }
}

/// Make the lines the selection touches `block`. A list or quote the lines
/// already all are turns back into text; a heading is set, not toggled.
/// Text clears headings, lists and quotes alike, and leaves a code block.
pub fn set_block(text: &str, range: Range<usize>, block: BlockType) -> Option<TextEdit> {
    let all = lines(text);
    let first = line_of(&all, range.start);
    // A selection ending at a line's very start leaves that line out.
    let end_at = if range.end > range.start
        && all[line_of(&all, range.end)].start == range.end
    {
        range.end - 1
    } else {
        range.end
    };
    let last = first.max(line_of(&all, end_at));
    let mut changes: Vec<Replace> = Vec::new();
    let (mut content_first, mut content_last) = (first, last);
    if let Some((open, close)) = fence_around(text, &all, first) {
        // Leaving a code block takes off its fences, whatever it becomes.
        content_first = open + 1;
        content_last = close.unwrap_or(all.len()).saturating_sub(1);
        let opening = &all[open];
        changes.push(Replace::new(opening.start..(opening.end + 1).min(text.len()), ""));
        if let Some(close) = close {
            let closing = &all[close];
            changes.push(Replace::new(closing.start.saturating_sub(1)..closing.end, ""));
        }
        if matches!(block, BlockType::CodeBlock | BlockType::Text) {
            return Some(mapped(changes, range));
        }
    } else if block == BlockType::CodeBlock {
        let (start, end) = (all[first].start, all[last].end);
        changes.push(Replace::new(start..start, "```\n"));
        changes.push(Replace::new(end..end, "\n```"));
        return Some(mapped(changes, range));
    }
    let body: Vec<(usize, Prefix)> = (content_first..=content_last.min(all.len() - 1))
        .filter(|&number| !text[all[number].clone()].trim().is_empty())
        .map(|number| (all[number].start, line_prefix(&text[all[number].clone()])))
        .collect();
    if body.is_empty() {
        return (!changes.is_empty()).then(|| mapped(changes, range));
    }
    let toggled_off = match block {
        BlockType::Quote => body.iter().all(|(_, prefix)| !prefix.quote.is_empty()),
        BlockType::BulletList | BlockType::OrderedList | BlockType::TaskList => body
            .iter()
            .all(|(_, prefix)| marker_type(&prefix.marker) == Some(block)),
        _ => false,
    };
    static QUOTE_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^>[ \t]?").unwrap());
    for (index, (from, prefix)) in body.iter().enumerate() {
        let mut quote = prefix.quote.clone();
        let mut marker = prefix.marker.clone();
        match block {
            BlockType::Quote => {
                quote = if toggled_off {
                    QUOTE_MARK.replace(&quote, "").into_owned()
                } else if quote.is_empty() {
                    "> ".into()
                } else {
                    quote
                };
            }
            BlockType::Text => {
                quote.clear();
                marker.clear();
            }
            _ => marker = if toggled_off { String::new() } else { marker_for(block, index) },
        }
        let next = format!("{}{quote}{marker}", prefix.indent);
        if next != text[*from..from + prefix.length] {
            changes.push(Replace::new(*from..from + prefix.length, next));
        }
    }
    (!changes.is_empty()).then(|| mapped(changes, range))
}

/// `changes` with the selection carried across them, never swallowing the
/// syntax put in front of it.
fn mapped(changes: Vec<Replace>, range: Range<usize>) -> TextEdit {
    let changes = normalize(changes);
    let anchor = map_pos(&changes, range.start, 1);
    let head = map_pos(&changes, range.end, if range.is_empty() { 1 } else { -1 });
    TextEdit { changes, anchor, head }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str, quote: &str) -> Range<usize> {
        let start = text.find(quote).unwrap();
        start..start + quote.len()
    }

    #[test]
    fn bold_wraps_each_line_and_comes_off() {
        let text = "one two\nthree";
        let edit = toggle_inline(text, 0..text.len(), InlineFormat::Bold).unwrap();
        let after = edit.apply(text);
        assert_eq!(after, "**one two**\n**three**");
        // Selected with its markers, every line reads as bold and comes off.
        let format = selection_format(&after, 0..after.len());
        assert!(format.inline.contains(&InlineFormat::Bold));
        let off = toggle_inline(&after, 0..after.len(), InlineFormat::Bold).unwrap();
        assert_eq!(off.apply(&after), text);
        let one = after.find("one two").unwrap();
        let inside = selection_format(&after, one..one + 7);
        assert!(inside.inline.contains(&InlineFormat::Bold));
    }

    #[test]
    fn italic_is_not_bold() {
        let text = "a **b** c";
        let format = selection_format(text, at(text, "b"));
        assert!(format.inline.contains(&InlineFormat::Bold));
        assert!(!format.inline.contains(&InlineFormat::Italic));
    }

    #[test]
    fn a_link_waits_for_its_destination() {
        let text = "see this";
        let edit = toggle_inline(text, at(text, "this"), InlineFormat::Link).unwrap();
        assert_eq!(edit.apply(text), "see [this]()");
        assert_eq!(edit.anchor, "see [this](".len());
    }

    #[test]
    fn blocks_set_and_toggle() {
        let text = "a\nb";
        let list = set_block(text, 0..text.len(), BlockType::BulletList).unwrap().apply(text);
        assert_eq!(list, "- a\n- b");
        let back = set_block(&list, 0..list.len(), BlockType::BulletList).unwrap().apply(&list);
        assert_eq!(back, text);
        let heading = set_block(text, 0..1, BlockType::Heading(2)).unwrap().apply(text);
        assert_eq!(heading, "## a\nb");
        assert_eq!(selection_format(&heading, 3..4).block, BlockType::Heading(2));
        let code = set_block(text, 0..1, BlockType::CodeBlock).unwrap().apply(text);
        assert_eq!(code, "```\na\n```\nb");
        assert!(selection_format(&code, 4..5).in_code);
        let plain = set_block(&code, 4..5, BlockType::Text).unwrap().apply(&code);
        assert_eq!(plain, text);
    }
}
