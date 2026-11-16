//! Review mode in the source editor (`src/history/review-mode-extension.ts`):
//! the writer's changes since the base drawn as Overleaf's suggestions are
//! (an insertion underlined over a tint, a deletion struck through at the
//! point it left), in the writer's own colour, with the same hover card to
//! accept or reject one, and the commands the review bar runs.
//!
//! The editor holds the file's base, so accepting a change is an undo step
//! like rejecting one (which edits the text): ⌘Z takes back either, in the
//! order they were made, and the changes are worked out again from the base
//! and the text, so they never disagree with what is on screen. Every base
//! the editor moves to is written back to the store (`history::review_mode`),
//! which saves it.
//!
//! Zed's undo history holds the text's transactions alone, so an accept
//! remembers which transaction was on top of it when it was made: ⌘Z takes
//! the accept back while that transaction is still on top (nothing typed or
//! undone since), and hands the key to the editor otherwise.
//!
//! A co-author's edit that Overleaf's live editing puts in is not the
//! writer's change: the base moves with it (`diff::advanced_base`), and when
//! it lands in text the writer had changed, the bar says so.

use std::{cell::RefCell, ops::Range, rc::Rc};

use editor::{SelectionEffects, ToOffset as _, scroll::Autoscroll};
use gpui::{
    App, Context, Focusable as _, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, Styled as _, WeakEntity, Window, div, px,
};
use language::{BufferSnapshot, TransactionId};
use lattice_editor::{
    decorations::{Mark, MarkStyle, Underline},
    hover::{HoverProvider, HoverTarget},
    inline_texts::{InlineLook, InlineText},
    remote_cursors::hue_color,
};
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Elevation,
    components::{Button, ButtonSize, ButtonVariant},
};

use super::EditorPanel;
use crate::history::review_mode::{
    REVIEW_HUE,
    diff::{self, Described, Hunk},
    store,
};

const LAYER: &str = "review-mode";
/// The tint behind an insertion, and behind a deletion's struck text, as
/// Overleaf's suggestions have them (`overleaf_review.rs`).
const INSERT_TINT: f32 = 0.14;
const DELETE_TINT: f32 = 0.10;

/// An accept, as an undo step: the base before and after it, and the
/// text's transaction on top of the undo history when it was made.
#[derive(Clone)]
struct Step {
    before: String,
    after: String,
    top: Option<TransactionId>,
}

/// The hunks' hover cards: each one's range in the buffer as it was when they
/// were drawn (a deletion covers the character after its point), its index
/// and what it did.
type Cards = Rc<RefCell<Vec<(Range<usize>, usize, Described)>>>;

#[derive(Default)]
pub(super) struct ReviewMarks {
    /// None while review mode is off for this file.
    base: Option<String>,
    /// The text the hunks were worked out against.
    text: String,
    hunks: Vec<Hunk>,
    /// The review mode the base belongs to.
    session: Option<SharedString>,
    undo: Vec<Step>,
    redo: Vec<Step>,
    cards: Cards,
    provider: bool,
    attached: bool,
}

/// What the review bar shows for one editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BarState {
    pub count: usize,
    /// The change at the caret, if the caret is on one.
    pub index: Option<usize>,
}

