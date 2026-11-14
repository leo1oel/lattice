//! The 40px titlebar, as the running app draws it (Paper's Main window,
//! `src/app/app-titlebar.tsx`, `src/trellis/trellis-titlebar.tsx`):
//!
//! - the project switcher after the traffic lights, or a tab per project
//!   once the window holds two;
//! - the Panels menu: each panel's toggle, the workspaces and the Writing
//!   and Reading presets, focus mode, maximize and reset;
//! - the workspace switcher: the named workspaces and "+", a dot on the
//!   project's workspace while its layout differs from it;
//! - the search field that opens the command palette, centred on the window
//!   as far as its neighbours let it;
//! - the project's tools at the right.
//!
//! Short of room the titlebar gives way as the app's does, so no control
//! covers another at any width down to the window's least: the search field
//! narrows to 200px, then folds to its icon at the bar's end, then the
//! workspaces fold into one menu (`useFolds`, which counts the hidden
//! panels' chips as content to fit); in a bar of 800px or less the project's
//! name is cut at 200px rather than 260px; with 264px or less left between
//! the project and the tools the workspaces go (the Panels menu switches
//! them too), with 159px or less the Panels menu keeps only its icon, and
//! last the chips shrink to an ellipsis each (`trellis.css`'s container
//! queries). The tools never shrink. In focus mode it keeps only the
//! window's controls, the document's name and the way out.
//!
//! The titlebar is the chrome under a white veil, closed by a hairline. Tools
//! that are not in the GPUI app yet (Track changes, Annotations, Git, Open in
//! browser) are drawn so the window reads as Lattice, and say so in their
//! tooltips; nothing pretends to work. Overleaf's is `shell::overleaf_flow`'s.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, WindowControlArea, canvas, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::InteractiveElementExt as _;
use lattice_i18n::t;
use lattice_settings::TitlebarTool;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, Keycap, SearchField, Surface},
    dock::STRIP_HEIGHT,
    elevation::bottom_hairline,
    icons::ICON,
    interaction::hover_wash,
    parity,
};

mod fit;
mod hidden_chips;
mod panels_menu;
mod project_group;
mod project_menu;
mod workspace_switch;

use fit::{GROUP_GAP, PANELS_START, Search, Switch, TOOLS_LEAD, plan, switcher_max, widths};
use panels_menu::panels_menu;
use project_group::project_group;
use workspace_switch::workspace_switcher;

use crate::shell::{
    Shell,
    commands::{CommandPalette, ToggleFocusMode, keys_label},
};

/// Room for the traffic lights, as the app leaves it.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: f32 = 95.;
#[cfg(not(target_os = "macos"))]
const TRAFFIC_LIGHTS: f32 = 6.;

/// Whether a press on the titlebar's empty space should move the window on
/// the next mouse move (a double click zooms it instead), and what the
/// titlebar measured of itself last frame.
#[derive(Default)]
pub struct TitlebarDrag {
    pressed: Cell<bool>,
    measured: Rc<Cell<Measured>>,
}

impl TitlebarDrag {
    /// Where the title bar's tools began, last frame, in window coordinates.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn tools_start(&self) -> Option<f32> {
        self.measured.get().tools_start
    }

    /// Where the title bar's left group (the project switcher first) began,
    /// last frame, in window coordinates.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn left_start(&self) -> Option<f32> {
        self.measured.get().left_start
    }
}

/// What the titlebar measured of itself last frame, in window coordinates:
/// where the left group begins, whatever it holds, and where the tools
/// begin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Measured {
    left_start: Option<f32>,
    tools_start: Option<f32>,
}

