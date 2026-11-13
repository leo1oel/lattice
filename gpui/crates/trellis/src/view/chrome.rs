// Part of the port of DanFessler/trellis 0.2.0 to GPUI, Copyright (c) Dan Fessler, Trellis Public License v1.0
// Non-Commercial (packages/core/src/runtime/workspace.ts: renderDividers, renderSlots, renderGroups;
// navigation.ts: the snap preview and marquee; style.css: their parts), with Lattice's trellis.css look
// (the divider's grip after a hover delay, the drop slot).

//! What the workspace draws between and over its panels: the dividers, the
//! drag's slots, the collapsed group tiles, the snap preview and marquee.

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, CursorStyle, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::model::{Axis, Rect};
use crate::runtime::engine::Frame;

use super::panel::hash;
use super::skin::ChromeStyle;
use super::{TrellisWorkspace, place};

/// The grip shows only after the pointer rests on a divider this long.
const GRIP_DELAY: Duration = Duration::from_millis(150);
/// Its fade, on the fast tier.
const GRIP_FADE: f32 = 80.;
/// A hovered grip's opacity; held, it is 1.
const GRIP_HOVER: f32 = 0.8;

impl TrellisWorkspace {
    /// Whether a hovered divider's grip is still fading in.
    pub(crate) fn divider_fading(&self) -> bool {
        self.divider_hover.as_ref().is_some_and(|(_, since)| {
            since.elapsed() < GRIP_DELAY + Duration::from_millis(GRIP_FADE as u64)
        })
    }

    fn grip_opacity(&self, key: &(String, usize), active: bool) -> f32 {
        if active {
            return 1.;
        }
        match &self.divider_hover {
            Some((hovered, since)) if hovered == key => {
                let t =
                    since.elapsed().saturating_sub(GRIP_DELAY).as_secs_f32() * 1000. / GRIP_FADE;
                GRIP_HOVER * t.clamp(0., 1.)
            }
            _ => 0.,
        }
    }

