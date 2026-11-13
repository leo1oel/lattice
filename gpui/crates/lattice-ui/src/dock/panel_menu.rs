//! A panel's ⋯ menu (Trellis's): the panel's own items, the app's, then
//! Maximize or Restore size, Move to, Close and Close other tabs.

use super::*;

/// A panel's ⋯ menu, as Trellis orders it: the panel's own items, the app's
/// (Float, Hide), then Maximize or Restore size, Move to (another group, a
/// new split right or below), Close and Close other tabs.
pub(super) fn panel_menu(
    menu: PopupMenu,
    area: &WeakEntity<DockArea>,
    group: &TabGroupContext,
    window: &mut Window,
    cx: &mut gpui::Context<PopupMenu>,
) -> PopupMenu {
    let Some(panel) = group.active_panel().cloned() else {
        return menu;
    };
    let panel_id = panel.panel_id(cx);
    let name = tab_name(&panel, cx);
    let mut menu = match PanelHandle::of(&panel) {
        Some(handle) => handle.panel().dropdown_menu(menu, window, cx),
        None => menu,
    };
    if !menu.is_empty() {
        menu = menu.separator();
    }
    if let Some(items) = cx
        .try_global::<PanelMenuItems>()
        .map(|items| items.0.clone())
    {
        let request = PanelMenuRequest {
            area: area.clone(),
            panel: panel_id,
            group: group.clone(),
        };
        menu = items(menu, &request, window, cx);
    }

    let zoomed = group.is_zoomed();
    let zoom_group = group.clone();
    menu = menu.item(
        PopupMenuItem::new(if zoomed {
            t!("Restore size")
        } else {
            t!("Maximize")
        })
        .icon(
            if zoomed {
                Icon::MINIMIZE
            } else {
                Icon::MAXIMIZE
            }
            .kit(),
        )
        .on_click(move |_, window, cx| zoom_group.toggle_zoom(window, cx)),
    );

    // Move to: the other groups, then a new split beside this one.
    let node = group.node();
    let targets = area
        .upgrade()
        .map(|area| move_targets(&area.read(cx), node, cx))
        .unwrap_or_default();
    let move_area = area.clone();
    menu = menu.submenu_with_icon(
        Some(Icon::ARROW_RIGHT_LEFT.kit()),
        space_mixed_script(&t!("Move {title} to", title = name)),
        window,
        cx,
        move |mut submenu, _, _| {
            for (target, label) in &targets {
                let (area, target) = (move_area.clone(), *target);
                submenu = submenu.item(PopupMenuItem::new(label.clone()).on_click(
                    move |_, window, cx| {
                        area.update(cx, |area, cx| {
                            area.move_panel(
                                panel_id,
                                InsertTarget::Tabs {
                                    node: target,
                                    ix: None,
                                    activate: true,
                                },
                                window,
                                cx,
                            )
                        })
                        .ok();
                    },
                ));
            }
            if !targets.is_empty() {
                submenu = submenu.separator();
            }
            for (label, icon, placement) in [
                (
                    t!("New split right"),
                    Icon::COLUMNS_2,
                    gpui_kit::base::Placement::Right,
                ),
                (
                    t!("New split below"),
                    Icon::ROWS_2,
                    gpui_kit::base::Placement::Bottom,
                ),
            ] {
                let area = move_area.clone();
                submenu = submenu.item(PopupMenuItem::new(label).icon(icon.kit()).on_click(
                    move |_, window, cx| {
                        area.update(cx, |area, cx| {
                            area.split_at(node, panel_id, placement, window, cx)
                        })
                        .ok();
                    },
                ));
            }
            submenu
        },
    );

    if panel.closable(cx) {
        let close = group.clone();
        menu = menu.separator().item(
            PopupMenuItem::new(space_mixed_script(&t!("Close {title}", title = name)))
                .icon(Icon::X.kit())
                .on_click(move |_, window, cx| close_panel(&close, panel_id, window, cx)),
        );
        let others: Vec<PanelId> = group
            .panels()
            .iter()
            .filter(|other| other.visible(cx) && other.closable(cx))
            .map(|other| other.panel_id(cx))
            .filter(|other| *other != panel_id)
            .collect();
        if !others.is_empty() {
            let close = group.clone();
            menu = menu.item(
                PopupMenuItem::new(t!("Close other tabs"))
                    .icon(Icon::CIRCLE_X.kit())
                    .on_click(move |_, window, cx| {
                        for other in &others {
                            close_panel(&close, *other, window, cx);
                        }
                    }),
            );
        }
    }
    menu
}

/// Every other tab group in the area, named by its displayed panel.
fn move_targets(area: &DockArea, from: NodeId, cx: &App) -> Vec<(NodeId, SharedString)> {
    let mut targets = Vec::new();
    for placement in [
        DockPlacement::Left,
        DockPlacement::Center,
        DockPlacement::Right,
        DockPlacement::Bottom,
    ] {
        let Some(tree) = area.layout(placement) else {
            continue;
        };
        tree.root().walk(&mut |node| {
            if let PaneRef::Tabs { panels, active_ix } = node.kind()
                && node.id() != from
                && let Some(panel) = panels
                    .get(active_ix)
                    .or(panels.first())
                    .and_then(|id| area.panel(*id))
            {
                targets.push((node.id(), tab_name(panel, cx)));
            }
        });
    }
    targets
}
