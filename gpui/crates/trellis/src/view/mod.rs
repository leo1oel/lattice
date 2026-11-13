// Part of the port of DanFessler/trellis 0.2.0 to GPUI, Copyright (c) Dan Fessler, Trellis Public License v1.0
// Non-Commercial: Trellis's DOM runtime (packages/core/src/runtime/workspace.ts: the elements, their listeners and
// the render loop) as a GPUI view over the engine.

//! The workspace as a GPUI view: it draws each [`Frame`] the engine lays
//! out, with the app's [`Skin`], and feeds the engine the pointer, wheel,
//! pinch and keys in workspace pixels. It asks for animation frames while
//! anything moves, and tells the app what changed through
//! [`WorkspaceEvent`]s.

mod chrome;
mod input;
mod panel;
pub mod skin;

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    App, Bounds, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, Render, Styled as _, Window, canvas, deferred, div, point, px,
};

use crate::model::{LayoutDocument, Point, Rect};
use crate::runtime::engine::frame::Frame;
use crate::runtime::engine::{Engine, Event, KeyOutcome, Options};
use crate::runtime::keymap::Command;

pub use skin::{CardStyle, ChromeStyle, PanelMenu, Skin, StripEnd, TabActions};

/// What the workspace tells the app.
#[derive(Clone, Debug, PartialEq)]
pub enum WorkspaceEvent {
    /// A committed layout change: persist the document.
    Changed,
    Opened(String),
    Closed(String),
    /// The workspace's focus moved to this view (a press, a tab, a key).
    Focused(Option<String>),
    /// Give this view's content the keyboard.
    FocusContent(String),
    /// The camera framed a node (a panel maximized), or the whole layout.
    Navigated(Option<String>),
    /// These views asked to close (a tab's X, the menu, a key): the app runs
    /// their close guards and calls [`TrellisWorkspace::close`].
    CloseRequested(Vec<String>),
    Announce(String),
}

/// What the pointer is holding.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Held {
    /// A press on a tab or strip that may become a drag.
    Press {
        panel: String,
        view: Option<String>,
    },
    Divider,
    FloatResize,
    Navigation,
}

