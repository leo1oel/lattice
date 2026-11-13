//! A passage read in place with its edits, ported from the Tauri app's
//! `InlineEdits` (`src/components/ui/inline-edits.tsx`, `inline-edits.css`)
//! as the history reads a version: one paragraph in the reading font (the
//! interface sans, `--reading-font` in theme.css) at the typeset size, each
//! edit's old words struck in the secondary ink with a 1px danger line and
//! its new words in the success ink on the success wash, a line break read
//! as a space as TeX reads it and a blank line as a new paragraph.
//!
//! The passage becomes one string with its marked ranges, drawn as one
//! styled text, so it wraps as the prose does.

use std::{ops::Range, sync::LazyLock};

use gpui::{
    AnyElement, App, HighlightStyle, IntoElement, ParentElement as _, SharedString,
    StrikethroughStyle, Styled as _, StyledText, div, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};
use regex::Regex;

use super::prose::{InlineEdit, ProsePassage, inline_edit_spans};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Deleted,
    Inserted,
    /// The "…" where a passage is cut out of a longer paragraph.
    Gap,
}

static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the spaces pattern compiles"));
static PARAGRAPH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n[^\S\n]*\n\s*").expect("the paragraph pattern compiles"));

/// Spaces and line breaks made visible when they are all an edit changes.
fn visible(text: &str) -> String {
    if !text.is_empty() && text.trim().is_empty() {
        text.chars()
            .map(|c| if c == '\n' { '↵' } else { '␣' })
            .collect()
    } else {
        SPACES.replace_all(text, " ").into_owned()
    }
}

struct Builder {
    text: String,
    marks: Vec<(Range<usize>, Mark)>,
}

impl Builder {
    fn plain(&mut self, text: &str) {
        self.text.push_str(text);
    }

    fn mark(&mut self, text: &str, mark: Mark) {
        let start = self.text.len();
        self.text.push_str(text);
        self.marks.push((start..self.text.len(), mark));
    }

    /// Unchanged source read as prose: a line break is a space, and a blank
    /// line starts a new paragraph.
    fn prose(&mut self, text: &str) {
        for (index, paragraph) in PARAGRAPH.split(text).enumerate() {
            if index > 0 {
                self.text.push('\n');
            }
            self.plain(&SPACES.replace_all(paragraph, " "));
        }
    }

    /// `text`'s edge spaces drawn outside its mark, so the strike and the
    /// wash cover words only; `last`: the edit's final words, whose trailing
    /// space the edit draws itself.
    fn marked(&mut self, text: &str, mark: Mark, last: bool) {
        if text.trim().is_empty() {
            self.mark(&visible(text), mark);
            return;
        }
        let core = text.trim();
        let leading = text.len() - text.trim_start().len() > 0;
        let trailing = text.len() - text.trim_end().len() > 0;
        if leading {
            self.plain(" ");
        }
        self.mark(&visible(core), mark);
        if trailing && !last {
            self.plain(" ");
        }
    }
}

/// The passage's text with its edits made, and the ranges each is marked over.
pub fn marked_text(text: &str, edits: &[InlineEdit]) -> (String, Vec<(Range<usize>, Mark)>) {
    let mut out = Builder {
        text: String::with_capacity(text.len()),
        marks: Vec::new(),
    };
    let mut cursor = 0;
    for span in inline_edit_spans(text, edits) {
        out.prose(&text[cursor..span.from]);
        cursor = span.to;
        let (original, revised) = (span.deleted.as_str(), span.inserted.as_str());
        if !original.is_empty() {
            out.marked(original, Mark::Deleted, revised.is_empty());
        }
        if !original.is_empty() && !revised.is_empty() {
            out.plain(" ");
        }
        if !revised.is_empty() {
            out.marked(revised, Mark::Inserted, true);
        }
        let last = if revised.is_empty() {
            original
        } else {
            revised
        };
        if !last.trim().is_empty() && last.ends_with(char::is_whitespace) {
            out.plain(" ");
        }
    }
    out.prose(&text[cursor..]);
    (out.text, out.marks)
}

/// A passage as the reader draws it, `…` where it is cut from a paragraph,
/// in the reading font at the typeset size.
pub fn passage_text(passage: &ProsePassage, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (body, marks) = marked_text(&passage.text, &passage.edits);
    let mut text = String::new();
    let mut runs: Vec<(Range<usize>, Mark)> = Vec::new();
    if passage.clipped_start {
        text.push_str("… ");
        runs.push((0.."…".len(), Mark::Gap));
    }
    let offset = text.len();
    text.push_str(&body);
    runs.extend(
        marks
            .into_iter()
            .map(|(range, mark)| (range.start + offset..range.end + offset, mark)),
    );
    if passage.clipped_end {
        let start = text.len() + 1;
        text.push_str(" …");
        runs.push((start..text.len(), Mark::Gap));
    }
    let highlights = runs.into_iter().map(|(range, mark)| {
        let style = match mark {
            Mark::Deleted => HighlightStyle {
                color: Some(palette.text_secondary),
                strikethrough: Some(StrikethroughStyle {
                    thickness: px(1.),
                    color: Some(palette.danger),
                }),
                ..HighlightStyle::default()
            },
            Mark::Inserted => HighlightStyle {
                color: Some(palette.success),
                background_color: Some(palette.success_soft),
                ..HighlightStyle::default()
            },
            Mark::Gap => HighlightStyle {
                color: Some(palette.text_secondary),
                ..HighlightStyle::default()
            },
        };
        (range, style)
    });
    let text: SharedString = text.into();
    div()
        .min_w_0()
        .text_role(TextRole::Typeset, cx)
        .text_color(palette.text)
        .child(StyledText::new(text.clone()).with_highlights(highlights.collect::<Vec<_>>()))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::prose::prose_passages;

    fn read(text: &str, marks: &[(Range<usize>, Mark)]) -> Vec<(String, Mark)> {
        marks
            .iter()
            .map(|(range, mark)| (text[range.clone()].to_string(), *mark))
            .collect()
    }

    #[test]
    fn strikes_the_old_words_and_marks_the_new() {
        let passages = prose_passages("The cat sat.\n", "The dog sat.\n").unwrap();
        let (text, marks) = marked_text(&passages[0].text, &passages[0].edits);
        assert_eq!(text, "The cat dog sat.");
        assert_eq!(
            read(&text, &marks),
            vec![
                ("cat".into(), Mark::Deleted),
                ("dog".into(), Mark::Inserted)
            ]
        );
    }

    #[test]
    fn reads_line_breaks_as_spaces_and_shows_a_changed_space() {
        let (text, _) = marked_text("one\ntwo\n\nthree", &[]);
        assert_eq!(text, "one two\nthree");
        let edits = [InlineEdit {
            id: 0,
            from: 3,
            to: 4,
            insert: "\n".into(),
        }];
        let (text, marks) = marked_text("one two", &edits);
        assert_eq!(read(&text, &marks)[1], ("↵".into(), Mark::Inserted));
    }
}
