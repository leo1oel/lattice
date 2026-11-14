//! The Overleaf collaboration panel (`src/overleaf/overleaf-collab.tsx`,
//! `overleaf-collab.css`): the comments on the text and the suggested
//! changes to it, for a project linked to Overleaf, docked as the Tauri app
//! docks the drawer, a Trellis tool panel on the input surface (the window's
//! "comments" view). The chat joins it later.
//!
//! A segmented switch picks Comments (with the open threads' count) or
//! Suggestions (the open file's); each lists what the bridge knows
//! (`overleaf::bridge::review`), and every action goes to the bridge, whose
//! failures show above the list. Each person keeps one colour throughout
//! (`overleaf::people`).

use std::collections::HashSet;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::{InputEvent, TextareaState},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::ViewSwitch,
    scrollbar::FluidScrollbar, tokens::FONT_WEIGHT_MEDIUM, typography::tabular_nums,
};

use super::bridge::OverleafBridge;
use crate::research_art::{Drawing, research_art};

mod changes;
mod comments;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollabTab {
    Comments,
    Suggestions,
}

/// What the panel asks of the window.
pub enum CollabEvent {
    /// Show `path` (in the project) at UTF-16 `position`.
    Reveal { path: String, position: i64 },
}

/// What a composer is writing.
#[derive(Clone, Debug, PartialEq)]
enum Draft {
    Reply {
        thread: String,
    },
    Edit {
        thread: String,
        message: String,
    },
    /// A new thread on `quote` at UTF-16 `from` of `path`.
    New {
        path: String,
        from: i64,
        quote: String,
    },
}

struct Composer {
    draft: Draft,
    state: Entity<TextareaState>,
    _enter: Subscription,
}

pub struct OverleafCollabPanel {
    focus_handle: FocusHandle,
    bridge: Entity<OverleafBridge>,
    tab: CollabTab,
    show_resolved: bool,
    /// Resolved threads unfolded.
    unfolded: HashSet<String>,
    /// The one composer open, panel-wide.
    composer: Option<Composer>,
    /// The file the writer works in, for "In this file" and Suggestions.
    active: Option<String>,
    scroll: ScrollHandle,
    _bridge: Subscription,
}

impl EventEmitter<CollabEvent> for OverleafCollabPanel {}
impl EventEmitter<PanelEvent> for OverleafCollabPanel {}

impl OverleafCollabPanel {
    pub fn new(bridge: Entity<OverleafBridge>, cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            _bridge: cx.observe(&bridge, |_, _, cx| cx.notify()),
            bridge,
            tab: CollabTab::Comments,
            show_resolved: false,
            unfolded: HashSet::new(),
            composer: None,
            active: None,
            scroll: ScrollHandle::new(),
        }
    }

    /// A composer is open, writing a new thread.
    pub fn composing_comment(&self) -> bool {
        self.composer
            .as_ref()
            .is_some_and(|composer| matches!(composer.draft, Draft::New { .. }))
    }

    pub fn tab(&self) -> CollabTab {
        self.tab
    }

    pub fn set_tab(&mut self, tab: CollabTab, cx: &mut Context<Self>) {
        if self.tab != tab {
            self.tab = tab;
            self.scroll.set_offset(gpui::point(px(0.), px(0.)));
            cx.notify();
        }
    }

    /// The writer works in `path` now.
    pub fn set_active(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        if self.active != path {
            self.active = path;
            cx.notify();
        }
    }

    /// Start a new thread on `quote` at UTF-16 `from` of `path`: the
    /// Comments tab, with its composer open.
    pub fn compose_comment(
        &mut self,
        path: String,
        from: i64,
        quote: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tab = CollabTab::Comments;
        self.open_composer(Draft::New { path, from, quote }, String::new(), window, cx);
    }

    fn open_composer(
        &mut self,
        draft: Draft,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Enter sends; Shift+Enter breaks the line.
        let state = cx.new(|cx| {
            TextareaState::new(window, cx)
                .default_value(text)
                .submit_on_enter(true)
        });
        state.update(cx, |state, cx| state.focus(window, cx));
        let enter = cx.subscribe(&state, |this, _, event: &InputEvent, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = event {
                this.submit(cx);
            }
        });
        self.composer = Some(Composer {
            draft,
            state,
            _enter: enter,
        });
        cx.notify();
    }

    fn close_composer(&mut self, cx: &mut Context<Self>) {
        self.composer = None;
        cx.notify();
    }

    /// Send what the composer holds.
    fn submit(&mut self, cx: &mut Context<Self>) {
        let Some(composer) = self.composer.take() else {
            return;
        };
        let text = composer.state.read(cx).value().to_string();
        if text.trim().is_empty() {
            self.composer = Some(composer);
            return;
        }
        self.bridge.update(cx, |bridge, cx| match composer.draft {
            Draft::Reply { thread } => bridge.reply_to_thread(&thread, text, cx),
            Draft::Edit { thread, message } => bridge.edit_message(&thread, &message, text, cx),
            Draft::New { path, from, quote } => bridge.add_comment(&path, from, quote, text, cx),
        });
        cx.notify();
    }

    /// The open threads' count, and the open file's suggestions'.
    fn counts(&self, cx: &App) -> (usize, usize) {
        let bridge = self.bridge.read(cx);
        let threads = bridge
            .threads()
            .iter()
            .filter(|thread| !thread.resolved)
            .count();
        let changes = self
            .active
            .as_deref()
            .and_then(|path| bridge.live_review(path))
            .map_or(0, |review| review.changes.len());
        (threads, changes)
    }
}

