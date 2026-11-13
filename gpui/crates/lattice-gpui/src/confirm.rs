//! The question the app asks before something it cannot undo, as the Tauri
//! app's `confirmAction` asks it: a dialog card over the scrim with Cancel
//! first and the answer last, the answer drawn as danger when it destroys.
//! One question at a time; the shell draws it ([`ConfirmHost`]).

use std::rc::Rc;

use gpui::{
    App, AppContext as _, Context, Entity, Global, IntoElement, Render, SharedString, Window, div,
};
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{Button, DialogCard, LayerPlacement, ModalLayer},
};

type Answer = Rc<dyn Fn(&mut Window, &mut App)>;
type Dismissal = Box<dyn FnOnce(&mut App)>;

pub struct Confirm {
    title: SharedString,
    body: Option<SharedString>,
    confirm_label: SharedString,
    destructive: bool,
    on_confirm: Answer,
    /// The question went unanswered: Cancel, a click outside, Escape, or
    /// another question asked over it.
    on_cancel: Option<Dismissal>,
}

impl Confirm {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            body: None,
            confirm_label: tc!("dialog button", "OK").into(),
            destructive: false,
            on_confirm: Rc::new(|_, _| {}),
            on_cancel: None,
        }
    }

    pub fn body(mut self, body: impl Into<SharedString>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn confirm_label(mut self, label: impl Into<SharedString>) -> Self {
        self.confirm_label = label.into();
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

pub fn ask(question: Confirm, cx: &mut App) {
    let host = install(cx);
    let replaced = host.update(cx, |host, cx| {
        host.serial += 1;
        cx.notify();
        host.pending.replace(question)
    });
    if let Some(cancel) = replaced.and_then(|question| question.on_cancel) {
        cancel(cx);
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn question(&self) -> Option<SharedString> {
        self.pending.as_ref().map(|question| question.title.clone())
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
        .on_click(cx.listener(move |this, _, window, cx| {
            // Answered: the question goes without its cancel.
            this.pending = None;
            cx.notify();
            answer(window, cx);
        }));
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
        let card = card
            .action(
                Button::new(("confirm-cancel", self.serial), t!("Cancel"))
                    .ghost()
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            )
            .action(confirm);
        let view = cx.entity().downgrade();
        ModalLayer::new(
            ("confirm", self.serial),
            LayerPlacement::Center,
            card,
            move |_, cx| {
                view.update(cx, |this, cx| this.close(cx)).ok();
            },
        )
        .into_any_element()
    }
}
