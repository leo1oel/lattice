//! Slider: a value on a track, as Settings' rows set a size or a delay.
//!
//! The app draws a native range input tinted with the accent
//! (`accent-color: var(--control-active)`, dialogs.css), so this follows
//! WebKit's slider in Lattice's colours: a 4px pill of the strong hairline,
//! filled with the accent up to the thumb, and a 14px thumb on the lift with
//! the raised level's ring and shadow, whose edge deepens under the pointer.
//! The thumb stays inside the control's box (the track runs half a thumb in
//! from each end), so the focus ring, the one 2px ring at a 2px offset, goes
//! round the whole control as the web view draws it round the input.
//!
//! In a Settings row the slider takes the control column (170px) with its
//! readout beside it: 10px over, at least 34px wide, right-aligned caption
//! in the secondary ink with tabular figures (`.settings-row-slider`).
//!
//! GPUI Kit's headless slider (`gpui_kit::base::Slider`) owns the value, the
//! pointer and the drag; this adds the keys a range input answers to: the
//! arrows step, Page Up and Page Down move a tenth of the range, Home and
//! End go to the ends. A disabled slider fades to 42% and takes nothing.

use std::rc::Rc;

use gpui::{
    App, ElementId, Entity, FontFeatures, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px, relative,
};
use gpui_kit::base::{
    Slider as BaseSlider, SliderIndicator, SliderThumb, SliderTrack, slider::SliderState,
};

use crate::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::focus_ring,
    elevation::ring,
    interaction::{fade, mix, tab_stop, track_pointer, use_interaction},
    motion::Motion,
    tokens::{CONTAINER_SETTINGS_CONTROL, OPACITY_DISABLED},
};

const THUMB: f32 = 14.;
const TRACK: f32 = 4.;

type Readout = Rc<dyn Fn(f32) -> SharedString>;

#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    state: Entity<SliderState>,
    readout: Option<Readout>,
    label: Option<SharedString>,
    disabled: bool,
}

impl Slider {
    pub fn new(id: impl Into<ElementId>, state: &Entity<SliderState>) -> Self {
        Self {
            id: id.into(),
            state: state.clone(),
            readout: None,
            label: None,
            disabled: false,
        }
    }

    /// Show the value beside the track, as `format` writes it, in a Settings
    /// row's 170px control column.
    pub fn readout(mut self, format: impl Fn(f32) -> SharedString + 'static) -> Self {
        self.readout = Some(Rc::new(format));
        self
    }

    /// The name assistive technology reads for it.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// How far a key moves the value, from `value` on a `min..=max` range with
/// `step`: an arrow one step, Page Up or Down a tenth of the range (at least
/// a step), Home and End to the ends. A step that is not a positive number
/// moves a hundredth of the range, as a range input without a usable step
/// would still answer its arrows. `None` for a key the slider ignores.
pub fn key_delta(key: &str, value: f32, min: f32, max: f32, step: f32) -> Option<f32> {
    let step = if step > 0. && step.is_finite() {
        step
    } else {
        (max - min) / 100.
    };
    let page = ((max - min) / 10.).max(step);
    match key {
        "right" | "up" => Some(step),
        "left" | "down" => Some(-step),
        "pageup" => Some(page),
        "pagedown" => Some(-page),
        "home" => Some(min - value),
        "end" => Some(max - value),
        _ => None,
    }
}

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let disabled = self.disabled;
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        // Held from a press anywhere on the control, the thumb included, to
        // the release, wherever the drag has taken the pointer: the thumb
        // swallows its own press, and a drag ends the frame's hover.
        let held_id = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let held_state = window.use_keyed_state(held_id("held"), cx, |_, _| false);
        let held = fade(
            held_id("held-fade"),
            *held_state.read(cx),
            Motion::Fast,
            window,
            cx,
        );
        let focus = focus_ring(&palette, palette.panel);
        let (fraction, value) = {
            let state = self.state.read(cx);
            (state.percentage().end, state.value().end())
        };

        // The thumb's edge: the raised level's ring, deepened under the
        // pointer, then the level's shadow.
        let mut thumb_shadow = Elevation::Raised.shadows(&palette);
        thumb_shadow[0] = ring(mix(
            palette.ring,
            palette.control_hover_border,
            interaction.hover.max(held),
        ));

