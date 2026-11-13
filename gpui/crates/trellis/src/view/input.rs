// Part of the port of DanFessler/trellis 0.2.0 to GPUI, Copyright (c) Dan Fessler, Trellis Public License v1.0
// Non-Commercial (packages/core/src/runtime/workspace.ts and drag.ts / navigation.ts: the pointer, wheel and key
// listeners), with Lattice's patch (presses a view's content or a control owns are never the navigator's).

//! The pointer, wheel, pinch and Escape, turned into engine calls.

use gpui::{
    AnyElement, Context, DispatchPhase, InteractiveElement as _, IntoElement, KeyDownEvent,
    Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _,
    PinchEvent, ScrollDelta, ScrollEvent, Stateful, Styled as _, WeakEntity, Window, canvas, div,
};

use crate::runtime::engine::ResizeDir;

use super::{Held, TrellisWorkspace, WorkspaceEvent};

fn plain(m: &Modifiers) -> bool {
    !m.shift && !m.alt && !m.control && !m.platform
}

impl TrellisWorkspace {
    /// A press anywhere in a panel: its selected view takes focus and a float
    /// rises; a frame too small to use drags from anywhere.
    pub(crate) fn press_panel(
        &mut self,
        panel: &str,
        event: &MouseDownEvent,
        frame_only: bool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selected = self.engine.doc().clone();
        let selected =
            crate::model::locate_panel(&selected, panel).map(|l| l.panel().selected.clone());
        self.update_engine(cx, |e| {
            if let Some(view) = &selected {
                e.focus_view(view);
            }
        });
        if frame_only
            && event.button == MouseButton::Left
            && plain(&event.modifiers)
            && self.held.is_none()
        {
            let p = self.local(event.position);
            self.engine.drag_begin(panel, None, p);
            self.held = Some(Held::Press {
                panel: panel.to_string(),
                view: None,
            });
            cx.notify();
        }
    }

    /// A press on a tab (`view`) or on a strip's background.
    pub(crate) fn press_strip(
        &mut self,
        panel: &str,
        view: Option<&str>,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.held.is_some() {
            return;
        }
        let p = self.local(event.position);
        // Shift on the chrome draws a marquee, Alt zooms (free navigation).
        if (event.modifiers.shift || event.modifiers.alt)
            && self
                .engine
                .nav_press(p, event.modifiers.shift, event.modifiers.alt)
        {
            self.held = Some(Held::Navigation);
            cx.notify();
            return;
        }
        self.press_panel(panel, event, false, window, cx);
        if !plain(&event.modifiers) {
            return;
        }
        self.engine.drag_begin(panel, view, p);
        self.held = Some(Held::Press {
            panel: panel.to_string(),
            view: view.map(str::to_string),
        });
        cx.notify();
    }

    pub(crate) fn press_divider(&mut self, split: &str, index: usize, cx: &mut Context<Self>) {
        if self.held.is_some() {
            return;
        }
        self.update_engine(cx, |e| e.divider_down(split, index));
        self.held = Some(Held::Divider);
    }

    pub(crate) fn press_resize(
        &mut self,
        panel: &str,
        dir: ResizeDir,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) {
        if self.held.is_some() {
            return;
        }
        let p = self.local(event.position);
        self.update_engine(cx, |e| e.float_resize_down(panel, dir, p));
        self.held = Some(Held::FloatResize);
    }

    fn pointer_moved(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let p = self.local(event.position);
        match &self.held {
            Some(Held::Press { .. }) => self.update_engine(cx, |e| e.drag_move(p)),
            Some(Held::Divider) => self.update_engine(cx, |e| e.divider_move(p)),
            Some(Held::FloatResize) => self.update_engine(cx, |e| e.float_resize_move(p)),
            Some(Held::Navigation) => self.update_engine(cx, |e| e.nav_move(p)),
            None => {}
        }
    }

    fn pointer_released(
        &mut self,
        position: gpui::Point<gpui::Pixels>,
        commit: bool,
        cx: &mut Context<Self>,
    ) {
        let p = self.local(position);
        match self.held.take() {
            Some(Held::Press { view, .. }) => {
                let click = self.engine.press_is_click();
                self.update_engine(cx, |e| {
                    if commit {
                        e.drag_move(p);
                    }
                    e.drag_end(commit)
                });
                // A press that never became a drag is a click on its tab.
                if commit
                    && click
                    && let Some(view) = view
                {
                    self.update_engine(cx, |e| e.select_and_focus(&view));
                    cx.emit(WorkspaceEvent::FocusContent(view));
                }
            }
            Some(Held::Divider) => self.update_engine(cx, |e| e.divider_up(!commit)),
            Some(Held::FloatResize) => self.update_engine(cx, |e| e.float_resize_up(!commit)),
            Some(Held::Navigation) => self.update_engine(cx, |e| e.nav_release(p, commit)),
            None => {}
        }
    }

