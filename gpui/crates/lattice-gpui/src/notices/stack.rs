//! How the stack stands and moves (`toast-stack.css`, on Base UI's Toast).
//!
//! Collapsed, the newest card stands in front and up to two older ones show
//! an 8px sliver beyond it, each 5% smaller about the edge away from the
//! stack's anchor, all at the front card's height so the pile reads as one
//! object; a fourth waits unseen behind them, and the cards behind the
//! front one fade their words out. Hovering or focusing the stack fans it
//! out into a list 8px apart, every card at its own height and full size.
//! A card moves on the slow tier (a spring), fades on the moderate and
//! changes height on the moderate, each retargeted from where it is drawn.
//!
//! Arriving, a card drops in its own height from the stack's edge, from
//! 96%; leaving, it lifts 40% of its height back out to 96% on the exit
//! tweens (the slow tier's spring overshoots, and a dismissal must not
//! bounce), or carries on the way it was swiped. A card swipes toward the
//! edge the stack stands on, or off the side it is pinned to: past 40px it
//! goes, short of it it springs back, and a pull the other way is damped to
//! its square root. F6 reaches the stack from anywhere while it shows a
//! card, and Escape there dismisses the front card.
//!
//! Under reduced motion every move lands at once.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, Context, DispatchPhase, Entity, InteractiveElement as _, IntoElement,
    KeyBinding, MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point,
    Render, StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, actions, canvas, div,
    point, prelude::FluentBuilder as _, px, scaled,
};
use lattice_settings::ToastPosition;
use lattice_ui::{
    ActiveLattice as _,
    components::{Button, Toast},
    motion::{Exit, Motion, Tween},
    tokens::{MOTION_MODERATE_EXIT, MOTION_SLOW_EXIT},
};

use super::{NoticeStack, Shown, Takedown};

actions!(notices, [DismissNotification]);

/// What a card behind the front one shows of itself (`--toast-peek`).
const PEEK: f32 = 8.;
/// Between fanned-out cards (`--toast-gap`).
const GAP: f32 = 8.;
/// Each card behind is this much smaller, down to the third.
const SHRINK: f32 = 0.05;
/// The width a card takes, unless the window is narrower than it and its
/// 16px margins.
const WIDTH: f32 = 320.;
/// A swipe that travels this far dismisses (`SWIPE_THRESHOLD`).
const SWIPE_THRESHOLD: f32 = 40.;
/// A swipe pulled back this far from its furthest is called off
/// (`REVERSE_CANCEL_THRESHOLD`).
const SWIPE_CANCEL: f32 = 10.;

/// Escape on the focused stack, and F6 from anywhere while it shows a card.
pub(super) fn bind_keys(stack: &Entity<NoticeStack>, cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        "escape",
        DismissNotification,
        Some("NoticeStack"),
    )]);
    let stack = stack.downgrade();
    // F6 is the panels' cycle elsewhere; with a card showing it reaches the
    // stack first, as Base UI's window listener takes it.
    cx.intercept_keystrokes(move |event, window, cx| {
        let keystroke = &event.keystroke;
        if keystroke.key != "f6" || keystroke.modifiers.modified() {
            return;
        }
        let Some(stack) = stack.upgrade() else {
            return;
        };
        let reached = stack.update(cx, |stack, cx| stack.reach(window, cx));
        if reached {
            cx.stop_propagation();
        }
    })
    .detach();
}

/// Which way a card was swiped off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SwipeDirection {
    Right,
    /// Toward the edge the stack stands on.
    Edge,
}

/// A card being dragged.
pub(super) struct Swipe {
    pub(super) id: usize,
    start: Point<Pixels>,
    /// Where a pull back toward the start is measured from.
    baseline: Point<Pixels>,
    /// The axis the drag locked onto at its first move.
    horizontal: Option<bool>,
    intended: Option<SwipeDirection>,
    furthest: f32,
    cancelled: bool,
    /// The card's offset from its place: right, and toward the edge.
    offset: (f32, f32),
    /// How it went, once released past the threshold.
    pub(super) dismissed: Option<SwipeDirection>,
}

