// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The main menu and the dropdown pieces, after Excalidraw
//! `main-menu/MainMenu.tsx`, `main-menu/DefaultItems.tsx` and
//! `dropdownMenu/*` (`DropdownMenu.scss`) @ 3a317b5: the hamburger
//! (`.main-menu-trigger`) opens an island (padding 8) of 32px items (icon,
//! 14px text, faded shortcut). The default items we support: 在画布上查找, 导出图片, 帮助 and 重置画布 (the Tauri board's menu)
//! (with its confirm dialog); Lattice leaves out the canvas background, as the
//! canvas is the editor sheet.
//! Differs: no open / save / export / search / socials / theme items (the
//! app's header, above the board, has the way back and the document menu).

use super::*;
use crate::board::action::BoardAction;
use crate::settings::tr;

/// `DropdownMenuContent`: an island (padding 2), items 1px apart.
pub(crate) fn dropdown(id: impl Into<ElementId>) -> Stateful<Div> {
    island(id, 2.)
        .flex()
        .flex_col()
        .gap(px(1.))
        .max_w(px(320.))
        .when(crate::theme::dark(), |d| {
            d.shadow({
                let mut s = style::shadow_island();
                s.extend(style::ring(style::hexa(0, 0.15)));
                s
            })
        })
}

/// `DropdownMenuItem`: 32px, padding 0 8, radius 6, icon 16 and 14px text 10
/// apart, the shortcut at the end at half opacity; hover
/// `--button-hover-bg`, selected `--color-primary-light` (icon
/// `--color-primary-darker`).
pub(crate) fn dropdown_item(
    id: impl Into<ElementId>,
    icon_name: Option<&str>,
    label: impl Into<SharedString>,
    shortcut: Option<String>,
    selected: bool,
) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .w_full()
        .h(px(32.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(style::RADIUS_MD))
        .cursor_pointer()
        .text_size(px(14.))
        .text_color(style::on_surface())
        .when(selected, |d| d.bg(style::primary_light()))
        .when(!selected, |d| d.hover(|s| s.bg(style::button_hover_bg())))
        .active(|s| {
            s.bg(style::button_hover_bg())
                .shadow(style::ring(style::brand_active()))
        })
        .when_some(icon_name, |d, n| {
            d.child(icon(
                n,
                style::ICON,
                if selected {
                    style::primary_darker()
                } else {
                    style::text()
                },
            ))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label.into()),
        )
        .when_some(shortcut, |d, k| {
            d.child(div().flex_none().ml(px(8.)).opacity(0.5).child(k))
        })
}

/// `MainMenu.Trigger` (`.main-menu-trigger`): the hamburger.
pub(crate) fn trigger(open: bool, cx: &mut Context<BoardView>) -> Stateful<Div> {
    filled_button("board-main-menu", open)
        .w(px(style::LG_BUTTON))
        .child(icon("hamburger", style::ICON, style::text()))
        .on_click(cx.listener(|_, _, _, cx| {
            let open = main_menu_open(cx);
            set_pop(if open { None } else { Some(Pop::MainMenu) }, cx)
        }))
}

pub(crate) fn main_menu_open(cx: &Context<BoardView>) -> bool {
    matches!(pop(cx), Some(Pop::MainMenu | Pop::CanvasBackground))
}

/// Top left (`.excalidraw-ui-top-left`): the hamburger and its menu.
pub(crate) fn main_menu(cx: &mut Context<BoardView>) -> impl IntoElement {
    let open = main_menu_open(cx);
    // the board sits in the note pane, under the app's header (which names it)
    let mut col = div()
        .absolute()
        .top(px(style::TOP_PADDING))
        .left(px(style::PADDING))
        .child(trigger(open, cx));
    if open {
        let menu = list(cx)
            .min_w(px(232.))
            .max_w(px(320.))
            .on_mouse_down_out(cx.listener(|_, _, _, cx| {
                if pop(cx) == Some(Pop::MainMenu) {
                    set_pop(None, cx)
                }
            }));
        // below the trigger, left edges aligned (`sideOffset` 8)
        col = col.child(
            div()
                .absolute()
                .top(px(style::LG_BUTTON + 8.))
                .left_0()
                .child(
                    deferred(anchored().snap_to_window_with_margin(px(8.)).child(menu))
                        .with_priority(3),
                ),
        );
    }
    col
}

/// The menu's items (`DefaultItems`).
pub(crate) fn list(cx: &mut Context<BoardView>) -> Stateful<Div> {
    let run = |a: BoardAction| {
        cx.listener(move |me: &mut BoardView, _: &ClickEvent, window, cx| {
            set_pop(None, cx);
            me.run(a.clone(), window, cx)
        })
    };
    dropdown("board-main-menu-list")
        .child(
            dropdown_item(
                "board-mm-search",
                Some("search"),
                tr("在画布上查找", "Find on canvas"),
                Some(shortcut("CtrlOrCmd+F")),
                false,
            )
            .on_click(run(BoardAction::FindOnCanvas)),
        )
        .child(
            dropdown_item(
                "board-mm-export",
                Some("image"),
                tr("导出图片...", "Export image..."),
                Some(shortcut("CtrlOrCmd+Shift+E")),
                false,
            )
            .on_click(run(BoardAction::ExportImage)),
        )
        .child(
            dropdown_item(
                "board-mm-help",
                Some("help"),
                tr("帮助", "Help"),
                Some("?".into()),
                false,
            )
            .on_click(run(BoardAction::ShowHelp)),
        )
        // (upstream shows it on an empty canvas too)
        .child(
            dropdown_item(
                "board-mm-clear",
                Some("trash"),
                tr("重置画布", "Reset the canvas"),
                None,
                false,
            )
            .on_click(cx.listener(|_, _, _, cx| set_pop(Some(Pop::ClearCanvas), cx))),
        )
}
