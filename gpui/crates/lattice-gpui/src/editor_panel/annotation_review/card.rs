//! The proposal's card (`AnnotationReviewCard` in
//! `src/canvas/annotation-review.tsx`, `.annotation-review-*` in
//! `editor-workspace.css`): the pin and the note it answers, then the
//! passage read with the agent's edits (each a toggle, held ones locked),
//! the agent's reason, or what the card is waiting on; then Accept (⌘↵),
//! Reject (⌫), Try again… and, with more than one waiting, "2 of 5 ↓ next".
//! Try again opens a field for what the agent should change, asked with
//! Ask again (Enter) or left with Cancel (Esc).

use std::{collections::BTreeSet, rc::Rc};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, TextareaState};
use lattice_core::project::EditorComment;
use lattice_editor::{
    latex::protected::ProtectedKind,
    proofread::{self, Edit, Review},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Textarea},
    tokens::RADIUS_PANEL,
};

use super::super::proofread::inline_edits::{self, Shown, Status};
use crate::{
    annotations::{card::pin, model},
    build::chip_mark::infinity_loader,
};

/// What the writer asked of the card.
#[derive(Clone, Debug)]
pub enum ReviewEvent {
    Accept,
    Reject,
    Retry(String),
    Navigate(isize),
    Close,
}

pub struct ReviewCard {
    comment: EditorComment,
    context: proofread::Context,
    review: Option<Review>,
    rejected: BTreeSet<usize>,
    editable: bool,
    running: bool,
    position: Option<usize>,
    total: usize,
    error: Option<String>,
    retry: Option<(Entity<TextareaState>, Subscription)>,
    focus: FocusHandle,
}

impl EventEmitter<ReviewEvent> for ReviewCard {}

impl Focusable for ReviewCard {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ReviewCard {
    pub fn new(
        comment: EditorComment,
        context: proofread::Context,
        editable: bool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut card = Self {
            comment: comment.clone(),
            context,
            review: None,
            rejected: BTreeSet::new(),
            editable,
            running: false,
            position: None,
            total: 0,
            error: None,
            retry: None,
            focus: cx.focus_handle(),
        };
        card.review = card.reviewed();
        card
    }

    fn proposal(&self) -> Option<&str> {
        let revision = self.comment.revision.as_ref()?;
        (revision.state == "proposed").then(|| revision.text.as_deref().unwrap_or(""))
    }

    fn original(&self) -> &str {
        self.comment
            .revision
            .as_ref()
            .and_then(|revision| revision.original.as_deref())
            .unwrap_or("")
    }

    fn reviewed(&self) -> Option<Review> {
        let proposal = self.proposal()?;
        let cite = self.comment.intent.as_deref() == Some("cite");
        Some(super::reviewed(self.original(), proposal, &self.context, cite))
    }

    /// Follow the annotation and the rounds as they are now.
    pub fn set(
        &mut self,
        comment: EditorComment,
        running: bool,
        position: Option<usize>,
        total: usize,
        cx: &mut Context<Self>,
    ) {
        // A new proposal starts the choice over.
        let key = |comment: &EditorComment| {
            comment.revision.as_ref().map(|revision| {
                (revision.round, revision.state.clone(), revision.text.clone(), revision.question.clone())
            })
        };
        let changed = key(&comment) != key(&self.comment);
        self.comment = comment;
        if changed {
            self.review = self.reviewed();
            self.rejected.clear();
            self.error = None;
        }
        self.running = running;
        self.position = position;
        self.total = total;
        cx.notify();
    }

    pub fn set_error(&mut self, error: String, cx: &mut Context<Self>) {
        self.error = Some(error);
        cx.notify();
    }

    /// The passage the proposal was made for and the edits still chosen.
    pub fn chosen(&self) -> Option<(String, Vec<Edit>)> {
        let review = self.review.as_ref()?;
        Some((self.original().to_string(), proofread::chosen_edits(review, &self.rejected)))
    }

