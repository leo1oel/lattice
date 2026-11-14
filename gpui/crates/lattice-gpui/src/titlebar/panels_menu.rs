//! The titlebar's Panels menu (`trellis-titlebar.tsx`'s `PanelToggles` and
//! its layout items).

use gpui::{Context, IntoElement, px};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{MenuAction, MenuPopover, ToolbarButton},
};

use crate::shell::{
    Shell,
    commands::{
        ResetLayout, ToggleAgentPanel, ToggleFocusMode, ToggleMaximize, TogglePapersPanel,
        TogglePdfPanel, ToggleProjectPanel,
    },
    trellis_layout::Preset,
    workspaces::{Workspaces, shown_name},
};

/// The Panels menu: each panel's toggle (checked while on screen), the
/// workspaces and the presets, focus mode, then maximize or restore and
/// reset.
pub(super) fn panels_menu(shell: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
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

pub(super) fn toggle_item(
    label: &str,
    icon: Icon,
    checked: bool,
    action: Box<dyn gpui::Action>,
) -> MenuAction {
    MenuAction::dispatch(label.to_string(), action)
        .icon(icon)
        .checked(checked)
}