/// One card's drawn geometry, each part retargetable mid-flight.
pub(super) struct Look {
    /// How far in from the stack's edge the card stands, px.
    inward: Tween<f32>,
    /// Its swipe offset to the right, px.
    right: Tween<f32>,
    /// Its swipe offset toward the edge, px, on top of `inward`.
    drag: Tween<f32>,
    scale: Tween<f32>,
    opacity: Tween<f32>,
    height: Tween<f32>,
    content: Tween<f32>,
    /// The words' own height as last laid out; 0 before the first layout.
    natural: Rc<Cell<f32>>,
    /// The entrance has begun (it waits for the first measure, since it
    /// travels by the card's own height).
    entered: bool,
}

impl Look {
    pub(super) fn arriving(now: Instant) -> Self {
        Self {
            inward: Tween::settled(0., now),
            right: Tween::settled(0., now),
            drag: Tween::settled(0., now),
            scale: Tween::settled(0.96, now),
            opacity: Tween::settled(0., now),
            height: Tween::settled(0., now),
            content: Tween::settled(1., now),
            natural: Rc::new(Cell::new(0.)),
            entered: false,
        }
    }

    fn is_running(&self, now: Instant) -> bool {
        !self.entered
            || [
                &self.inward,
                &self.right,
                &self.drag,
                &self.scale,
                &self.opacity,
                &self.height,
                &self.content,
            ]
            .iter()
            .any(|tween| tween.is_running(now))
    }
}

/// One card as a scenario reads it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Clone, Debug, serde::Serialize)]
pub struct CardState {
    pub title: String,
    pub inward: f32,
    pub scale: f32,
    pub opacity: f32,
    pub height: f32,
    pub natural: f32,
    pub copy: Option<String>,
    pub progress: Option<f32>,
    pub actions: Vec<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Look {
    pub(super) fn state(&self, notice: &super::Notice, now: Instant) -> CardState {
        CardState {
            title: notice.title.to_string(),
            inward: self.inward.value(now) + self.drag.value(now),
            scale: self.scale.value(now),
            opacity: self.opacity.value(now),
            height: self.height.value(now),
            natural: self.natural.get(),
            copy: notice.copy_text().map(|text| text.to_string()),
            progress: notice.progress.map(|progress| match progress {
                lattice_ui::components::ToastProgress::Fraction(share) => share,
                lattice_ui::components::ToastProgress::Indeterminate => -1.,
            }),
            actions: notice
                .actions
                .iter()
                .map(|action| action.label.to_string())
                .collect(),
        }
    }
}

/// Where a card should stand this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Place {
    inward: f32,
    scale: f32,
    opacity: f32,
    height: f32,
    content: f32,
}

/// The `index`th card's place (0 the front), given every showing card's
/// own height in order.
fn place(index: usize, heights: &[f32], expanded: bool) -> Place {
    let front = heights.first().copied().unwrap_or_default();
    if expanded {
        let before: f32 = heights[..index].iter().sum();
        Place {
            inward: before + index as f32 * GAP,
            scale: 1.,
            opacity: 1.,
            height: heights[index],
            content: 1.,
        }
    } else {
        Place {
            inward: index as f32 * PEEK,
            scale: 1. - index.min(3) as f32 * SHRINK,
            // A card beyond the third sits behind the pile.
            opacity: (1. - index.saturating_sub(2) as f32).clamp(0., 1.),
            height: front,
            content: if index == 0 { 1. } else { 0. },
        }
    }
}

/// How much of the stack the pointer must be over to hold it open: the
/// pile, or the fanned-out list with the gaps between its cards.
fn extent(heights: &[f32], expanded: bool) -> f32 {
    let Some(front) = heights.first() else {
        return 0.;
    };
    let behind = heights.len() - 1;
    if expanded {
        heights.iter().sum::<f32>() + behind as f32 * GAP
    } else {
        front + behind.min(2) as f32 * PEEK
    }
}

/// Damp a pull the card may not travel: a browser's `|d| ^ 0.5`.
fn damp(delta: f32) -> f32 {
    delta.signum() * delta.abs().sqrt()
}

/// A card on its way out.
pub(super) struct Leaving {
    shown: Shown,
    index: usize,
    started: Instant,
}

