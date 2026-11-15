//! A passage read in place with its suggested edits, as the Tauri app's
//! `InlineEdits` draws it (`src/components/ui/inline-edits.tsx`,
//! `inline-edit-spans.ts`, `inline-edits.css`): one paragraph in the reading
//! font on the typeset role, each edit's old words struck in the secondary
//! ink and its new ones on the success wash, with a quiet tag after it
//! saying why. An edit is a toggle: a click keeps the original, and again
//! makes the edit. Held edits show where they would have been, locked.
//!
//! The source reads as prose, as TeX reads it: a line break is a space and
//! a blank line starts a new paragraph. The text flows as words that wrap;
//! each edit is one piece of that flow, so the pointer over any of its
//! words lights the whole edit and a click on any of them toggles it.

use std::rc::Rc;

use gpui::{
    AnyElement, App, HighlightStyle, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, StrikethroughStyle, Styled as _, StyledText,
    UnderlineStyle, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::LatticeTooltip,
};

/// How an edit is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Made: the old words struck and the new ones marked.
    Applied,
    /// The original stays, and toggling makes the edit again.
    Kept,
    /// The original stays and the edit cannot be chosen.
    Held,
}

/// One suggested change to the passage: `[from, to)` of its text (bytes)
/// becomes `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shown {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub status: Status,
    /// A word or two naming why, drawn as a tag after the edit.
    pub tag: Option<SharedString>,
    /// The longer reason, read in the edit's tooltip.
    pub detail: Option<SharedString>,
}

/// An edit as it is drawn: the span of the passage it covers, widened to
/// whole words, the words there now and the words it would put there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    /// Its index in the edits given.
    pub edit: usize,
    pub from: usize,
    pub to: usize,
    pub deleted: String,
    pub inserted: String,
}

/// How far an edit that cuts into a word widens to show the whole word, in
/// characters.
const WORD_LIMIT: usize = 32;

fn word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| !c.is_whitespace())
}

/// `edits` in order, each widened to whole words when it cuts into one, so
/// ` of the ` → `-of-the-` reads as `state of the art` → `state-of-the-art`,
/// but never into a neighbouring edit's span (`inlineEditSpans`).
pub fn spans(text: &str, edits: &[Shown]) -> Vec<Span> {
    let mut order: Vec<usize> = (0..edits.len()).collect();
    order.sort_by_key(|&index| edits[index].from);
    let mut out: Vec<Span> = Vec::with_capacity(edits.len());
    for (position, &index) in order.iter().enumerate() {
        let edit = &edits[index];
        let floor = out.last().map_or(0, |span| span.to);
        let ceiling = order
            .get(position + 1)
            .map_or(text.len(), |&next| edits[next].from);
        let deleted = &text[edit.from..edit.to];
        let (mut from, mut to) = (edit.from, edit.to);
        if word_char(deleted.chars().next()) || word_char(edit.insert.chars().next()) {
            let mut widened = 0;
            while from > floor && widened < WORD_LIMIT {
                let Some(c) = text[..from].chars().next_back() else { break };
                if c.is_whitespace() {
                    break;
                }
                from -= c.len_utf8();
                widened += 1;
            }
        }
        if word_char(deleted.chars().next_back()) || word_char(edit.insert.chars().next_back()) {
            let mut widened = 0;
            while to < ceiling && widened < WORD_LIMIT {
                let Some(c) = text[to..].chars().next() else { break };
                if c.is_whitespace() {
                    break;
                }
                to += c.len_utf8();
                widened += 1;
            }
        }
        out.push(Span {
            edit: index,
            from,
            to,
            deleted: text[from..to].to_string(),
            inserted: format!("{}{}{}", &text[from..edit.from], edit.insert, &text[edit.to..to]),
        });
    }
    out
}

