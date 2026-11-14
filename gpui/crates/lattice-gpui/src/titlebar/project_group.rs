//! The titlebar's project switcher, or one tab per project once the window
//! holds two (`project-tabs.tsx`), each with its close button and its
//! right-click menu.

use gpui::{
    AnyElement, AnyView, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
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
use crate::shell::Shell;

/// The project switcher, cut at `switcher_max`, or one tab per project once
/// the window holds two.
pub(super) fn project_group(
    shell: &Shell,
    switcher_max: f32,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let switcher = MenuPopover::new(
        "project-switcher-menu",
        ToolbarButton::new("project-switcher", shell.project_name(cx))
            .switcher()
            .max_w(px(switcher_max))
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
