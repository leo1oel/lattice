//! The inline proofread card, as the Tauri app draws it under the selection
//! it answers (`src/canvas/proofread-card.tsx`, `.proofread-card` in
//! `editor-workspace.css` and `surfaces.css`): the strength switch
//! (Proofread | Polish) or a rewrite's own instruction, the summary with the
//! loader while the agent works, skeleton lines where the answer will be,
//! then the selection read in place with each edit struck and inserted
//! (`inline_edits.rs`), the edits Lattice held back, an error, and the
//! actions: Accept (⌘↵), Accept all, Discard (Esc); Try again and Dismiss
//! after an error; Cancel while loading, Done when nothing was suggested.
//!
//! It unrolls downward from the selection on the slow tier, and its answer
//! comes up first as the passage, then each edit in turn.

use std::{collections::BTreeSet, rc::Rc};

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Context, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_editor::{
    latex::protected::ProtectedKind,
    proofread::{self, Ask, Category, Review},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, Motion, TextRole, TextRoleStyle as _,
    components::{Button, Segmented},
    tokens::RADIUS_PANEL,
};

use super::inline_edits::{self, Shown, Status};
use crate::{build::chip_mark::infinity_loader, overleaf::parts::sheen};

/// What the card shows.
#[derive(Clone, Debug)]
pub enum CardState {
    Loading,
    Ready {
        review: Review,
        /// The offered edits the writer turned down; every other one is
        /// applied.
        rejected: BTreeSet<usize>,
        /// The model that answered, once the runtime reports one.
        model: Option<String>,
    },
    Error {
        message: String,
        retryable: bool,
    },
}

/// What the writer asked of the card.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardEvent {
    /// Apply the edits still made (⌘↵).
    Accept,
    /// Apply every offered edit.
    AcceptAll,
    /// Discard, dismiss, cancel or done (Esc).
    Dismiss,
    /// Ask again with the same ask.
    Retry,
    /// Ask again at the other strength.
    Mode(Ask),
    /// Keep the original for an edit (`false`), or make it again (`true`).
    Choose(usize, bool),
}

pub struct ProofreadCard {
    original: String,
    ask: Ask,
    state: CardState,
    editable: bool,
    /// Bumped with each answer, which replays its entrance.
    answered: usize,
}

impl EventEmitter<CardEvent> for ProofreadCard {}

/// About how many characters of the selection one line of the card holds.
const PLACEHOLDER_LINE_CHARACTERS: usize = 90;
/// How far apart, at most, the card is from its surface's edges.
const MAX_WIDTH: f32 = 760.;

impl ProofreadCard {
    pub fn new(original: String, ask: Ask, editable: bool) -> Self {
        Self {
            original,
            ask,
            state: CardState::Loading,
            editable,
            answered: 0,
        }
    }

    pub fn state(&self) -> &CardState {
        &self.state
    }

    pub fn ask(&self) -> &Ask {
        &self.ask
    }

    /// Show `state` for `ask` about `original`.
    pub fn set(&mut self, original: String, ask: Ask, state: CardState, cx: &mut Context<Self>) {
        if matches!(state, CardState::Ready { .. }) {
            self.answered += 1;
        }
        self.original = original;
        self.ask = ask;
        self.state = state;
        cx.notify();
    }

    pub fn set_state(&mut self, state: CardState, cx: &mut Context<Self>) {
        let (original, ask) = (self.original.clone(), self.ask.clone());
        self.set(original, ask, state, cx);
    }

    /// Toggle an edit's choice, the card's own business until accepted.
    pub fn choose(&mut self, id: usize, accepted: bool, cx: &mut Context<Self>) {
        if let CardState::Ready { rejected, .. } = &mut self.state {
            if accepted {
                rejected.remove(&id);
            } else {
                rejected.insert(id);
            }
            cx.notify();
        }
    }

    /// How many edits are offered, and how many of them are still made.
    pub fn counts(&self) -> (usize, usize) {
        match &self.state {
            CardState::Ready {
                review, rejected, ..
            } => (
                review.edits.len(),
                proofread::chosen_edits(review, rejected).len(),
            ),
            _ => (0, 0),
        }
    }

