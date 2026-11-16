//! The titlebar's project switcher, or one tab per project once the window
//! holds two (`project-tabs.tsx`, `project-tabs.css`), each with its close
//! button and its right-click menu. A tab has its own outline, open at the
//! bottom, where the active one meets the workspace below the bar, and a
//! folder before its name. Tabs (and a lone switcher, which can go to
//! another window) are dragged as `shell/project_tab_drag.rs` says, with
//! the dragged tab at 55% under the grabbing hand and a 2px line where it
//! would go.

use std::path::PathBuf;

use gpui::{
    AnyElement, AnyView, Context, CursorStyle, InteractiveElement as _, IntoElement,
    MouseDownEvent, ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::{space_mixed_script, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, LatticeTooltip, MenuAction, MenuPopover, ToolbarButton, context_menu_trigger,
    },
    icons::ICON_SMALL,
    interaction::hover_wash,
};

use super::{
    controls,
    fit::{PROJECT_GROUP_END, PROJECT_TAB_GAP, PROJECT_TAB_MAX},
    project_menu::{project_menu, switcher_for},
};
use crate::shell::{Shell, project_tab_drag};

/// A tab's height: the bar's 32px action size and 4px more, standing on the
/// bar's bottom edge.
const TAB_HEIGHT: f32 = 36.;
/// A tab's least width, and the active one's, which leaves the name room
/// beside the switcher's chevron.
const TAB_MIN: f32 = 2. * 32. + 16.;
const ACTIVE_TAB_MIN: f32 = 2. * 32. + 32.;
/// The dragged tab's opacity.
const DRAGGED_OPACITY: f32 = 0.55;

/// A press on `root`'s tab body, caught before the tab's own handlers: the
/// active tab's switcher would open on it.
fn on_press(
    root: PathBuf,
    active: bool,
    weak: gpui::WeakEntity<Shell>,
) -> impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static {
    move |event, _, cx| {
        let held = weak
            .update(cx, |shell, cx| {
                shell.press_project_tab(root.clone(), event, active, cx)
            })
            .unwrap_or(false);
        if held {
            cx.stop_propagation();
        }
    }
}