pub struct TrellisWorkspace {
    pub(crate) engine: Engine,
    pub(crate) skin: Rc<dyn Skin>,
    /// The workspace's bounds in the window, as last laid out.
    pub(crate) bounds: Rc<RefCell<Option<Bounds<Pixels>>>>,
    /// Each panel's strip, tab list and tabs as last laid out (window
    /// coordinates), for drops and sorting.
    pub(crate) strips: Rc<RefCell<HashMap<String, StripBoxes>>>,
    pub(crate) held: Option<Held>,
    /// The divider under the pointer, and since when (its grip fades in
    /// after a delay).
    pub(crate) divider_hover: Option<((String, usize), std::time::Instant)>,
    pub(crate) frame: Frame,
    focus_handle: FocusHandle,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct StripBoxes {
    pub bar: Option<Bounds<Pixels>>,
    pub list: Option<Bounds<Pixels>>,
    pub tabs: Vec<(String, Bounds<Pixels>)>,
}

impl EventEmitter<WorkspaceEvent> for TrellisWorkspace {}

impl TrellisWorkspace {
    pub fn new(
        options: Options,
        document: LayoutDocument,
        skin: Rc<dyn Skin>,
        cx: &mut Context<Self>,
    ) -> TrellisWorkspace {
        TrellisWorkspace {
            engine: Engine::new(options, document, 1200., 800.),
            skin,
            bounds: Rc::default(),
            strips: Rc::default(),
            held: None,
            divider_hover: None,
            frame: Frame::default(),
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// The engine, for changes that draw nothing by themselves (titles,
    /// badges, minimum sizes): the next frame picks them up.
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    /// Change the engine, then draw again (and tell the app what changed).
    pub fn update_engine<R>(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut Engine) -> R,
    ) -> R {
        let result = f(&mut self.engine);
        self.flush_events(cx);
        cx.notify();
        result
    }

    /// Close views after their guards allowed it.
    pub fn close(&mut self, views: &[String], cx: &mut Context<Self>) {
        self.update_engine(cx, |engine| {
            for view in views {
                engine.close(view);
            }
        });
    }

    /// Run one of the workspace's commands on the focused panel.
    pub fn run(&mut self, command: Command, cx: &mut Context<Self>) {
        let outcome = self.update_engine(cx, |engine| engine.run(command));
        self.key_outcome(outcome, cx);
    }

    pub(crate) fn key_outcome(&mut self, outcome: KeyOutcome, cx: &mut Context<Self>) {
        match outcome {
            KeyOutcome::Handled => {}
            KeyOutcome::FocusTab(view) | KeyOutcome::FocusContent(view) => {
                cx.emit(WorkspaceEvent::FocusContent(view));
            }
            KeyOutcome::Close(view) => cx.emit(WorkspaceEvent::CloseRequested(vec![view])),
        }
    }

    pub(crate) fn flush_events(&mut self, cx: &mut Context<Self>) {
        for event in self.engine.drain_events() {
            cx.emit(match event {
                Event::Change => WorkspaceEvent::Changed,
                Event::Open(id) => WorkspaceEvent::Opened(id),
                Event::Close(id) => WorkspaceEvent::Closed(id),
                Event::Focus(id) => WorkspaceEvent::Focused(id),
                Event::Navigate(id) => WorkspaceEvent::Navigated(id),
                Event::Announce(text) => WorkspaceEvent::Announce(text),
            });
        }
    }

    /// A window point in workspace pixels.
    pub(crate) fn local(&self, p: gpui::Point<Pixels>) -> Point {
        let origin = self.bounds.borrow().map(|b| b.origin).unwrap_or_default();
        Point::new(
            f64::from(f32::from(p.x - origin.x)),
            f64::from(f32::from(p.y - origin.y)),
        )
    }

    /// A rect in workspace pixels, from window bounds.
    pub(crate) fn local_rect(&self, b: Bounds<Pixels>) -> Rect {
        let p = self.local(b.origin);
        Rect::new(
            p.x,
            p.y,
            f64::from(f32::from(b.size.width)),
            f64::from(f32::from(b.size.height)),
        )
    }

    /// The strips' boxes from the last frame drawn, for the engine.
    fn report_strips(&mut self) {
        let strips = self.strips.borrow().clone();
        for (panel, boxes) in strips {
            let (Some(bar), Some(list)) = (boxes.bar, boxes.list) else {
                continue;
            };
            let tabs = boxes
                .tabs
                .iter()
                .map(|(view, b)| (view.clone(), self.local_rect(*b)))
                .collect();
            let (bar, list) = (self.local_rect(bar), self.local_rect(list));
            self.engine.set_tab_boxes(&panel, bar, list, tabs);
        }
    }

    /// The window bounds of the workspace, as last laid out.
    pub fn bounds(&self) -> Option<Bounds<Pixels>> {
        *self.bounds.borrow()
    }

    /// A panel's rect in window coordinates, as last drawn.
    pub fn panel_bounds(&self, panel_id: &str) -> Option<Bounds<Pixels>> {
        let origin = self.bounds()?.origin;
        let r = self.engine.panel_rect(panel_id)?;
        Some(Bounds::new(
            origin + point(px(r.x as f32), px(r.y as f32)),
            gpui::size(px(r.w as f32), px(r.h as f32)),
        ))
    }
}

impl Focusable for TrellisWorkspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TrellisWorkspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The workspace's size, from the last layout.
        if let Some(bounds) = *self.bounds.borrow() {
            let (w, h) = (
                f64::from(f32::from(bounds.size.width)),
                f64::from(f32::from(bounds.size.height)),
            );
            self.engine.set_viewport(w, h);
        }
        self.report_strips();
        let skin = self.skin.clone();
        let chrome = skin.chrome(cx);
        self.frame = self
            .engine
            .frame(&mut |input| skin.measure_header(input, window, cx));
        self.flush_events(cx);
        if self.engine.moving() || self.divider_fading() {
            window.request_animation_frame();
        }
        let frame = self.frame.clone();
        let entity = cx.entity().downgrade();
        let bounds = self.bounds.clone();
        let measure = canvas(
            move |b, window, _| {
                let changed = bounds.borrow().is_none_or(|old| old.size != b.size);
                *bounds.borrow_mut() = Some(b);
                if changed {
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let mut root = div()
            .id("trellis-workspace")
            .key_context("TrellisWorkspace")
            .relative()
            .size_full()
            .overflow_hidden()
            .child(measure);
        // Paint order follows Trellis's z-index: docked panels and the group
        // tiles, the source slot, the dividers, the floats, the drop slot, the
        // settling, leaving and lifted panels, the snap preview.
        let (low, high): (Vec<_>, Vec<_>) = frame.panels.iter().partition(|p| p.z < 20.);
        for p in &low {
            root = root.child(self.render_panel(p, &chrome, window, cx));
        }
        root = root.children(self.render_groups(&frame, &chrome, cx));
        root = root.children(self.render_source_slot(&frame, &chrome));
        root = root.children(self.render_dividers(&frame, &chrome, cx));
        // The layers above the docked panels, and the shield over them all
        // while the pointer is held, draw together: deferred when the skin
        // asks, clipped to the workspace as the root clips them.
        let (floats, top): (Vec<_>, Vec<_>) = high.into_iter().partition(|p| p.z < 2900.);
        let mut raised = div().absolute().size_full().overflow_hidden();
        for p in &floats {
            raised = raised.child(self.render_panel(p, &chrome, window, cx));
        }
        raised = raised.children(self.render_drop_slot(&frame, &chrome, cx));
        for p in &top {
            raised = raised.child(self.render_panel(p, &chrome, window, cx));
        }
        raised = raised
            .children(self.render_navigation(&frame, &chrome, cx))
            .children(self.render_shield(&frame));
        root = match skin.raised_priority() {
            Some(priority) => root.child(deferred(raised).with_priority(priority)),
            None => root.child(raised),
        };
        if frame.empty {
            root = root.children(skin.empty(window, cx));
        }
        root = self.wire_root(root, entity, window, cx);
        root.children(skin.overlay(window, cx))
    }
}

/// Lay out a rect, in workspace pixels.
pub(crate) fn place<E: gpui::Styled>(element: E, r: Rect) -> E {
    element
        .absolute()
        .left(px(r.x as f32))
        .top(px(r.y as f32))
        .w(px(r.w.max(0.) as f32))
        .h(px(r.h.max(0.) as f32))
}
