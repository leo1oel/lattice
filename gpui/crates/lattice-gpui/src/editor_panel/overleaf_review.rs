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

/// A comment thread's passage, in UTF-16 units, with its messages for its
/// margin card.
#[derive(Clone, Debug, PartialEq)]
pub struct CommentMark {
    pub thread_id: String,
    pub from: i64,
    pub len: i64,
    pub color: Hsla,
    pub messages: Vec<MarginMessage>,
}

/// A message as a margin card shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct MarginMessage {
    pub author: SharedString,
    pub color: Hsla,
    /// Its age, as said ("5m ago").
    pub at: String,
    pub content: String,
}

/// A suggestion and what its card says.
#[derive(Clone, Debug, PartialEq)]
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
    /// Resolve a thread (a margin card).
    Resolve(String),
    DeleteThread(String),
    /// Reply to a thread: its composer in the collaboration panel.
    Reply(String),
}

/// The suggestions shown, for the hover card, by byte range of the buffer
/// as it was when they were set (a deletion covers the character after its
/// point, which its struck text stands before).
type Cards = Rc<RefCell<Vec<(Range<usize>, ChangeMark)>>>;

#[derive(Default)]
pub(super) struct ReviewLayer {
    cards: Cards,
    provider: bool,
    /// What was last shown, and the buffer's version it was shown against.
    shown: Option<(clock::Global, Vec<CommentMark>, Vec<ChangeMark>)>,
}

/// The byte offset of each of `units` (UTF-16 positions) in `text`, in one
/// walk of it: clamped to its end and never inside a character.
fn bytes_at(text: &str, units: &[i64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..units.len()).collect();
    order.sort_by_key(|&at| units[at]);
    let mut bytes = vec![text.len(); units.len()];
    let mut characters = text.char_indices().peekable();
    let mut counted = 0i64;
    for at in order {
        while counted < units[at] {
            let Some((_, character)) = characters.next() else {
                break;
            };
            counted += character.len_utf16() as i64;
        }
        bytes[at] = characters.peek().map_or(text.len(), |&(byte, _)| byte);
    }
    bytes
}

/// A struck deletion reads on one line, as it does in the Tauri app: each
/// line break becomes a space, so the inlay and its measured width agree.
fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\n', '\r'], " ")
}

impl EditorPanel {
    /// Show these comments and suggestions in the source.
    pub fn set_overleaf_review(
        &mut self,
        comments: Vec<CommentMark>,
        changes: Vec<ChangeMark>,
        cx: &mut Context<Self>,
    ) {
        let version = self.buffer.read(cx).version();
        if self.overleaf_review.shown.as_ref().is_some_and(
            |(shown, shown_comments, shown_changes)| {
                *shown == version && *shown_comments == comments && *shown_changes == changes
            },
        ) {
            return;
        }
        let text = self.buffer.read(cx).text();
        let units: Vec<i64> = comments
            .iter()
            .flat_map(|comment| [comment.from, comment.from + comment.len])
            .chain(changes.iter().flat_map(|mark| {
                let units = mark.change.text.encode_utf16().count() as i64;
                [mark.change.position, mark.change.position + units]
            }))
            .collect();
        let bytes = bytes_at(&text, &units);
        let (comment_bytes, change_bytes) = bytes.split_at(comments.len() * 2);
        let mut marks = Vec::new();
        let mut inline = Vec::new();
        let mut cards = Vec::new();
        let mut margin = Vec::new();
        for (comment, at) in comments.iter().zip(comment_bytes.chunks(2)) {
            let (from, to) = (at[0], at[1]);
            if from < to {
                marks.push(Mark {
                    range: from..to,
                    style: underlined(comment.color, COMMENT_TINT),
                });
            }
            margin.push(super::margin_review::MarginItem {
                key: format!("comment:{}", comment.thread_id),
                offset: from,
                kind: super::margin_review::ItemKind::Comment(comment.clone()),
            });
        }
        for (mark, at) in changes.iter().cloned().zip(change_bytes.chunks(2)) {
            let hue = hue_color(mark.change.hue as f32);
            let (from, to) = (at[0], at[1]);
            if mark.change.deletion {
                if mark.change.text.is_empty() {
                    continue;
                }
                inline.push(InlineText {
                    offset: from,
                    text: one_line(&mark.change.text).into(),
                    color: hue,
                    tint: hue.opacity(DELETE_TINT),
                });
                let next = text[from..].chars().next().map_or(0, char::len_utf8);
                margin.push(super::margin_review::MarginItem {
                    key: format!("change:{}", mark.change.id),
                    offset: from,
                    kind: super::margin_review::ItemKind::Change(mark.clone()),
                });
                cards.push((from..from + next.max(1), mark));
            } else {
                // A stale suggestion (its text no longer there) is skipped.
                if from >= to || text.get(from..to) != Some(mark.change.text.as_str()) {
                    continue;
                }
                marks.push(Mark {
                    range: from..to,
                    style: underlined(hue, INSERT_TINT),
                });
                margin.push(super::margin_review::MarginItem {
                    key: format!("change:{}", mark.change.id),
                    offset: from,
                    kind: super::margin_review::ItemKind::Change(mark.clone()),
                });
                cards.push((from..to, mark));
            }
        }
        margin.sort_by(|a, b| (a.offset, &a.key).cmp(&(b.offset, &b.key)));
        self.margin.items = margin;
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
        self.overleaf_review.shown = Some((version, comments, changes));
    }
}

impl EditorPanel {
    /// The selection, as a comment would quote it: its start in UTF-16
    /// units and its text; none when nothing is selected.
    pub fn overleaf_selection(&self, cx: &App) -> Option<(i64, String)> {
        use editor::ToOffset as _;
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        let (start, end) = (
            selection.start.to_offset(&snapshot).0,
            selection.end.to_offset(&snapshot).0,
        );
        let (from, to) = (start.min(end), start.max(end));
        let text = self.buffer.read(cx).text();
        let quote = text.get(from..to)?.to_string();
        if quote.trim().is_empty() {
            return None;
        }
        Some((text[..from].encode_utf16().count() as i64, quote))
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
    cards: Cards,
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
    use super::{bytes_at, one_line};

    #[test]
    fn utf16_positions_become_byte_offsets() {
        // "é" is one UTF-16 unit and two bytes; "🔵" two units, four bytes.
        // Asked out of order, each gets its own.
        assert_eq!(bytes_at("é🔵ab", &[3, 1, 99, 0, -1]), vec![6, 2, 8, 0, 0]);
        // Inside the emoji: never splits it.
        assert_eq!(bytes_at("🔵a", &[1]), vec![4]);
    }

    #[test]
    fn a_struck_deletion_across_lines_reads_on_one_line() {
        assert_eq!(one_line("end.\n\nNext"), "end.  Next");
        assert_eq!(one_line("a\r\nb\rc"), "a b c");
        assert_eq!(one_line("same"), "same");
    }
}
