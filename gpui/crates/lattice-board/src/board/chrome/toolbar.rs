// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The tool bar, after Excalidraw `Toolbar.tsx`, `Tools.tsx`, `LockButton.tsx`
//! and `Toolbar.scss` / `ToolIcon.scss` @ 3a317b5: an island (padding 4, gap
//! 4) with the tool lock, a divider, hand, selection, the shapes, text,
//! sticky note and eraser, a divider and the "more tools" dropdown (image,
//! frame, lasso: the ones we have), the hint line under it. Each tool shows
//! its letter, and its title "Rectangle — R or 2", as upstream's. Fillable
//! tools fill their icon while active. Differs: no pen mode, laser, embed,
//! draw-to-shape, bucket fill or "Generate" items.

use super::menu::{dropdown, dropdown_item};
use super::tip::ExTip;
use super::*;
use crate::board::action::{BoardAction, Tool};
use crate::settings::tr;

/// The main row, in upstream order.
pub(super) const MAIN: [Tool; 10] = [
    Tool::Hand,
    Tool::Selection,
    Tool::Rectangle,
    Tool::Diamond,
    Tool::Ellipse,
    Tool::Arrow,
    Tool::Line,
    Tool::FreeDraw,
    Tool::Text,
    Tool::Eraser,
];
/// `ExtraToolsDropdown`'s tools we have.
const EXTRA: [Tool; 3] = [Tool::Image, Tool::Frame, Tool::Lasso];

pub(crate) fn tool_icon_name(t: Tool) -> &'static str {
    match t {
        Tool::Selection => "selection",
        Tool::Lasso => "lasso",
        Tool::Hand => "hand",
        Tool::Rectangle => "rectangle",
        Tool::Diamond => "diamond",
        Tool::Ellipse => "ellipse",
        Tool::Arrow => "arrow",
        Tool::Line => "line",
        Tool::FreeDraw => "freedraw",
        Tool::Text => "text",
        Tool::Image => "image",
        Tool::Eraser => "eraser",
        Tool::Frame => "frame",
        Tool::StickyNote => "sticky-note",
    }
}

/// `TOOLS[*].fillable`.
fn fillable(t: Tool) -> bool {
    matches!(
        t,
        Tool::Selection
            | Tool::Rectangle
            | Tool::Diamond
            | Tool::Ellipse
            | Tool::Arrow
            | Tool::Line
    )
}

/// `toolBar.*`.
pub(crate) fn tool_label(t: Tool) -> &'static str {
    match t {
        Tool::Selection => tr("选择", "Selection"),
        Tool::Lasso => tr("套索选择", "Lasso selection"),
        Tool::Hand => tr("抓手（平移工具）", "Hand (panning tool)"),
        Tool::Rectangle => tr("矩形", "Rectangle"),
        Tool::Diamond => tr("菱形", "Diamond"),
        Tool::Ellipse => tr("椭圆", "Ellipse"),
        Tool::Arrow => tr("箭头", "Arrow"),
        Tool::Line => tr("线条", "Line"),
        Tool::FreeDraw => tr("自由书写", "Draw"),
        Tool::Text => tr("文字", "Text"),
        Tool::Image => tr("插入图像", "Insert image"),
        Tool::Eraser => tr("橡皮", "Eraser"),
        Tool::Frame => tr("画框工具", "Frame tool"),
        Tool::StickyNote => tr("便签", "Sticky note"),
    }
}

/// `getToolLetter`: the badge (the letter, else the number).
fn tool_letter(t: Tool) -> Option<String> {
    let (k, n) = t.shortcut()?;
    if k.chars().all(|c| c.is_ascii_alphabetic()) {
        Some(k.to_uppercase())
    } else {
        n.map(|n| n.to_string())
    }
}

/// `getToolShortcut`: "R or 2".
pub(crate) fn tool_shortcut(t: Tool) -> Option<String> {
    let (k, n) = t.shortcut()?;
    let letter = k
        .chars()
        .all(|c| c.is_ascii_alphabetic())
        .then(|| k.to_uppercase());
    Some(match (letter, n) {
        (Some(l), Some(n)) => format!("{l} {} {n}", tr("或", "or")),
        (Some(l), None) => l,
        (None, n) => n.map(|n| n.to_string()).unwrap_or_default(),
    })
}