    fn summary(&self) -> SharedString {
        let rewrite = matches!(self.ask, Ask::Instruction(_));
        let polishing = matches!(self.ask, Ask::Polish);
        match &self.state {
            CardState::Loading if rewrite => t!("Rewriting…").into(),
            CardState::Loading if polishing => t!("Polishing…").into(),
            CardState::Loading => t!("Proofreading…").into(),
            CardState::Error { .. } if rewrite => t!("Could not rewrite").into(),
            CardState::Error { .. } if polishing => t!("Could not polish").into(),
            CardState::Error { .. } => t!("Could not proofread").into(),
            CardState::Ready { review, .. } => match review.edits.len() {
                0 if !review.held.is_empty() => t!("No safe edits").into(),
                0 => t!("No changes suggested").into(),
                1 => t!("1 edit").into(),
                offered => t!("{offered} edits", offered = offered).into(),
            },
        }
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let lead: AnyElement = match &self.ask {
            Ask::Instruction(instruction) => div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(palette.text)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(SharedString::from(instruction.clone()))
                .into_any_element(),
            ask => {
                let current = ask.clone();
                let mut switch = Segmented::new("proofread-mode").filled();
                for (mode, label) in [
                    (Ask::Proofread, t!("Proofread")),
                    (Ask::Polish, t!("Polish")),
                ] {
                    let selected = mode == current;
                    let this = cx.entity().downgrade();
                    switch = switch.label(label, selected, move |_, _, cx| {
                        if !selected {
                            this.update(cx, |_, cx| cx.emit(CardEvent::Mode(mode.clone())))
                                .ok();
                        }
                    });
                }
                switch.into_any_element()
            }
        };
        let model = match &self.state {
            CardState::Ready {
                model: Some(model), ..
            } => Some(model.clone()),
            _ => None,
        };
        let summary = div()
            .ml_auto()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .when(matches!(self.state, CardState::Loading), |this| {
                this.child(infinity_loader("proofread-loader", px(12.), &palette))
            })
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(self.summary()),
            )
            .when_some(model, |this, model| {
                this.child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .pl(px(4.))
                        .child(SharedString::from(model)),
                )
            });
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(12.))
            .gap_y(px(8.))
            .min_w_0()
            .child(lead)
            .child(summary)
            .into_any_element()
    }

    /// Where the answer will be, while the agent works: a line for about
    /// each line the selection will take, at most three, under the sheen.
    fn placeholder(&self, cx: &App) -> AnyElement {
        let palette = cx.palette().clone();
        let lines = self
            .original
            .chars()
            .count()
            .div_ceil(PLACEHOLDER_LINE_CHARACTERS)
            .clamp(1, 3);
        let mut skeleton = div()
            .relative()
            .overflow_hidden()
            .flex()
            .flex_col()
            .gap(px(16.))
            .py(px(12.))
            .px(px(2.))
            .rounded(px(4.));
        for index in 0..lines {
            let width = if lines > 1 && index + 1 == lines {
                gpui::relative(0.62)
            } else if index == 1 {
                gpui::relative(0.9)
            } else {
                gpui::relative(1.)
            };
            skeleton = skeleton.child(div().h(px(16.)).w(width).rounded_full().bg(palette.line));
        }
        skeleton
            .child(sheen("proofread-sheen", palette.raised))
            .into_any_element()
    }

    /// The selection with the edits, offered and held.
    fn passage(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let CardState::Ready {
            review, rejected, ..
        } = &self.state
        else {
            return None;
        };
        let keep_hint = t!("Click to keep the original");
        let mut shown: Vec<Shown> = review
            .edits
            .iter()
            .map(|edit| {
                let status = if rejected.contains(&edit.id) {
                    Status::Kept
                } else {
                    Status::Applied
                };
                let note = edit
                    .reason
                    .as_ref()
                    .map(|reason| {
                        reason
                            .note
                            .trim_end_matches(|c: char| {
                                c.is_whitespace() || ".。!！?？".contains(c)
                            })
                            .to_string()
                    })
                    .filter(|note| !note.is_empty());
                let detail = match (status, note) {
                    (Status::Applied, Some(note)) => {
                        Some(t!("{note}. Click to keep the original", note = note))
                    }
                    (Status::Applied, None) => Some(keep_hint.to_string()),
                    (_, note) => note,
                };
                Shown {
                    id: edit.id,
                    from: edit.from,
                    to: edit.to,
                    insert: edit.insert.clone(),
                    status,
                    tag: edit
                        .reason
                        .as_ref()
                        .and_then(|reason| reason.category)
                        .map(|category| category_name(category).into()),
                    detail: detail.map(Into::into),
                }
            })
            .collect();
        shown.extend(
            proofread::held_runs(&self.original, review)
                .into_iter()
                .map(|run| Shown {
                    id: run.id,
                    from: run.from,
                    to: run.to,
                    insert: run.insert,
                    status: Status::Held,
                    tag: Some(held_tag(run.kind).into()),
                    detail: None,
                }),
        );
        if shown.is_empty() {
            return None;
        }
        let card = cx.entity().downgrade();
        let rejected = rejected.clone();
        let toggle: inline_edits::Toggle = Rc::new(move |id, _, cx| {
            let accepted = rejected.contains(&id);
            card.update(cx, |_, cx| cx.emit(CardEvent::Choose(id, accepted)))
                .ok();
        });
        let passage =
            inline_edits::render("proofread-edit", &self.original, &shown, Some(toggle), cx);
        // The passage comes up first, then each edit arrives on it.
        Some(
            div()
                .px(px(2.))
                .child(passage)
                .with_animation(
                    ("proofread-text", self.answered),
                    Animation::new(Motion::Moderate.duration()),
                    |this, t| this.opacity(t),
                )
                .into_any_element(),
        )
    }

    fn held_notice(&self, cx: &App) -> Option<AnyElement> {
        let CardState::Ready { review, .. } = &self.state else {
            return None;
        };
        if review.held.is_empty() {
            return None;
        }
        let mut kinds: Vec<ProtectedKind> = Vec::new();
        for held in &review.held {
            if !kinds.contains(&held.kind) {
                kinds.push(held.kind);
            }
        }
        let changed = kinds
            .iter()
            .map(|kind| held_name(*kind))
            .collect::<Vec<_>>()
            .join(", ");
        let count = review.held.len();
        let text = if count == 1 {
            t!(
                "Held back 1 edit that would change {changed}",
                changed = changed
            )
        } else {
            t!(
                "Held back {count} edits that would change {changed}",
                count = count,
                changed = changed
            )
        };
        Some(message(
            Icon::TRIANGLE_ALERT,
            cx.palette().warning,
            text,
            cx,
        ))
    }

    fn actions(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let accept_keys = if cfg!(target_os = "macos") {
            "⌘↩"
        } else {
            "Ctrl+↩"
        };
        let emit = |event: CardEvent, cx: &mut Context<Self>| {
            let card = cx.entity().downgrade();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                card.update(cx, |_, cx| cx.emit(event.clone())).ok();
            }
        };
        let (offered, kept) = self.counts();
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .pt(px(12.))
            .border_t_1()
            .border_color(palette.line);
        if offered > 0 {
            let label = if offered == 1 {
                t!("Accept").to_string()
            } else if kept == offered {
                t!("Accept all").to_string()
            } else {
                t!("Accept {kept} of {offered}", kept = kept, offered = offered)
            };
            row = row.child(
                Button::new("proofread-accept", label)
                    .compact()
                    .tinted()
                    .keys(accept_keys)
                    .disabled(!self.editable || kept == 0)
                    .on_click(emit(CardEvent::Accept, cx)),
            );
            if kept < offered && offered > 1 {
                row = row.child(
                    Button::new("proofread-accept-all", t!("Accept all"))
                        .compact()
                        .ghost()
                        .disabled(!self.editable)
                        .on_click(emit(CardEvent::AcceptAll, cx)),
                );
            }
            row = row.child(
                Button::new("proofread-discard", t!("Discard"))
                    .compact()
                    .ghost()
                    .keys("Esc")
                    .on_click(emit(CardEvent::Dismiss, cx)),
            );
        } else if let CardState::Error { retryable, .. } = self.state {
            if retryable {
                row = row.child(
                    Button::new("proofread-retry", t!("Try again"))
                        .compact()
                        .tinted()
                        .on_click(emit(CardEvent::Retry, cx)),
                );
            }
            row = row.child(
                Button::new("proofread-dismiss", t!("Dismiss"))
                    .compact()
                    .ghost()
                    .keys("Esc")
                    .on_click(emit(CardEvent::Dismiss, cx)),
            );
        } else {
            let label = if matches!(self.state, CardState::Loading) {
                t!("Cancel")
            } else {
                t!("Done")
            };
            row = row.child(
                Button::new("proofread-done", label)
                    .compact()
                    .ghost()
                    .keys("Esc")
                    .on_click(emit(CardEvent::Dismiss, cx)),
            );
        }
        row.into_any_element()
    }
}

