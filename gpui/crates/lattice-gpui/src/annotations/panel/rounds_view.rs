//! The Annotations panel's side of the revision rounds
//! (`annotations/rounds.rs`), as the Tauri panel shows them
//! (`editor-comments-panel.tsx`, `annotation-rounds-view.ts`): a note the
//! agent is answering reads "Revising…"; its question waits on the card with
//! a field for the answer and Answer and revise; a failure says why, with
//! Try again; a card with a proposal opens it for review. The foot offers
//! Review N proposals while any wait, else Revise from N annotations
//! (⇧⌘↵).

use std::collections::HashMap;

use gpui::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Styled as _,
    Window, div, px,
};
use gpui_kit::component::input::{InputEvent, TextareaState};
use lattice_core::project::EditorComment;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Button, Textarea},
    tokens::{SPACING_2, SPACING_3, SPACING_4},
};

use super::AnnotationsPanel;
use crate::annotations::rounds::{self, AnnotationRounds};

/// What the panel keeps of the rounds: the window's rounds, and the answers
/// being typed to the agent's questions, each dropped once sent or once its
/// note no longer waits on a question, so a follow-up starts empty.
#[derive(Default)]
pub(super) struct RoundsView {
    rounds: Option<Entity<AnnotationRounds>>,
    answers: HashMap<String, Entity<TextareaState>>,
    _observe: Option<gpui::Subscription>,
}

impl AnnotationsPanel {
    /// The window's revision rounds, which the panel shows and asks.
    pub fn set_rounds(&mut self, rounds: Entity<AnnotationRounds>, cx: &mut Context<Self>) {
        self.rounds._observe = Some(cx.observe(&rounds, |_, _, cx| cx.notify()));
        self.rounds.rounds = Some(rounds);
        cx.notify();
    }

    /// ⇧⌘↵ in the panel: Revise from annotations.
    pub(super) fn rounds_key(&mut self, event: &gpui::KeyDownEvent, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        let command = if cfg!(target_os = "macos") { keys.modifiers.platform } else { keys.modifiers.control };
        if keys.key != "enter" || !command || !keys.modifiers.shift {
            return;
        }
        if let Some(rounds) = self.rounds.rounds.clone()
            && rounds.read(cx).revisable_count(cx) > 0
        {
            cx.stop_propagation();
            rounds.update(cx, |rounds, cx| rounds.revise(None, cx));
        }
    }

    /// The project's revision rounds.
    pub(super) fn rounds_list(&self, cx: &gpui::App) -> Vec<lattice_core::project::AnnotationRound> {
        self.root
            .as_ref()
            .and_then(|root| self.store.read(cx).notes(root).map(|notes| notes.rounds.clone()))
            .unwrap_or_default()
    }

    /// Whether the agent is answering `id` now.
    pub(super) fn revising(&self, id: &str, cx: &gpui::App) -> bool {
        self.rounds.rounds.as_ref().is_some_and(|rounds| rounds.read(cx).is_running(id))
    }

    /// Open `comment`'s proposal for review, when one waits: whether it did.
    pub(super) fn review_proposal(&self, comment: &EditorComment, cx: &mut Context<Self>) -> bool {
        let proposed = !comment.resolved
            && comment.revision.as_ref().is_some_and(|revision| revision.state == "proposed");
        let Some(rounds) = self.rounds.rounds.clone().filter(|_| proposed) else {
            return false;
        };
        let id = comment.id.clone();
        rounds.update(cx, |rounds, cx| rounds.open_review(&id, cx));
        true
    }

    /// Send the answer typed in `id`'s field (Answer and revise); once the
    /// agent is asked again, the field goes with the question.
    fn send_answer(&mut self, id: &str, cx: &mut Context<Self>) {
        let (Some(field), Some(rounds)) = (self.rounds.answers.get(id).cloned(), self.rounds.rounds.clone())
        else {
            return;
        };
        let text = field.read(cx).value().to_string();
        rounds.update(cx, |rounds, cx| rounds.answer(id, &text, cx));
        if rounds.read(cx).is_running(id) {
            self.rounds.answers.remove(id);
        }
    }

    /// Type `text` into `id`'s answer field and send it, as the writer
    /// would; whether the field was there.
    pub fn scripted_answer(&mut self, id: &str, text: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(field) = self.rounds.answers.get(id).cloned() else {
            return false;
        };
        field.update(cx, |field, cx| field.set_value(text.to_string(), window, cx));
        self.send_answer(id, cx);
        true
    }

    /// The text waiting in `id`'s answer field, while it has one.
    pub fn answer_draft(&self, id: &str, cx: &gpui::App) -> Option<String> {
        self.rounds.answers.get(id).map(|field| field.read(cx).value().to_string())
    }