impl Leaving {
    pub(super) fn new(
        mut shown: Shown,
        index: usize,
        swipe: Option<SwipeDirection>,
        now: Instant,
        reduce: bool,
    ) -> Self {
        let look = &mut shown.look;
        let height = look.height.value(now);
        let width = WIDTH;
        // From where it is drawn, the drag folded into its place.
        let inward = look.inward.value(now) + look.drag.value(now);
        look.inward.jump(inward, now);
        look.drag.jump(0., now);
        let (transform, fade) = (MOTION_SLOW_EXIT, MOTION_MODERATE_EXIT);
        // Under reduced motion the card lands where it goes and only fades.
        let travel = |tween: &mut Tween<f32>, to: f32| {
            if reduce {
                tween.jump(to, now);
            } else {
                tween.retarget_on(to, transform, Duration::ZERO, now);
            }
        };
        let (inward, right, scale) = match swipe {
            Some(SwipeDirection::Right) => (inward, look.right.value(now) + 1.1 * width, 1.),
            Some(SwipeDirection::Edge) => (inward - 1.2 * height, look.right.value(now), 1.),
            None => (-0.4 * height, 0., 0.96),
        };
        travel(&mut look.inward, inward);
        travel(&mut look.right, right);
        travel(&mut look.scale, scale);
        look.opacity.retarget_on(0., fade, Duration::ZERO, now);
        Self {
            shown,
            index,
            started: now,
        }
    }

    fn is_done(&self, now: Instant) -> bool {
        Exit::TOAST.is_done(now.saturating_duration_since(self.started))
    }
}

impl NoticeStack {
    /// F6: take keyboard focus into the stack, keeping what held it to give
    /// back. False when no card shows, the window doesn't draw the stack, or
    /// the stack holds focus already.
    fn reach(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let window_id = window.window_handle().window_id();
        if self.shown.is_empty()
            || !self.windows.contains_key(&window_id)
            || self.focus.contains_focused(window, cx)
        {
            return false;
        }
        self.focus_before = window.focused(cx).map(|focus| (window_id, focus));
        self.focus.focus(window, cx);
        self.set_focused(true, cx);
        true
    }