        let state = self.state.clone();
        let keys = move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
            let delta = {
                let s = state.read(cx);
                key_delta(
                    &event.keystroke.key,
                    s.value().end(),
                    s.min_value(),
                    s.max_value(),
                    s.step_value(),
                )
            };
            if let Some(delta) = delta {
                cx.stop_propagation();
                state.update(cx, |s, cx| s.step_thumb(false, delta, window, cx));
            }
        };

        let thumb = SliderThumb::new(&self.state)
            .disabled(disabled)
            .absolute()
            .top(px((TRACK - THUMB) / 2.))
            .left(relative(fraction))
            .ml(px(-THUMB / 2.))
            .size(px(THUMB))
            .rounded_full()
            .bg(palette.raised)
            .shadow(thumb_shadow);
        let bar = SliderIndicator::new(&self.state)
            .relative()
            .w_full()
            .h(px(TRACK))
            .rounded_full()
            .bg(palette.line_strong)
            .child(
                div()
                    .absolute()
                    .left_0()
                    .h_full()
                    .w(relative(fraction))
                    .rounded_full()
                    .bg(palette.accent),
            )
            .child(thumb);
        let track = SliderTrack::new(&self.state)
            .disabled(disabled)
            .flex()
            .items_center()
            .w_full()
            .h(px(THUMB + 2.))
            .px(px(THUMB / 2.))
            .child(bar);
        let slider = BaseSlider::new(&self.state)
            .disabled(disabled)
            .when_some(self.label, |this, label| this.accessibility_label(label))
            .flex_1()
            .min_w_0()
            .child(track);

        let frame = div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(10.))
            .rounded_full()
            .when(self.readout.is_some(), |this| {
                this.w(CONTAINER_SETTINGS_CONTROL)
            })
            .when(disabled, |this| this.opacity(OPACITY_DISABLED));
        // A press drags the thumb without taking focus (`tab_stop`), so a
        // pointer never draws the ring.
        let frame = if disabled {
            frame
        } else {
            let set_held = move |held: bool| {
                let state = held_state.clone();
                move |cx: &mut App| {
                    state.update(cx, |state, cx| {
                        if *state != held {
                            *state = held;
                            cx.notify();
                        }
                    })
                }
            };
            let (press, release, release_out) = (set_held(true), set_held(false), set_held(false));
            track_pointer(tab_stop(frame), pointer)
                .focus_visible(move |style| style.shadow(focus))
                .on_key_down(keys)
                .capture_any_mouse_down(move |event, _, cx| {
                    if event.button == MouseButton::Left {
                        press(cx)
                    }
                })
                .capture_any_mouse_up(move |event, _, cx| {
                    if event.button == MouseButton::Left {
                        release(cx)
                    }
                })
                .on_mouse_up_out(MouseButton::Left, move |_, _, cx| release_out(cx))
        };
        frame.child(slider).when_some(self.readout, |this, format| {
            this.child(
                div()
                    .flex_none()
                    .min_w(px(34.))
                    .flex()
                    .justify_end()
                    .text_role(TextRole::Caption, cx)
                    .font_features(FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)])))
                    .text_color(palette.text_secondary)
                    .child(format(value)),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrows_step_and_pages_move_a_tenth_of_the_range() {
        assert_eq!(key_delta("right", 40., 0., 100., 1.), Some(1.));
        assert_eq!(key_delta("down", 40., 0., 100., 1.), Some(-1.));
        assert_eq!(key_delta("pageup", 40., 0., 100., 1.), Some(10.));
        assert_eq!(key_delta("pagedown", 40., 0., 100., 1.), Some(-10.));
    }

    #[test]
    fn a_page_is_never_less_than_a_step() {
        // An editor font size, 10 to 20 in steps of 2: a tenth of the range
        // would be one point, off the grid.
        assert_eq!(key_delta("pageup", 14., 10., 20., 2.), Some(2.));
    }

    #[test]
    fn home_and_end_reach_the_ends_from_anywhere() {
        assert_eq!(
            key_delta("home", 14., 10., 20., 2.).map(|d| 14. + d),
            Some(10.)
        );
        assert_eq!(
            key_delta("end", 14., 10., 20., 2.).map(|d| 14. + d),
            Some(20.)
        );
    }

    #[test]
    fn an_unusable_step_moves_a_hundredth_of_the_range() {
        assert_eq!(key_delta("right", 40., 0., 200., 0.), Some(2.));
        assert_eq!(key_delta("left", 40., 0., 200., -1.), Some(-2.));
        assert_eq!(key_delta("up", 40., 0., 200., f32::NAN), Some(2.));
        assert_eq!(key_delta("pageup", 40., 0., 200., f32::NAN), Some(20.));
    }

    #[test]
    fn other_keys_are_left_alone() {
        assert_eq!(key_delta("tab", 0., 0., 1., 0.1), None);
        assert_eq!(key_delta("a", 0., 0., 1., 0.1), None);
    }
}