impl Render for ProofreadCard {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let header = self.header(cx);
        let loading = matches!(self.state, CardState::Loading).then(|| self.placeholder(cx));
        let passage = self.passage(cx);
        let held = self.held_notice(cx);
        let error = match &self.state {
            CardState::Error { message: text, .. } => Some(message(
                Icon::CIRCLE_ALERT,
                palette.danger,
                text.clone(),
                cx,
            )),
            _ => None,
        };
        let actions = self.actions(cx);
        let card = div()
            .id("proofread-card")
            .max_w(px(MAX_WIDTH))
            .flex()
            .flex_col()
            .gap(px(12.))
            .pt(px(12.))
            .px(px(16.))
            .pb(px(12.))
            .rounded(RADIUS_PANEL)
            .bg(palette.raised.opacity(0.97))
            .shadow(Elevation::Popover.shadows(&palette))
            .text_role(TextRole::BodyCompact, cx)
            .text_color(palette.text)
            .cursor_default()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .children(loading)
            .children(passage)
            .children(held)
            .children(error)
            .child(actions);
        // The card unrolls downward from the selection it answers.
        div()
            .pt(px(12.))
            .px(px(8.))
            .pb(px(16.))
            .child(card.with_animation(
                "proofread-unroll",
                Animation::new(Motion::Slow.duration()),
                |this, t| this.opacity(t).mt(px(-10. * (1. - t))),
            ))
    }
}