    /// The workspace's own listeners: the held pointer anywhere in the
    /// window, Escape while held, wheels and pinches over its chrome.
    pub(crate) fn wire_root(
        &mut self,
        root: Stateful<gpui::Div>,
        entity: WeakEntity<Self>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let listeners = {
            let entity = entity.clone();
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let move_entity = entity.clone();
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            move_entity
                                .update(cx, |this, cx| this.pointer_moved(event, cx))
                                .ok();
                        }
                    });
                    let up_entity = entity.clone();
                    window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            up_entity
                                .update(cx, |this, cx| {
                                    this.pointer_released(event.position, true, cx)
                                })
                                .ok();
                        }
                    });
                    let key_entity = entity.clone();
                    window.on_key_event(move |event: &KeyDownEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture && event.keystroke.key == "escape" {
                            key_entity
                                .update(cx, |this, cx| {
                                    if this.held.is_some() {
                                        cx.stop_propagation();
                                        this.pointer_released(gpui::Point::default(), false, cx);
                                    }
                                })
                                .ok();
                        }
                    });
                    let pinch_entity = entity.clone();
                    window.on_mouse_event(move |event: &PinchEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble {
                            return;
                        }
                        pinch_entity
                            .update(cx, |this, cx| this.pinch(event, window, cx))
                            .ok();
                    });
                },
            )
            .absolute()
            .size_full()
        };
        let wheel_entity = entity.clone();
        let nav_entity = entity;
        root.child(listeners)
            .on_scroll(move |event: &ScrollEvent, _, cx| {
                wheel_entity
                    .update(cx, |this, cx| this.wheel(event, cx))
                    .ok();
            })
            // Shift or Alt on the gutters between panels: the navigator's.
            .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, _, cx| {
                if !(event.modifiers.shift || event.modifiers.alt) {
                    return;
                }
                nav_entity
                    .update(cx, |this, cx| {
                        let p = this.local(event.position);
                        if this.held.is_none()
                            && this.over_content(p).is_none()
                            && this
                                .engine
                                .nav_press(p, event.modifiers.shift, event.modifiers.alt)
                        {
                            this.held = Some(Held::Navigation);
                            cx.notify();
                        }
                    })
                    .ok();
            })
    }

    /// Whether a point (workspace px) is over a view's content.
    fn over_content(&self, p: crate::model::Point) -> Option<String> {
        self.frame
            .panels
            .iter()
            .rev()
            .find(|panel| panel.rect.contains(p))
            .and_then(|panel| {
                panel
                    .surfaces
                    .iter()
                    .find(|s| s.shown && s.body.contains(p))
                    .map(|s| s.view_id.clone())
            })
    }

    fn wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let p = self.local(event.position);
        // A view's content keeps its wheel; Ctrl over it is a pinch the view
        // may keep too.
        if let Some(view) = self.over_content(p)
            && (!event.modifiers.control || self.skin.owns_gestures(&view, cx))
        {
            return;
        }
        let delta = match event.delta {
            ScrollDelta::Pixels(d) => (f64::from(f32::from(d.y)), f64::from(f32::from(d.x))),
            ScrollDelta::Lines(d) => (f64::from(d.y) * 16., f64::from(d.x) * 16.),
        };
        // GPUI's deltas run opposite to the DOM's.
        let taken = self.update_engine(cx, |e| {
            e.wheel(
                p,
                -delta.0,
                -delta.1,
                event.modifiers.control,
                event.modifiers.shift,
            )
        });
        if taken {
            cx.stop_propagation();
        }
    }

    fn pinch(&mut self, event: &PinchEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(bounds) = self.bounds() else { return };
        if !bounds.contains(&event.position) {
            return;
        }
        let p = self.local(event.position);
        if let Some(view) = self.over_content(p)
            && self.skin.owns_gestures(&view, cx)
        {
            return;
        }
        self.update_engine(cx, |e| e.pinch(p, 1. + f64::from(event.delta)));
    }

    /// While a drag, resize or marquee holds the pointer: a shield over
    /// everything, holding its cursor, so nothing else lights up.
    pub(crate) fn render_shield(
        &self,
        frame: &crate::runtime::engine::Frame,
    ) -> Option<AnyElement> {
        let cursor = if frame.dragging {
            gpui::CursorStyle::ClosedHand
        } else if let Some(kind) = frame.resizing {
            match kind {
                crate::runtime::engine::ResizeKind::Divider(crate::model::Axis::X) => {
                    gpui::CursorStyle::ResizeColumn
                }
                crate::runtime::engine::ResizeKind::Divider(crate::model::Axis::Y) => {
                    gpui::CursorStyle::ResizeRow
                }
                crate::runtime::engine::ResizeKind::Float => gpui::CursorStyle::Arrow,
            }
        } else if self.engine.nav_pointer_held() {
            gpui::CursorStyle::Crosshair
        } else {
            return None;
        };
        Some(
            div()
                .id("trellis-shield")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .cursor(cursor)
                .occlude()
                .into_any_element(),
        )
    }
}