impl Focusable for OverleafCollabPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for OverleafCollabPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (threads, changes) = self.counts(cx);
        let label = |name: String, count: usize| {
            if count > 0 {
                format!("{name} {count}")
            } else {
                name
            }
        };
        let this = cx.weak_entity();
        let choose = move |tab: CollabTab| {
            let this = this.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                this.update(cx, |this, cx| this.set_tab(tab, cx)).ok();
            }
        };
        let switch = ViewSwitch::new("overleaf-collab-tabs")
            .named(true)
            .mode(
                Icon::MESSAGE_SQUARE_TEXT,
                label(t!("Comments").into(), threads),
                self.tab == CollabTab::Comments,
                choose(CollabTab::Comments),
            )
            .mode(
                Icon::FILE_PEN_LINE,
                label(t!("Suggestions").into(), changes),
                self.tab == CollabTab::Suggestions,
                choose(CollabTab::Suggestions),
            );
        let error = self.bridge.read(cx).review_error().cloned();
        let content = match self.tab {
            CollabTab::Comments => self.render_comments(window, cx),
            CollabTab::Suggestions => self.render_changes(cx),
        };
        div()
            .id("overleaf-collab")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.input)
            .child(
                div()
                    .flex_none()
                    .px(px(14.))
                    .pt(px(12.))
                    .pb(px(8.))
                    .child(switch),
            )
            .children(error.map(|error| {
                div()
                    .flex_none()
                    .px(px(16.))
                    .pb(px(8.))
                    .child(crate::history::widgets::inline_message(error, true, cx))
            }))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("overleaf-collab-scroll")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .child(
                                div()
                                    .min_h_full()
                                    .flex()
                                    .flex_col()
                                    .px(px(14.))
                                    .pb(px(16.))
                                    .child(content),
                            ),
                    )
                    .child(FluidScrollbar::vertical(
                        "overleaf-collab-scrollbar",
                        &self.scroll,
                    )),
            )
    }
}

/// `EmptyState` with research art (`.overleaf-collab-empty`).
fn empty_state(drawing: Drawing, title: SharedString, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .py(px(20.))
        .px(px(12.))
        .child(
            div()
                .mb(px(8.))
                .child(research_art(drawing, px(144.), palette.input, cx)),
        )
        .child(
            div()
                .text_role(TextRole::Subtitle, cx)
                .text_color(palette.text)
                .text_center()
                .child(title),
        )
        .into_any_element()
}

/// A group's heading (`.overleaf-collab-group`): its icon, its label and a
/// count at the end.
fn group_heading(icon: Icon, label: SharedString, count: usize, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(2.))
        .py(px(4.))
        .text_role(TextRole::Caption, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .text_color(palette.text_secondary)
        .child(icon.element(px(14.), palette.text_secondary))
        .child(div().min_w_0().child(label))
        .child(
            div()
                .ml_auto()
                .font_features(tabular_nums())
                .child(count.to_string()),
        )
        .into_any_element()
}

impl BasePanel for OverleafCollabPanel {
    fn panel_name(&self) -> &'static str {
        "OverleafCollabPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for OverleafCollabPanel {
    /// The tab's title, as Trellis names the tool.
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Overleaf collaboration").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("Overleaf collaboration")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