impl EditorPanel {
    /// Follow the project's review mode: read it, and take its base for this
    /// file whenever it changes (review mode turned on or off).
    pub(super) fn attach_review_marks(&mut self, cx: &mut Context<Self>) {
        if self.review_marks.attached {
            return;
        }
        self.review_marks.attached = true;
        let store = store::store(cx);
        let root = self.project_root(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        cx.observe(&store, |this, _, cx| this.sync_review_base(cx))
            .detach();
        self.sync_review_base(cx);
    }

    /// Take the store's base for this file when it is a new review mode's,
    /// or another editor of the file moved it.
    fn sync_review_base(&mut self, cx: &mut Context<Self>) {
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let root = self.project_root(cx);
        let (base, session) = {
            let store = store.read(cx);
            (store.base_for(&root, &self.relative), store.session(&root))
        };
        if session != self.review_marks.session {
            self.review_marks.session = session;
            self.review_marks.undo.clear();
            self.review_marks.redo.clear();
        } else if base == self.review_marks.base {
            return;
        }
        self.review_marks.base = base;
        self.recompute_review(cx);
    }

    /// The buffer changed: the changes are worked out again.
    pub(super) fn review_edited(&mut self, cx: &mut Context<Self>) {
        if self.review_marks.base.is_some() {
            self.recompute_review(cx);
        }
    }

    /// Overleaf's live editing replaced `before` with the buffer's text: the
    /// base moves with the co-author's edit.
    pub(super) fn review_coauthor_edited(&mut self, before: &str, cx: &mut Context<Self>) {
        let Some(base) = self.review_marks.base.clone() else {
            return;
        };
        let after = self.buffer.read(cx).text();
        let (advanced, touched) = diff::base_after(&base, before, &after);
        if advanced != base {
            // A co-author's edit is no undo step of the writer's.
            self.review_marks.undo.clear();
            self.review_marks.redo.clear();
            self.store_review_base(advanced, cx);
        }
        if touched {
            let root = self.project_root(cx);
            store::store(cx).update(cx, |store, cx| {
                store.set_notice(
                    &root,
                    Some(t!("A co-author edited text you changed. Both versions are kept.").into()),
                    cx,
                )
            });
        }
        self.recompute_review(cx);
    }

    fn store_review_base(&mut self, base: String, cx: &mut Context<Self>) {
        self.review_marks.base = Some(base.clone());
        let root = self.project_root(cx);
        let path = self.relative.clone();
        store::store(cx).update(cx, |store, cx| store.set_base(&root, &path, base, cx));
    }

    /// Work the changes out from the base and the text, and draw them.
    fn recompute_review(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).text();
        let hunks = match &self.review_marks.base {
            Some(base) => diff::hunks(base, &text),
            None => Vec::new(),
        };
        let hue = hue_color(REVIEW_HUE);
        let mut marks = Vec::new();
        let mut inline = Vec::new();
        let mut cards = Vec::new();
        if let Some(base) = &self.review_marks.base {
            for (index, hunk) in hunks.iter().enumerate() {
                let described = diff::describe(base, &text, hunk);
                let removed = hunk.removed(base);
                if !removed.is_empty() {
                    inline.push(InlineText {
                        offset: hunk.from,
                        text: one_line(removed).into(),
                        look: InlineLook::Struck {
                            color: hue,
                            tint: hue.opacity(DELETE_TINT),
                            drawn: 1.,
                        },
                    });
                }
                if hunk.to > hunk.from {
                    marks.push(Mark {
                        range: hunk.from..hunk.to,
                        style: MarkStyle {
                            underline: Some(Underline {
                                color: hue,
                                wavy: false,
                                thickness: px(2.),
                            }),
                            background: Some(hue.opacity(INSERT_TINT)),
                            ..MarkStyle::default()
                        },
                    });
                }
                // A deletion's card sits over the character its text stands
                // before; an insertion's (or a replacement's) over its text.
                let end = if hunk.to > hunk.from {
                    hunk.to
                } else {
                    hunk.from + text[hunk.from..].chars().next().map_or(1, char::len_utf8)
                };
                cards.push((hunk.from..end, index, described));
            }
        }
        *self.review_marks.cards.borrow_mut() = cards;
        if !self.review_marks.provider && self.review_marks.base.is_some() {
            self.review_marks.provider = true;
            let provider = ReviewCards {
                cards: self.review_marks.cards.clone(),
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
        self.review_marks.text = text;
        self.review_marks.hunks = hunks;
        cx.notify();
    }

    /// The review bar's count and the change at the caret, while review mode
    /// is on for this file.
    pub(crate) fn review_bar_state(&self, cx: &App) -> Option<BarState> {
        self.review_marks.base.as_ref()?;
        let head = self.review_caret(cx);
        Some(BarState {
            count: self.review_marks.hunks.len(),
            index: diff::hunk_at(&self.review_marks.hunks, head, false),
        })
    }

    /// The buffer's text, unsaved edits included: what the writer sees.
    pub(crate) fn review_text(&self, cx: &App) -> String {
        self.buffer.read(cx).text()
    }

    fn review_caret(&self, cx: &App) -> usize {
        self.selection_offsets(cx).1
    }

    /// The newest selection's tail and head, as byte offsets.
    fn selection_offsets(&self, cx: &App) -> (usize, usize) {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        (
            selection.tail().to_offset(&snapshot).0,
            selection.head().to_offset(&snapshot).0,
        )
    }

    /// Select `hunk` (its text, or the point a deletion left) and scroll it
    /// to the middle.
    fn select_hunk(&mut self, hunk: Hunk, window: &mut Window, cx: &mut Context<Self>) {
        let (start, end) = {
            let buffer = self.buffer.read(cx);
            (
                buffer.offset_to_point(hunk.from),
                buffer.offset_to_point(hunk.to),
            )
        };
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([start..end]),
            );
        });
    }

    /// Select the next (or previous) change, wrapping round at the end.
    pub(super) fn review_step(
        &mut self,
        forward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (tail, head) = self.selection_offsets(cx);
        let (from, to) = (tail.min(head), tail.max(head));
        let Some(index) = diff::step(&self.review_marks.hunks, from, to, forward) else {
            return;
        };
        let hunk = self.review_marks.hunks[index];
        self.select_hunk(hunk, window, cx);
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    /// Accept (or reject) the change at the caret, then select the next.
    pub(crate) fn review_decide_at_caret(
        &mut self,
        accept: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let head = self.review_caret(cx);
        if let Some(index) = diff::hunk_at(&self.review_marks.hunks, head, false) {
            self.review_decide(index, accept, Some(window), cx);
        }
    }

    /// Accept (or reject) a whole hunk, its deletion and insertion together,
    /// then, given the window, select the next one, as Word's Accept and Move
    /// to Next does.
    pub(super) fn review_decide(
        &mut self,
        index: usize,
        accept: bool,
        window: Option<&mut Window>,
        cx: &mut Context<Self>,
    ) {
        let Some(base) = self.review_marks.base.clone() else {
            return;
        };
        let Some(hunk) = self.review_marks.hunks.get(index).copied() else {
            return;
        };
        let text = self.review_marks.text.clone();
        if accept {
            self.accept_review_base(diff::accepted_base(&base, &text, &hunk), cx);
        } else {
            let edit = diff::reject_edit(&base, &hunk);
            self.buffer.update(cx, |buffer, cx| {
                buffer.edit([(edit.range, edit.insert)], None, cx);
            });
            self.recompute_review(cx);
        }
        let Some(window) = window else {
            return;
        };
        let at = if accept {
            hunk.to
        } else {
            hunk.from + (hunk.base_to - hunk.base_from)
        };
        let hunks = &self.review_marks.hunks;
        if !hunks.is_empty() {
            let next = hunks[diff::hunk_at(hunks, at, true).unwrap_or(0)];
            self.select_hunk(next, window, cx);
        }
    }

    /// Accept every change: the base becomes the text. One undo step.
    pub(super) fn review_accept_all(&mut self, cx: &mut Context<Self>) {
        if self.review_marks.hunks.is_empty() {
            return;
        }
        let text = self.review_marks.text.clone();
        self.accept_review_base(text, cx);
    }

    /// Reject every change: the text goes back to the base. One undo step.
    pub(crate) fn review_reject_all(&mut self, cx: &mut Context<Self>) {
        let Some(base) = self.review_marks.base.clone() else {
            return;
        };
        if self.review_marks.hunks.is_empty() {
            return;
        }
        let edits = diff::reject_all_edits(&base, &self.review_marks.hunks);
        self.buffer.update(cx, |buffer, cx| {
            buffer.edit(
                edits.into_iter().map(|edit| (edit.range, edit.insert)),
                None,
                cx,
            );
        });
        self.recompute_review(cx);
    }

    /// The writer's accept: the base becomes `base`, one undo step.
    fn accept_review_base(&mut self, base: String, cx: &mut Context<Self>) {
        let Some(before) = self.review_marks.base.clone() else {
            return;
        };
        if before == base {
            return;
        }
        let top = self.undo_top(cx);
        self.review_marks.undo.push(Step {
            before,
            after: base.clone(),
            top,
        });
        self.review_marks.redo.clear();
        self.store_review_base(base, cx);
        self.recompute_review(cx);
    }

    fn undo_top(&self, cx: &App) -> Option<TransactionId> {
        self.buffer
            .read(cx)
            .peek_undo_stack()
            .map(|entry| entry.transaction_id())
    }

    /// ⌘Z: take back the last accept, while nothing was typed or undone
    /// since it. False hands the key to the editor.
    pub(super) fn review_undo(&mut self, cx: &mut Context<Self>) -> bool {
        let top = self.undo_top(cx);
        let Some(step) = self.review_marks.undo.last().cloned() else {
            return false;
        };
        if step.top != top || self.review_marks.base.as_deref() != Some(step.after.as_str()) {
            return false;
        }
        self.review_marks.undo.pop();
        self.review_marks.redo.push(step.clone());
        self.store_review_base(step.before, cx);
        self.recompute_review(cx);
        true
    }

    /// ⇧⌘Z: make the accept taken back again, while the text is as it was.
    pub(super) fn review_redo(&mut self, cx: &mut Context<Self>) -> bool {
        let top = self.undo_top(cx);
        let Some(step) = self.review_marks.redo.last().cloned() else {
            return false;
        };
        if step.top != top || self.review_marks.base.as_deref() != Some(step.before.as_str()) {
            return false;
        }
        self.review_marks.redo.pop();
        self.review_marks.undo.push(step.clone());
        self.store_review_base(step.after, cx);
        self.recompute_review(cx);
        true
    }
}