    fn open_retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("What should the agent change? (optional)"))
                .auto_grow(2, 6)
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let subscription = cx.subscribe_in(&field, window, |this, field, event, window, cx| {
            if let InputEvent::PressEnter { secondary: false, .. } = event {
                let guidance = field.read(cx).value().to_string();
                this.ask_again(guidance, window, cx);
            }
        });
        self.retry = Some((field, subscription));
        cx.notify();
    }

    fn ask_again(&mut self, guidance: String, window: &mut Window, cx: &mut Context<Self>) {
        self.retry = None;
        window.focus(&self.focus, cx);
        cx.emit(ReviewEvent::Retry(guidance));
    }

    /// One of the card's keys, which reach it as the editor's actions (the
    /// card is drawn in the editor, whose keymap binds them): ⌘↵ accepts,
    /// ⌫ rejects, ↑ and ↓ move between proposals, Esc closes.
    fn command(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.retry.is_some() {
            return;
        }
        let decidable = self.proposal().is_some() && !self.running;
        match key {
            "accept" if decidable => cx.emit(ReviewEvent::Accept),
            "reject" if decidable => cx.emit(ReviewEvent::Reject),
            "down" | "up" if self.total > 1 => {
                cx.emit(ReviewEvent::Navigate(if key == "down" { 1 } else { -1 }))
            }
            "close" => cx.emit(ReviewEvent::Close),
            _ => {}
        }
        cx.stop_propagation();
    }

    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        let command = if cfg!(target_os = "macos") { keys.modifiers.platform } else { keys.modifiers.control };
        if self.retry.is_some() {
            // Typing in the field is not a command to the card; Esc leaves it.
            if keys.key == "escape" {
                self.retry = None;
                window.focus(&self.focus, cx);
                cx.stop_propagation();
                cx.notify();
            }
            return;
        }
        let plain = !keys.modifiers.modified();
        let decidable = self.proposal().is_some() && !self.running;
        match keys.key.as_str() {
            "enter" if command => {
                if decidable {
                    cx.emit(ReviewEvent::Accept);
                }
            }
            "backspace" | "delete" if plain => {
                if decidable {
                    cx.emit(ReviewEvent::Reject);
                }
            }
            "down" | "up" if plain && self.total > 1 => {
                cx.emit(ReviewEvent::Navigate(if keys.key == "down" { 1 } else { -1 }));
            }
            "escape" => cx.emit(ReviewEvent::Close),
            _ => return,
        }
        cx.stop_propagation();
    }

    fn passage(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let status = |text: String| {
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_color(palette.text_secondary)
                .child(text)
                .into_any_element()
        };
        if self.running {
            return div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_color(palette.text_secondary)
                .child(infinity_loader("review-loader", px(12.), &palette))
                .child(t!("Asking the agent again…"))
                .into_any_element();
        }
        let revision = self.comment.revision.as_ref();
        match (&self.review, revision) {
            (Some(review), Some(revision)) => {
                let mut shown: Vec<Shown> = review
                    .edits
                    .iter()
                    .map(|edit| Shown {
                        id: edit.id,
                        from: edit.from,
                        to: edit.to,
                        insert: edit.insert.clone(),
                        status: if self.rejected.contains(&edit.id) { Status::Kept } else { Status::Applied },
                        tag: None,
                        detail: None,
                    })
                    .collect();
                shown.extend(review.held.iter().map(|held| Shown {
                    id: held.edit.id,
                    from: held.edit.from,
                    to: held.edit.to,
                    insert: held.edit.insert.clone(),
                    status: Status::Held,
                    tag: Some(held_tag(held.kind).into()),
                    detail: None,
                }));
                let body = if shown.is_empty() {
                    status(t!("The agent suggests leaving the passage as it is.").to_string())
                } else {
                    let card = cx.entity().downgrade();
                    let toggle: inline_edits::Toggle = Rc::new(move |id, _, cx| {
                        card.update(cx, |card, cx| {
                            if !card.rejected.remove(&id) {
                                card.rejected.insert(id);
                            }
                            cx.notify();
                        })
                        .ok();
                    });
                    inline_edits::render("review-edit", self.original(), &shown, Some(toggle), cx)
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(body)
                    .when_some(revision.reason.clone().filter(|reason| !reason.trim().is_empty()), |this, reason| {
                        this.child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(t!("Agent: {0}", reason)),
                        )
                    })
                    .into_any_element()
            }
            (None, Some(revision)) if revision.state == "asked" => status(t!("The agent asks: {0}", revision.question.clone().unwrap_or_default())),
            _ => status(t!("This proposal has been decided.").to_string()),
        }
    }

    fn actions(&self, cx: &mut Context<Self>) -> AnyElement {
        let emit = |event: ReviewEvent, cx: &mut Context<Self>| {
            let card = cx.entity().downgrade();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                card.update(cx, |_, cx| cx.emit(event.clone())).ok();
            }
        };
        let mut row = div().flex().flex_wrap().items_center().gap(px(8.));
        if let Some((field, _)) = &self.retry {
            let ask = field.clone();
            return div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(Textarea::new(field).grows())
                .child(
                    row.child(
                        Button::new("review-ask-again", t!("Ask again"))
                            .compact()
                            .tinted()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let guidance = ask.read(cx).value().to_string();
                                this.ask_again(guidance, window, cx);
                            })),
                    )
                    .child(
                        Button::new("review-retry-cancel", t!("Cancel"))
                            .compact()
                            .ghost()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.retry = None;
                                window.focus(&this.focus, cx);
                                cx.notify();
                            })),
                    ),
                )
                .into_any_element();
        }
        if self.proposal().is_some() && !self.running {
            let offered = self.review.as_ref().map_or(0, |review| review.edits.len());
            let chosen = self.chosen().map_or(0, |(_, chosen)| chosen.len());
            let accept_keys = if cfg!(target_os = "macos") { "⌘↩" } else { "Ctrl+↩" };
            row = row
                .child(
                    Button::new("review-accept", t!("Accept"))
                        .compact()
                        .tinted()
                        .keys(accept_keys)
                        .disabled(!self.editable || (offered > 0 && chosen == 0))
                        .on_click(emit(ReviewEvent::Accept, cx)),
                )
                .child(
                    Button::new("review-reject", t!("Reject"))
                        .compact()
                        .ghost()
                        .keys("⌫")
                        .on_click(emit(ReviewEvent::Reject, cx)),
                );
        }
        if !self.running {
            row = row.child(
                Button::new("review-retry", t!("Try again…"))
                    .compact()
                    .ghost()
                    .icon(Icon::ROTATE_CCW)
                    .on_click(cx.listener(|this, _, window, cx| this.open_retry(window, cx))),
            );
        }
        if let Some(position) = self.position.filter(|_| self.total > 1) {
            let palette = cx.palette().clone();
            let label = t!("{position} of {total}", position = position + 1, total = self.total);
            // "2 of 5 ↓ next", as the Tauri app's ghost button reads.
            row = row.child(
                div()
                    .id("review-next")
                    .ml_auto()
                    .h(px(28.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_color(palette.text_secondary)
                    .hover(|style| style.bg(palette.hover).text_color(palette.text))
                    .child(label)
                    .child(Icon::ARROW_DOWN.element(px(13.), palette.text_secondary))
                    .child(t!("next"))
                    .on_click(emit(ReviewEvent::Navigate(1), cx)),
            );
        }
        row.into_any_element()
    }
}

