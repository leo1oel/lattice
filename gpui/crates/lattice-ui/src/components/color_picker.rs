//! A custom colour on one surface, the way desktop editors draw it (Figma,
//! Framer, Confluence), as the Tauri app's `ColorPicker`
//! (`src/components/ui/color-picker.tsx`, `color-picker.css`) has it: a
//! saturation × brightness field, a hue strip beside the eyedropper, and a
//! hex field that is always there, with the colour's chip and spoken name.
//! HSV is the canonical draft (`crate::color`), so a grey or black keeps the
//! hue it came from, and every brightness is one drag away.
//!
//! This is the picker's core; whoever opens it puts its preview, verdict,
//! swatches ([`SwatchGrid`]) and footer around it, as the Tauri component
//! takes them as props. The eyedropper asks the host to sample the screen
//! ([`ColorPickerEvent::Sample`]), since the system's sampler is the
//! platform's, and the host hands the colour back with
//! [`ColorPicker::set_hex`].
//!
//! The field is one tab stop whose arrows move its thumb (Shift for tens),
//! the strip another whose arrows step the hue, as a range input's do; a
//! press on either takes the thumb there and drags it until the release,
//! wherever the pointer goes. Return in the picker confirms.

use gpui::{
    App, AppContext as _, Bounds, Context, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable as _, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window,
    canvas, div, linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px, relative,
    rgb,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_i18n::t;

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    color::{self, Hsv},
    components::{focus_ring, key_delta},
    shape::{RADIUS_CHIP, RADIUS_TARGET},
    tokens::{SPACING_2, SPACING_4},
};

/// The field's height (`.cp-field`).
const FIELD_HEIGHT: f32 = 128.;
/// The hue strip's height (`.cp-hue`).
const STRIP_HEIGHT: f32 = 10.;
/// A thumb's diameter (`.cp-field-thumb`, `.cp-hue-thumb`).
const THUMB: f32 = 14.;
/// The eyedropper's side (`.cp-eyedropper`).
const EYEDROPPER: f32 = 28.;

/// What the picker tells whoever opened it.
#[derive(Clone, Debug, PartialEq)]
pub enum ColorPickerEvent {
    /// The draft changed, to this `#RRGGBB`.
    Change(String),
    /// Return in the picker: commit this `#RRGGBB`.
    Confirm(String),
    /// The eyedropper: sample a colour from the screen.
    Sample,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Surface {
    Field,
    Hue,
}

pub struct ColorPicker {
    hsv: Hsv,
    hex: Entity<InputState>,
    /// While the field shows what was typed rather than the draft: a code
    /// still being typed, or one that is not a colour.
    typed: bool,
    /// Writing the draft into the hex field, whose change is then not the
    /// writer's.
    syncing: bool,
    field_focus: FocusHandle,
    hue_focus: FocusHandle,
    field_bounds: Option<Bounds<Pixels>>,
    hue_bounds: Option<Bounds<Pixels>>,
    dragging: Option<Surface>,
    eyedropper: bool,
    _hex_events: Subscription,
}

impl EventEmitter<ColorPickerEvent> for ColorPicker {}

impl ColorPicker {
    /// A picker drafting `hex` (the default highlighter's yellow when it is
    /// not a colour).
    pub fn new(hex: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let hsv = color::normalize_hex(hex)
            .and_then(|hex| color::hsv_of(&hex, 0.))
            .or_else(|| color::hsv_of("#FFF1A6", 0.))
            .unwrap_or(Hsv {
                h: 0.,
                s: 0.,
                v: 100.,
            });
        let start = color::hsv_hex(hsv);
        let field = cx.new(|cx| InputState::new(window, cx).default_value(start[1..].to_string()));
        let events = cx.subscribe_in(
            &field,
            window,
            |this, field, event, window, cx| match event {
                InputEvent::Change if !this.syncing => {
                    let text = field.read(cx).value().to_string();
                    this.typed = true;
                    // A complete code applies at once; three digits wait for the
                    // blur, as they are also the start of a six-digit one.
                    let digits = text.trim().trim_start_matches('#');
                    if let Some(hex) = color::normalize_hex(&text).filter(|_| digits.len() == 6) {
                        this.typed = false;
                        this.set_draft(
                            color::hsv_of(&hex, this.hsv.h).unwrap_or(this.hsv),
                            false,
                            window,
                            cx,
                        );
                    }
                    cx.notify();
                }
                InputEvent::Blur => {
                    let text = field.read(cx).value().to_string();
                    match color::normalize_hex(&text) {
                        Some(hex) => this.set_hex(&hex, window, cx),
                        None => {
                            this.typed = false;
                            this.write_field(window, cx);
                        }
                    }
                }
                InputEvent::PressEnter { .. } => {
                    let text = field.read(cx).value().to_string();
                    if let Some(hex) = color::normalize_hex(&text) {
                        this.set_hex(&hex, window, cx);
                        cx.emit(ColorPickerEvent::Confirm(hex));
                    }
                }
                _ => {}
            },
        );
        Self {
            hsv,
            hex: field,
            typed: false,
            syncing: false,
            field_focus: cx.focus_handle(),
            hue_focus: cx.focus_handle(),
            field_bounds: None,
            hue_bounds: None,
            dragging: None,
            eyedropper: true,
            _hex_events: events,
        }
    }