/// A struck deletion reads on one line, as the Tauri app draws it: each
/// line break becomes a space, so the inlay and its measured width agree.
fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\n', '\r'], " ")
}

/// What a hunk did, in words, for its hover card (`describeHunk`).
fn describe(described: &Described) -> SharedString {
    match described {
        Described::Inserted(added) => t!("Inserted “{added}”", added = added).into(),
        Described::Deleted(removed) => t!("Deleted “{removed}”", removed = removed).into(),
        Described::Replaced(removed, added) => t!(
            "Replaced “{removed}” with “{added}”",
            removed = removed,
            added = added
        )
        .into(),
    }
}

/// The hover card over one of the writer's changes.
struct ReviewCards {
    cards: Cards,
    panel: WeakEntity<EditorPanel>,
}

impl HoverProvider for ReviewCards {
    fn target(&self, _: &BufferSnapshot, offset: usize, _: &App) -> Option<HoverTarget> {
        let cards = self.cards.borrow();
        // One card per hunk: a replacement's two halves are accepted together.
        let (range, index, described) = cards
            .iter()
            .find(|(range, _, _)| range.start <= offset && offset < range.end)?
            .clone();
        let panel = self.panel.clone();
        Some(HoverTarget {
            range,
            id: "review-change",
            card: Rc::new(move |_, _, cx| {
                review_card(index, &described, &panel, cx).into_any_element()
            }),
        })
    }
}