/// An invisible layer that reports its parent's left or right edge.
fn edge_probe(
    room: Rc<Cell<Measured>>,
    write: fn(&mut Measured, f32, f32),
    shell: gpui::WeakEntity<Shell>,
) -> impl IntoElement {
    canvas(
        move |bounds, _, cx| {
            let mut next = room.get();
            write(
                &mut next,
                f32::from(bounds.origin.x),
                f32::from(bounds.origin.x + bounds.size.width),
            );
            if next != room.get() {
                let room = room.clone();
                let shell = shell.clone();
                cx.defer(move |cx| {
                    room.set(next);
                    shell.update(cx, |_, cx| cx.notify()).ok();
                });
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

pub fn render(shell: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let palette = cx.palette().clone();
    let fullscreen = window.is_fullscreen();
    let weak = cx.entity().downgrade();
    // In focus mode the bar is the shell itself, with no rule under it
    // (`.titlebar.titlebar-focus`), so it melts into the gutters.
    let focus = shell.layout.focus.is_some();
    let bar = div()
        .id("titlebar")
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h(STRIP_HEIGHT)
        .pl(px(if fullscreen {
            6.
        } else {
            crate::interface_zoom::traffic_light_room(TRAFFIC_LIGHTS, cx)
        }))
        .bg(if focus {
            palette.shell
        } else {
            palette.titlebar
        })
        .when(!focus, |bar| {
            bar.shadow(vec![bottom_hairline(palette.line)])
        })
        .children(parity::probe("titlebar"))
        .window_control_area(WindowControlArea::Drag)
        .on_double_click(|_, window, _| window.titlebar_double_click())
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|shell, _, _, _| shell.titlebar_drag().pressed.set(true)),
        )
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|shell, _, _, _| shell.titlebar_drag().pressed.set(false)),
        )
        .on_mouse_move(cx.listener(|shell, _, window, _| {
            if shell.titlebar_drag().pressed.replace(false) {
                window.start_window_move();
            }
        }));

    if focus {
        return bar.child(focus_bar(shell, window, cx)).into_any_element();
    }

    let room_cell = shell.titlebar_drag().measured.clone();
    let width = f32::from(window.viewport_size().width);
    let plan = plan(room_cell.get(), widths(shell, window, cx), width);

    // The project group never shrinks (`.project-switcher`); the Panels
    // menu's group takes what is left before the tools, and clips rather
    // than run under them (`.trellis-titlebar`: `overflow: clip`).
    let project = div()
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h_full()
        .child(project_group(shell, switcher_max(width), window, cx))
        .child(edge_probe(
            room_cell.clone(),
            |room, left, _| room.left_start = Some(left),
            weak.clone(),
        ));

    let search_tooltip = t!("Search files, papers and commands");
    let search_keys = keys_label(&CommandPalette, window).unwrap_or_else(|| "⌘K".into());
    let open_palette = cx.listener(|shell, _, window, cx| shell.open_palette(window, cx));
    let (search_inline, search_folded): (Option<AnyElement>, Option<AnyElement>) = match plan.search
    {
        Search::Icon => {
            let folded = div()
                .relative()
                .flex_none()
                .child(
                    IconButton::new("titlebar-search", Icon::SEARCH)
                        .surface(Surface::Titlebar)
                        .tooltip(search_tooltip)
                        .on_click(open_palette),
                )
                .children(parity::probe("titlebar/search"))
                .into_any_element();
            (None, Some(folded))
        }
        Search::Field { x, width } => {
            let inline = div()
                .absolute()
                .top(px(6.))
                .left(px(x))
                .child(controls(
                    SearchField::new("titlebar-search", t!("Search"))
                        .filled()
                        .keycap(search_keys)
                        .parity("titlebar/search")
                        .width(px(width))
                        .on_click(open_palette),
                ))
                .into_any_element();
            (Some(inline), None)
        }
    };

    // Panels and the workspaces, then, at the group's end, the search field
    // folded to its icon and the hidden panels' chips after it.
    let panels = div()
        .flex()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .items_center()
        .gap(px(GROUP_GAP))
        .h_full()
        .pl(px(PANELS_START))
        .pr(px(TOOLS_LEAD / 2.))
        .child(controls(panels_menu(shell, plan.panels_label, cx)))
        .when(plan.switch != Switch::Hidden, |group| {
            group.child(controls(workspace_switcher(
                shell,
                plan.switch == Switch::Folded,
                window,
                cx,
            )))
        })
        .child(div().flex_1())
        .children(search_folded.map(controls))
        .children(hidden_chips::hidden_chips(shell, cx));

    let hidden = crate::settings::get(cx)
        .appearance
        .hidden_titlebar_tools
        .clone();
    let not_yet = |id: &'static str, icon: Icon, name: &str| {
        IconButton::new(id, icon)
            .surface(Surface::Titlebar)
            .tooltip(t!("{name} — not in the GPUI preview yet", name = name))
    };
    // Settings › Appearance › Title bar tools hides each of these.
    let tool = |tool: TitlebarTool, id: &'static str, icon: Icon, name: &str| {
        (!hidden.contains(&tool)).then(|| not_yet(id, icon, name))
    };
    let tools = div()
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(2.))
        .children(parity::probe("titlebar/tools"))
        .child(not_yet(
            "track-changes",
            Icon::FILE_PEN_LINE,
            t!("Track changes"),
        ))
        // A project linked to Overleaf keeps its notes in Overleaf's
        // comments, reached from the Overleaf control instead.
        .children(
            tool(
                TitlebarTool::Comments,
                "annotations",
                Icon::ANNOTATIONS,
                t!("Annotations"),
            )
            .filter(|_| shell.overleaf.read(cx).link().is_none()),
        )
        .children(shell.overleaf_tools(cx))
        .children((!hidden.contains(&TitlebarTool::Git)).then(|| shell.git_button(cx)))
        .children((!hidden.contains(&TitlebarTool::History)).then(|| shell.history_button(cx)))
        // Moves the workspace into a browser tab (`canvas-toolbar.tsx`,
        // `onMoveWorkspace`), the last of the app's tools.
        .children(tool(
            TitlebarTool::Browser,
            "browser",
            Icon::GLOBE,
            t!("Open in browser"),
        ))
        .child(edge_probe(
            room_cell,
            |room, left, _| room.tools_start = Some(left),
            weak,
        ));

    // What follows the project (`.titlebar-main`): the Panels menu's group
    // and the tools, which keep their width; a window too narrow for both
    // clips the tools at its edge rather than lay them over anything.
    let main = div()
        .flex()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .items_start()
        .h_full()
        .child(panels)
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .pt(px(6.))
                .pl(px(TOOLS_LEAD / 2.))
                .pr(px(6.))
                .child(controls(tools)),
        );

    bar.child(project)
        .child(main)
        .children(search_inline)
        .into_any_element()
}