    /// Leave the eyedropper out, where the platform has no screen sampler.
    pub fn without_eyedropper(mut self) -> Self {
        self.eyedropper = false;
        self
    }

    /// The draft as `#RRGGBB`, or what the hex field holds when it is a
    /// colour typed but not yet applied; `None` while it holds no colour.
    pub fn hex(&self, cx: &App) -> Option<String> {
        if self.typed {
            color::normalize_hex(&self.hex.read(cx).value())
        } else {
            Some(color::hsv_hex(self.hsv))
        }
    }

    /// Whether the hex field holds something that is not a colour.
    pub fn invalid(&self, cx: &App) -> bool {
        self.typed && color::normalize_hex(&self.hex.read(cx).value()).is_none()
    }

    /// The draft as HSV.
    pub fn hsv(&self) -> Hsv {
        self.hsv
    }

    /// Where the saturation × brightness field was laid out last frame.
    pub fn field_bounds(&self) -> Option<Bounds<Pixels>> {
        self.field_bounds
    }

    /// Take `hex` as the draft (a swatch, the eyedropper, a fix), keeping
    /// the hue when it is a grey.
    pub fn set_hex(&mut self, hex: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(hsv) = color::normalize_hex(hex).and_then(|hex| color::hsv_of(&hex, self.hsv.h))
        else {
            return;
        };
        self.typed = false;
        self.set_draft(hsv, true, window, cx);
    }

    fn set_draft(&mut self, hsv: Hsv, write: bool, window: &mut Window, cx: &mut Context<Self>) {
        let before = color::hsv_hex(self.hsv);
        self.hsv = hsv;
        if write {
            self.write_field(window, cx);
        }
        let after = color::hsv_hex(hsv);
        if after != before {
            cx.emit(ColorPickerEvent::Change(after));
        }
        cx.notify();
    }

    /// Show the draft in the hex field.
    fn write_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let hex = color::hsv_hex(self.hsv);
        self.syncing = true;
        self.hex.update(cx, |field, cx| {
            field.set_value(hex[1..].to_string(), window, cx)
        });
        self.syncing = false;
    }

    fn drag_to(
        &mut self,
        surface: Surface,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bounds = match surface {
            Surface::Field => self.field_bounds,
            Surface::Hue => self.hue_bounds,
        };
        let Some(bounds) = bounds else {
            return;
        };
        let share = |at: Pixels, start: Pixels, length: Pixels| {
            if length <= px(0.) {
                0.
            } else {
                ((at - start) / length).clamp(0., 1.)
            }
        };
        let x = share(position.x, bounds.left(), bounds.size.width);
        let next = match surface {
            Surface::Field => Hsv {
                h: self.hsv.h,
                s: x * 100.,
                v: (1. - share(position.y, bounds.top(), bounds.size.height)) * 100.,
            },
            Surface::Hue => Hsv {
                h: (x * 359.).round(),
                ..self.hsv
            },
        };
        self.typed = false;
        self.set_draft(next, true, window, cx);
    }