    /// Under a card: the agent's question with the answer's field, or why
    /// it failed with Try again.
    pub(super) fn round_extras(
        &mut self,
        comment: &EditorComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let rounds = self.rounds.rounds.clone()?;
        let asked = comment.revision.as_ref().is_some_and(|revision| revision.state == "asked");
        if comment.resolved || !asked || rounds.read(cx).is_running(&comment.id) {
            self.rounds.answers.remove(&comment.id);
        }
        let revision = comment.revision.as_ref()?;
        if comment.resolved || rounds.read(cx).is_running(&comment.id) {
            return None;
        }
        let palette = cx.palette().clone();
        let id = comment.id.clone();
        match revision.state.as_str() {
            "asked" => {
                let question = revision.question.clone()?;
                let field = self
                    .rounds
                    .answers
                    .entry(id.clone())
                    .or_insert_with(|| {
                        let field = cx.new(|cx| {
                            TextareaState::new(window, cx)
                                .placeholder(t!("Your answer…"))
                                .auto_grow(2, 6)
                        });
                        let (answer_id, answer_rounds) = (id.clone(), rounds.clone());
                        cx.subscribe(&field, move |this, field, event: &InputEvent, cx| match event {
                            InputEvent::PressEnter { secondary: true, .. } => {
                                let text = field.read(cx).value().to_string();
                                answer_rounds.update(cx, |rounds, cx| rounds.answer(&answer_id, &text, cx));
                                if answer_rounds.read(cx).is_running(&answer_id) {
                                    this.rounds.answers.remove(&answer_id);
                                }
                            }
                            InputEvent::Change => cx.notify(),
                            _ => {}
                        })
                        .detach();
                        field
                    })
                    .clone();
                let filled = !field.read(cx).value().trim().is_empty();
                Some(
                    div()
                        .ml(px(30.))
                        .flex()
                        .flex_col()
                        .gap(SPACING_3)
                        .p(SPACING_3)
                        .rounded(px(6.))
                        .bg(crate::annotations::colors::asked(&palette).opacity(0.08))
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(crate::annotations::colors::asked(&palette))
                                .child(t!("The agent asks")),
                        )
                        .child(div().text_role(TextRole::Body, cx).child(question))
                        .child(Textarea::new(&field).grows())
                        .child(
                            div().flex().child(
                                Button::new(("annotation-answer", super::cards::hash(&id)), t!("Answer and revise"))
                                    .compact()
                                    .tinted()
                                    .disabled(!filled)
                                    .on_click(cx.listener(move |this, _, _, cx| this.send_answer(&id, cx))),
                            ),
                        )
                        .into_any_element(),
                )
            }
            "failed" => {
                let error = revision.error.clone()?;
                Some(
                    div()
                        .ml(px(30.))
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap(SPACING_2)
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.danger)
                        .child(error)
                        .child(
                            Button::new(("annotation-retry", super::cards::hash(&id)), t!("Try again"))
                                .compact()
                                .ghost()
                                .on_click(move |_, _, cx| {
                                    rounds.update(cx, |rounds, cx| rounds.retry(&id, "", cx));
                                }),
                        )
                        .into_any_element(),
                )
            }
            _ => None,
        }
    }

    /// The round in progress, over the list: what the agent is doing, and
    /// how far it is (`.annotations-round`).
    pub(super) fn rounds_banner(
        &self,
        notes: &[EditorComment],
        rounds_list: &[lattice_core::project::AnnotationRound],
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let rounds = self.rounds.rounds.as_ref()?.read(cx);
        let refs: Vec<&EditorComment> = notes.iter().collect();
        let running = |id: &str| rounds.is_running(id);
        let (round, total, answered, still) = rounds::round_progress(rounds_list, &refs, &running)?;
        let proposals = rounds::pending_proposals(&refs).len();
        if still == 0 && proposals == 0 {
            return None;
        }
        let text = if still > 0 {
            t!("Agent is revising, {0} of {1} answered", answered, total)
        } else if proposals == 1 {
            t!("Round {0}, 1 proposal to review", round)
        } else {
            t!("Round {0}, {1} proposals to review", round, proposals)
        };
        let palette = cx.palette().clone();
        let ink = crate::annotations::colors::proposed(&palette);
        let share = if total == 0 { 0. } else { answered as f32 / total as f32 };
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x(SPACING_4)
                .gap_y(SPACING_2)
                .mb(SPACING_2)
                .mt(SPACING_3)
                .px(px(10.))
                .py(SPACING_4)
                .rounded(px(6.))
                .bg(ink.opacity(0.07))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text)
                .child(div().min_w_0().flex_1().child(text))
                .child(
                    div()
                        .w(px(88.))
                        .h(px(4.))
                        .rounded_full()
                        .overflow_hidden()
                        .bg(palette.pressed)
                        .child(div().h_full().w(gpui::relative(share)).bg(ink)),
                )
                .into_any_element(),
        )
    }

    /// The foot: Review N proposals while any wait, else Revise from N
    /// annotations.
    pub(super) fn rounds_foot(&self, notes: &[EditorComment], cx: &mut Context<Self>) -> Option<AnyElement> {
        let rounds = self.rounds.rounds.clone()?;
        if notes.is_empty() {
            return None;
        }
        let refs: Vec<&EditorComment> = notes.iter().collect();
        let proposals = rounds::pending_proposals(&refs);
        let palette = cx.palette().clone();
        let button = if let Some(first) = proposals.first() {
            let count = proposals.len();
            let label = if count == 1 {
                t!("Review 1 proposal").to_string()
            } else {
                t!("Review {0} proposals", count)
            };
            let first = first.id.clone();
            Button::new("annotations-review", label)
                .tinted()
                .on_click(move |_, _, cx| rounds.update(cx, |rounds, cx| rounds.open_review(&first, cx)))
        } else {
            let count = rounds.read(cx).revisable_count(cx);
            let label = match count {
                0 => t!("Revise from annotations").to_string(),
                1 => t!("Revise from 1 annotation").to_string(),
                count => t!("Revise from {0} annotations", count),
            };
            let keys = if cfg!(target_os = "macos") { "⇧⌘↩" } else { "Ctrl+Shift+↩" };
            Button::new("annotations-revise", label)
                .tinted()
                .keys(keys)
                .disabled(count == 0)
                .on_click(move |_, _, cx| rounds.update(cx, |rounds, cx| rounds.revise(None, cx)))
        };
        Some(
            div()
                .flex()
                .flex_col()
                .py(SPACING_4)
                .border_t_1()
                .border_color(palette.line)
                .child(button.w_full())
                .into_any_element(),
        )
    }
}
