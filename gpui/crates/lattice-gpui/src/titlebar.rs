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
//! Short of room the titlebar folds as the app's does (`useFolds`): first the
//! search field to its icon, then the workspaces into one menu, so no control
//! covers another. In focus mode it keeps only the window's controls, the
//! document's name and the way out.
//!
//! The titlebar is the chrome under a white veil, closed by a hairline. Tools
//! that are not in the GPUI app yet (Track changes, Annotations, Overleaf,
//! Git, History) are drawn so the window reads as Lattice, and say so in
//! their tooltips; nothing pretends to work.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, AnyView, Context, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, WindowControlArea,
    canvas, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    InteractiveElementExt as _,
    menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenuItem},
};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, Keycap, LatticeTooltip, SearchField, Surface, ToolbarButton},
    dock::STRIP_HEIGHT,
    elevation::bottom_hairline,
    icons::{ICON, ICON_SMALL},
    parity,
};

mod workspace_switch;

use workspace_switch::workspace_switcher;

use crate::shell::{
    Shell,
    commands::{
        CloseProject, CommandPalette, OpenFolder, OpenInNewWindow, ResetLayout, ToggleAgentPanel,
        ToggleFocusMode, ToggleMaximize, TogglePapersPanel, TogglePdfPanel, ToggleProjectPanel,
        keys_label,
    },
    layout::{Preset, View},
    project_display_name,
    workspaces::Workspaces,
};

/// Room for the traffic lights, as the app leaves it.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: f32 = 95.;
#[cfg(not(target_os = "macos"))]
const TRAFFIC_LIGHTS: f32 = 6.;
/// Between the titlebar's groups (`--space-6`), and its side padding.
const GROUP_GAP: f32 = 12.;
/// The search field's width, and the least it gives up to before folding.
const SEARCH_WIDTH: f32 = 320.;
const SEARCH_MIN: f32 = 200.;

const NOT_YET: &str = "not in the GPUI preview yet";

/// Whether a press on the titlebar's empty space should move the window on
/// the next mouse move (a double click zooms it instead), and what the
/// titlebar measured of itself last frame.
#[derive(Default)]
pub struct TitlebarDrag {
    pressed: Cell<bool>,
    room: Rc<Cell<Room>>,
}

/// The titlebar's measured groups, in window coordinates: where the left
/// group ends when its workspaces are unfolded (and folded), and where the
/// tools begin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Room {
    left_unfolded: Option<f32>,
    left_folded: Option<f32>,
    tools_start: Option<f32>,
}

/// How far the titlebar folds: 0 none, 1 the search field to its icon, 2 the
/// workspaces into one menu too.
fn folds(room: Room, width: f32) -> u8 {
    let tools = room.tools_start.unwrap_or(width);
    let fits = |left: Option<f32>, search: f32| {
        left.is_none_or(|left| left + GROUP_GAP + search + GROUP_GAP <= tools)
    };
    if fits(room.left_unfolded, SEARCH_MIN) {
        0
    } else if fits(room.left_unfolded, 28.) {
        1
    } else {
        2
    }
}

/// Where the unfolded search field stands: centred on the window, moved only
/// as far as the room between its neighbours lets it, and narrowed to that
/// room down to its minimum.
fn search_place(room: Room, folds: u8, window_width: f32) -> (f32, f32) {
    let left = if folds >= 2 {
        room.left_folded
    } else {
        room.left_unfolded
    }
    .unwrap_or(0.);
    let tools = room.tools_start.unwrap_or(window_width);
    let from = left + GROUP_GAP;
    let to = tools - GROUP_GAP;
    let width = SEARCH_WIDTH.min((to - from).max(SEARCH_MIN));
    let wanted = (window_width - width) / 2.;
    let x = wanted.min(to - width).max(from);
    (x, width)
}

