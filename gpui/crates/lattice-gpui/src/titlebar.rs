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
//! Git, History, Open in browser) are drawn so the window reads as Lattice, and say so in
//! their tooltips; nothing pretends to work.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, AnyView, Context, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, WeakEntity, Window,
    WindowControlArea, canvas, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::InteractiveElementExt as _;
use lattice_i18n::{space_mixed_script, t};
use lattice_settings::TitlebarTool;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, IconButton, Keycap, LatticeTooltip, MenuAction, MenuPopover, SearchField,
        Surface, ToolbarButton, context_menu_trigger,
    },
    dock::STRIP_HEIGHT,
    elevation::bottom_hairline,
    icons::{ICON, ICON_SMALL},
    interaction::hover_wash,
    parity,
    typography::shaped_width,
};

mod hidden_chips;
mod project_menu;
mod workspace_switch;

use project_menu::project_menu;
#[cfg(test)]
use workspace_switch::{SwitchTab, tab_width};
use workspace_switch::{unfolded_switch_width, workspace_switcher};

use crate::shell::{
    Shell,
    commands::{
        CloseProject, CommandPalette, ResetLayout, ToggleAgentPanel, ToggleFocusMode,
        ToggleMaximize, TogglePapersPanel, TogglePdfPanel, ToggleProjectPanel, keys_label,
    },
    trellis_layout::Preset,
    workspaces::{Workspaces, shown_name},
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

/// The project switcher's chrome around its name (`ToolbarButton::switcher`:
/// 8px in at each side, the 12px chevron 8px after the name), and the
/// widest it grows, alone or as the current project's tab.
const SWITCHER_CHROME: f32 = 8. + 8. + 12. + 8.;
const SWITCHER_MAX: f32 = 260.;
const TAB_SWITCHER_MAX: f32 = 220.;
/// Another project's tab: its name 8px in and 4px before the close button,
/// cut at 180px, then the 20px close button 4px from the tab's end; tabs
/// 2px apart; the group 6px before the Panels menu's own 6px.
const PROJECT_TAB_PAD: f32 = 8. + 4.;
const PROJECT_TAB_MAX: f32 = 180.;
const PROJECT_CLOSE: f32 = 20. + 4.;
const PROJECT_TAB_GAP: f32 = 2.;
const PROJECT_GROUP_END: f32 = 6.;
const PANELS_START: f32 = 6.;
/// The Panels menu's chrome around its label (`ToolbarButton` with an
/// icon: 8px in at each side, the 14px icon 6px before the label).
const PANELS_CHROME: f32 = 8. + 14. + 6. + 8.;

/// The project group's width from its names' widths: the switcher alone
/// (`switcher` its name), or a tab per project once there are two (`tabs`,
/// each name and whether it is the current project).
fn project_group_width(switcher: f32, tabs: &[(f32, bool)]) -> f32 {
    if tabs.len() < 2 {
        return (switcher + SWITCHER_CHROME).min(SWITCHER_MAX) + PROJECT_GROUP_END;
    }
    let tabs_width: f32 = tabs
        .iter()
        .map(|&(name, current)| {
            let body = if current {
                (name + SWITCHER_CHROME).min(TAB_SWITCHER_MAX)
            } else {
                (name + PROJECT_TAB_PAD).min(PROJECT_TAB_MAX)
            };
            body + PROJECT_CLOSE
        })
        .sum();
    tabs_width + PROJECT_TAB_GAP * (tabs.len() - 1) as f32 + PROJECT_GROUP_END
}

/// How wide the left group draws with its workspaces unfolded, from its
/// labels' shaped widths, so the folds are right on the frame that changes
/// any of them.
fn unfolded_left_width(shell: &Shell, window: &Window, cx: &gpui::App) -> f32 {
    let subtitle = |text: &str, weight| {
        f32::from(shaped_width(
            text,
            TextRole::Subtitle,
            Some(weight),
            window,
            cx,
        ))
    };
    let switcher = subtitle(
        &shell.project_name(cx),
        lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD,
    );
    let active = shell.root(cx);
    let tabs: Vec<(f32, bool)> = shell
        .projects
        .iter()
        .map(|open| {
            if Some(&open.root) == active.as_ref() {
                (switcher, true)
            } else {
                (
                    subtitle(&open.name, lattice_ui::tokens::FONT_WEIGHT_REGULAR),
                    false,
                )
            }
        })
        .collect();
    let panels = f32::from(shaped_width(
        t!("Panels"),
        TextRole::Caption,
        None,
        window,
        cx,
    ));
    project_group_width(switcher, &tabs)
        + PANELS_START
        + PANELS_CHROME
        + panels
        + GROUP_GAP
        + unfolded_switch_width(shell, window, cx)
}

/// The room the folds are decided in: where the left group ends with its
/// workspaces unfolded, and where the tools begin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Room {
    left_unfolded: Option<f32>,
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
fn search_place(room: Room, window_width: f32) -> (f32, f32) {
    let left = room.left_unfolded.unwrap_or(0.);
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
    let measured = room_cell.get();
    let room = Room {
        left_unfolded: measured
            .left_start
            .map(|start| start + unfolded_left_width(shell, window, cx)),
        tools_start: measured.tools_start,
    };
    let width = f32::from(window.viewport_size().width);
    let folds = folds(room, width);

    let left = div()
        .relative()
        .flex()
        .flex_none()
        .items_start()
        .h_full()
        .child(project_group(shell, window, cx))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(GROUP_GAP))
                .h_full()
                .pl(px(PANELS_START))
                .child(controls(panels_menu(shell, cx)))
                .child(controls(workspace_switcher(shell, folds >= 2, window, cx))),
        )
        .child(edge_probe(
            room_cell.clone(),
            |room, left, _| room.left_start = Some(left),
            weak.clone(),
        ));

    let search_tooltip = t!("Search files, papers and commands");
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
        let (x, search_width) = search_place(room, width);
        let inline = div()
            .absolute()
            .top(px(6.))
            .left(px(x))
            .child(controls(
                SearchField::new("titlebar-search", t!("Search"))
                    .filled()
                    .keycap(search_keys)
                    .parity("titlebar/search")
                    .width(px(search_width))
                    .on_click(open_palette),
            ))
            .into_any_element();
        (Some(inline), None)
    };

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
        .children(tool(
            TitlebarTool::Comments,
            "annotations",
            Icon::ANNOTATIONS,
            t!("Annotations"),
        ))
        .children(tool(
            TitlebarTool::Overleaf,
            "overleaf",
            Icon::CLOUD,
            t!("Open a project from Overleaf"),
        ))
        .children(tool(
            TitlebarTool::Git,
            "git",
            Icon::GIT,
            t!("Git status and commit"),
        ))
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
                .children(hidden_chips::hidden_chips(shell, cx))
                .children(search_folded.map(controls))
                .child(controls(tools)),
        )
        .into_any_element()
}

