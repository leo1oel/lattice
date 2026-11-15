//! Reviewing the agent's proposal for one annotation, in place, as the
//! Tauri app does (`src/canvas/annotation-review.tsx`,
//! `src/editor/annotation-review-anchor.ts`): a card under the annotated
//! passage, read like Proofread's (`proofread/inline_edits.rs`), with the
//! note it answers and the agent's reason. Accept writes the edits still
//! chosen as one undo step; Reject keeps the passage; Try again asks for
//! another with what the writer wants instead; ↓ and ↑ move between the
//! proposals waiting. The decisions go to the window's revision rounds
//! (`annotations/rounds.rs`), which open the next proposal or end the
//! review.

mod card;

use std::{ops::Range, sync::Arc};

use gpui::{AppContext as _, Context, Entity, Focusable as _, IntoElement as _, Subscription, Window};
use language::{Anchor, ToOffset as _};
use lattice_editor::{
    blocks::{BlockSide, BlockWidget},
    decorations::Highlight,
    latex::protected::ProtectedKind,
    proofread::{self, Review},
};
use lattice_i18n::t;
use lattice_ui::ActiveLattice as _;

use self::card::{ReviewCard, ReviewEvent};
use super::EditorPanel;
use crate::annotations::{
    model::{self, Utf16},
    rounds::{Accepted, AnnotationRounds},
    store,
};

const SOURCE: &str = "annotation-review-source";
const BLOCK: &str = "annotation-review-card";

/// The open review.
pub(super) struct ReviewSession {
    id: String,
    range: Range<Anchor>,
    card: Entity<ReviewCard>,
    rounds: Entity<AnnotationRounds>,
    _subscriptions: Vec<Subscription>,
}

/// The proposal's edits: a citation is what "Add a citation" asks for, so
/// it is offered rather than held back.
fn reviewed(original: &str, proposal: &str, context: &proofread::Context, cite: bool) -> Review {
    let mut review = proofread::review(original, proposal, context);
    if cite {
        let (allowed, held): (Vec<_>, Vec<_>) = std::mem::take(&mut review.held)
            .into_iter()
            .partition(|held| held.kind == ProtectedKind::Reference);
        review.edits.extend(allowed.into_iter().map(|held| held.edit));
        review.edits.sort_by_key(|edit| edit.from);
        review.held = held;
    }
    review
}