impl Render for ReviewCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let status = if self.running {
            model::Status::Open
        } else {
            model::Status::Proposed
        };
        let head = div()
            .flex()
            .items_start()
            .gap(px(8.))
            .child(pin(self.comment.number, status, 18., cx))
            .child(
                div()
                    .min_w_0()
                    .text_color(palette.text)
                    .child(SharedString::from(self.comment.body.clone())),
            );
        let passage = self.passage(cx);
        let error = self.error.clone().map(|error| {
            div()
                .flex()
                .items_start()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .child(Icon::CIRCLE_ALERT.element(px(13.), palette.danger))
                .child(div().min_w_0().child(error))
        });
        let actions = self.actions(cx);
        div().pt(px(12.)).px(px(8.)).pb(px(16.)).child(
            div()
                .id("annotation-review-card")
                .track_focus(&self.focus)
                .on_key_down(cx.listener(Self::key))
                .capture_action(cx.listener(|this, _: &editor::actions::NewlineBelow, _, cx| {
                    this.command("accept", cx)
                }))
                .capture_action(cx.listener(|this, _: &editor::actions::Backspace, _, cx| {
                    this.command("reject", cx)
                }))
                .capture_action(cx.listener(|this, _: &editor::actions::Delete, _, cx| {
                    this.command("reject", cx)
                }))
                .capture_action(cx.listener(|this, _: &zed_actions::editor::MoveDown, _, cx| {
                    this.command("down", cx)
                }))
                .capture_action(cx.listener(|this, _: &zed_actions::editor::MoveUp, _, cx| {
                    this.command("up", cx)
                }))
                .capture_action(cx.listener(|this, _: &editor::actions::Cancel, _, cx| {
                    this.command("close", cx)
                }))
                .max_w(px(760.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .p(px(12.))
                .px(px(16.))
                .rounded(RADIUS_PANEL)
                .bg(palette.raised.opacity(0.97))
                .shadow(Elevation::Popover.shadows(&palette))
                .text_role(TextRole::BodyCompact, cx)
                .text_color(palette.text)
                .cursor_default()
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(head)
                .child(passage)
                .children(error)
                .child(actions),
        )
    }
}

/// A held edit's tag: what it would have changed, in a word.
fn held_tag(kind: ProtectedKind) -> String {
    match kind {
        ProtectedKind::Math => t!("math"),
        ProtectedKind::Reference => t!("citation"),
        ProtectedKind::Comment => t!("% comment"),
        ProtectedKind::Command => t!("command"),
        ProtectedKind::Environment => t!("environment"),
        ProtectedKind::Verbatim => t!("verbatim"),
        ProtectedKind::Paragraph => t!("paragraph break"),
    }
    .to_string()
}
