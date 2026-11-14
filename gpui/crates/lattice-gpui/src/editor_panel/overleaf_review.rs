//! Overleaf's review in the source (`src/overleaf/overleaf-editor-extensions.ts`):
//! a comment thread's passage marked in its author's colour, a suggested
//! insertion underlined in its author's hue over a tint, a suggested
//! deletion shown at its point as its removed text struck through, and, over
//! a suggestion, a card saying who suggested what with Accept and Reject.
//!
//! Positions arrive in Overleaf's UTF-16 units of the text and are turned
//! into the buffer's bytes here, against the buffer as it is when they are
//! set; the adapter anchors them, so they ride along with typing until the
//! next set.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    Styled as _, WeakEntity, div, prelude::FluentBuilder as _, px,
};
use language::BufferSnapshot;
use lattice_core::overleaf_rt::TrackedChange;
use lattice_editor::{
    decorations::{Mark, MarkStyle, Underline},
    hover::{HoverProvider, HoverTarget},
    inline_texts::InlineText,
    remote_cursors::hue_color,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation,
    components::{Button, ButtonSize, ButtonVariant},
};

use super::{EditorPanel, EditorPanelEvent};

const LAYER: &str = "overleaf-review";
/// The tint behind a suggested insertion, and behind a deletion's text.
const INSERT_TINT: f32 = 0.14;
const DELETE_TINT: f32 = 0.10;
/// A comment's tint, as strong as the palette's own light colours.
const COMMENT_TINT: f32 = 0.28;

/// A comment thread's passage, in UTF-16 units.
#[derive(Clone, Debug)]
pub struct CommentMark {
    pub thread_id: String,
    pub from: i64,
    pub len: i64,
    pub color: Hsla,
}

/// A suggestion and what its card says.
#[derive(Clone, Debug)]
pub struct ChangeMark {
    pub change: TrackedChange,
    pub author: SharedString,
    /// This account may accept or reject it.
    pub can_act: bool,
}

/// What the writer asked of a suggestion on its card.
#[derive(Clone, Debug, PartialEq)]
pub enum ReviewAction {
    Accept(String),
    Reject(String),
}

/// The suggestions shown, for the hover card, by byte range of the buffer
/// as it was when they were set (a deletion covers the character after its
/// point, which its struck text stands before).
#[derive(Default)]
pub(super) struct ReviewLayer {
    cards: Rc<RefCell<Vec<(Range<usize>, ChangeMark)>>>,
    provider: bool,
}

/// The byte offset `units` UTF-16 units into `text`, clamped to its end and
/// never inside a character.
fn byte_at(text: &str, units: i64) -> usize {
    let mut counted = 0i64;
    for (byte, character) in text.char_indices() {
        if counted >= units {
            return byte;
        }
        counted += character.len_utf16() as i64;
    }
    text.len()
}

impl EditorPanel {
    /// Show these comments and suggestions in the source.
    pub fn set_overleaf_review(
        &mut self,
        comments: Vec<CommentMark>,
        changes: Vec<ChangeMark>,
        cx: &mut Context<Self>,
    ) {
        let text = self.buffer.read(cx).text();
        let mut marks = Vec::new();
        let mut inline = Vec::new();
        let mut cards = Vec::new();
        for comment in &comments {
            let from = byte_at(&text, comment.from);
            let to = byte_at(&text, comment.from + comment.len);
            if from < to {
                marks.push(Mark {
                    range: from..to,
                    style: underlined(comment.color, COMMENT_TINT),
                });
            }
        }
        for mark in changes {
            let hue = hue_color(mark.change.hue as f32);
            let from = byte_at(&text, mark.change.position);
            if mark.change.deletion {
                if mark.change.text.is_empty() {
                    continue;
                }
                inline.push(InlineText {
                    offset: from,
                    text: mark.change.text.clone().into(),
                    color: hue,
                    tint: hue.opacity(DELETE_TINT),
                });
                let next = text[from..].chars().next().map_or(0, char::len_utf8);
                cards.push((from..from + next.max(1), mark));
            } else {
                let units = mark.change.text.encode_utf16().count() as i64;
                let to = byte_at(&text, mark.change.position + units);
                // A stale suggestion (its text no longer there) is skipped.
                if from >= to || text.get(from..to) != Some(mark.change.text.as_str()) {
                    continue;
                }
                marks.push(Mark {
                    range: from..to,
                    style: underlined(hue, INSERT_TINT),
                });
                cards.push((from..to, mark));
            }
        }
        *self.overleaf_review.cards.borrow_mut() = cards;
        if !self.overleaf_review.provider {
            self.overleaf_review.provider = true;
            let provider = ChangeCards {
                cards: self.overleaf_review.cards.clone(),
                panel: cx.weak_entity(),
            };
            self.lattice.update(cx, |lattice, _| {
                lattice.add_hover_provider(Rc::new(provider))
            });
        }
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_marks(LAYER, marks, cx);
            lattice.set_inline_texts(LAYER, inline, cx);
        });
    }
}