/// Who and what, with Accept and Reject for that change alone
/// (`buildTrackedChangeTooltipDom` with the writer as its author).
fn review_card(
    index: usize,
    described: &Described,
    panel: &WeakEntity<EditorPanel>,
    cx: &App,
) -> impl IntoElement {
    let palette = cx.palette().clone();
    let ui = cx.lattice().fonts.ui.clone();
    let action = |label: SharedString, accept: bool, id: &'static str| {
        let panel = panel.clone();
        Button::new(id, label)
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Compact)
            .on_click(move |_, _, cx| {
                panel
                    .update(cx, |panel, cx| panel.review_decide(index, accept, None, cx))
                    .ok();
            })
    };
    div()
        .id("review-change-card")
        .flex()
        .flex_col()
        .gap(px(4.))
        .max_w(px(320.))
        .p(px(10.))
        .rounded(px(8.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .text_color(palette.text)
        .font_family(ui)
        .text_size(px(13.))
        .line_height(px(18.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .size(px(8.))
                        .rounded_full()
                        .flex_none()
                        .bg(hue_color(REVIEW_HUE)),
                )
                .child(
                    div()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child(tc!("the writer, as the author of a tracked change", "You")),
                ),
        )
        .child(div().whitespace_normal().child(describe(described)))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .child(action(t!("Accept").into(), true, "review-change-accept"))
                .child(action(t!("Reject").into(), false, "review-change-reject")),
        )
}
