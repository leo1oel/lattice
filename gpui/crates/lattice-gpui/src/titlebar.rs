//! The 40px titlebar, as the running app draws it (Paper's Main window):
//! the project switcher after the traffic lights, the Panels menu and the
//! workspace switcher, the search field centred on the window, and the
//! window's tool buttons at the right.
//!
//! The titlebar is the chrome under a white veil, closed by a hairline. Tools
//! that are not in the GPUI app yet (the palette behind Search, Annotations,
//! Overleaf, Git, History) are drawn so the window reads as Lattice, and say
//! so in their tooltips; nothing pretends to work.

use std::cell::Cell;

use gpui::{
    Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Styled as _,
    Window, WindowControlArea, div, px,
};
use gpui_kit::component::{
    InteractiveElementExt as _, dock::DockPlacement, menu::DropdownMenu as _,
};
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{IconButton, SearchField, Segmented, Surface, ToolbarButton},
    dock::STRIP_HEIGHT,
    elevation::bottom_hairline,
};

use crate::shell::{OpenFolder, Shell, ToggleBuildPanel, TogglePdfPanel, ToggleProjectPanel};

/// Room for the traffic lights, as the app leaves it.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: f32 = 95.;
#[cfg(not(target_os = "macos"))]
const TRAFFIC_LIGHTS: f32 = 6.;

/// Whether a press on the titlebar's empty space should move the window on
/// the next mouse move (a double click zooms it instead).
#[derive(Default)]
pub struct TitlebarDrag(Cell<bool>);

const NOT_YET: &str = "not in the GPUI preview yet";

pub fn render(shell: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let palette = cx.palette().clone();
    let project = shell.project_name();
    let docks = shell.dock_area().read(cx);
    let open = |placement| docks.is_dock_open(placement);
    let (project_open, pdf_open, build_open) = (
        open(DockPlacement::Left),
        open(DockPlacement::Right),
        shell.build_panel_shown(cx),
    );
    let fullscreen = window.is_fullscreen();

    let switcher = div().pt(px(4.)).pr(px(6.)).child(controls(
        ToolbarButton::new("project-switcher", project)
            .switcher()
            .max_w(px(260.))
            // Called on the shell, not dispatched: with nothing focused an
            // action would start at the root and never reach the shell.
            .on_click(
                cx.listener(|shell, _, window, cx| shell.open_folder(&OpenFolder, window, cx)),
            ),
    ));

    let panels = ToolbarButton::new("panels", "Panels")
        .icon(Icon::LAYOUT_PANEL_LEFT)
        .dropdown_menu(move |menu, _, _| {
            menu.menu_with_check("Project", project_open, Box::new(ToggleProjectPanel))
                .menu_with_check("PDF", pdf_open, Box::new(TogglePdfPanel))
                .menu_with_check("Build", build_open, Box::new(ToggleBuildPanel))
        });

    let workspace = Segmented::new("workspace").label("Workspace", true, |_, _, _| {});

    let search = SearchField::new("titlebar-search", "Search")
        .filled()
        .keycap("⌘K")
        .width(px(320.))
        .tooltip(format!("Search files, papers and commands — {NOT_YET}"));

    let not_yet = |id: &'static str, icon: Icon, name: &str| {
        IconButton::new(id, icon)
            .surface(Surface::Titlebar)
            .tooltip(format!("{name} — {NOT_YET}"))
    };

    div()
        .id("titlebar")
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h(STRIP_HEIGHT)
        .pl(px(if fullscreen { 6. } else { TRAFFIC_LIGHTS }))
        .bg(palette.titlebar)
        .shadow(vec![bottom_hairline(palette.line)])
        .window_control_area(WindowControlArea::Drag)
        .on_double_click(|_, window, _| window.titlebar_double_click())
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|shell, _, _, _| shell.titlebar_drag().0.set(true)),
        )
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|shell, _, _, _| shell.titlebar_drag().0.set(false)),
        )
        .on_mouse_move(cx.listener(|shell, _, window, _| {
            if shell.titlebar_drag().0.replace(false) {
                window.start_window_move();
            }
        }))
        .child(switcher)
        .child(
            div()
                .flex()
                .flex_1()
                .items_center()
                .gap(px(12.))
                .h_full()
                .pl(px(6.))
                .child(controls(panels))
                .child(controls(workspace)),
        )
        // Centred on the window, as the app centres it.
        .child(
            div()
                .absolute()
                .top(px(6.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(controls(search)),
        )
        .child(
            div().flex_none().pt(px(6.)).pr(px(6.)).child(controls(
                div()
                    .flex()
                    .gap(px(2.))
                    .child(not_yet("annotations", Icon::ANNOTATIONS, "Annotations"))
                    .child(not_yet(
                        "overleaf",
                        Icon::CLOUD,
                        "Open a project from Overleaf",
                    ))
                    .child(not_yet("git", Icon::GIT, "Git status and commit"))
                    .child(not_yet("history", Icon::HISTORY, "Project history")),
            )),
        )
}

/// The titlebar's own press starts a window move on the next mouse move, and
/// its double click zooms; a press on a control stops there, so a click that
/// drifts a pixel stays a click and a double click on a button does not zoom
/// the window.
fn controls(child: impl IntoElement) -> gpui::Div {
    div()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(child)
}