fn underlined(color: Hsla, tint: f32) -> MarkStyle {
    MarkStyle {
        underline: Some(Underline {
            color,
            wavy: false,
            thickness: px(2.),
        }),
        background: Some(color.opacity(tint)),
        ..MarkStyle::default()
    }
}

/// The hover card over a suggestion.
struct ChangeCards {
    cards: Rc<RefCell<Vec<(Range<usize>, ChangeMark)>>>,
    panel: WeakEntity<EditorPanel>,
}

impl HoverProvider for ChangeCards {
    fn target(&self, _: &BufferSnapshot, offset: usize, _: &App) -> Option<HoverTarget> {
        let cards = self.cards.borrow();
        let hits: Vec<_> = cards
            .iter()
            .filter(|(range, _)| range.start <= offset && offset < range.end)
            .collect();
        let start = hits.iter().map(|(range, _)| range.start).min()?;
        let end = hits.iter().map(|(range, _)| range.end).max()?;
        let marks: Vec<ChangeMark> = hits.into_iter().map(|(_, mark)| mark.clone()).collect();
        let panel = self.panel.clone();
        Some(HoverTarget {
            range: start..end,
            id: "overleaf-suggestion",
            card: Rc::new(move |_, _, cx| change_card(&marks, &panel, cx).into_any_element()),
        })
    }
}

/// For each suggestion: who and what, and Accept and Reject for that one
/// alone (`buildTrackedChangeTooltipDom`).
fn change_card(
    marks: &[ChangeMark],
    panel: &WeakEntity<EditorPanel>,
    cx: &App,
) -> impl IntoElement {
    let palette = cx.palette().clone();
    let ui = cx.lattice().fonts.ui.clone();
    let mut card = div()
        .id("overleaf-suggestion-card")
        .flex()
        .flex_col()
        .gap(px(8.))
        .max_w(px(320.))
        .p(px(10.))
        .rounded(px(8.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .text_color(palette.text)
        .font_family(ui)
        .text_size(px(13.))
        .line_height(px(18.));
    for (index, mark) in marks.iter().enumerate() {
        let change = &mark.change;
        let text = change.text.clone();
        let body = if change.deletion {
            t!("Suggests removing \"{text}\"", text = &text)
        } else {
            t!("Suggests inserting \"{text}\"", text = &text)
        };
        let action = |label: SharedString, act: ReviewAction, id: (&'static str, usize)| {
            let panel = panel.clone();
            Button::new(id, label)
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Compact)
                .disabled(!mark.can_act)
                .on_click(move |_, _, cx| {
                    let act = act.clone();
                    panel
                        .update(cx, |_, cx| cx.emit(EditorPanelEvent::OverleafReview(act)))
                        .ok();
                })
        };
        let head = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .size(px(8.))
                    .rounded_full()
                    .flex_none()
                    .bg(hue_color(change.hue as f32)),
            )
            .child(
                div()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(mark.author.clone()),
            )
            .children(change.timestamp.as_deref().map(|at| {
                div()
                    .ml_auto()
                    .text_size(px(11.))
                    .text_color(palette.text_secondary)
                    .child(crate::overleaf::picker::relative_time(at))
            }));
        let item = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .when(index > 0, |this| {
                this.pt(px(8.)).border_t_1().border_color(palette.line)
            })
            .child(head)
            .child(div().whitespace_normal().child(body))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(action(
                        t!("Accept").into(),
                        ReviewAction::Accept(change.id.clone()),
                        ("overleaf-suggestion-accept", index),
                    ))
                    .child(action(
                        t!("Reject").into(),
                        ReviewAction::Reject(change.id.clone()),
                        ("overleaf-suggestion-reject", index),
                    )),
            );
        card = card.child(item);
    }
    card
}

#[cfg(test)]
mod tests {
    use super::byte_at;

    #[test]
    fn utf16_positions_become_byte_offsets() {
        // "é" is one UTF-16 unit and two bytes; "🔵" two units, four bytes.
        assert_eq!(byte_at("é🔵ab", 1), 2);
        assert_eq!(byte_at("é🔵ab", 3), 6);
        assert_eq!(byte_at("é🔵ab", 99), 8);
        // Inside the emoji: never splits it.
        assert_eq!(byte_at("🔵a", 1), 4);
    }
}