/// Spaces and line breaks made visible when they are all an edit changes;
/// otherwise runs of space read as one.
fn visible(text: &str) -> String {
    if !text.is_empty() && text.trim().is_empty() {
        text.chars()
            .map(|c| if c == '\n' { '↵' } else { '␣' })
            .collect()
    } else {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

/// What toggling an edit does, given its id.
pub type Toggle = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// The passage with its edits: words that wrap, each edit one piece.
pub fn render(
    id: &'static str,
    text: &str,
    edits: &[Shown],
    on_toggle: Option<Toggle>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let fonts = cx.lattice().fonts.ui.clone();
    let mut flow = div()
        .flex()
        .flex_wrap()
        .items_baseline()
        .font_family(fonts)
        .text_role(TextRole::Typeset, cx)
        .text_color(palette.text);
    let mut cursor = 0;
    for span in spans(text, edits) {
        flow = prose(flow, &text[cursor..span.from], cx);
        cursor = span.to;
        flow = flow.child(edit_piece(id, &edits[span.edit], &span, on_toggle.clone(), cx));
    }
    prose(flow, &text[cursor..], cx).into_any_element()
}

/// Unchanged source as words in the flow; a blank line breaks the paragraph.
fn prose(mut flow: gpui::Div, text: &str, cx: &App) -> gpui::Div {
    let _ = cx;
    let mut paragraphs = text.split("\n\n").peekable();
    let mut first = true;
    while let Some(paragraph) = paragraphs.next() {
        if !first && !paragraph.trim().is_empty() {
            // A whole row of its own, the paragraph's gap tall.
            flow = flow.child(div().w_full().h(px(8.)));
        }
        first = false;
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        let starts_spaced = paragraph.starts_with(char::is_whitespace);
        let ends_spaced = paragraph.ends_with(char::is_whitespace) || paragraphs.peek().is_some();
        let count = words.len();
        for (index, word) in words.into_iter().enumerate() {
            let lead = index == 0 && starts_spaced;
            let trail = index + 1 < count || ends_spaced;
            flow = flow.child(div().whitespace_nowrap().child(SharedString::from(format!(
                "{}{word}{}",
                if lead { " " } else { "" },
                if trail { " " } else { "" },
            ))));
        }
        if count == 0 && (starts_spaced || ends_spaced) && !paragraph.is_empty() {
            flow = flow.child(div().child(" "));
        }
    }
    flow
}

/// One edit: its words as the status draws them, its tag, its tooltip and
/// its toggle.
fn edit_piece(
    id: &'static str,
    edit: &Shown,
    span: &Span,
    on_toggle: Option<Toggle>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let original = visible(&span.deleted);
    let revised = visible(&span.inserted);
    let lead = span.deleted.starts_with(char::is_whitespace) && !span.deleted.trim().is_empty();
    let last = if edit.status == Status::Applied && !span.inserted.is_empty() {
        &span.inserted
    } else {
        &span.deleted
    };
    let trail = !last.trim().is_empty() && last.ends_with(char::is_whitespace);
    // The words, as one run of styled text: struck, then inserted; or the
    // original, underlined as a choice.
    let mut body = String::new();
    let mut styles: Vec<(std::ops::Range<usize>, HighlightStyle)> = Vec::new();
    if lead {
        body.push(' ');
    }
    let struck = HighlightStyle {
        color: Some(palette.text_secondary),
        strikethrough: Some(StrikethroughStyle {
            thickness: px(1.),
            color: Some(palette.danger),
        }),
        ..Default::default()
    };
    let inserted = HighlightStyle {
        color: Some(palette.success),
        background_color: Some(palette.success_soft),
        ..Default::default()
    };
    let kept = HighlightStyle {
        underline: Some(UnderlineStyle {
            thickness: px(1.),
            color: Some(if edit.status == Status::Held {
                palette.warning
            } else {
                palette.line_strong
            }),
            wavy: false,
        }),
        ..Default::default()
    };
    match edit.status {
        Status::Applied => {
            if !original.is_empty() {
                let start = body.len();
                body.push_str(&original);
                styles.push((start..body.len(), struck));
            }
            if !original.is_empty() && !revised.is_empty() {
                // A space, not a margin, between the two, so a narrow line
                // can break there.
                body.push(' ');
            }
            if !revised.is_empty() {
                let start = body.len();
                body.push_str(&revised);
                styles.push((start..body.len(), inserted));
            }
        }
        Status::Kept | Status::Held => {
            if original.is_empty() {
                // A kept insertion has no words of its own: a caret marks
                // where it would go.
                let start = body.len();
                body.push('⁁');
                styles.push((
                    start..body.len(),
                    HighlightStyle {
                        color: Some(palette.text_secondary),
                        ..Default::default()
                    },
                ));
            } else {
                let start = body.len();
                body.push_str(&original);
                styles.push((start..body.len(), kept));
            }
        }
    }
    let words = StyledText::new(SharedString::from(body)).with_highlights(styles);
    let tag = (edit.tag.is_some() || edit.status == Status::Held).then(|| {
        let held = edit.status == Status::Held;
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.))
            .ml(px(2.))
            .px(px(4.))
            .rounded_full()
            .font_family(cx.lattice().fonts.ui.clone())
            .text_role(TextRole::Micro, cx)
            .text_color(if held { palette.warning } else { palette.text_secondary })
            .when(edit.status == Status::Kept, |this| {
                this.border_1().border_color(palette.line)
            })
            .when(edit.status != Status::Kept, |this| this.bg(palette.hover))
            .when(held, |this| this.child(Icon::LOCK.element(px(12.), palette.warning)))
            .children(edit.tag.clone())
    });
    let toggle = on_toggle.filter(|_| edit.status != Status::Held);
    let detail = edit.detail.clone();
    let edit_id = edit.id;
    div()
        .id((id, edit.id))
        .flex()
        .items_baseline()
        .rounded(px(4.))
        .child(words)
        .children(tag)
        .when(trail, |this| this.child(" "))
        .when_some(detail, |this, detail| {
            this.tooltip(move |_, cx| LatticeTooltip::view(detail.clone(), None, cx))
        })
        .when_some(toggle, |this, toggle| {
            this.cursor_pointer()
                .hover(|style| style.bg(palette.hover))
                .active(|style| style.bg(palette.pressed))
                .on_click(move |_, window, cx| toggle(edit_id, window, cx))
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(id: usize, from: usize, to: usize, insert: &str) -> Shown {
        Shown {
            id,
            from,
            to,
            insert: insert.into(),
            status: Status::Applied,
            tag: None,
            detail: None,
        }
    }

    // inline-edit-spans.test.ts's cases: an edit cutting into a word reads
    // as the whole word, never into the next edit's span.
    #[test]
    fn an_edit_inside_a_word_widens_to_the_whole_word() {
        let text = "state of the art";
        let spans = spans(text, &[edit(0, 5, 6, "-"), edit(1, 8, 9, "-"), edit(2, 12, 13, "-")]);
        assert_eq!(spans[0].deleted, "state of");
        assert_eq!(spans[0].inserted, "state-of");
        // The second stops where the first ended.
        assert_eq!(spans[1].from, spans[0].to);
        assert_eq!(spans[1].inserted, "-the");
        assert_eq!(spans[2].deleted, " art");
    }

    #[test]
    fn a_whole_word_edit_stays_put() {
        let text = "a teh cat";
        let spans = spans(text, &[edit(0, 2, 5, "the")]);
        assert_eq!((spans[0].from, spans[0].to), (2, 5));
        assert_eq!(spans[0].inserted, "the");
    }

    #[test]
    fn widening_steps_over_whole_characters() {
        // “数据” is six bytes: widening must not land inside a character.
        let text = "看数据集";
        let from = "看".len();
        let to = from + "数据".len();
        let spans = spans(text, &[edit(0, from, to, "资料")]);
        assert_eq!(spans[0].deleted, "看数据集");
        assert_eq!(spans[0].inserted, "看资料集");
    }

    #[test]
    fn space_only_changes_are_drawn_visible() {
        assert_eq!(visible(" \n"), "␣↵");
        assert_eq!(visible("two  words\nhere"), "two words here");
    }
}