/// The project switcher, or one tab per project once the window holds two.
fn project_group(shell: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let switcher = MenuPopover::new(
        "project-switcher-menu",
        ToolbarButton::new("project-switcher", shell.project_name(cx))
            .switcher()
            .max_w(px(SWITCHER_MAX))
            .parity("titlebar/project"),
        {
            let shell = cx.entity().downgrade();
            move |menu, window, cx| project_menu(shell.clone(), menu, window, cx)
        },
    );
    if shell.projects.len() < 2 {
        return div()
            .pt(px(4.))
            .pr(px(PROJECT_GROUP_END))
            .child(controls(switcher))
            .into_any_element();
    }
    let palette = cx.palette().clone();
    let active = shell.root(cx);
    // A project tab's right-click menu: Open in New Window, Close.
    let tab_menu = ContextMenu::<std::path::PathBuf>::keyed("project-tab-menu", window, cx);
    let menu_weak = cx.entity().downgrade();
    let menu_layer = ContextMenu::layer(&tab_menu, window, cx, move |menu, root, _, _| {
        let (weak, close, root, close_root) = (
            menu_weak.clone(),
            menu_weak.clone(),
            root.clone(),
            root.clone(),
        );
        menu.item(
            MenuAction::new(t!("Open in New Window"), move |window, cx| {
                weak.update(cx, |shell, cx| {
                    shell.move_project_to_window(root.clone(), window, cx)
                })
                .ok();
            })
            .icon(Icon::APP_WINDOW),
        )
        .item(
            MenuAction::new(t!("Close"), move |window, cx| {
                close
                    .update(cx, |shell, cx| shell.close_project(&close_root, window, cx))
                    .ok();
            })
            .icon(Icon::X),
        )
    });
    let tabs = shell.projects.iter().enumerate().map(|(ix, open)| {
        let root = &open.root;
        let current = Some(root) == active.as_ref();
        let name = open.name.clone();
        let close_name = name.clone();
        let switch_root = root.clone();
        let move_root = root.clone();
        let menu_root = root.clone();
        let weak = cx.entity().downgrade();
        let close_weak = weak.clone();
        let group: gpui::SharedString = format!("project-tab-{ix}").into();
        let body: AnyElement = if current {
            div()
                .child(switcher_for(shell, weak.clone(), cx))
                .into_any_element()
        } else {
            div()
                .id(("project-tab-name", ix))
                .h(px(28.))
                .max_w(px(PROJECT_TAB_MAX))
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
        let tab = div()
            .id(("project-tab", ix))
            .group(group.clone())
            .flex()
            .flex_none()
            .items_center()
            .h(px(28.))
            .rounded(px(6.));
        let tab = if current {
            tab
        } else {
            hover_wash(
                tab,
                ("project-tab-wash", ix),
                gpui::transparent_black(),
                palette.chrome_hover,
                window,
                cx,
            )
        };
        let close = hover_wash(
            div().id(("project-tab-close", ix)),
            ("project-tab-close-wash", ix),
            gpui::transparent_black(),
            palette.chrome_hover,
            window,
            cx,
        );
        tab.child(body)
            .child(
                close
                    .size(px(20.))
                    .mr(px(4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .when(!current, |close| {
                        close.invisible().group_hover(group, |s| s.visible())
                    })
                    .tooltip(move |_, cx| -> AnyView {
                        LatticeTooltip::view(
                            space_mixed_script(&t!("Close {name}", name = close_name)),
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
            .map(|tab| context_menu_trigger(tab, &tab_menu, menu_root.clone()))
            .into_any_element()
    });
    div()
        .flex()
        .items_center()
        .gap(px(PROJECT_TAB_GAP))
        .h_full()
        .pr(px(PROJECT_GROUP_END))
        .children(tabs.map(controls))
        .children(menu_layer)
        .into_any_element()
}

fn switcher_for(shell: &Shell, weak: WeakEntity<Shell>, cx: &gpui::App) -> impl IntoElement {
    MenuPopover::new(
        "project-switcher-menu",
        ToolbarButton::new("project-switcher", shell.project_name(cx))
            .switcher()
            .max_w(px(TAB_SWITCHER_MAX))
            .parity("titlebar/project"),
        move |menu, window, cx| {
            project_menu(weak.clone(), menu, window, cx)
                .separator()
                .item(MenuAction::dispatch(
                    t!("Close this project"),
                    Box::new(CloseProject),
                ))
        },
    )
}

/// The Panels menu: each panel's toggle (checked while on screen), the
/// workspaces and the presets, focus mode, then maximize or restore and
/// reset.
fn panels_menu(shell: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
    let on_screen: Vec<bool> = ["project", "papers", "agent", "pdf"]
        .iter()
        .map(|kind| shell.view_on_screen(kind, cx))
        .collect();
    let workspaces: Vec<(String, String)> = Workspaces::global(cx)
        .list()
        .iter()
        .map(|entry| (entry.id.clone(), shown_name(&entry.name)))
        .collect();
    let current = shell.layout.workspace.clone();
    let preset = shell.layout.preset.as_ref().map(|active| active.preset);
    let maximized = shell.workspace().read(cx).engine().framed().is_some();
    let weak = cx.entity().downgrade();
    MenuPopover::new(
        "panels-menu",
        ToolbarButton::new("panels", t!("Panels"))
            .icon(Icon::LAYOUT_PANEL_LEFT)
            .parity("titlebar/panels"),
        move |menu, _, _| {
            let mut menu = menu
                .min_w(px(224.))
                .label(t!("Panels"))
                .item(toggle_item(
                    t!("Project"),
                    Icon::FOLDER_TREE,
                    on_screen[0],
                    Box::new(ToggleProjectPanel),
                ))
                .item(toggle_item(
                    t!("Papers"),
                    Icon::LIBRARY,
                    on_screen[1],
                    Box::new(TogglePapersPanel),
                ))
                .item(toggle_item(
                    t!("Agent"),
                    Icon::BOT,
                    on_screen[2],
                    Box::new(ToggleAgentPanel),
                ))
                .item(toggle_item(
                    t!("PDF"),
                    Icon::FILE_TEXT,
                    on_screen[3],
                    Box::new(TogglePdfPanel),
                ))
                .separator()
                .label(t!("Layout"));
            for (ix, (id, name)) in workspaces.iter().enumerate() {
                let chosen = preset.is_none() && current.as_deref() == Some(id.as_str());
                let weak = weak.clone();
                let id = id.clone();
                let mut item = MenuAction::new(name.clone(), move |window, cx| {
                    weak.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                        .ok();
                })
                .checked(chosen);
                if let Some(keys) = crate::shell::workspaces::shortcut_label(ix) {
                    item = item.shortcut(keys);
                }
                menu = menu.item(item);
            }
            for preset_kind in Preset::ALL {
                let weak = weak.clone();
                menu = menu.item(
                    MenuAction::new(preset_kind.label(), move |window, cx| {
                        weak.update(cx, |shell, cx| shell.set_preset(preset_kind, window, cx))
                            .ok();
                    })
                    .icon(match preset_kind {
                        Preset::Writing => Icon::PEN_LINE,
                        Preset::Reading => Icon::BOOK_OPEN_TEXT,
                        Preset::Bibliography => Icon::LIBRARY,
                    })
                    .checked(preset == Some(preset_kind)),
                );
            }
            menu.item(
                MenuAction::dispatch(t!("Focus mode"), Box::new(ToggleFocusMode)).icon(Icon::FOCUS),
            )
            .separator()
            .item(
                MenuAction::dispatch(
                    if maximized {
                        t!("Restore the layout")
                    } else {
                        t!("Maximize focused panel")
                    },
                    Box::new(ToggleMaximize),
                )
                .icon(if maximized {
                    Icon::MINIMIZE
                } else {
                    Icon::MAXIMIZE
                }),
            )
            .item(
                MenuAction::dispatch(t!("Reset layout"), Box::new(ResetLayout))
                    .icon(Icon::ROTATE_CCW),
            )
        },
    )
}

fn toggle_item(
    label: &str,
    icon: Icon,
    checked: bool,
    action: Box<dyn gpui::Action>,
) -> MenuAction {
    MenuAction::dispatch(label.to_string(), action)
        .icon(icon)
        .checked(checked)
}

/// Focus mode's bar: the document's tab title, and the way out with its key.
fn focus_bar(shell: &Shell, window: &mut Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let palette = cx.palette().clone();
    let title = shell
        .active_document(cx)
        .map(|key| shell.document_title(key, cx))
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
            tools_start: Some(tools),
        }
    }

    #[test]
    fn a_wide_window_folds_nothing_and_centres_the_search() {
        let room = room(513., 1288.);
        assert_eq!(folds(room, 1440.), 0);
        assert_eq!(search_place(room, 1440.), (560., 320.));
    }

    #[test]
    fn the_search_never_overlaps_the_workspace_switcher() {
        // The 1015px CI window: the left group ends at 513.
        let room = room(513., 863.);
        let fold = folds(room, 1015.);
        assert_eq!(fold, 0);
        let (x, width) = search_place(room, 1015.);
        assert!(x >= 513. + GROUP_GAP, "{x} starts inside the switcher");
        assert!(x + width <= 863. - GROUP_GAP);
    }

    #[test]
    fn short_of_room_the_search_folds_then_the_workspaces() {
        assert_eq!(folds(room(513., 700.), 900.), 1);
        assert_eq!(folds(room(513., 540.), 760.), 2);
    }

    #[test]
    fn the_fold_follows_the_workspaces_without_measuring_them_unfolded() {
        // In a narrow window five workspaces fold; with three deleted the
        // same switch start leaves room for them unfolded, and a longer name
        // or the dot on a workspace that differs takes that room back.
        let switch_start = 300.;
        let tools = 760.;
        let left = |tabs: &[(f32, bool)]| {
            switch_start
                + workspace_switch::track_width(
                    tabs.iter()
                        .map(|&(label, dot)| tab_width(SwitchTab::Named { label, dot })),
                )
        };
        let five = [(60., false); 5];
        assert_eq!(folds(room(left(&five), tools), 1015.), 2);
        let two = [(60., false), (60., false)];
        assert_eq!(folds(room(left(&two), tools), 1015.), 0);
        let renamed = [(60., false), (150., false)];
        assert_eq!(folds(room(left(&renamed), tools), 1015.), 1);
        // Just room for two clean tabs and the least search field: the dot
        // on one of them folds the search field.
        let differs = [(60., true), (60., false)];
        let snug = left(&two) + GROUP_GAP + SEARCH_MIN + GROUP_GAP;
        assert_eq!(folds(room(left(&two), snug), 1015.), 0);
        assert_eq!(folds(room(left(&differs), snug), 1015.), 1);
    }

    #[test]
    fn a_rename_keeps_the_width_its_field_draws() {
        // The rename field is at least 6×7+20px wide and its Input adds no
        // width of its own, so a long name typed in it scrolls instead of
        // widening the track.
        let renaming = [SwitchTab::Renaming];
        assert_eq!(
            workspace_switch::track_width(renaming.map(tab_width)),
            2. + 62. + 2. + 28.
        );
    }

    #[test]
    fn the_fold_follows_the_project_group_without_a_frame_late() {
        // ToolbarButton::switcher: 8px in, the name, 8px, a 12px chevron,
        // 8px; cut at 260px alone, then 6px before the Panels menu.
        assert_eq!(project_group_width(100., &[(100., true)]), 136. + 6.);
        assert_eq!(project_group_width(400., &[]), 260. + 6.);
        // A second project turns the switcher into two tabs, each with its
        // 20px close button 4px from its end, 2px apart.
        let two = project_group_width(100., &[(100., true), (80., false)]);
        assert_eq!(two, (136. + 24.) + 2. + (92. + 24.) + 6.);
        assert_eq!(
            project_group_width(100., &[(100., true), (400., false)]),
            (136. + 24.) + 2. + (180. + 24.) + 6.
        );
        // Snug at 1015px with one project, the second one folds the search
        // field on the frame it opens.
        let rest = 300.;
        let one = 95. + project_group_width(100., &[(100., true)]) + rest;
        let snug = one + GROUP_GAP + SEARCH_MIN + GROUP_GAP;
        assert_eq!(folds(room(one, snug), 1015.), 0);
        assert_eq!(folds(room(95. + two + rest, snug), 1015.), 1);
    }

    #[test]
    fn before_anything_is_measured_nothing_folds() {
        assert_eq!(folds(Room::default(), 1440.), 0);
    }
}