    /// Give focus back to what held it before F6.
    fn leave_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let window_id = window.window_handle().window_id();
        match self.focus_before.take() {
            Some((id, before)) if id == window_id => before.focus(window, cx),
            _ => window.blur(cx),
        }
        self.set_focused(false, cx);
    }

    fn set_focused(&mut self, focused: bool, cx: &mut Context<Self>) {
        if self.focused != focused {
            self.focused = focused;
            self.schedule(cx);
            cx.notify();
        }
    }

    /// Escape on the focused stack: the front card goes, and with the last
    /// one focus goes back.
    fn dismiss_front(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(front) = self.shown.first().map(|shown| shown.id) {
            self.take_down(front, Takedown::Dismissed, cx);
        }
        if self.shown.is_empty() {
            self.leave_focus(window, cx);
        }
    }

    /// Follow each window drawing the stack in and out of the front, and
    /// focus in and out of the stack there.
    fn observe_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let id = window.window_handle().window_id();
        if self.windows.contains_key(&id) {
            return;
        }
        self.windows.insert(id, window.is_window_active());
        let activation = cx.observe_window_activation(window, |this, window, cx| {
            let id = window.window_handle().window_id();
            this.set_window_active(id, window.is_window_active(), cx);
        });
        let focus = self.focus.clone();
        let focus_out = cx.on_focus_out(&focus, window, |this, _, _, cx| {
            this.set_focused(false, cx);
        });
        self._activation.extend([activation, focus_out]);
        self.schedule(cx);
    }

    fn begin_swipe(&mut self, id: usize, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.swipe = Some(Swipe {
            id,
            start: at,
            baseline: at,
            horizontal: None,
            intended: None,
            furthest: 0.,
            cancelled: false,
            offset: (0., 0.),
            dismissed: None,
        });
        cx.notify();
    }

    /// The drag moved to `at`; `edge` is +1 when the stack stands at the
    /// bottom (its edge is down), -1 at the top; `right` whether it is
    /// pinned to the right, so a card can leave that way.
    fn move_swipe(&mut self, at: Point<Pixels>, edge: f32, right: bool, cx: &mut Context<Self>) {
        let Some(swipe) = self.swipe.as_mut() else {
            return;
        };
        let (dx, dy) = (
            f32::from(at.x - swipe.start.x),
            f32::from(at.y - swipe.start.y),
        );
        if swipe.horizontal.is_none() && dx.hypot(dy) >= 1. && right {
            swipe.horizontal = Some(dx.abs() > dy.abs());
        }
        // Toward the edge, in the stack's own terms.
        let toward = dy * edge;
        let displacement = |direction: SwipeDirection, x: f32, y: f32| match direction {
            SwipeDirection::Right => x,
            SwipeDirection::Edge => y * edge,
        };
        // A pull back toward the start moves the baseline it is judged from.
        let (bx, by) = (
            f32::from(at.x - swipe.baseline.x),
            f32::from(at.y - swipe.baseline.y),
        );
        match swipe.intended {
            None => {
                let candidate = match swipe.horizontal {
                    Some(true) => (dx > 0.).then_some(SwipeDirection::Right),
                    Some(false) => (toward > 0.).then_some(SwipeDirection::Edge),
                    None if right && dx.abs() >= dy.abs() => {
                        (dx > 0.).then_some(SwipeDirection::Right)
                    }
                    None => (toward > 0.).then_some(SwipeDirection::Edge),
                };
                if let Some(direction) = candidate {
                    swipe.intended = Some(direction);
                    swipe.furthest = displacement(direction, dx, dy);
                }
            }
            Some(direction) => {
                let now = displacement(direction, bx, by);
                swipe.furthest = swipe.furthest.max(displacement(direction, dx, dy));
                if now > SWIPE_THRESHOLD {
                    swipe.cancelled = false;
                } else if swipe.furthest - now >= SWIPE_CANCEL {
                    swipe.cancelled = true;
                }
            }
        }
        // The card follows on the axes it may travel, damped the other way.
        let x = match (right, swipe.horizontal) {
            (false, _) | (_, Some(false)) => 0.,
            _ if dx > 0. => dx,
            _ => damp(dx),
        };
        let y = match swipe.horizontal {
            Some(true) => 0.,
            _ if toward > 0. => toward,
            _ => damp(toward),
        };
        swipe.offset = (x, y);
        let id = swipe.id;
        let now = Instant::now();
        if let Some(shown) = self.shown.iter_mut().find(|shown| shown.id == id) {
            shown.look.right.jump(x, now);
            shown.look.drag.jump(-y, now);
        }
        cx.notify();
    }

    /// The press let go: past the threshold the card goes the way it was
    /// pulled, short of it it springs back.
    fn end_swipe(&mut self, reduce: bool, cx: &mut Context<Self>) {
        let Some(swipe) = self.swipe.as_mut() else {
            return;
        };
        let (x, y) = swipe.offset;
        let direction = if swipe.cancelled {
            None
        } else if x > SWIPE_THRESHOLD {
            Some(SwipeDirection::Right)
        } else if y > SWIPE_THRESHOLD {
            Some(SwipeDirection::Edge)
        } else {
            None
        };
        let id = swipe.id;
        match direction {
            Some(direction) => {
                swipe.dismissed = Some(direction);
                self.take_down(id, Takedown::Dismissed, cx);
            }
            None => {
                self.swipe = None;
                let now = Instant::now();
                if let Some(shown) = self.shown.iter_mut().find(|shown| shown.id == id) {
                    move_to(&mut shown.look.right, 0., Motion::Slow, now, reduce);
                    move_to(&mut shown.look.drag, 0., Motion::Slow, now, reduce);
                }
                cx.notify();
            }
        }
    }
}

fn move_to(tween: &mut Tween<f32>, to: f32, motion: Motion, now: Instant, reduce: bool) {
    if reduce {
        tween.jump(to, now);
    } else {
        tween.retarget(to, motion, now);
    }
}