/// `keys`: show its letter (`.App-toolbar--mobile` hides them).
pub(super) fn tool_button(
    me: &BoardView,
    t: Tool,
    keys: bool,
    cx: &mut Context<BoardView>,
) -> Stateful<Div> {
    let on = me.tool() == t;
    let name = if on && fillable(t) {
        format!("{}-filled", tool_icon_name(t))
    } else {
        tool_icon_name(t).to_string()
    };
    tool_icon(
        SharedString::from(format!("board-tool-{t:?}")),
        style::LG_BUTTON,
        on,
    )
    .child(icon(&name, style::ICON, tool_icon_color(on)))
    // the hand hides its key (`hideKeyBinding`)
    .when_some(
        tool_letter(t).filter(|_| keys && t != Tool::Hand),
        |d, k| d.child(keybinding(k, on)),
    )
    .ex_tip(tool_label(t), tool_shortcut(t).as_deref())
    .on_click(cx.listener(move |me, _, window, cx| me.set_tool(t, window, cx)))
}

/// `.App-toolbar__divider`: 1 × 24, `--default-border-color`.
pub(super) fn divider() -> Div {
    div().flex_none().w(px(1.)).h(px(24.)).bg(style::border())
}

/// `ExtraToolsDropdown`: the trigger shows the chosen extra tool, else the dots.
pub(super) fn extra_tools(me: &BoardView, cx: &mut Context<BoardView>) -> Stateful<Div> {
    let tool = me.tool();
    let selected = EXTRA.contains(&tool);
    let open = pop(cx) == Some(Pop::ExtraTools);
    let trigger = div()
        .id("board-extra-tools")
        .flex_none()
        .relative()
        .size(px(style::LG_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(style::RADIUS_LG))
        .cursor_pointer()
        .when(selected, |d| d.bg(style::surface_primary_container()))
        .active(|s| {
            s.bg(style::button_hover_bg())
                .border_1()
                .border_color(style::button_active_border())
        })
        .child(icon(
            if selected {
                tool_icon_name(tool)
            } else {
                "dots"
            },
            style::ICON,
            if selected {
                style::on_primary_container()
            } else {
                style::text()
            },
        ))
        .when(!open, |d| d.ex_tip(tr("更多工具", "More tools"), None))
        .on_click(cx.listener(|_, _, _, cx| {
            let open = pop(cx) == Some(Pop::ExtraTools);
            set_pop(if open { None } else { Some(Pop::ExtraTools) }, cx)
        }));
    if !open {
        return trigger;
    }
    let mut menu = dropdown("board-extra-tools-menu").min_w(px(190.));
    for t in EXTRA {
        let k = match t {
            Tool::Image => Some("9".to_string()),
            Tool::Frame => Some("F".to_string()),
            _ => None,
        };
        menu = menu.child(
            dropdown_item(
                ("board-extra-tool", t as usize),
                Some(tool_icon_name(t)),
                tool_label(t),
                k,
                tool == t,
            )
            .on_click(cx.listener(move |me, _, window, cx| {
                set_pop(None, cx);
                me.set_tool(t, window, cx)
            })),
        );
    }
    let menu = menu.on_mouse_down_out(cx.listener(|_, _, _, cx| {
        if pop(cx) == Some(Pop::ExtraTools) {
            set_pop(None, cx)
        }
    }));
    // below the trigger, right edges aligned (`sideOffset` 8 + `margin-top` 6)
    trigger.child(
        div()
            .absolute()
            .top(px(style::LG_BUTTON + 14.))
            .right_0()
            .child(
                deferred(
                    anchored()
                        .anchor(Anchor::TopRight)
                        .snap_to_window_with_margin(px(8.))
                        .child(menu),
                )
                .with_priority(3),
            ),
    )
}

pub(crate) fn render(me: &BoardView, cx: &mut Context<BoardView>) -> impl IntoElement {
    let locked = me.tool_locked();
    let lock = tool_icon("board-tool-lock", style::LG_BUTTON, locked)
        .child(icon(
            if locked { "locked" } else { "unlocked" },
            style::ICON,
            tool_icon_color(locked),
        ))
        .ex_tip(
            &format!(
                "{} — Q",
                tr(
                    "绘制后保持所选的工具栏状态",
                    "Keep selected tool active after drawing"
                )
            ),
            None,
        )
        .on_click(cx.listener(|me, _, window, cx| me.run(BoardAction::ToggleToolLock, window, cx)));
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(style::SPACE))
        .child(lock)
        .child(divider().mr(px(4.)));
    for t in MAIN {
        row = row.child(tool_button(me, t, true, cx));
    }
    row = row.child(divider().ml(px(4.))).child(extra_tools(me, cx));
    let bar = island("board-toolbar", 1.)
        .relative()
        .child(row)
        .children(super::hints::render(me));
    // `.App-menu_top`'s `1fr auto 1fr` grid: centered, but never over the
    // main menu's column when the board is narrow.
    div()
        .absolute()
        .top(px(style::TOP_PADDING))
        .left_0()
        .right_0()
        .flex()
        .child(
            div()
                .flex_1()
                .min_w(px(style::PADDING + style::LG_BUTTON + 8.)),
        )
        .child(bar)
        .child(div().flex_1())
}
