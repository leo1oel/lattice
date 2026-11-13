//! The interface size (Settings › Appearance › Interface size), as the Tauri
//! app has it (`src/settings/interface-scale.ts`, `use-interface-zoom.ts`,
//! `interface-zoom-hud.tsx`).
//!
//! The size is one of five steps, 90% to 135%, kept in the settings and
//! applied to every window as a page zoom (`Window::set_interface_zoom`,
//! gpui-fast's `fast::interface_zoom`): the whole interface, editor and PDF
//! chrome included, grows and reflows into the window rather than being
//! magnified past it. ⌘+ (and ⌘=), ⌘− and ⌘0 step through the sizes from
//! anywhere, as do View ▸ Bigger, Smaller and Actual Size and the palette.
//! Each of those raises the size pill under the titlebar for a moment, with
//! − and + and Reset under the pointer; Settings changes the size without it.
//!
//! On macOS the traffic lights stay where AppKit puts them across, but follow
//! the taller or shorter titlebar down or up, and the titlebar leaves room
//! for them in its zoomed pixels (`traffic_lights.rs`'s alignment).

use std::time::{Duration, Instant};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Task, Window, div, point, prelude::FluentBuilder as _, px, relative,
};
use lattice_i18n::t;
use lattice_settings::{INTERFACE_SCALE_STEPS, nearest_interface_step, zoomed_interface_scale};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, Motion, TextRole, TextRoleStyle as _,
    components::LatticeTooltip, motion::Tween,
};

/// How long the pill stays after the last change, unless the pointer is on
/// it (`HUD_SHOWN_MS`).
const HUD_SHOWN: Duration = Duration::from_millis(1_600);
/// Where AppKit centres the traffic lights at 100%, from the window's top,
/// and their height: the titlebar's 40pt centre.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_CENTER: f32 = 20.;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_HEIGHT: f32 = 14.;
/// Where the traffic lights start from the window's leading edge, in points.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f32 = 14.;
/// The traffic-light cluster's trailing edge at 100%, in points, which the
/// titlebar measures its leading room from (`--titlebar-traffic-space-width`).
#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHT_CLUSTER: f32 = 72.;

/// A step through the sizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    In,
    Out,
    Reset,
}

/// The size the settings hold now.
pub fn scale(cx: &App) -> f32 {
    crate::settings::get(cx).appearance.interface_scale
}

/// Step the interface size; the settings apply it to every window.
pub fn zoom(change: Change, cx: &mut App) {
    let next = match change {
        Change::Reset => 1.,
        Change::In => zoomed_interface_scale(scale(cx), 1),
        Change::Out => zoomed_interface_scale(scale(cx), -1),
    };
    crate::settings::update_appearance(cx, |appearance| appearance.interface_scale = next);
}

/// The size commands where no workspace window takes them (the PDF's own
/// window, or no window in front): the size changes without a pill.
pub fn init(cx: &mut App) {
    use crate::shell::commands::{LargerInterface, ResetInterfaceSize, SmallerInterface};
    cx.on_action(|_: &LargerInterface, cx| zoom_and_reveal(Change::In, cx));
    cx.on_action(|_: &SmallerInterface, cx| zoom_and_reveal(Change::Out, cx));
    cx.on_action(|_: &ResetInterfaceSize, cx| zoom_and_reveal(Change::Reset, cx));
}

/// A change from a key or the menu that no element took (the keyboard is
/// nowhere in particular): the size changes, and the window in front, or
/// every workspace window when none is, raises its pill.
fn zoom_and_reveal(change: Change, cx: &mut App) {
    zoom(change, cx);
    let active = cx.active_window().map(|window| window.window_id());
    cx.defer(move |cx| {
        crate::shell::windows::for_shells(
            cx,
            |id| active.is_none_or(|active| active == id),
            |shell, _, cx| shell.reveal_zoom_hud(cx),
        );
    });
}

/// Lay `window` out at the settings' size.
pub fn apply(window: &mut Window, cx: &mut App) {
    window.set_interface_zoom(scale(cx), cx);
}

/// Keep a workspace window's traffic lights centred on its titlebar, which
/// is taller or shorter with the size; across, they stay where AppKit puts
/// them.
pub fn align_traffic_lights(window: &mut Window, cx: &App) {
    #[cfg(target_os = "macos")]
    window.set_traffic_light_position(point(
        px(TRAFFIC_LIGHT_X),
        px(TRAFFIC_LIGHT_CENTER * scale(cx) - TRAFFIC_LIGHT_HEIGHT / 2.),
    ));
    #[cfg(not(target_os = "macos"))]
    let _ = (window, cx);
}

/// Apply the size to every window of the app.
pub fn apply_all(cx: &mut App) {
    // Deferred: a key or a menu item changes the size while its own window
    // is being updated, which a window update from here could not reach.
    cx.defer(apply_all_now);
}

fn apply_all_now(cx: &mut App) {
    let windows: Vec<AnyWindowHandle> = cx.windows();
    for handle in windows {
        handle.update(cx, |_, window, cx| apply(window, cx)).ok();
    }
    crate::shell::windows::for_shells(
        cx,
        |_| true,
        |_, window, cx| align_traffic_lights(window, cx),
    );
}

/// The titlebar's leading room for the traffic lights, in the window's
/// zoomed pixels: the cluster, which does not zoom, and the app's own gap
/// after it, which does.
/// Elsewhere the room is the app's alone.
pub fn traffic_light_room(room_at_100: f32, cx: &App) -> f32 {
    #[cfg(target_os = "macos")]
    {
        room_at_100 - TRAFFIC_LIGHT_CLUSTER + TRAFFIC_LIGHT_CLUSTER / scale(cx)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
        room_at_100
    }
}