    fn field_keys(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let step = if event.keystroke.modifiers.shift {
            10.
        } else {
            1.
        };
        let (ds, dv) = match event.keystroke.key.as_str() {
            "left" => (-step, 0.),
            "right" => (step, 0.),
            "up" => (0., step),
            "down" => (0., -step),
            "enter" => return self.confirm(cx),
            _ => return,
        };
        cx.stop_propagation();
        let next = Hsv {
            h: self.hsv.h,
            s: (self.hsv.s + ds).clamp(0., 100.),
            v: (self.hsv.v + dv).clamp(0., 100.),
        };
        self.typed = false;
        self.set_draft(next, true, window, cx);
    }

    fn hue_keys(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "enter" {
            return self.confirm(cx);
        }
        let hue = self.hsv.h.round();
        let Some(delta) = key_delta(&event.keystroke.key, hue, 0., 359., 1.) else {
            return;
        };
        cx.stop_propagation();
        let next = Hsv {
            h: (hue + delta).clamp(0., 359.),
            ..self.hsv
        };
        self.typed = false;
        self.set_draft(next, true, window, cx);
    }

    fn confirm(&mut self, cx: &mut Context<Self>) {
        cx.stop_propagation();
        if let Some(hex) = self.hex(cx) {
            cx.emit(ColorPickerEvent::Confirm(hex));
        }
    }

    /// Records where `surface` was laid out, and holds a drag that began on
    /// it until the release, wherever the pointer goes.
    fn tracker(&self, surface: Surface, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        canvas(
            |bounds, _, _| bounds,
            move |_, bounds, window, cx| {
                this.update(cx, |picker, _| match surface {
                    Surface::Field => picker.field_bounds = Some(bounds),
                    Surface::Hue => picker.hue_bounds = Some(bounds),
                });
                let moved = this.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if !phase.bubble() {
                        return;
                    }
                    moved.update(cx, |picker, cx| {
                        if picker.dragging != Some(surface) {
                            return;
                        }
                        if event.pressed_button != Some(MouseButton::Left) {
                            picker.dragging = None;
                            return;
                        }
                        picker.drag_to(surface, event.position, window, cx);
                    });
                });
                let released = this.clone();
                window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                    if phase.bubble() {
                        released.update(cx, |picker, _| {
                            if picker.dragging == Some(surface) {
                                picker.dragging = None;
                            }
                        });
                    }
                });
            },
        )
        .absolute()
        .size_full()
    }

    fn press(
        &mut self,
        surface: Surface,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A press moves the thumb without drawing the keyboard's ring.
        window.prevent_default();
        let focus = match surface {
            Surface::Field => self.field_focus.clone(),
            Surface::Hue => self.hue_focus.clone(),
        };
        window.focus(&focus, cx);
        self.dragging = Some(surface);
        self.drag_to(surface, event.position, window, cx);
    }
}

/// The thumb's rings (`box-shadow: 0 0 0 2px #FFF, 0 0 0 3px rgb(0 0 0 /
/// 22%), 0 1px 4px rgb(0 0 0 / 30%)`).
fn thumb(fill: Hsla) -> gpui::Div {
    let shadow = |color: Hsla, spread: f32, y: f32, blur: f32| gpui::BoxShadow {
        color,
        offset: gpui::point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
    };
    div()
        .absolute()
        .size(px(THUMB))
        .rounded_full()
        .bg(fill)
        .shadow(vec![
            shadow(gpui::black().opacity(0.3), 0., 1., 4.),
            shadow(gpui::black().opacity(0.22), 3., 0., 0.),
            shadow(gpui::white(), 2., 0., 0.),
        ])
}

fn hue_color(hue: f32) -> Hsla {
    gpui::hsla(hue.rem_euclid(360.) / 360., 1., 0.5, 1.)
}