/// An invisible layer that reports its parent's left or right edge.
fn edge_probe(
    room: Rc<Cell<Room>>,
    write: fn(&mut Room, f32, f32),
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
    let bar = div()
        .id("titlebar")
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h(STRIP_HEIGHT)
        .pl(px(if fullscreen { 6. } else { TRAFFIC_LIGHTS }))
        .bg(palette.titlebar)
        .shadow(vec![bottom_hairline(palette.line)])
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

    if shell.layout.focus.is_some() {
        return bar.child(focus_bar(shell, window, cx)).into_any_element();
    }

    let room_cell = shell.titlebar_drag().room.clone();
    let room = room_cell.get();
    let width = f32::from(window.viewport_size().width);
    let folds = folds(room, width);

    let left = div()
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h_full()
        .child(project_group(shell, cx))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(GROUP_GAP))
                .h_full()
                .pl(px(6.))
                .child(controls(panels_menu(shell, cx)))
                .child(controls(workspace_switcher(shell, folds >= 2, window, cx))),
        )
        .child(edge_probe(
            room_cell.clone(),
            if folds >= 2 {
                |room, _, right| room.left_folded = Some(right)
            } else {
                |room, _, right| room.left_unfolded = Some(right)
            },
            weak.clone(),
        ));

    let search_tooltip = "Search files, papers and commands";
    let search_keys = keys_label(&CommandPalette, window).unwrap_or_else(|| "⌘K".into());
    let open_palette = cx.listener(|shell, _, window, cx| shell.open_palette(window, cx));
    let (search_inline, search_folded): (Option<AnyElement>, Option<AnyElement>) = if folds >= 1 {
        let folded = IconButton::new("titlebar-search", Icon::SEARCH)
            .surface(Surface::Titlebar)
            .tooltip(search_tooltip)
            .on_click(open_palette)
            .into_any_element();
        (None, Some(folded))
    } else {
        let (x, search_width) = search_place(room, folds, width);
        let inline = div()
            .absolute()
            .top(px(6.))
            .left(px(x))
            .child(controls(
                SearchField::new("titlebar-search", "Search")
                    .filled()
                    .keycap(search_keys)
                    .parity("titlebar/search")
                    .width(px(search_width))
                    .on_click(open_palette),
            ))
            .into_any_element();
        (Some(inline), None)
    };

    let not_yet = |id: &'static str, icon: Icon, name: &str| {
        IconButton::new(id, icon)
            .surface(Surface::Titlebar)
            .tooltip(format!("{name} — {NOT_YET}"))
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
            "Track changes",
        ))
        .child(not_yet("annotations", Icon::ANNOTATIONS, "Annotations"))
        .child(not_yet(
            "overleaf",
            Icon::CLOUD,
            "Open a project from Overleaf",
        ))
        .child(not_yet("git", Icon::GIT, "Git status and commit"))
        .child(not_yet("history", Icon::HISTORY, "Project history"))
        .child(edge_probe(
            room_cell,
            |room, left, _| room.tools_start = Some(left),
            weak,
        ));

    bar.child(left)
        .child(div().flex_1())
        .children(search_inline)
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(2.))
                .pt(px(6.))
                .pr(px(6.))
                .children(search_folded.map(controls))
                .child(controls(tools)),
        )
        .into_any_element()
}

