//! Notifications, as the Tauri app's toast stack shows them
//! (`src/telemetry/toast-stack.tsx`): 320px cards at the bottom right, 44px
//! up so they stay off the panels' status row and 32px in; an error stays
//! 9 s and anything else 6 s, unless it waits for an answer, which stays
//! until it is given or dismissed. A notice with a key replaces the one
//! already showing under it.
//!
//! Any code reaches the stack through the window-independent global the
//! shell installs ([`install`]).

use std::{rc::Rc, time::Duration};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Global, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, Task, Window, div, px,
};
use lattice_ui::components::{Button, PopFrom, Toast, ToastLevel, toast_in};

const ERROR_TIMEOUT: Duration = Duration::from_secs(9);
const TIMEOUT: Duration = Duration::from_secs(6);

type Run = Rc<dyn Fn(&mut Window, &mut App)>;

pub struct NoticeAction {
    label: SharedString,
    run: Run,
}

impl NoticeAction {
    pub fn new(
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            run: Rc::new(run),
        }
    }
}

pub struct Notice {
    level: ToastLevel,
    title: SharedString,
    detail: Option<SharedString>,
    actions: Vec<NoticeAction>,
    /// Replaces a notice showing under the same key.
    key: Option<SharedString>,
    /// Stays until dismissed or answered.
    persistent: bool,
}

impl Notice {
    pub fn new(level: ToastLevel, title: impl Into<SharedString>) -> Self {
        Self {
            level,
            title: title.into(),
            detail: None,
            actions: Vec::new(),
            key: None,
            persistent: false,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn action(mut self, action: NoticeAction) -> Self {
        self.actions.push(action);
        self
    }

    pub fn key(mut self, key: impl Into<SharedString>) -> Self {
        self.key = Some(key.into());
        self
    }

    pub fn persistent(mut self) -> Self {
        self.persistent = true;
        self
    }
}

struct Shown {
    id: usize,
    notice: Notice,
    _expiry: Option<Task<()>>,
}

pub struct NoticeStack {
    shown: Vec<Shown>,
    next_id: usize,
}

struct NoticeCenter(Entity<NoticeStack>);

impl Global for NoticeCenter {}

/// Make the stack every `show` reaches, and return it for the shell to draw.
pub fn install(cx: &mut App) -> Entity<NoticeStack> {
    if let Some(center) = cx.try_global::<NoticeCenter>() {
        return center.0.clone();
    }
    let stack = cx.new(|_| NoticeStack {
        shown: Vec::new(),
        next_id: 0,
    });
    cx.set_global(NoticeCenter(stack.clone()));
    stack
}

pub fn show(notice: Notice, cx: &mut App) {
    // Every notice reaches the log too, which a scripted run reads.
    let level = match notice.level {
        ToastLevel::Error => log::Level::Error,
        ToastLevel::Warning => log::Level::Warn,
        ToastLevel::Info | ToastLevel::Success => log::Level::Info,
    };
    log::log!(
        level,
        "{}{}",
        notice.title,
        notice
            .detail
            .as_ref()
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default()
    );
    let stack = install(cx);
    stack.update(cx, |stack, cx| stack.push(notice, cx));
}

/// Take down the notice showing under `key`, if any.
pub fn dismiss(key: &str, cx: &mut App) {
    let Some(center) = cx.try_global::<NoticeCenter>() else {
        return;
    };
    let stack = center.0.clone();
    stack.update(cx, |stack, cx| {
        stack
            .shown
            .retain(|shown| shown.notice.key.as_deref() != Some(key));
        cx.notify();
    });
}

pub fn error(title: impl Into<SharedString>, detail: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Error, title).detail(detail), cx);
}

pub fn warning(title: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Warning, title), cx);
}

pub fn info(title: impl Into<SharedString>, detail: impl Into<SharedString>, cx: &mut App) {
    show(Notice::new(ToastLevel::Info, title).detail(detail), cx);
}

impl NoticeStack {
    fn push(&mut self, notice: Notice, cx: &mut Context<Self>) {
        if let Some(key) = &notice.key {
            self.shown
                .retain(|shown| shown.notice.key.as_ref() != Some(key));
        }
        let id = self.next_id;
        self.next_id += 1;
        let timeout = (!notice.persistent && notice.actions.is_empty()).then_some(
            if notice.level == ToastLevel::Error {
                ERROR_TIMEOUT
            } else {
                TIMEOUT
            },
        );
        let expiry = timeout.map(|timeout| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(timeout).await;
                this.update(cx, |this, cx| this.remove(id, cx)).ok();
            })
        });
        self.shown.push(Shown {
            id,
            notice,
            _expiry: expiry,
        });
        cx.notify();
    }

    fn remove(&mut self, id: usize, cx: &mut Context<Self>) {
        self.shown.retain(|shown| shown.id != id);
        cx.notify();
    }

    /// The titles of the notices showing, oldest first, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn titles(&self) -> Vec<SharedString> {
        self.shown
            .iter()
            .map(|shown| shown.notice.title.clone())
            .collect()
    }

    /// Take every notice down, as their close buttons do, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.shown.clear();
        cx.notify();
    }
}

impl Render for NoticeStack {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let cards: Vec<AnyElement> = self
            .shown
            .iter()
            .map(|shown| {
                let id = shown.id;
                let notice = &shown.notice;
                let mut toast = Toast::new(("notice", id), notice.level, notice.title.clone())
                    .on_dismiss(cx.listener(move |this, _, _, cx| this.remove(id, cx)));
                if let Some(detail) = &notice.detail {
                    toast = toast.detail(detail.clone());
                }
                for (ix, action) in notice.actions.iter().enumerate() {
                    let run = action.run.clone();
                    let mut button =
                        Button::new(("notice-action", id * 8 + ix), action.label.clone())
                            .compact()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.remove(id, cx);
                                run(window, cx);
                            }));
                    if ix == 0 {
                        button = button.tinted();
                    }
                    toast = toast.action(button);
                }
                toast_in(("notice-in", id), PopFrom::Below, toast)
            })
            .collect();
        div()
            .absolute()
            .bottom(px(44.))
            .right(px(32.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .children(cards)
    }
}