impl Render for ColorPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let hsv = self.hsv;
        let draft: Hsla = rgb(color::hsv_to_rgb(hsv)).into();
        let hue = hue_color(hsv.h);
        let ring = focus_ring(&palette, palette.raised);
        let edge = gpui::black().opacity(0.1);

        // Saturation across, brightness up: white to the hue, under black
        // rising from the foot.
        let field = div()
            .id("cp-field")
            .track_focus(&self.field_focus)
            .tab_index(0)
            .relative()
            .h(px(FIELD_HEIGHT))
            .rounded(RADIUS_TARGET)
            .bg(linear_gradient(
                90.,
                linear_color_stop(gpui::white(), 0.),
                linear_color_stop(hue, 1.),
            ))
            .cursor_crosshair()
            .focus_visible({
                let ring = ring.clone();
                move |style| style.shadow(ring)
            })
            .on_key_down(cx.listener(|this, event, window, cx| this.field_keys(event, window, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event, window, cx| {
                    this.press(Surface::Field, event, window, cx)
                }),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(RADIUS_TARGET)
                    .border_1()
                    .border_color(edge)
                    .bg(linear_gradient(
                        0.,
                        linear_color_stop(gpui::black(), 0.),
                        linear_color_stop(gpui::black().opacity(0.), 1.),
                    )),
            )
            .child(self.tracker(Surface::Field, cx))
            .child(
                thumb(draft)
                    .left(relative(hsv.s / 100.))
                    .top(relative(1. - hsv.v / 100.))
                    .ml(px(-THUMB / 2.))
                    .mt(px(-THUMB / 2.)),
            );

        // The strip: red through the hues back to red, in six runs.
        let stops = [
            0xFF0000, 0xFFFF00, 0x00FF00, 0x00FFFF, 0x0000FF, 0xFF00FF, 0xFF0000,
        ];
        let strip = div()
            .id("cp-hue")
            .track_focus(&self.hue_focus)
            .tab_index(0)
            .relative()
            .flex_1()
            .min_w_0()
            .h(px(STRIP_HEIGHT))
            .rounded_full()
            .cursor_pointer()
            .focus_visible({
                let ring = ring.clone();
                move |style| style.shadow(ring)
            })
            .on_key_down(cx.listener(|this, event, window, cx| this.hue_keys(event, window, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event, window, cx| this.press(Surface::Hue, event, window, cx)),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded_full()
                    .overflow_hidden()
                    .flex()
                    .children(stops.windows(2).map(|pair| {
                        div().flex_1().h_full().bg(linear_gradient(
                            90.,
                            linear_color_stop(rgb(pair[0]), 0.),
                            linear_color_stop(rgb(pair[1]), 1.),
                        ))
                    }))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded_full()
                            .border_1()
                            .border_color(edge),
                    ),
            )
            .child(self.tracker(Surface::Hue, cx))
            .child(
                thumb(hue)
                    .left(relative(hsv.h.round().clamp(0., 359.) / 359.))
                    .top(px((STRIP_HEIGHT - THUMB) / 2.))
                    .ml(px(-THUMB / 2.)),
            );
        let eyedropper = div()
            .id("cp-eyedropper")
            .flex_none()
            .size(px(EYEDROPPER))
            .flex()
            .items_center()
            .justify_center()
            .rounded(RADIUS_TARGET)
            .border_1()
            .border_color(palette.line)
            .bg(palette.input)
            .cursor_pointer()
            .hover(|style| style.bg(palette.hover))
            .tooltip(|_, cx| {
                crate::components::LatticeTooltip::view(t!("Pick color from screen"), None, cx)
            })
            .child(Icon::PIPETTE.element(px(14.), palette.text_secondary))
            .on_click(cx.listener(|_, _, _, cx| cx.emit(ColorPickerEvent::Sample)));

        // The hex row: the chip, `#`, the code, and the colour's name (or
        // what is wrong with the code).
        let invalid = self.invalid(cx);
        let shown = self.hex(cx).unwrap_or_else(|| color::hsv_hex(hsv));
        let focused = self.hex.focus_handle(cx).is_focused(window);
        let mono = cx.lattice().fonts.editor.clone();
        let hex_row = div()
            .h(px(28.))
            .min_w_0()
            .pl(SPACING_2)
            .pr(px(6.))
            .flex()
            .items_center()
            .gap(SPACING_2)
            .rounded(RADIUS_TARGET)
            .border_1()
            .border_color(if invalid {
                palette.danger
            } else if focused {
                palette.field_border_hover
            } else {
                palette.field_border
            })
            .bg(palette.input)
            .text_role(TextRole::Caption, cx)
            .child(
                div()
                    .flex_none()
                    .size(px(16.))
                    .rounded(RADIUS_CHIP)
                    .bg(color::hex_value(&shown).map_or(draft, |value| rgb(value).into()))
                    .border_1()
                    .border_color(gpui::black().opacity(0.12)),
            )
            .child(
                div()
                    .flex_none()
                    .font_family(mono.clone())
                    .text_color(palette.line_number)
                    .child("#"),
            )
            .child(
                div().flex_1().min_w_0().font_family(mono).child(
                    Input::new(&self.hex)
                        .appearance(false)
                        .px_0()
                        .py_0()
                        .h_full(),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(px(110.))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(if invalid {
                        palette.warning
                    } else {
                        palette.text_secondary
                    })
                    .child(if invalid {
                        t!("Enter 6 hex digits").to_string()
                    } else {
                        color::color_name(&shown)
                    }),
            );

        div()
            .id("color-picker")
            .flex()
            .flex_col()
            .gap(SPACING_4)
            .child(field)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(SPACING_4)
                    .when(self.eyedropper, |row| row.child(eyedropper))
                    .child(strip),
            )
            .child(hex_row)
    }
}

