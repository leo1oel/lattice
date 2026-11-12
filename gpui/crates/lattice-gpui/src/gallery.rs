//! `lattice-gpui --gallery`: every lattice-ui component, laid out like
//! Paper's Components boards, for a look review in either appearance
//! (`LATTICE_APPEARANCE=light|dark`).
//!
//! With `LATTICE_SHOT_OUT=PATH.png` it saves the window once it has drawn and
//! quits, as the `shot` scenario does for the main window. The sheet runs
//! over three pages, `LATTICE_GALLERY_PAGE=1|2|3`:
//!
//! 1. controls: buttons, fields, the textarea, selects (one open), checkbox,
//!    switch and slider, the small controls;
//! 2. overlays: a menu, a popover and a tooltip (each drawn open, beside a
//!    live trigger), toasts and dialogs;
//! 3. surfaces: rows, a sheet and a drawer over their scrim, the Settings
//!    card, a panel header and the empty, loading and error states.

mod controls;
mod overlays;
mod surfaces;

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, WindowBounds, WindowOptions, div, px, size,
};
use gpui_kit::{
    base::slider::SliderState,
    component::input::{InputState, TextareaState},
};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, Tracking, components::LatticeTooltip,
};

pub struct Gallery {
    page: u8,
    fields: [Entity<InputState>; 5],
    note: Entity<TextareaState>,
    rename: Entity<InputState>,
    sliders: [Entity<SliderState>; 3],
    /// The chosen option of each select, by its place on the page.
    choices: [Option<usize>; 4],
    tooltip: gpui::AnyView,
    loading_since: Instant,
}

pub fn open(cx: &mut App) -> anyhow::Result<()> {
    let bounds = Bounds::centered(None, size(px(1440.), px(1100.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        ..Default::default()
    };
    let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| Gallery::new(window, cx))
    })?;
    if let Ok(out) = std::env::var("LATTICE_SHOT_OUT") {
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1500))
                .await;
            let result = window.update(cx, |_, window, cx| capture(window, cx, &out));
            if let Err(error) | Ok(Err(error)) = result.map_err(anyhow::Error::from) {
                log::error!("gallery shot: {error:#}");
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
    Ok(())
}

#[cfg(feature = "offscreen-shots")]
fn capture(window: &mut Window, cx: &mut App, out: &str) -> anyhow::Result<()> {
    window.refresh();
    let _ = window.draw(cx);
    window.render_to_image()?.save(out)?;
    Ok(())
}

#[cfg(not(feature = "offscreen-shots"))]
fn capture(_: &mut Window, _: &mut App, _: &str) -> anyhow::Result<()> {
    anyhow::bail!("build with --features offscreen-shots to capture the gallery")
}

impl Gallery {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = |text: &str, placeholder: &str, window: &mut Window, cx: &mut Context<Self>| {
            let (text, placeholder) = (text.to_string(), placeholder.to_string());
            cx.new(move |cx| {
                let mut state = InputState::new(window, cx).placeholder(placeholder);
                state.set_value(text, window, cx);
                state
            })
        };
        let slider = |min: f32, max: f32, step: f32, value: f32, cx: &mut Context<Self>| {
            cx.new(|_| {
                SliderState::new()
                    .min(min)
                    .max(max)
                    .step(step)
                    .default_value(value)
            })
        };
        Self {
            page: match std::env::var("LATTICE_GALLERY_PAGE").as_deref() {
                Ok("2") => 2,
                Ok("3") => 3,
                _ => 1,
            },
            fields: [
                field("", "Paper title", window, cx),
                field("Attention Is All You Need", "", window, cx),
                field("vaswani2017", "", window, cx),
                field("", "Search or add papers", window, cx),
                field("main.tex", "", window, cx),
            ],
            note: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .placeholder("What the paper argues")
                    .default_value(
                        "Readers will learn how attention turns token representations into \
                         context.",
                    )
            }),
            rename: field("Writing", "", window, cx),
            sliders: [
                slider(0., 100., 1., 40., cx),
                slider(10., 20., 1., 14., cx),
                slider(0., 100., 1., 60., cx),
            ],
            choices: [Some(0), Some(0), Some(0), Some(1)],
            tooltip: LatticeTooltip::view("Toggle Project panel", Some("⌘⌥1".into()), cx),
            loading_since: Instant::now() - Duration::from_secs(1),
        }
    }
}

/// A board: its serif title, a note in caption, and the components on the
/// panel sheet, as Paper lays out a Components section.
fn board(title: &str, note: &str, children: Vec<AnyElement>, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_end()
                .gap(px(12.))
                .child(
                    div()
                        .text_role(TextRole::Title, cx)
                        .text_color(palette.text)
                        .child(SharedString::from(title.to_string())),
                )
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(SharedString::from(note.to_string())),
                ),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .gap(px(16.))
                .p(px(20.))
                .rounded(px(10.))
                .bg(palette.panel)
                .shadow(lattice_ui::elevation::panel_ring(palette))
                .children(children),
        )
        .into_any_element()
}

/// One specimen and the caption that names its state.
fn labelled(label: &str, child: impl IntoElement, cx: &App) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(cx.palette().text_secondary)
                .child(SharedString::from(label.to_string())),
        )
        .child(child)
        .into_any_element()
}

fn noop(_: &gpui::ClickEvent, _: &mut Window, _: &mut App) {}

impl Render for Gallery {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (title, boards) = match self.page {
            2 => ("Menus, toasts and dialogs", overlays::boards(self, cx)),
            3 => ("Surfaces", surfaces::boards(self, cx)),
            _ => ("Controls", controls::boards(self, cx)),
        };
        // The page head as Paper's Components artboards set it: the eyebrow
        // in micro capitals on the caps tracking, then the serif title.
        let head = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .text_role(TextRole::Micro, cx)
                    .tracking(Tracking::Caps)
                    .text_color(palette.text_secondary)
                    .child("LATTICE DESIGN SYSTEM · COMPONENTS"),
            )
            .child(
                div()
                    .text_role(TextRole::Display, cx)
                    .text_color(palette.text)
                    .child(title),
            );
        div()
            .id("gallery")
            .size_full()
            .overflow_y_scroll()
            .bg(palette.window)
            .p(px(32.))
            .flex()
            .flex_col()
            .gap(px(28.))
            .child(head)
            .children(boards)
    }
}