/// The project switcher, or one tab per project once the window holds two.
fn project_group(shell: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let switcher = ToolbarButton::new("project-switcher", shell.project_name(cx))
        .switcher()
        .max_w(px(260.))
        .parity("titlebar/project")
        .dropdown_menu(|menu, _, _| {
            menu.menu("Open Folder…", Box::new(OpenFolder))
                .menu("Open in New Window", Box::new(OpenInNewWindow))
        });
    if shell.projects.len() < 2 {
        return div()
            .pt(px(4.))
            .pr(px(6.))
            .child(controls(switcher))
            .into_any_element();
    }
    let palette = cx.palette().clone();
    let active = shell.root(cx);
    let tabs = shell.projects.iter().enumerate().map(|(ix, root)| {
        let current = Some(root) == active.as_ref();
        let name = project_display_name(root);
        let close_root = root.clone();
        let switch_root = root.clone();
        let move_root = root.clone();
        let menu_root = root.clone();
        let weak = cx.entity().downgrade();
        let close_weak = weak.clone();
        let menu_weak = weak.clone();
        let group: gpui::SharedString = format!("project-tab-{ix}").into();
        let body: AnyElement = if current {
            div().child(switcher_for(shell, cx)).into_any_element()
        } else {
            div()
                .id(("project-tab-name", ix))
                .h(px(28.))
                .max_w(px(180.))
                .flex()
                .items_center()
                .pl(px(8.))
                .pr(px(4.))
                .rounded(px(6.))
                .truncate()
                .text_role(TextRole::Subtitle, cx)
                .font_weight(lattice_ui::tokens::FONT_WEIGHT_REGULAR)
                .text_color(palette.text_secondary)
                .cursor_pointer()
                .hover(|style| style.text_color(palette.text))
                .on_click(move |_, window, cx| {
                    weak.update(cx, |shell, cx| {
                        shell.switch_project(switch_root.clone(), window, cx)
                    })
                    .ok();
                })
                .child(name.clone())
                .into_any_element()
        };
        div()
            .id(("project-tab", ix))
            .group(group.clone())
            .flex()
            .flex_none()
            .items_center()
            .h(px(28.))
            .rounded(px(6.))
            .when(!current, |tab| {
                tab.hover(|style| style.bg(palette.chrome_hover))
            })
            .child(body)
            .child(
                div()
                    .id(("project-tab-close", ix))
                    .size(px(20.))
                    .mr(px(4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .when(!current, |close| {
                        close.invisible().group_hover(group, |s| s.visible())
                    })
                    .hover(|style| style.bg(palette.chrome_hover))
                    .tooltip(move |_, cx| -> AnyView {
                        LatticeTooltip::view(
                            format!("Close {}", project_display_name(&close_root)),
                            None,
                            cx,
                        )
                    })
                    .on_click(move |_, window, cx| {
                        let root = move_root.clone();
                        close_weak
                            .update(cx, |shell, cx| shell.close_project(&root, window, cx))
                            .ok();
                    })
                    .child(Icon::X.element(ICON_SMALL, palette.text_secondary)),
            )
            .context_menu(move |menu, _, _| {
                let root = menu_root.clone();
                let close_root = menu_root.clone();
                let weak = menu_weak.clone();
                let close = menu_weak.clone();
                menu.item(
                    PopupMenuItem::new("Open in New Window")
                        .icon(Icon::APP_WINDOW.kit())
                        .on_click(move |_, window, cx| {
                            weak.update(cx, |shell, cx| {
                                shell.move_project_to_window(root.clone(), window, cx)
                            })
                            .ok();
                        }),
                )
                .item(PopupMenuItem::new("Close").icon(Icon::X.kit()).on_click(
                    move |_, window, cx| {
                        close
                            .update(cx, |shell, cx| shell.close_project(&close_root, window, cx))
                            .ok();
                    },
                ))
            })
            .into_any_element()
    });
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .h_full()
        .pr(px(6.))
        .children(tabs.map(controls))
        .into_any_element()
}

fn switcher_for(shell: &Shell, cx: &gpui::App) -> impl IntoElement {
    ToolbarButton::new("project-switcher", shell.project_name(cx))
        .switcher()
        .max_w(px(220.))
        .parity("titlebar/project")
        .dropdown_menu(|menu, _, _| {
            menu.menu("Open Folder…", Box::new(OpenFolder))
                .menu("Open in New Window", Box::new(OpenInNewWindow))
                .separator()
                .menu("Close Project", Box::new(CloseProject))
        })
}

/// The Panels menu: each panel's toggle (checked while on screen), the
/// workspaces and the presets, focus mode, then maximize or restore and
/// reset.
fn panels_menu(shell: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
    let on_screen: Vec<bool> = [View::Project, View::Papers, View::Agent, View::Pdf]
        .iter()
        .map(|view| shell.view_on_screen(view, cx))
        .collect();
    let workspaces: Vec<(String, String)> = Workspaces::global(cx)
        .list()
        .iter()
        .map(|entry| (entry.id.clone(), entry.name.clone()))
        .collect();
    let current = shell.layout.workspace.clone();
    let preset = shell.layout.preset.as_ref().map(|active| active.preset);
    let maximized = shell.dock_area().read(cx).is_zoomed();
    let weak = cx.entity().downgrade();
    ToolbarButton::new("panels", "Panels")
        .icon(Icon::LAYOUT_PANEL_LEFT)
        .parity("titlebar/panels")
        .dropdown_menu(move |menu, _, _| {
            let mut menu = menu
                .min_w(px(224.))
                .label("Panels")
                .item(toggle_item(
                    "Project",
                    Icon::FOLDER_TREE,
                    on_screen[0],
                    Box::new(ToggleProjectPanel),
                ))
                .item(toggle_item(
                    "Papers",
                    Icon::LIBRARY,
                    on_screen[1],
                    Box::new(TogglePapersPanel),
                ))
                .item(toggle_item(
                    "Agent",
                    Icon::BOT,
                    on_screen[2],
                    Box::new(ToggleAgentPanel),
                ))
                .item(toggle_item(
                    "PDF",
                    Icon::FILE_TEXT,
                    on_screen[3],
                    Box::new(TogglePdfPanel),
                ))
                .separator()
                .label("Layout");
            for (ix, (id, name)) in workspaces.iter().enumerate() {
                let chosen = preset.is_none() && current.as_deref() == Some(id.as_str());
                let weak = weak.clone();
                let id = id.clone();
                let mut item = PopupMenuItem::new(name.clone()).checked(chosen).on_click(
                    move |_, window, cx| {
                        weak.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                            .ok();
                    },
                );
                if let Some(action) = crate::shell::commands::switch_workspace_action(ix) {
                    item = item.action(action);
                }
                menu = menu.item(item);
            }
            for preset_kind in Preset::ALL {
                let weak = weak.clone();
                menu = menu.item(
                    PopupMenuItem::new(preset_kind.label())
                        .icon(match preset_kind {
                            Preset::Writing => Icon::PEN_LINE.kit(),
                            Preset::Reading => Icon::BOOK_OPEN_TEXT.kit(),
                        })
                        .checked(preset == Some(preset_kind))
                        .on_click(move |_, window, cx| {
                            weak.update(cx, |shell, cx| shell.set_preset(preset_kind, window, cx))
                                .ok();
                        }),
                );
            }
            menu.menu_with_icon("Focus mode", Icon::FOCUS.kit(), Box::new(ToggleFocusMode))
                .separator()
                .menu_with_icon(
                    if maximized {
                        "Restore the layout"
                    } else {
                        "Maximize focused panel"
                    },
                    if maximized {
                        Icon::MINIMIZE
                    } else {
                        Icon::MAXIMIZE
                    }
                    .kit(),
                    Box::new(ToggleMaximize),
                )
                .menu_with_icon(
                    "Reset layout",
                    Icon::ROTATE_CCW.kit(),
                    Box::new(ResetLayout),
                )
        })
}

fn toggle_item(
    label: &str,
    icon: Icon,
    checked: bool,
    action: Box<dyn gpui::Action>,
) -> PopupMenuItem {
    PopupMenuItem::new(label.to_string())
        .icon(icon.kit())
        .checked(checked)
        .action(action)
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
            div()
                .id("leave-focus-mode")
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(28.))
                .px(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .hover(|style| style.bg(palette.chrome_hover))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .on_click(
                    cx.listener(|shell, _, window, cx| shell.set_focus_mode(false, window, cx)),
                )
                .child(Icon::MINIMIZE.element(ICON, palette.text_secondary))
                .child("Leave focus mode")
                .children(keys.map(Keycap::new)),
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn room(left: f32, tools: f32) -> Room {
        Room {
            left_unfolded: Some(left),
            left_folded: Some(left - 60.),
            tools_start: Some(tools),
        }
    }

    #[test]
    fn a_wide_window_folds_nothing_and_centres_the_search() {
        let room = room(513., 1288.);
        assert_eq!(folds(room, 1440.), 0);
        assert_eq!(search_place(room, 0, 1440.), (560., 320.));
    }

    #[test]
    fn the_search_never_overlaps_the_workspace_switcher() {
        // The 1015px CI window: the left group ends at 513.
        let room = room(513., 863.);
        let fold = folds(room, 1015.);
        assert_eq!(fold, 0);
        let (x, width) = search_place(room, fold, 1015.);
        assert!(x >= 513. + GROUP_GAP, "{x} starts inside the switcher");
        assert!(x + width <= 863. - GROUP_GAP);
    }

    #[test]
    fn short_of_room_the_search_folds_then_the_workspaces() {
        assert_eq!(folds(room(513., 700.), 900.), 1);
        assert_eq!(folds(room(513., 540.), 760.), 2);
    }

    #[test]
    fn before_anything_is_measured_nothing_folds() {
        assert_eq!(folds(Room::default(), 1440.), 0);
    }
}