/// The size pill (`InterfaceZoomHud`): the new size for a moment after a
/// change from a key, the menu or the palette.
pub struct ZoomHud {
    /// Bumped by each change that raises the pill.
    reveal: u64,
    /// The change whose moment has passed.
    settled: u64,
    hovered: bool,
    /// 0 hidden, 1 shown, eased on the moderate tier both ways.
    shown: Tween<f32>,
    _timer: Option<Task<()>>,
}

impl ZoomHud {
    pub fn new(_: &mut Context<Self>) -> Self {
        Self {
            reveal: 0,
            settled: 0,
            hovered: false,
            shown: Tween::settled(0., Instant::now()),
            _timer: None,
        }
    }

    /// Whether the pill is up (or rising), for a scenario.
    pub fn is_shown(&self) -> bool {
        self.shown.target() > 0.5
    }

    /// A change from a key, the menu or the palette: show the pill.
    pub fn reveal(&mut self, cx: &mut Context<Self>) {
        self.reveal += 1;
        self.update(cx);
    }

    fn update(&mut self, cx: &mut Context<Self>) {
        let shown = self.reveal > 0 && (self.hovered || self.settled != self.reveal);
        self.shown.retarget(
            if shown { 1. } else { 0. },
            Motion::Moderate,
            Instant::now(),
        );
        // The moment runs from the last change, and not while the pointer
        // holds the pill.
        self._timer = (shown && !self.hovered).then(|| {
            let reveal = self.reveal;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(HUD_SHOWN).await;
                this.update(cx, |this, cx| {
                    this.settled = reveal;
                    this.update(cx);
                })
                .ok();
            })
        });
        cx.notify();
    }

    fn set_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if self.hovered != hovered {
            self.hovered = hovered;
            self.update(cx);
        }
    }
}

impl Render for ZoomHud {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let progress = self.shown.value(now);
        if self.shown.is_running(now) {
            window.request_animation_frame();
        }
        if progress <= 0. {
            return div().into_any_element();
        }
        let palette = cx.palette().clone();
        let interactive = self.shown.target() > 0.5;
        let step = nearest_interface_step(scale(cx));
        let smallest = step <= INTERFACE_SCALE_STEPS[0] + 1e-3;
        let largest = step >= INTERFACE_SCALE_STEPS[INTERFACE_SCALE_STEPS.len() - 1] - 1e-3;
        let percent: SharedString = format!("{}%", (step * 100.).round()).into();
        let keys: SharedString = format!("{}0", crate::shell::commands::MOD_LABEL).into();

        // A 24px pill button: secondary ink, the hover wash and primary ink
        // under the pointer, 40% when it cannot act.
        let button = |id: &'static str, disabled: bool| {
            div()
                .id(id)
                .h(px(24.))
                .min_w(px(24.))
                .px(px(6.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .text_color(palette.text_secondary)
                .when(disabled, |this| this.opacity(0.4))
                .when(!disabled && interactive, |this| {
                    this.cursor_pointer()
                        .hover(|style| style.bg(palette.hover).text_color(palette.text))
                })
        };
        let change = |change: Change| {
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| zoom(change, cx)
        };
        let icon_color = palette.text_secondary;

        div()
            .absolute()
            .top(px(44.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                div()
                    .id("interface-zoom-hud")
                    .h(px(32.))
                    .px(px(4.))
                    .rounded_full()
                    .bg(palette.raised)
                    .shadow(Elevation::Popover.shadows(&palette))
                    .text_color(palette.text)
                    .text_role(TextRole::Caption, cx)
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .opacity(progress)
                    .mt(px(-4. * (1. - progress)))
                    .when(interactive, |this| {
                        this.occlude().on_hover(
                            cx.listener(|hud, hovered: &bool, _, cx| hud.set_hovered(*hovered, cx)),
                        )
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        button("interface-zoom-out", smallest)
                            .tooltip(|_, cx| {
                                LatticeTooltip::view(t!("Smaller interface"), None, cx)
                            })
                            .child(Icon::MINUS.element(px(13.), icon_color))
                            .when(!smallest && interactive, |this| {
                                this.on_click(change(Change::Out))
                            }),
                    )
                    .child(
                        div()
                            .min_w(px(40.))
                            .text_center()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(percent),
                    )
                    .child(
                        button("interface-zoom-in", largest)
                            .tooltip(|_, cx| LatticeTooltip::view(t!("Larger interface"), None, cx))
                            .child(Icon::PLUS.element(px(13.), icon_color))
                            .when(!largest && interactive, |this| {
                                this.on_click(change(Change::In))
                            }),
                    )
                    .child(div().w(px(1.)).h(px(14.)).mx(px(2.)).bg(palette.line))
                    .child(
                        button("interface-zoom-reset", (step - 1.).abs() < 1e-3)
                            .child(t!("Reset"))
                            .child(
                                div()
                                    // `--text-tertiary`, which is the secondary ink.
                                    .text_color(palette.text_secondary)
                                    .line_height(relative(1.))
                                    .child(keys),
                            )
                            .when((step - 1.).abs() >= 1e-3 && interactive, |this| {
                                this.on_click(change(Change::Reset))
                            }),
                    ),
            )
            .into_any_element()
    }
}

/// The pill for a window.
pub fn new_hud(cx: &mut App) -> Entity<ZoomHud> {
    cx.new(ZoomHud::new)
}