impl Render for NoticeStack {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.observe_window(window, cx);
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        self.leaving.retain(|leaving| !leaving.is_done(now));
        if self.leaving.is_empty() && std::mem::take(&mut self.leave_pending) {
            // The pointer left while a card was on its way out.
            self.set_hovered(false, cx);
        }
        // Settings › Appearance › Notification position (toast-stack.css):
        // 52px clears the 40px title bar at the top, 44px keeps the cards
        // off the panels' status row at the bottom; 16px in at the right,
        // or centred.
        let position = crate::settings::get(cx).appearance.toast_position;
        let (top, centered) = match position {
            ToastPosition::TopRight => (true, false),
            ToastPosition::TopCenter => (true, true),
            ToastPosition::BottomRight => (false, false),
            ToastPosition::BottomCenter => (false, true),
        };
        let width = WIDTH
            .min(f32::from(window.viewport_size().width) - 32.)
            .max(0.);
        let expanded = self.hovered || self.focused;
        let heights: Vec<f32> = self
            .shown
            .iter()
            .map(|shown| shown.look.natural.get())
            .collect();
        let mut animating = !self.leaving.is_empty();
        let palette = cx.palette().clone();
        let this = cx.entity().downgrade();
        // A card that has not laid out yet has no height to stand the others
        // on: they hold where they are for the frame it takes.
        let measuring = heights.iter().any(|height| *height <= 0.);
        let mut cards: Vec<(usize, AnyElement)> = Vec::new();
        for index in 0..self.shown.len() {
            let target = place(index, &heights, expanded);
            let shown = &mut self.shown[index];
            let look = &mut shown.look;
            if !look.entered {
                if look.natural.get() > 0. {
                    // In from beyond the edge by its own height, from 96%.
                    look.entered = true;
                    look.inward.jump(-look.natural.get(), now);
                    look.height.jump(target.height, now);
                    look.content.jump(target.content, now);
                } else {
                    look.height.jump(target.height.max(1.), now);
                }
            }
            if look.entered && !measuring {
                move_to(&mut look.inward, target.inward, Motion::Slow, now, reduce);
                move_to(&mut look.scale, target.scale, Motion::Slow, now, reduce);
                move_to(
                    &mut look.opacity,
                    target.opacity,
                    Motion::Moderate,
                    now,
                    reduce,
                );
                move_to(
                    &mut look.height,
                    target.height,
                    Motion::Moderate,
                    now,
                    reduce,
                );
                move_to(&mut look.content, target.content, Motion::Fast, now, reduce);
            }
            animating |= look.is_running(now) || measuring;
            let card = draw(
                shown,
                index == 0,
                Some(&this),
                top,
                width,
                now,
                &palette,
                window,
                cx,
            );
            cards.push((10 - index.min(10), card));
        }
        for leaving in &self.leaving {
            animating = true;
            let card = draw(
                &leaving.shown,
                false,
                None,
                top,
                width,
                now,
                &palette,
                window,
                cx,
            );
            cards.push((10 - leaving.index.min(10), card));
        }
        // Front cards over back ones; a leaving card where it stood.
        cards.sort_by_key(|(z, _)| *z);
        if animating {
            window.request_animation_frame();
        }
        let right = !centered;
        let edge = if top { -1. } else { 1. };
        let swiping = self
            .swipe
            .as_ref()
            .is_some_and(|swipe| swipe.dismissed.is_none());
        let tracker = swiping.then(|| {
            let this = this.clone();
            canvas(
                |_, _, _| (),
                move |_, _, window, _| {
                    let moves = this.clone();
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            moves
                                .update(cx, |this, cx| {
                                    this.move_swipe(event.position, edge, right, cx)
                                })
                                .ok();
                        }
                    });
                    let ups = this.clone();
                    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let reduce = cx.reduce_motion();
                            ups.update(cx, |this, cx| this.end_swipe(reduce, cx)).ok();
                        }
                    });
                },
            )
            .absolute()
            .size_0()
        });
        let stack = div()
            .id("notice-stack")
            .key_context("NoticeStack")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &DismissNotification, window, cx| {
                this.dismiss_front(window, cx)
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                // A pointer leaving while a card is still on its way out keeps
                // the stack open until it has gone, so the list does not fold
                // up mid-gesture.
                this.leave_pending = !*hovered && !this.leaving.is_empty();
                if !this.leave_pending {
                    this.set_hovered(*hovered, cx)
                }
            }))
            // The stack, not each card, keeps the pointer from what is under
            // it: a card's own occlusion would hide the stack's hover from it.
            .occlude()
            .relative()
            .w(px(width))
            .h(px(extent(&heights, expanded)))
            .children(cards.into_iter().map(|(_, card)| card))
            .children(tracker);
        div()
            .absolute()
            .when(top, |this| this.top(px(52.)))
            .when(!top, |this| this.bottom(px(44.)))
            .map(|this| {
                if centered {
                    this.left_0().right_0().flex().justify_center()
                } else {
                    this.right(px(16.))
                }
            })
            .child(stack)
    }
}