    pub(crate) fn render_dividers(
        &self,
        frame: &Frame,
        chrome: &ChromeStyle,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let entity = cx.entity().downgrade();
        frame
            .dividers
            .iter()
            .map(|d| {
                let key = (d.split_id.clone(), d.index);
                let opacity = self.grip_opacity(&key, d.active);
                let grip = match d.axis {
                    Axis::X => div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px((d.rect.w as f32 - f32::from(chrome.grip_width)) / 2.))
                        .w(chrome.grip_width),
                    Axis::Y => div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(px((d.rect.h as f32 - f32::from(chrome.grip_width)) / 2.))
                        .h(chrome.grip_width),
                }
                .rounded_full()
                .bg(chrome.grip)
                .opacity(opacity);
                let (split, index) = (d.split_id.clone(), d.index);
                let hover_entity = entity.clone();
                let down_entity = entity.clone();
                let click_entity = entity.clone();
                let hover_key = key.clone();
                place(
                    div().id((
                        "trellis-divider",
                        hash(&format!("{}:{}", d.split_id, d.index)),
                    )),
                    d.rect,
                )
                .cursor(match d.axis {
                    Axis::X => CursorStyle::ResizeColumn,
                    Axis::Y => CursorStyle::ResizeRow,
                })
                .child(grip)
                .on_hover(move |hovered, _, cx| {
                    let key = hover_key.clone();
                    hover_entity
                        .update(cx, |this, cx| {
                            if *hovered {
                                this.divider_hover = Some((key, Instant::now()));
                            } else if this.divider_hover.as_ref().is_some_and(|(k, _)| *k == key) {
                                this.divider_hover = None;
                            }
                            cx.notify();
                        })
                        .ok();
                })
                .on_mouse_down(MouseButton::Left, {
                    let split = split.clone();
                    move |_, _, cx| {
                        cx.stop_propagation();
                        down_entity
                            .update(cx, |this, cx| this.press_divider(&split, index, cx))
                            .ok();
                    }
                })
                .on_click(move |event, _, cx| {
                    if event.click_count() == 2 {
                        click_entity
                            .update(cx, |this, cx| {
                                this.update_engine(cx, |e| e.equalize(&split, index))
                            })
                            .ok();
                    }
                })
                .into_any_element()
            })
            .collect()
    }

    pub(crate) fn render_source_slot(
        &self,
        frame: &Frame,
        chrome: &ChromeStyle,
    ) -> Option<AnyElement> {
        // Where the lifted panel came from: a place held, drawn as nothing.
        let r = frame.source_slot?;
        Some(
            place(div(), r)
                .rounded(chrome.slot_radius)
                .into_any_element(),
        )
    }

    pub(crate) fn render_drop_slot(
        &self,
        frame: &Frame,
        chrome: &ChromeStyle,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let r = frame.drop_slot?;
        let label =
            (!frame.drop_label.is_empty()).then(|| self.skin.drop_label(&frame.drop_label, cx));
        Some(
            place(div(), r)
                .rounded(chrome.slot_radius)
                .bg(chrome.slot_fill)
                .border_2()
                .border_color(chrome.slot_ring)
                .flex()
                .items_center()
                .justify_center()
                .children(label)
                .into_any_element(),
        )
    }

    pub(crate) fn render_groups(
        &self,
        frame: &Frame,
        chrome: &ChromeStyle,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let entity = cx.entity().downgrade();
        frame
            .groups
            .iter()
            .map(|g| {
                let id = g.id.clone();
                let entity = entity.clone();
                let lines = g.lines.iter().map(|(axis, at, from, to)| {
                    let (w, h) = (g.rect.w, g.rect.h);
                    let line = match axis {
                        Axis::X => Rect::new(at * w, from * h, 1., (to - from) * h),
                        Axis::Y => Rect::new(from * w, at * h, (to - from) * w, 1.),
                    };
                    place(div(), line).bg(chrome.group_line)
                });
                place(div().id(("trellis-group", hash(&g.id))), g.rect)
                    .rounded(chrome.slot_radius)
                    .bg(chrome.group_fill)
                    .cursor(CursorStyle::PointingHand)
                    .children(lines)
                    .on_click(move |event, _, cx| {
                        if event.click_count() == 2 {
                            let position = event.position();
                            entity
                                .update(cx, |this, cx| {
                                    let p = this.local(position);
                                    this.update_engine(cx, |e| e.group_segment_at(&id, p));
                                })
                                .ok();
                        }
                    })
                    .into_any_element()
            })
            .collect()
    }

    /// The snap preview while a gesture drives the camera, and a marquee
    /// with the target it would frame.
    pub(crate) fn render_navigation(
        &self,
        frame: &Frame,
        chrome: &ChromeStyle,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        use crate::runtime::labels::{Label, label};
        let mut out = Vec::new();
        let ring = |r: Rect, text: String, cx: &mut Context<Self>| {
            let pad = 3.;
            place(
                div(),
                Rect::new(r.x - pad, r.y - pad, r.w + pad * 2., r.h + pad * 2.),
            )
            .rounded(chrome.slot_radius + px(3.))
            .border_2()
            .border_color(chrome.snap_ring)
            .flex()
            .justify_center()
            .pt(px(12.))
            .child(self.skin.snap_label(&text, cx))
            .into_any_element()
        };
        if let Some(r) = frame.snap {
            out.push(ring(r, label(Label::ReleaseToFocus), cx));
        }
        if let Some(m) = &frame.marquee {
            out.push(
                place(div(), m.rect)
                    .rounded(px(4.))
                    .bg(chrome.marquee_fill)
                    .border_1()
                    .border_color(chrome.marquee_border)
                    .into_any_element(),
            );
            if let Some((r, title)) = &m.target {
                out.push(ring(
                    *r,
                    label(Label::ReleaseToFocusTarget(title.clone())),
                    cx,
                ));
            }
        }
        out
    }
}