/// The project switcher, cut at `switcher_max`, or one tab per project once
/// the window holds two.
pub(super) fn project_group(
    shell: &Shell,
    switcher_max: f32,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let weak = cx.entity().downgrade();
    let palette = cx.palette().clone();
    let active = shell.root(cx);
    let (dragging, line, _) = shell.project_drag_view();
    let bounds = shell.project_strip_bounds();
    bounds.borrow_mut().tabs.clear();
    // While a tab is pressed, the window's pointer drives the drag.
    let pressed = shell.project_tab_pressed().then(|| {
        let weak = weak.clone();
        gpui::canvas(
            |_, _, _| (),
            move |_, _, window, _| project_tab_drag::listen_while_pressed(weak, window),
        )
        .absolute()
        .size_0()
    });
    // The 2px line where a dragged tab would go (`[data-project-drop]`).
    let drop_line = line.map(|slot| {
        let width = bounds
            .borrow()
            .strip
            .map(|strip| strip.size.width)
            .unwrap_or_default();
        let x = slot.x.max(px(0.)).min((width - px(2.)).max(px(0.)));
        div()
            .absolute()
            .top(px(6.))
            .bottom(px(6.))
            .left(x)
            .w(px(2.))
            .rounded_full()
            .bg(palette.focus)
    });
    let strip_bounds = bounds.clone();
    let strip = move |strip: gpui::Div| {
        lattice_ui::measure::measured(strip.relative(), move |rect, _| {
            strip_bounds.borrow_mut().strip = Some(rect);
        })
    };

    if shell.projects.len() < 2 {
        let switcher = MenuPopover::new(
            "project-switcher-menu",
            ToolbarButton::new("project-switcher", shell.project_name(cx))
                .switcher()
                .max_w(px(switcher_max))
                .parity("titlebar/project"),
            {
                let shell = weak.clone();
                move |menu, window, cx| project_menu(shell.clone(), menu, window, cx)
            },
        );
        // A lone project can still go to another window's strip.
        let lone = active.clone().map(|root| {
            let tab_bounds = bounds.clone();
            let measured_root = root.clone();
            lattice_ui::measure::measured(
                div()
                    .id("project-tab-single")
                    .flex()
                    .items_center()
                    .when(dragging.as_ref() == Some(&root), |tab| {
                        tab.opacity(DRAGGED_OPACITY).cursor(CursorStyle::ClosedHand)
                    })
                    .capture_any_mouse_down(on_press(root, true, weak.clone()))
                    .child(switcher),
                move |rect, _| {
                    tab_bounds
                        .borrow_mut()
                        .tabs
                        .push((measured_root.clone(), rect))
                },
            )
            .into_any_element()
        });
        return strip(
            div()
                .pt(px(4.))
                .pr(px(PROJECT_GROUP_END))
                .children(lone.map(controls))
                .children(pressed)
                .children(drop_line),
        );
    }
    // A project tab's right-click menu: Open in New Window, Close.
    let tab_menu = ContextMenu::<PathBuf>::keyed("project-tab-menu", window, cx);
    let menu_weak = weak.clone();
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
    let tabs: Vec<AnyElement> = shell
        .projects
        .iter()
        .enumerate()
        .map(|(ix, open)| {
            let root = &open.root;
            let current = Some(root) == active.as_ref();
            let name = open.name.clone();
            let close_name = name.clone();
            let switch_root = root.clone();
            let move_root = root.clone();
            let menu_root = root.clone();
            let tab_weak = weak.clone();
            let close_weak = weak.clone();
            let group: gpui::SharedString = format!("project-tab-{ix}").into();
            let body: AnyElement = if current {
                div()
                    .id(("project-tab-title", ix))
                    .capture_any_mouse_down(on_press(root.clone(), true, weak.clone()))
                    .child(switcher_for(shell, weak.clone(), cx))
                    .into_any_element()
            } else {
                div()
                    .id(("project-tab-name", ix))
                    .h(px(32.))
                    .max_w(px(PROJECT_TAB_MAX))
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .pl(px(8.))
                    .pr(px(4.))
                    .rounded(px(6.))
                    .text_role(TextRole::Subtitle, cx)
                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_REGULAR)
                    .text_color(palette.text_secondary)
                    .cursor_pointer()
                    .hover(|style| style.text_color(palette.text))
                    .capture_any_mouse_down(on_press(root.clone(), false, weak.clone()))
                    .on_click(move |_, window, cx| {
                        tab_weak
                            .update(cx, |shell, cx| {
                                // The release ending a drag switches nothing.
                                if !shell.project_tab_click_suppressed() {
                                    shell.switch_project(switch_root.clone(), window, cx)
                                }
                            })
                            .ok();
                    })
                    .child(
                        div()
                            .flex_none()
                            .child(Icon::FOLDER.element(px(12.), palette.text_secondary)),
                    )
                    .child(div().min_w_0().truncate().child(name.clone()))
                    .into_any_element()
            };
            let tab = div()
                .id(("project-tab", ix))
                .group(group.clone())
                .flex()
                .flex_none()
                .items_center()
                .h(px(TAB_HEIGHT))
                .min_w(px(if current { ACTIVE_TAB_MIN } else { TAB_MIN }))
                .border_1()
                .border_b_0()
                .border_color(if current {
                    palette.line_strong
                } else {
                    palette.line
                })
                .rounded_t(px(6.))
                .when(current, |tab| tab.bg(palette.window))
                .when(dragging.as_ref() == Some(root), |tab| {
                    tab.opacity(DRAGGED_OPACITY).cursor(CursorStyle::ClosedHand)
                });
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
            let tab = tab
                .child(body)
                .child(
                    close
                        .size(px(20.))
                        .flex_none()
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
                .map(|tab| context_menu_trigger(tab, &tab_menu, menu_root.clone()));
            let tab_bounds = bounds.clone();
            let measured_root = root.clone();
            controls(lattice_ui::measure::measured(tab, move |rect, _| {
                tab_bounds
                    .borrow_mut()
                    .tabs
                    .push((measured_root.clone(), rect))
            }))
            .into_any_element()
        })
        .collect();
    strip(
        div()
            .flex()
            .items_end()
            .gap(px(PROJECT_TAB_GAP))
            .h_full()
            .pr(px(PROJECT_GROUP_END))
            .children(tabs)
            .children(pressed)
            .children(drop_line)
            .children(menu_layer),
    )
}
