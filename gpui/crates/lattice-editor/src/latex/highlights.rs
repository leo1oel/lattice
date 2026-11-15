//! Highlights in LaTeX source, the Tauri app's `latex-highlights.ts`: the
//! `\colorbox[HTML]{FFF1A6}{…}` the selection toolbar writes, a
//! `\colorbox{yellow}{…}` typed by hand, and soul's `\hl{…}` (coloured by
//! `\sethlcolor`, which this does not follow). Pure text, so the toolbar,
//! its Remove, the paint and the Annotations panel read highlights the same
//! way. Offsets are bytes; every pattern is ASCII.

use std::ops::Range;

use crate::text_edit::{Replace, TextEdit, map_pos};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatexHighlight {
    /// The command's backslash.
    pub from: usize,
    /// Just past the closing brace.
    pub to: usize,
    /// The highlighted text, inside the last pair of braces.
    pub content_from: usize,
    pub content_to: usize,
    /// `#RRGGBB` for an HTML colour, a colour name as written, or `None` for
    /// `\hl`.
    pub color: Option<String>,
}

/// How far from a selection a highlight's ends may lie.
const REACH: usize = 4000;

fn group_end(text: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = open;
    while index < text.len() {
        match text[index] {
            b'\\' => index += 1,
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

fn skip_space(text: &[u8], mut index: usize) -> usize {
    while matches!(text.get(index), Some(b' ' | b'\t')) {
        index += 1;
    }
    index
}

/// Whether a highlight command starts at `at` (not `\hline` and its like).
fn command_at(text: &[u8], at: usize) -> Option<usize> {
    let rest = &text[at..];
    let length = if rest.starts_with(b"\\colorbox") {
        9
    } else if rest.starts_with(b"\\hl") {
        3
    } else {
        return None;
    };
    match rest.get(length) {
        Some(next) if next.is_ascii_alphabetic() || *next == b'@' => None,
        _ => Some(length),
    }
}

/// The highlight whose command starts at `from`.
fn highlight_from(text: &str, from: usize) -> Option<LatexHighlight> {
    let bytes = text.as_bytes();
    // `\\colorbox` is a line break followed by the word.
    let mut slashes = 0;
    while from > slashes && bytes[from - 1 - slashes] == b'\\' {
        slashes += 1;
    }
    if slashes % 2 == 1 {
        return None;
    }
    let length = command_at(bytes, from)?;
    let is_box = length == 9;
    let mut index = skip_space(bytes, from + length);
    let mut color = None;
    if is_box {
        let mut model = "";
        if bytes.get(index) == Some(&b'[') {
            let close = index + bytes[index..].iter().position(|&b| b == b']')?;
            model = text[index + 1..close].trim();
            index = skip_space(bytes, close + 1);
        }
        if bytes.get(index) != Some(&b'{') {
            return None;
        }
        let spec_end = group_end(bytes, index)?;
        let spec = text[index + 1..spec_end - 1].trim();
        let hex = spec.len() == 6 && spec.bytes().all(|b| b.is_ascii_hexdigit());
        color = Some(if model.eq_ignore_ascii_case("html") && hex {
            format!("#{}", spec.to_ascii_uppercase())
        } else {
            spec.to_string()
        });
        index = skip_space(bytes, spec_end);
    }
    if bytes.get(index) != Some(&b'{') {
        return None;
    }
    let to = group_end(bytes, index)?;
    Some(LatexHighlight {
        from,
        to,
        content_from: index + 1,
        content_to: to - 1,
        color,
    })
}

/// Every highlight in `text`, in order; a highlight nested in another
/// follows it.
pub fn latex_highlights(text: &str) -> Vec<LatexHighlight> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = bytes[at..].iter().position(|&b| b == b'\\') {
        let start = at + offset;
        if command_at(bytes, start).is_some()
            && let Some(highlight) = highlight_from(text, start)
        {
            found.push(highlight);
        }
        at = start + 1;
    }
    found
}

/// The innermost highlight around `range`: one whose text holds the
/// selection, or whose command the selection covers exactly. It reads only
/// the text near the selection.
pub fn highlight_around(doc: &str, range: Range<usize>) -> Option<LatexHighlight> {
    let mut offset = range.start.saturating_sub(REACH);
    while !doc.is_char_boundary(offset) {
        offset -= 1;
    }
    let mut end_at = (range.end + REACH).min(doc.len());
    while !doc.is_char_boundary(end_at) {
        end_at += 1;
    }
    let text = &doc[offset..end_at];
    let bytes = text.as_bytes();
    let (start, end) = (range.start - offset, range.end - offset);
    let mut at = start.min(bytes.len().saturating_sub(1));
    loop {
        let candidate = (0..=at.min(bytes.len().saturating_sub(1)))
            .rev()
            .find(|&index| bytes[index] == b'\\' && command_at(bytes, index).is_some())?;
        if let Some(found) = highlight_from(text, candidate)
            && ((found.content_from <= start && end <= found.content_to)
                || (found.from == start && found.to == end))
        {
            return Some(LatexHighlight {
                from: found.from + offset,
                to: found.to + offset,
                content_from: found.content_from + offset,
                content_to: found.content_to + offset,
                color: found.color,
            });
        }
        if candidate == 0 {
            return None;
        }
        at = candidate - 1;
    }
}

/// The command that opens a highlight of `color` (`#RRGGBB`, or a name).
pub fn highlight_opening(color: &str) -> String {
    let trimmed = color.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let is_hex = (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    if is_hex {
        format!("\\colorbox[HTML]{{{}}}{{", hex[..6].to_ascii_uppercase())
    } else {
        format!(
            "\\colorbox{{{}}}{{",
            if trimmed.is_empty() {
                "yellow"
            } else {
                trimmed
            }
        )
    }
}

/// The highlight colours a source already uses, most used first.
pub fn document_colors(source: &str) -> Vec<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for highlight in latex_highlights(source) {
        let Some(hex) = highlight.color.map(|color| color.to_ascii_uppercase()) else {
            continue;
        };
        if hex.len() != 7 || !hex.starts_with('#') {
            continue;
        }
        match counts.iter_mut().find(|(color, _)| *color == hex) {
            Some((_, count)) => *count += 1,
            None => counts.push((hex, 1)),
        }
    }
    counts.sort_by_key(|&(_, count)| std::cmp::Reverse(count));
    counts.into_iter().map(|(hex, _)| hex).collect()
}

/// The toolbar's Highlight (`color`) or Remove highlight (`None`) on the
/// selection `range` (`applySourceSelectionEdit`): Remove takes off the
/// highlight around the selection; a colour chosen for a whole highlight
/// recolours it rather than nesting another inside; any other selection is
/// wrapped. `None` when there is nothing to do.
pub fn highlight_edit(doc: &str, range: Range<usize>, color: Option<&str>) -> Option<TextEdit> {
    let around = highlight_around(doc, range.clone());
    let whole = around.as_ref().is_some_and(|around| {
        (around.content_from == range.start && around.content_to == range.end)
            || (around.from == range.start && around.to == range.end)
    });
    let target = if color.is_none() || whole {
        around
    } else {
        None
    };
    if let Some(target) = target {
        let changes = match color {
            None => vec![
                Replace::new(target.from..target.content_from, ""),
                Replace::new(target.content_to..target.to, ""),
            ],
            Some(color) => vec![Replace::new(
                target.from..target.content_from,
                highlight_opening(color),
            )],
        };
        let anchor = map_pos(&changes, target.content_from, 1);
        let head = map_pos(&changes, target.content_to, -1);
        return Some(TextEdit {
            changes,
            anchor,
            head,
        });
    }
    let color = color?;
    Some(super::format_toggle::wrap_range(
        doc,
        range,
        &highlight_opening(color),
        "}",
    ))
}

/// How a highlight is painted in the source (`latex-highlight-paint.ts`):
/// its text on its paper tint under the paper's black ink in a light
/// editor, as it prints; in a dark one a wash at 18% and a 2px underline at
/// 75% in its colour, since a pastel block would put light ink on a light
/// ground; and the `\colorbox[HTML]{…}{` wrapper and closing brace receding
/// at 45%. Only `#RRGGBB` highlights are painted; a colour by name and soul's
/// `\hl` are the document's to say. `text` is the document from `offset` on,
/// the stretch around what the editor shows.
pub fn paint(
    text: &str,
    offset: usize,
    dark: bool,
) -> (
    Vec<crate::decorations::Highlight>,
    Vec<crate::decorations::Mark>,
) {
    use crate::decorations::{Highlight, Mark, MarkStyle, Underline};
    let mut washes = Vec::new();
    let mut marks = Vec::new();
    let wrapper = MarkStyle {
        fade: Some(0.55),
        ..MarkStyle::default()
    };
    for mut highlight in latex_highlights(text) {
        highlight.from += offset;
        highlight.content_from += offset;
        highlight.content_to += offset;
        highlight.to += offset;
        let Some(hex) = highlight.color.as_deref().filter(|color| {
            color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        }) else {
            continue;
        };
        let Ok(value) = u32::from_str_radix(&hex[1..], 16) else {
            continue;
        };
        let tint: gpui::Hsla = gpui::rgb(value).into();
        marks.push(Mark {
            range: highlight.from..highlight.content_from,
            style: wrapper,
        });
        marks.push(Mark {
            range: highlight.content_to..highlight.to,
            style: wrapper,
        });
        if highlight.content_to <= highlight.content_from {
            continue;
        }
        let range = highlight.content_from..highlight.content_to;
        if dark {
            washes.push(Highlight {
                range: range.clone(),
                color: tint.opacity(0.18),
            });
            marks.push(Mark {
                range,
                style: MarkStyle {
                    underline: Some(Underline {
                        color: tint.opacity(0.75),
                        wavy: false,
                        thickness: gpui::px(2.),
                    }),
                    ..MarkStyle::default()
                },
            });
        } else {
            washes.push(Highlight {
                range: range.clone(),
                color: tint,
            });
            marks.push(Mark {
                range,
                style: MarkStyle {
                    color: Some(gpui::rgb(0x242426).into()),
                    ..MarkStyle::default()
                },
            });
        }
    }
    (washes, marks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_are_read_with_their_colours() {
        let text = r"a \colorbox[HTML]{fff1a6}{one} \hl{two} \hline \colorbox{yellow}{three}";
        let found = latex_highlights(text);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].color.as_deref(), Some("#FFF1A6"));
        assert_eq!(&text[found[0].content_from..found[0].content_to], "one");
        assert_eq!(found[1].color, None);
        assert_eq!(found[2].color.as_deref(), Some("yellow"));
        assert_eq!(document_colors(text), vec!["#FFF1A6".to_string()]);
    }

    #[test]
    fn highlight_wraps_recolours_and_comes_off() {
        let doc = "a word";
        let edit = highlight_edit(doc, 2..6, Some("#FFF1A6")).unwrap();
        let after = edit.apply(doc);
        assert_eq!(after, r"a \colorbox[HTML]{FFF1A6}{word}");
        let word = after.find("word").unwrap()..after.find("word").unwrap() + 4;
        let around = highlight_around(&after, word.clone()).unwrap();
        assert_eq!(around.color.as_deref(), Some("#FFF1A6"));
        let recolored = highlight_edit(&after, word.clone(), Some("#D3E4FF"))
            .unwrap()
            .apply(&after);
        assert_eq!(recolored, r"a \colorbox[HTML]{D3E4FF}{word}");
        let removed = highlight_edit(&after, word, None).unwrap();
        assert_eq!(removed.apply(&after), doc);
        assert!(highlight_edit(doc, 2..6, None).is_none());
    }

    #[test]
    fn a_highlight_paints_its_text_and_fades_its_wrapper() {
        let text = r"a \colorbox[HTML]{FFF1A6}{word} \hl{other}";
        let (washes, marks) = paint(text, 0, false);
        let word = text.find("word").unwrap();
        assert_eq!(washes.len(), 1);
        assert_eq!(washes[0].range, word..word + 4);
        let (shifted, _) = paint(&text[1..], 1, false);
        assert_eq!(shifted[0].range, word..word + 4);
        assert_eq!(washes[0].color, gpui::rgb(0xFFF1A6).into());
        assert_eq!(
            marks
                .iter()
                .filter(|mark| mark.style.fade.is_some())
                .count(),
            2
        );
        let (dark, _) = paint(text, 0, true);
        assert!(dark[0].color.a < 0.2);
    }
}