/// One card where its look stands at `now`; `this` wires its X, actions
/// and swipe, and is `None` for a card on its way out, which takes no input.
#[allow(clippy::too_many_arguments)]
fn draw(
    shown: &Shown,
    front: bool,
    this: Option<&WeakEntity<NoticeStack>>,
    top: bool,
    width: f32,
    now: Instant,
    palette: &lattice_ui::Palette,
    _: &mut Window,
    _: &mut App,
) -> AnyElement {
    let id = shown.id;
    let notice = &shown.notice;
    let look = &shown.look;
    // A host error reads in the interface language on screen only; the
    // log and Copy keep the English a report is searched by.
    let title: gpui::SharedString = crate::host_errors::text(&notice.title).into();
    let mut toast = Toast::new(("notice", id), notice.level, title)
        .width(px(width))
        .height(px(look.height.value(now).max(0.)))
        .content_opacity(look.content.value(now).clamp(0., 1.));
    if this.is_some() && front {
        toast = toast.parity("toast/front");
    }
    if let Some(detail) = notice
        .detail
        .as_ref()
        .filter(|detail| !detail.trim().is_empty())
    {
        toast = toast.detail(crate::host_errors::text(detail));
    }
    if let Some(copy) = notice.copy_text() {
        toast = toast.copy(copy);
    }
    if let Some(progress) = notice.progress {
        toast = toast
            .progress(progress)
            .mark(crate::build::chip_mark::infinity_loader(
                ("notice-loader", id),
                px(16.),
                palette,
            ));
    }
    if let Some(this) = this {
        let natural = look.natural.clone();
        let measured = this.clone();
        toast = toast.on_measure(move |height, cx| {
            let height = f32::from(height);
            if (natural.get() - height).abs() > 0.5 {
                natural.set(height);
                measured.update(cx, |_, cx| cx.notify()).ok();
            }
        });
        let dismiss = this.clone();
        toast = toast.on_dismiss(move |_, _, cx| {
            dismiss
                .update(cx, |this, cx| this.take_down(id, Takedown::Dismissed, cx))
                .ok();
        });
        for (ix, action) in notice.actions.iter().enumerate() {
            let run = action.run.clone();
            let keep_open = action.keep_open;
            let answer = this.clone();
            let mut button = Button::new(("notice-action", id * 8 + ix), action.label.clone())
                .compact()
                .on_click(move |_, window, cx| {
                    run(window, cx);
                    if !keep_open {
                        answer
                            .update(cx, |this, cx| this.take_down(id, Takedown::Answered, cx))
                            .ok();
                    }
                });
            if ix == 0 {
                button = button.tinted();
            }
            toast = toast.action(button);
        }
    } else {
        for (ix, action) in notice.actions.iter().enumerate() {
            let mut button =
                Button::new(("notice-action", id * 8 + ix), action.label.clone()).compact();
            if ix == 0 {
                button = button.tinted();
            }
            toast = toast.action(button);
        }
        toast = toast.on_dismiss(|_, _, _| {});
    }
    // Scaled about the edge away from the stack's anchor, so a smaller card
    // still shows its whole sliver past the one in front.
    let origin = if top { 1. } else { 0. };
    let card = scaled(div().child(toast))
        .origin(point(0.5, origin))
        .scale(look.scale.value(now));
    let inward = look.inward.value(now) + look.drag.value(now);
    let right = look.right.value(now);
    let wrapper = div()
        .id(("notice-card", id))
        .absolute()
        .w(px(width))
        .left(px(right))
        .when(top, |this| this.top(px(inward)))
        .when(!top, |this| this.bottom(px(inward)))
        .opacity(look.opacity.value(now).clamp(0., 1.))
        .child(card);
    match this {
        Some(this) => {
            let (press, up, up_out) = (this.clone(), this.clone(), this.clone());
            let release = |stack: &WeakEntity<NoticeStack>, cx: &mut App| {
                let reduce = cx.reduce_motion();
                stack.update(cx, |this, cx| this.end_swipe(reduce, cx)).ok();
            };
            wrapper
                .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                    press
                        .update(cx, |this, cx| this.begin_swipe(id, event.position, cx))
                        .ok();
                })
                // A release before the window's own listeners are in place
                // (the frame after the press) still ends the drag.
                .on_mouse_up(MouseButton::Left, move |_, _, cx| release(&up, cx))
                .on_mouse_up_out(MouseButton::Left, move |_, _, cx| release(&up_out, cx))
                .into_any_element()
        }
        None => wrapper.into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pile_shows_two_slivers_and_hides_the_fourth() {
        let heights = [60., 80., 40., 50.];
        let front = place(0, &heights, false);
        assert_eq!(
            (front.inward, front.scale, front.opacity, front.content),
            (0., 1., 1., 1.)
        );
        let second = place(1, &heights, false);
        assert_eq!(second.inward, PEEK);
        assert!((second.scale - 0.95).abs() < 1e-6);
        // Every card takes the front card's height.
        assert_eq!(second.height, 60.);
        assert_eq!(second.content, 0.);
        assert_eq!(place(2, &heights, false).opacity, 1.);
        assert_eq!(place(3, &heights, false).opacity, 0.);
        assert!((place(3, &heights, false).scale - 0.85).abs() < 1e-6);
        assert_eq!(extent(&heights, false), 60. + 2. * PEEK);
    }

    #[test]
    fn fanned_out_every_card_stands_at_its_own_height_one_gap_apart() {
        let heights = [60., 80., 40.];
        let third = place(2, &heights, true);
        assert_eq!(third.inward, 60. + 80. + 2. * GAP);
        assert_eq!((third.scale, third.height, third.content), (1., 40., 1.));
        assert_eq!(extent(&heights, true), 180. + 2. * GAP);
    }

    fn card_pulled_toward_the_edge(pull: f32, now: Instant) -> Shown {
        let mut look = Look::arriving(now);
        look.inward.jump(PEEK, now);
        look.height.jump(60., now);
        look.opacity.jump(1., now);
        look.scale.jump(1., now);
        look.drag.jump(-pull, now);
        Shown {
            id: 0,
            notice: super::super::Notice::new(lattice_ui::components::ToastLevel::Info, "t"),
            key: "t".into(),
            clock: None,
            look,
        }
    }

    #[test]
    fn an_edge_swipe_leaves_from_where_the_card_is_drawn() {
        let now = Instant::now();
        let leaving = Leaving::new(
            card_pulled_toward_the_edge(50., now),
            0,
            Some(SwipeDirection::Edge),
            now,
            false,
        );
        let look = &leaving.shown.look;
        assert_eq!(look.inward.value(now) + look.drag.value(now), PEEK - 50.);
    }

    #[test]
    fn under_reduced_motion_a_leaving_card_lands_at_once_and_only_fades() {
        let now = Instant::now();
        let leaving = Leaving::new(card_pulled_toward_the_edge(0., now), 0, None, now, true);
        let look = &leaving.shown.look;
        assert_eq!((look.inward.value(now), look.right.value(now)), (-24., 0.));
        assert!((look.scale.value(now) - 0.96).abs() < 1e-6);
        assert!(!look.inward.is_running(now) && !look.scale.is_running(now));
        assert!(look.opacity.is_running(now));
    }

    #[test]
    fn a_pull_the_card_may_not_travel_is_damped() {
        assert_eq!(damp(16.), 4.);
        assert_eq!(damp(-25.), -5.);
    }
}