/// Focus mode's bar: the document's name, and the way out with its key.
fn focus_bar(shell: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let palette = cx.palette().clone();
    let title = shell
        .active_document(cx)
        .map(|path| {
            std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(path)
        })
        .unwrap_or_else(|| shell.project_name(cx).to_string());
    let keys = keys_label(&ToggleFocusMode, window);
    div()
        .flex()
        .flex_1()
        .items_center()
        .justify_between()
        .h_full()
        .pr(px(6.))
        .child(
            div()
                .text_role(TextRole::BodyCompact, cx)
                .text_color(palette.text_secondary)
                .child(title),
        )
        .child(controls(
            hover_wash(
                div().id("leave-focus-mode"),
                "leave-focus-mode-wash",
                gpui::transparent_black(),
                palette.chrome_hover,
                window,
                cx,
            )
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .on_click(cx.listener(|shell, _, window, cx| shell.set_focus_mode(false, window, cx)))
            .child(Icon::MINIMIZE.element(ICON, palette.text_secondary))
            .child(t!("Leave focus mode"))
            .children(keys.map(Keycap::new)),
        ))
}

/// The titlebar's own press starts a window move on the next mouse move, and
/// its double click zooms; a press on a control stops there, so a click that
/// drifts a pixel stays a click and a double click on a button does not zoom
/// the window.
pub(super) fn controls(child: impl IntoElement) -> gpui::Div {
    div()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(child)
}