impl EditorPanel {
    /// Open `id`'s proposal: its card under the passage, once the passage
    /// is found in this file.
    pub(crate) fn open_annotation_review(
        &mut self,
        id: &str,
        rounds: Entity<AnnotationRounds>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_annotation_review(cx);
        let root = self.project_root(cx);
        let Some(comment) = store::try_store(cx).and_then(|store| store.read(cx).get(&root, id).cloned())
        else {
            return;
        };
        let text = self.buffer.read(cx).text();
        let Some(range) = model::anchor_of(&text, &comment) else {
            cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.close_review(cx)));
            crate::notices::show(
                crate::notices::Notice::new(lattice_ui::components::ToastLevel::Warning, t!("Annotations"))
                    .detail(t!("The annotated passage changed or moved, so its proposal cannot be placed. Ask the agent again from the Annotations panel.")),
                cx,
            );
            return;
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let anchors = snapshot.anchor_after(range.start)..snapshot.anchor_before(range.end);
        let context = proofread::context(&text, range.start, range.end);
        let editable = !self.editor.read(cx).read_only(cx);
        let card = cx.new(|cx| ReviewCard::new(comment, context, editable, window, cx));
        let mut subscriptions = vec![cx.subscribe_in(&card, window, |this, _, event, window, cx| {
            this.review_event(event.clone(), window, cx)
        })];
        // The card follows its annotation, and the rounds, as they change.
        if let Some(store) = store::try_store(cx) {
            subscriptions.push(cx.observe(&store, |this, _, cx| this.refresh_review(cx)));
        }
        subscriptions.push(cx.observe(&rounds, |this, _, cx| this.refresh_review(cx)));
        self.review = Some(ReviewSession {
            id: id.to_string(),
            range: anchors,
            card: card.clone(),
            rounds,
            _subscriptions: subscriptions,
        });
        self.refresh_review(cx);
        // The passage in the middle of the view; the card under it follows.
        let at = editor::MultiBufferOffset(range.start);
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                editor::SelectionEffects::scroll(editor::scroll::Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([at..at]),
            )
        });
        let last = if range.end > range.start { range.end - 1 } else { range.end };
        let line = snapshot.offset_to_point(last).row;
        let wash = crate::annotations::colors::proposed(cx.palette()).opacity(0.12);
        let lattice = self.lattice.clone();
        let block_card = card.clone();
        window.defer(cx, move |window, cx| {
            lattice.update(cx, |lattice, cx| {
                lattice.set_highlights(SOURCE, vec![Highlight { range, color: wash }], cx);
                lattice.set_blocks(
                    BLOCK,
                    vec![BlockWidget {
                        line,
                        side: BlockSide::Below,
                        lines: 4,
                        render: Arc::new(move |_| block_card.clone().into_any_element()),
                    }],
                    cx,
                );
            });
            // The card takes the keys, so ⌘↵, ⌫ and ↓ answer at once.
            let focus = card.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        });
    }

    /// Put the card and its mark away.
    pub(crate) fn close_annotation_review(&mut self, cx: &mut Context<Self>) {
        if self.review.take().is_none() {
            return;
        }
        self.lattice.update(cx, |lattice, cx| {
            lattice.clear_layer(SOURCE, cx);
            lattice.set_blocks(BLOCK, Vec::new(), cx);
        });
        cx.notify();
    }

    /// Show the annotation and the rounds as they are now.
    fn refresh_review(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.review else {
            return;
        };
        let root = self.project_root(cx);
        let Some(comment) = store::try_store(cx).and_then(|store| store.read(cx).get(&root, &session.id).cloned())
        else {
            return;
        };
        let rounds = session.rounds.read(cx);
        let running = rounds.is_running(&session.id);
        let (position, total) = rounds.position(&session.id, cx);
        session.card.update(cx, |card, cx| card.set(comment, running, position, total, cx));
    }

    fn review_event(&mut self, event: ReviewEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = &self.review else {
            return;
        };
        let (id, rounds) = (session.id.clone(), session.rounds.clone());
        // The rounds read this editor's text, so they are asked once its
        // update is over.
        match event {
            ReviewEvent::Accept => self.accept_review(window, cx),
            ReviewEvent::Reject => cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.rejected(&id, cx))),
            ReviewEvent::Retry(guidance) => {
                cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.retry(&id, &guidance, cx)))
            }
            ReviewEvent::Navigate(step) => {
                cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.navigate(&id, step, cx)))
            }
            ReviewEvent::Close => {
                cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.close_review(cx)));
                window.focus(&self.editor.focus_handle(cx), cx);
            }
        }
    }

    /// Write the edits still chosen as one undo step, and tell the rounds
    /// where the passage now stands.
    fn accept_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = &self.review else {
            return;
        };
        let card = session.card.clone();
        let Some((original, chosen)) = card.read(cx).chosen() else {
            return;
        };
        if self.editor.read(cx).read_only(cx) {
            return;
        }
        let snapshot = self.buffer.read(cx).snapshot();
        let from = session.range.start.to_offset(&snapshot);
        let to = session.range.end.to_offset(&snapshot).max(from);
        if snapshot.text_for_range(from..to).collect::<String>() != original {
            let message = t!("The passage changed after the agent read it. Try again to have it read the passage as it is now.");
            card.update(cx, |card, cx| card.set_error(message.to_string(), cx));
            return;
        }
        let revised = proofread::apply_edits(&original, &chosen);
        let (id, rounds) = (session.id.clone(), session.rounds.clone());
        if !chosen.is_empty() {
            self.editor.update(cx, |editor, cx| {
                editor.buffer().update(cx, |buffer, cx| {
                    buffer.finalize_last_transaction(cx);
                    buffer.edit(
                        chosen.iter().map(|edit| {
                            (
                                editor::MultiBufferOffset(from + edit.from)
                                    ..editor::MultiBufferOffset(from + edit.to),
                                edit.insert.as_str(),
                            )
                        }),
                        None,
                        cx,
                    );
                    buffer.finalize_last_transaction(cx);
                });
            });
        }
        let text = self.buffer.read(cx).text();
        let end = from + revised.len();
        let units = Utf16::new(&text);
        let (start16, end16) = (units.to_units(from), units.to_units(end));
        let (prefix, suffix) = model::context(&text, from, end);
        let applied = Accepted {
            from: start16 as u32,
            to: end16 as u32,
            quote: revised,
            prefix,
            suffix,
        };
        self.close_annotation_review(cx);
        cx.defer(move |cx| rounds.update(cx, |rounds, cx| rounds.accepted(&id, applied, cx)));
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    /// Save the open composer's note with Save and revise now, as its
    /// button does.
    pub(crate) fn scripted_save_and_revise(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_note(true, window, cx);
    }

    /// Keep the original for every edit on the open review card.
    pub(crate) fn scripted_review_keep_all(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = &self.review {
            session.card.update(cx, |card, cx| card.keep_all(cx));
        }
    }

    /// The annotation under review, for scripted checks.
    pub(crate) fn reviewing_annotation(&self) -> Option<&str> {
        self.review.as_ref().map(|session| session.id.as_str())
    }
}