/// A warning or error line (`InlineMessage`).
fn message(icon: Icon, ink: gpui::Hsla, text: impl Into<SharedString>, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(6.))
        .text_role(TextRole::Caption, cx)
        .text_color(palette.text)
        .child(
            div()
                .flex_none()
                .pt(px(1.5))
                .child(icon.element(px(13.), ink)),
        )
        .child(div().min_w_0().child(text.into()))
        .into_any_element()
}

/// The card's tag for an edit's category, in the interface's language.
fn category_name(category: Category) -> String {
    match category {
        Category::Spelling => t!("spelling"),
        Category::Grammar => t!("grammar"),
        Category::Punctuation => t!("punctuation"),
        Category::WordChoice => t!("word choice"),
        Category::Clarity => t!("clarity"),
        Category::Concision => t!("concision"),
        Category::Flow => t!("flow"),
        Category::Consistency => t!("consistency"),
        Category::Translation => t!("translation"),
    }
    .to_string()
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

/// What held edits would have changed, for the notice.
fn held_name(kind: ProtectedKind) -> String {
    match kind {
        ProtectedKind::Math => t!("math"),
        ProtectedKind::Reference => t!("citations or references"),
        ProtectedKind::Comment => t!("comments"),
        ProtectedKind::Command => t!("LaTeX commands"),
        ProtectedKind::Environment => t!("environments"),
        ProtectedKind::Verbatim => t!("verbatim code"),
        ProtectedKind::Paragraph => t!("paragraph breaks"),
    }
    .to_string()
}
