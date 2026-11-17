//! The question the app asks before something it cannot undo, as the Tauri
//! app's `confirmAction` asks it: a dialog card over the scrim with Cancel
//! first and the answer last, the answer drawn as danger when it destroys.
//! One question at a time; the shell draws it ([`ConfirmHost`]).

use std::rc::Rc;

use gpui::{
    App, AppContext as _, Context, Entity, Global, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div, px,
};
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, DialogCard, LayerPlacement, ModalLayer},
};

type Answer = Rc<dyn Fn(&mut Window, &mut App)>;
type Dismissal = Box<dyn FnOnce(&mut App)>;

/// Over the window's deferred overlays (the palette and Settings, at 10, in
/// `shell/layers.rs`), which a question can be asked from (Settings ›
/// Plugins and Overleaf ask theirs there), and under the notices (50).
const PRIORITY: usize = 20;

pub struct Confirm {
    title: SharedString,
    body: Option<SharedString>,
    /// Bullets under the body (`ul`), as a plugin's permissions are listed.
    list: Vec<SharedString>,
    confirm_label: SharedString,
    /// The other answer's words, when not "Cancel": a question whose two
    /// answers both act names what each does.
    cancel_label: Option<SharedString>,
    destructive: bool,
    on_confirm: Answer,
    /// A second answer between Cancel and the first, as the Tauri app's
    /// `chooseAction` offers one ("Keep citations" beside "Remove citations
    /// too").
    alternative: Option<(SharedString, Answer)>,
    /// The question went unanswered: Cancel, a click outside, Escape, or
    /// another question asked over it.
    on_cancel: Option<Dismissal>,
}

impl Confirm {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            body: None,
            list: Vec::new(),
            confirm_label: tc!("dialog button", "OK").into(),
            cancel_label: None,
            destructive: false,
            on_confirm: Rc::new(|_, _| {}),
            alternative: None,
            on_cancel: None,
        }
    }

    pub fn body(mut self, body: impl Into<SharedString>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn list(mut self, lines: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.list = lines.into_iter().map(Into::into).collect();
        self
    }

    pub fn confirm_label(mut self, label: impl Into<SharedString>) -> Self {
        self.confirm_label = label.into();
        self
    }

    pub fn cancel_label(mut self, label: impl Into<SharedString>) -> Self {
        self.cancel_label = Some(label.into());
        self
    }

    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub fn on_confirm(mut self, answer: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_confirm = Rc::new(answer);
        self
    }

    /// Offer a second answer, drawn as the first is (danger when the
    /// question destroys).
    pub fn alternative(
        mut self,
        label: impl Into<SharedString>,
        answer: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.alternative = Some((label.into(), Rc::new(answer)));
        self
    }

    /// What to do when the question goes unanswered; an island's page waits
    /// for one answer or the other.
    pub fn on_cancel(mut self, cancel: impl FnOnce(&mut App) + 'static) -> Self {
        self.on_cancel = Some(Box::new(cancel));
        self
    }
}

pub struct ConfirmHost {
    pending: Option<Confirm>,
    /// Bumped per question, so each one's dialog enters afresh.
    serial: usize,
}

struct ConfirmCenter(Entity<ConfirmHost>);

impl Global for ConfirmCenter {}

/// Make the host every `ask` reaches, and return it for the shell to draw.
pub fn install(cx: &mut App) -> Entity<ConfirmHost> {
    if let Some(center) = cx.try_global::<ConfirmCenter>() {
        return center.0.clone();
    }
    let host = cx.new(|_| ConfirmHost {
        pending: None,
        serial: 0,
    });
    cx.set_global(ConfirmCenter(host.clone()));
    host
}

/// A question is open: a caller the writer didn't prompt waits rather than
/// ask over it.
pub fn is_pending(cx: &App) -> bool {
    cx.try_global::<ConfirmCenter>()
        .is_some_and(|center| center.0.read(cx).pending.is_some())
}

