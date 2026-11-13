// Part of the port of DanFessler/trellis 0.2.0 to GPUI, Copyright (c) Dan Fessler, Trellis Public License v1.0
// Non-Commercial (packages/core/src/runtime/workspace.ts: ensurePanelDom, syncTabs, render, placeSurface;
// packages/core/src/style.css: the panel, tab bar and surface parts).

//! A panel: its card, its tab strip, its views' content, the icon it shows
//! when too small, and a floating panel's resize handles.

use std::rc::Rc;

use gpui::{
    AnyElement, Context, CursorStyle, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, StatefulInteractiveElement as _, StyleRefinement,
    Styled as _, Window, canvas, div, point, prelude::FluentBuilder as _, px, scaled,
};

use crate::model::{Rect, TabbarMode};
use crate::runtime::engine::ResizeDir;
use crate::runtime::engine::frame::{PanelFrame, SurfaceFrame};
use crate::runtime::motion::cubic_bezier;

use super::skin::{ChromeStyle, PanelMenu, TabActions};
use super::{TrellisWorkspace, WorkspaceEvent, place};

/// The strip's tab list: 6px in from the panel's edge and 6px from the
/// strip's top and bottom (28px tabs in a 40px strip), tabs 2px apart.
const LIST_INSET: f32 = 6.;
const TAB_GAP: f32 = 2.;

impl TrellisWorkspace {
    pub(crate) fn render_panel(
        &mut self,
        p: &PanelFrame,
        chrome: &ChromeStyle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let card = self.skin.card(p, cx);
        let shadow = if p.lifted {
            chrome.lifted_shadow.clone()
        } else if p.floating {
            chrome.floating_shadow.clone()
        } else {
            card.shadow.clone()
        };
        let local = Rect::new(0., 0., p.rect.w, p.rect.h);
        let panel_id = p.id.clone();
        let entity = cx.entity().downgrade();
        let mut el = place(div().id(("trellis-panel", hash(&p.id))), p.rect)
            .rounded(card.radius)
            .bg(card.background)
            .shadow(shadow)
            // A press anywhere in a panel focuses its selected view and raises
            // it if it floats; a frame too small to use drags from anywhere.
            .on_any_mouse_down({
                let entity = entity.clone();
                let panel = panel_id.clone();
                let frame_only = p.frame_only;
                move |event: &MouseDownEvent, window, cx| {
                    entity
                        .update(cx, |this, cx| {
                            this.press_panel(&panel, event, frame_only, window, cx)
                        })
                        .ok();
                }
            });
        if p.frame_only {
            let size = px(p.frame_icon_size as f32);
            el = el
                .cursor(CursorStyle::OpenHand)
                .flex()
                .items_center()
                .justify_center()
                .child(self.skin.frame_icon(p, size, cx))
                .on_click({
                    let entity = entity.clone();
                    let panel = panel_id.clone();
                    move |event, _, cx| {
                        if event.click_count() == 2 {
                            entity
                                .update(cx, |this, cx| {
                                    this.update_engine(cx, |e| e.toggle_frame(&panel));
                                })
                                .ok();
                        }
                    }
                });
        } else {
            for s in p.surfaces.iter().filter(|s| s.shown) {
                if let Some(content) = self.render_surface(p, s, window, cx) {
                    el = el.child(content);
                }
            }
            if p.bar == TabbarMode::Always || p.bar == TabbarMode::Overlay {
                el = el.child(self.render_strip(p, window, cx));
            }
        }
        el = el.children(self.skin.clone().card_children(p, cx));
        if p.handles {
            el = el.children(self.render_handles(p, local, cx));
        }
        let mut element = el.opacity(p.opacity as f32).into_any_element();
        if let Some(t) = p.appear {
            // Lattice's trellis-appear: opacity 0 → 1, scale .97 → 1, on the
            // slow tier's curve.
            let e = cubic_bezier(0.3, 0.8, 0.3, 1.02)(t) as f32;
            element = div()
                .opacity(e.min(1.))
                .child(scaled(element).scale(0.97 + 0.03 * e))
                .into_any_element();
        }
        element
    }

    fn render_surface(
        &mut self,
        p: &PanelFrame,
        s: &SurfaceFrame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view = self.skin.content(&s.view_id, window, cx)?;
        let body = Rect::new(s.body.x - p.rect.x, s.body.y - p.rect.y, s.body.w, s.body.h);
        let (w, h) = s.layout;
        let content = div()
            .absolute()
            .top_0()
            .left_0()
            .w(px(w as f32))
            .h(px(h as f32))
            .child(view.cached(StyleRefinement::default().absolute().size_full()));
        let content = if (s.scale - 1.).abs() > 1e-3 {
            scaled(content)
                .scale(s.scale as f32)
                .origin(point(0., 0.))
                .into_any_element()
        } else {
            content.into_any_element()
        };
        Some(
            place(div(), body)
                .overflow_hidden()
                .opacity(s.opacity as f32)
                .child(content)
                .into_any_element(),
        )
    }

