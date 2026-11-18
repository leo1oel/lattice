// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The footer, after Excalidraw `footer/Footer.tsx`, `Actions.tsx`
//! (`ZoomActions`, `UndoRedoActions`), `HelpButton.tsx` and `Actions.scss` /
//! `styles.scss` @ 3a317b5: bottom left, 16px in, the zoom island (zoom out,
//! the zoom level, zoom in: 36px buttons, the level 60px wide, 14px) and the
//! undo / redo island 0.6em to its right, both `--color-surface-low` with a
//! 1px `--color-surface-lowest` ring; bottom right the help button. Differs:
//! no minimap toggle or zen-mode exit.

use super::tip::ExTip;
use super::*;
use crate::board::action::BoardAction;
use crate::settings::tr;

/// `.zoom-actions`, `.undo-redo-buttons`.
fn group(id: &'static str) -> Stateful<Div> {
    eat(div()
        .id(id)
        .occlude()
        .flex()
        .items_center()
        .bg(style::surface_low())
        .rounded(px(style::RADIUS_LG))
        .shadow(style::ring(style::surface_lowest())))
}

/// A 36px button of a group, rounded only on its outer side.
fn part(id: &'static str, w: f32, first: bool, last: bool, enabled: bool) -> Stateful<Div> {
    let r = px(style::RADIUS_LG);
    div()
        .id(id)
        .flex_none()
        .w(px(w))
        .h(px(style::LG_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(14.))
        .text_color(style::text())
        .when(first, |d| d.rounded_tl(r).rounded_bl(r))
        .when(last, |d| d.rounded_tr(r).rounded_br(r))
        .when(enabled, |d| {
            d.cursor_pointer()
                .hover(|s| s.bg(style::button_hover_bg()))
                .active(|s| {
                    s.bg(style::button_hover_bg())
                        .border_1()
                        .border_color(style::button_active_border())
                })
        })
}

pub(crate) fn footer(me: &BoardView, cx: &mut Context<BoardView>) -> impl IntoElement {
    let pct = format!("{}%", (me.viewport().zoom * 100.).round() as i64);
    let run = |a: BoardAction| {
        cx.listener(move |me: &mut BoardView, _: &ClickEvent, window, cx| {
            me.run(a.clone(), window, cx)
        })
    };
    let ic = |name: &str, on: bool| {
        icon(
            name,
            style::ICON,
            if on { style::text() } else { style::disabled() },
        )
    };
    let zoom = group("board-zoom")
        .child(
            part("board-zoom-out", style::LG_BUTTON, true, false, true)
                .child(ic("zoom-out", true))
                .ex_tip(tr("缩小", "Zoom out"), Some(&shortcut("CtrlOrCmd+-")))
                .on_click(run(BoardAction::ZoomOut)),
        )
        .child(
            part("board-zoom-reset", 60., false, false, true)
                .child(pct)
                .ex_tip(tr("重置缩放", "Reset zoom"), None)
                .on_click(run(BoardAction::ResetZoom)),
        )
        .child(
            part("board-zoom-in", style::LG_BUTTON, false, true, true)
                .child(ic("zoom-in", true))
                .ex_tip(tr("放大", "Zoom in"), Some(&shortcut("CtrlOrCmd++")))
                .on_click(run(BoardAction::ZoomIn)),
        );
    let (u, r) = (me.can_undo(), me.can_redo());
    let undo = group("board-history")
        .child(
            part("board-undo", style::LG_BUTTON, true, false, u)
                .child(ic("undo", u))
                .when(u, |d| {
                    d.ex_tip(tr("撤销", "Undo"), Some(&shortcut("CtrlOrCmd+Z")))
                        .on_click(run(BoardAction::Undo))
                }),
        )
        .child(
            part("board-redo", style::LG_BUTTON, false, true, r)
                .child(ic("redo", r))
                .when(r, |d| {
                    d.ex_tip(tr("重做", "Redo"), Some(&shortcut("CtrlOrCmd+Shift+Z")))
                        .on_click(run(BoardAction::Redo))
                }),
        );
    let help = filled_button("board-help", false)
        .w(px(style::LG_BUTTON))
        .child(icon("help", style::ICON, style::text()))
        // no tooltip over the open dialog
        .when(!me.help_open(), |d| d.ex_tip(tr("帮助", "Help"), Some("?")))
        .on_click(cx.listener(|me, _, _, cx| {
            let open = !me.help_open();
            me.set_help_open(open, cx)
        }));
    div()
        .absolute()
        .left(px(style::PADDING))
        .right(px(style::PADDING))
        .bottom(px(style::PADDING))
        .flex()
        .items_center()
        .child(zoom)
        .child(undo.ml(px(9.6)))
        .child(div().flex_1())
        .child(help)
}