pub fn ask(question: Confirm, cx: &mut App) {
    let host = install(cx);
    let replaced = host.update(cx, |host, cx| {
        host.serial += 1;
        cx.notify();
        host.pending.replace(question)
    });
    if let Some(cancel) = replaced.and_then(|question| question.on_cancel) {
        cx.defer(cancel);
    }
}

impl ConfirmHost {
    /// The question goes unanswered.
    fn close(&mut self, cx: &mut Context<Self>) {
        let cancel = self.pending.take().and_then(|question| question.on_cancel);
        cx.notify();
        if let Some(cancel) = cancel {
            cx.defer(cancel);
        }
    }

    /// Answer the open question as a click on its answer would, for a
    /// scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn accept(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(question) = self.pending.take() else {
            return false;
        };
        cx.notify();
        (question.on_confirm)(window, cx);
        true
    }

    /// Whether a question is up.
    pub fn is_open(&self) -> bool {
        self.pending.is_some()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn question(&self) -> Option<SharedString> {
        self.pending.as_ref().map(|question| question.title.clone())
    }

    /// The open question's body, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn question_list(&self) -> Vec<SharedString> {
        self.pending
            .as_ref()
            .map(|question| question.list.clone())
            .unwrap_or_default()
    }

    pub fn question_body(&self) -> Option<SharedString> {
        self.pending
            .as_ref()
            .and_then(|question| question.body.clone())
    }

    /// Leave the open question unanswered, as Cancel would, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.close(cx);
    }
}

impl Render for ConfirmHost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(question) = &self.pending else {
            return div().into_any_element();
        };
        let palette = cx.palette().clone();
        let answer = question.on_confirm.clone();
        let mut confirm = Button::new(
            ("confirm-answer", self.serial),
            question.confirm_label.clone(),
        )
        // Each answer plays the dialog's exit before it runs, as the
        // app's dialog leaves (`ModalLayer::closing`).
        .on_click(ModalLayer::closing(
            ("confirm", self.serial),
            cx,
            move |this, window, cx| {
                // Answered: the question goes without its cancel.
                this.pending = None;
                cx.notify();
                answer(window, cx);
            },
        ));
        confirm = if question.destructive {
            confirm.danger()
        } else {
            confirm.primary()
        };
        let mut card = DialogCard::new(question.title.clone());
        if question.destructive {
            card = card.mark(Icon("icons/trash.svg"), palette.danger, palette.danger_soft);
        }
        if let Some(body) = &question.body {
            card = card.body(body.clone());
        }
        if !question.list.is_empty() {
            // `.plugin-permissions`: the body's face in the primary ink,
            // each line after its bullet, 16px in and 2px apart.
            card = card.field(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text)
                    .children(question.list.iter().map(|line| {
                        div()
                            .flex()
                            .child(div().flex_none().w(px(16.)).child("•"))
                            .child(div().flex_1().min_w_0().child(line.clone()))
                    })),
            );
        }
        let mut card = card.action(
            Button::new(
                ("confirm-cancel", self.serial),
                question
                    .cancel_label
                    .clone()
                    .unwrap_or_else(|| t!("Cancel").into()),
            )
            .ghost()
            .on_click(ModalLayer::closing(
                ("confirm", self.serial),
                cx,
                |this, _, cx| this.close(cx),
            )),
        );
        if let Some((label, answer)) = question.alternative.clone() {
            let button = Button::new(("confirm-alternative", self.serial), label).on_click(
                ModalLayer::closing(("confirm", self.serial), cx, move |this, window, cx| {
                    this.pending = None;
                    cx.notify();
                    answer(window, cx);
                }),
            );
            card = card.action(if question.destructive {
                button.danger()
            } else {
                button.primary()
            });
        }
        let card = card.action(confirm);
        let view = cx.entity().downgrade();
        ModalLayer::new(
            ("confirm", self.serial),
            LayerPlacement::Center,
            card,
            move |_, cx| {
                view.update(cx, |this, cx| this.close(cx)).ok();
            },
        )
        .priority(PRIORITY)
        .into_any_element()
    }
}