    fn render_strip(
        &mut self,
        p: &PanelFrame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity().downgrade();
        let panel_id = p.id.clone();
        let strips = self.strips.clone();
        let menu = self.panel_menu(&panel_id, cx);
        let end = self.skin.strip_end(p, menu.clone(), window, cx);
        let mut list = div()
            .id(("trellis-tabs", hash(&p.id)))
            .relative()
            .flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .items_center()
            .gap(px(TAB_GAP))
            .pl(px(LIST_INSET))
            .pr(px(LIST_INSET))
            .overflow_x_scroll()
            .child({
                let strips = strips.clone();
                let panel = panel_id.clone();
                canvas(
                    move |b, _, _| {
                        strips.borrow_mut().entry(panel.clone()).or_default().list = Some(b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full()
            });
        {
            if let Some(boxes) = strips.borrow_mut().get_mut(&panel_id) {
                boxes
                    .tabs
                    .retain(|(v, _)| p.tabs.iter().any(|t| t.view_id == *v));
            }
        }
        for tab in &p.tabs {
            let view = tab.view_id.clone();
            let close = {
                let entity = entity.clone();
                let view = view.clone();
                Rc::new(move |_: &mut Window, cx: &mut gpui::App| {
                    entity
                        .update(cx, |_, cx| {
                            cx.emit(WorkspaceEvent::CloseRequested(vec![view.clone()]))
                        })
                        .ok();
                })
            };
            let element = self.skin.tab(p, tab, TabActions { close }, window, cx);
            let strips = strips.clone();
            let panel = panel_id.clone();
            let measured = view.clone();
            list = list.child(
                div()
                    .id(("trellis-tab", hash(&format!("{}\n{}", p.id, view))))
                    .relative()
                    .flex_shrink_1()
                    .min_w_0()
                    .left(px(tab.offset as f32))
                    .when(tab.sorting, |tab| tab.cursor(CursorStyle::ClosedHand))
                    .child(element)
                    .child(
                        canvas(
                            move |b, _, _| {
                                let mut strips = strips.borrow_mut();
                                let boxes = strips.entry(panel.clone()).or_default();
                                // At rest, not where a sort or settle moved it.
                                match boxes.tabs.iter_mut().find(|(v, _)| *v == measured) {
                                    Some(entry) => entry.1 = b,
                                    None => boxes.tabs.push((measured.clone(), b)),
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .on_mouse_down(MouseButton::Left, {
                        let entity = entity.clone();
                        let panel = panel_id.clone();
                        let view = view.clone();
                        move |event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            entity
                                .update(cx, |this, cx| {
                                    this.press_strip(&panel, Some(&view), event, window, cx)
                                })
                                .ok();
                        }
                    })
                    .on_mouse_down(MouseButton::Middle, {
                        let entity = entity.clone();
                        let view = view.clone();
                        let closable = tab.closable;
                        move |_, _, cx| {
                            cx.stop_propagation();
                            if closable {
                                entity
                                    .update(cx, |_, cx| {
                                        cx.emit(WorkspaceEvent::CloseRequested(vec![view.clone()]))
                                    })
                                    .ok();
                            }
                        }
                    })
                    .on_mouse_down(MouseButton::Right, {
                        let entity = entity.clone();
                        let view = view.clone();
                        let menu = menu.clone();
                        move |event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            entity
                                .update(cx, |this, cx| {
                                    this.update_engine(cx, |e| e.select_and_focus(&view));
                                    this.skin.clone().open_menu_at(
                                        menu.clone(),
                                        event.position,
                                        window,
                                        cx,
                                    );
                                })
                                .ok();
                        }
                    }),
            );
        }
        let bar_height = px(if p.bar_height > 0. {
            p.bar_height as f32
        } else {
            40.
        });
        div()
            .id(("trellis-strip", hash(&p.id)))
            .absolute()
            .top_0()
            .left_0()
            .w_full()
            .h(bar_height)
            .flex()
            .items_center()
            .pr(px(6.))
            .child({
                let strips = strips.clone();
                let panel = panel_id.clone();
                canvas(
                    move |b, _, _| {
                        strips.borrow_mut().entry(panel.clone()).or_default().bar = Some(b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full()
            })
            .children(self.skin.clone().strip_children(p, cx))
            .child(list)
            .children(end.accessories.map(|tools| {
                // A press on the tools belongs to them, never to a drag.
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(tools)
            }))
            .children(end.menu.map(|menu| {
                div()
                    .flex_none()
                    .ml(px(4.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(menu)
            }))
            // The strip's own background drags the whole panel; a double
            // click maximizes it, a right click opens its menu.
            .on_mouse_down(MouseButton::Left, {
                let entity = entity.clone();
                let panel = panel_id.clone();
                move |event: &MouseDownEvent, window, cx| {
                    entity
                        .update(cx, |this, cx| {
                            this.press_strip(&panel, None, event, window, cx)
                        })
                        .ok();
                }
            })
            .on_click({
                let entity = entity.clone();
                let panel = panel_id.clone();
                move |event, _, cx| {
                    if event.click_count() == 2 {
                        entity
                            .update(cx, |this, cx| {
                                if !this.engine.suppress_clicks() {
                                    this.update_engine(cx, |e| e.toggle_frame(&panel));
                                }
                            })
                            .ok();
                    }
                }
            })
            .on_mouse_down(MouseButton::Right, {
                let entity = entity.clone();
                move |event: &MouseDownEvent, window, cx| {
                    entity
                        .update(cx, |this, cx| {
                            this.skin.clone().open_menu_at(
                                menu.clone(),
                                event.position,
                                window,
                                cx,
                            );
                        })
                        .ok();
                }
            })
            .into_any_element()
    }

    /// A panel's menu: the built-ins for it, and how to run one.
    pub(crate) fn panel_menu(&self, panel_id: &str, cx: &mut Context<Self>) -> PanelMenu {
        let entity = cx.entity();
        let weak = entity.downgrade();
        let id = panel_id.to_string();
        let built_ins = {
            let weak = weak.clone();
            let id = id.clone();
            Rc::new(move |cx: &gpui::App| {
                weak.upgrade()
                    .map(|this| this.read(cx).engine.built_in_menu(&id))
                    .unwrap_or_default()
            })
        };
        let selected = {
            let weak = weak.clone();
            let id = id.clone();
            Rc::new(move |cx: &gpui::App| {
                let this = weak.upgrade()?;
                let doc = this.read(cx).engine.doc();
                crate::model::locate_panel(doc, &id).map(|l| l.panel().selected.clone())
            })
        };
        PanelMenu {
            panel_id: id,
            selected,
            built_ins,
            run: Rc::new(move |action, _, cx| {
                weak.update(cx, |this, cx| {
                    let close = this.update_engine(cx, |e| e.run_menu_action(action));
                    if !close.is_empty() {
                        cx.emit(WorkspaceEvent::CloseRequested(close));
                    }
                })
                .ok();
            }),
        }
    }

    /// A floating panel's eight resize handles: edges 8px thick, inset 8px
    /// from the corners and centred on the edge; corners 14px at −5px.
    fn render_handles(&self, p: &PanelFrame, r: Rect, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let entity = cx.entity().downgrade();
        let (w, h) = (r.w, r.h);
        let rects = [
            (
                ResizeDir::N,
                Rect::new(8., -4., w - 16., 8.),
                CursorStyle::ResizeUpDown,
            ),
            (
                ResizeDir::S,
                Rect::new(8., h - 4., w - 16., 8.),
                CursorStyle::ResizeUpDown,
            ),
            (
                ResizeDir::E,
                Rect::new(w - 4., 8., 8., h - 16.),
                CursorStyle::ResizeLeftRight,
            ),
            (
                ResizeDir::W,
                Rect::new(-4., 8., 8., h - 16.),
                CursorStyle::ResizeLeftRight,
            ),
            (
                ResizeDir::NE,
                Rect::new(w - 9., -5., 14., 14.),
                CursorStyle::ResizeUpRightDownLeft,
            ),
            (
                ResizeDir::NW,
                Rect::new(-5., -5., 14., 14.),
                CursorStyle::ResizeUpLeftDownRight,
            ),
            (
                ResizeDir::SE,
                Rect::new(w - 9., h - 9., 14., 14.),
                CursorStyle::ResizeUpLeftDownRight,
            ),
            (
                ResizeDir::SW,
                Rect::new(-5., h - 9., 14., 14.),
                CursorStyle::ResizeUpRightDownLeft,
            ),
        ];
        rects
            .into_iter()
            .map(|(dir, rect, cursor)| {
                let panel = p.id.clone();
                let entity = entity.clone();
                place(
                    div().id(("trellis-resize", hash(&format!("{}{dir:?}", p.id)))),
                    rect,
                )
                .cursor(cursor)
                .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    entity
                        .update(cx, |this, cx| this.press_resize(&panel, dir, event, cx))
                        .ok();
                })
                .into_any_element()
            })
            .collect()
    }
}

/// A stable element id from a string.
pub(crate) fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}