/// A labelled set of swatches (`SwatchGrid`): eight to a row, the chosen one
/// ringed and checked.
#[derive(IntoElement)]
pub struct SwatchGrid {
    id: ElementId,
    label: SharedString,
    colors: Vec<String>,
    chosen: Option<String>,
    on_pick: OnPick,
}

/// What a swatch's click does with its colour.
type OnPick = std::rc::Rc<dyn Fn(&str, &mut Window, &mut App)>;

impl SwatchGrid {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        colors: Vec<String>,
        chosen: Option<String>,
        on_pick: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            colors,
            chosen,
            on_pick: std::rc::Rc::new(on_pick),
        }
    }
}

/// Swatches to a row (`--cp-columns`).
const COLUMNS: usize = 8;
/// The picker's width (`.color-picker`'s `inline-size`), padding included.
pub const PICKER_WIDTH: f32 = 248.;
/// A swatch's side: eight square cells and their 4px gaps across the
/// picker's 8px-padded width.
const SWATCH: f32 = (PICKER_WIDTH - 2. * 8. - (COLUMNS as f32 - 1.) * 4.) / COLUMNS as f32;

impl RenderOnce for SwatchGrid {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let ink = rgb(0x242426);
        let rows: Vec<Vec<(usize, String)>> = self
            .colors
            .iter()
            .cloned()
            .enumerate()
            .collect::<Vec<_>>()
            .chunks(COLUMNS)
            .map(<[_]>::to_vec)
            .collect();
        let id = self.id.clone();
        div()
            .id(self.id)
            .flex()
            .flex_col()
            .gap(SPACING_2)
            .child(
                div()
                    .text_role(TextRole::Micro, cx)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(palette.text_secondary)
                    .child(self.label),
            )
            .children(rows.into_iter().map(|row| {
                div()
                    .flex()
                    .gap(SPACING_2)
                    .children((0..COLUMNS).map(|column| {
                        let Some((index, hex)) = row.get(column).cloned() else {
                            return div().size(px(SWATCH)).into_any_element();
                        };
                        let on = self
                            .chosen
                            .as_deref()
                            .is_some_and(|chosen| chosen.eq_ignore_ascii_case(&hex));
                        let fill: Hsla = color::hex_value(&hex)
                            .map_or(palette.raised, |value| rgb(value).into());
                        let pick = self.on_pick.clone();
                        let chosen = hex.clone();
                        div()
                            .id(ElementId::NamedChild(
                                std::sync::Arc::new(id.clone()),
                                format!("{index}").into(),
                            ))
                            .flex_none()
                            .size(px(SWATCH))
                            .rounded(RADIUS_CHIP)
                            .bg(fill)
                            .border_1()
                            .border_color(Hsla::from(ink).opacity(0.1))
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .when(on, |this| {
                                this.shadow(vec![
                                    gpui::BoxShadow {
                                        color: palette.text,
                                        offset: gpui::point(px(0.), px(0.)),
                                        blur_radius: px(0.),
                                        spread_radius: px(3.5),
                                        inset: false,
                                    },
                                    gpui::BoxShadow {
                                        color: palette.raised,
                                        offset: gpui::point(px(0.), px(0.)),
                                        blur_radius: px(0.),
                                        spread_radius: px(2.),
                                        inset: false,
                                    },
                                ])
                                .child(Icon::CHECK.element(px(12.), ink.into()))
                            })
                            .tooltip({
                                let hex = hex.clone();
                                move |_, cx| {
                                    crate::components::LatticeTooltip::view(hex.clone(), None, cx)
                                }
                            })
                            .on_click(move |_, window, cx| pick(&chosen, window, cx))
                            .into_any_element()
                    }))
            }))
    }
}
