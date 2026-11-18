// Ported from Excalidraw (https://github.com/excalidraw/excalidraw,
// @excalidraw/excalidraw 0.18.1) for Lattice's native whiteboard. Excalidraw:
// MIT License, Copyright (c) 2020 Excalidraw. See THIRD_PARTY_NOTICES.md.

//! The narrow layout, after Excalidraw 0.18.1's `MobileMenu.tsx` and its CSS
//! (`.App-toolbar--mobile`, `.mobile-misc-tools-container`,
//! `.App-bottom-bar`, `.App-toolbar-content`, `.App-mobile-menu`): what the
//! web board shows below `MQ_MAX_WIDTH_PORTRAIT` (730px), the usual width of
//! the editor pane. Top center the shapes without their letters, on the
//! right edge a column with the tool lock and the hand; at the bottom one
//! island with the main menu, the styles toggle, duplicate (finalize while a
//! line is drawn click by click), delete, and undo / redo. The styles open
//! above them only through the toggle (`openMenu: "shape"`), so nothing
//! covers the canvas while drawing. No zoom, help or side panel. Differs: no
//! library trigger, pen mode button or "scroll back to content".

use super::tip::ExTip;
use super::toolbar::{MAIN, divider, extra_tools, tool_button};
use super::*;
use crate::board::action::{BoardAction, Tool};
use crate::settings::tr;
use std::collections::HashSet;

/// `SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2` around the bottom bar.
const BAR_MARGIN: f32 = 14.;
/// The misc tools' top: `5rem - --editor-container-padding` below the top
/// row's container.
const MISC_TOP: f32 = 64.;

thread_local! {
    /// Boards whose styles are open (`appState.openMenu === "shape"`).
    static EDIT_MENU: RefCell<HashSet<EntityId>> = RefCell::default();
}

pub(crate) fn edit_menu(cx: &Context<BoardView>) -> bool {
    EDIT_MENU.with(|m| m.borrow().contains(&cx.entity_id()))
}

fn toggle_edit_menu(cx: &mut Context<BoardView>) {
    let id = cx.entity_id();
    EDIT_MENU.with(|m| {
        let mut m = m.borrow_mut();
        if !m.remove(&id) {
            m.insert(id);
        }
    });
    cx.notify();
}

/// `App-top-bar`: the shapes island centered, the misc tools on the right.
pub(crate) fn top_bar(me: &BoardView, cx: &mut Context<BoardView>) -> impl IntoElement {
    let mut row = div().flex().items_center().gap(px(style::SPACE));
    for t in MAIN.into_iter().filter(|&t| t != Tool::Hand) {
        row = row.child(tool_button(me, t, false, cx));
    }
    row = row.child(divider().ml(px(4.))).child(extra_tools(me, cx));
    let bar = island("board-toolbar", 1.)
        .relative()
        .child(row)
        .children(super::hints::render(me));
    let locked = me.tool_locked();
    let hand = me.tool() == Tool::Hand;
    let misc_button =
        |id: &'static str, on: bool| tool_icon(id, style::DEFAULT_BUTTON, on).rounded(px(0.));
    let misc = eat(div()
        .id("board-misc-tools")
        .occlude()
        .absolute()
        .top(px(style::TOP_PADDING + MISC_TOP))
        .right_0()
        .flex()
        .flex_col()
        .overflow_hidden()
        .bg(style::island_bg())
        .border_1()
        .border_r_0()
        .border_color(style::surface_high())
        .rounded_tl(px(style::RADIUS_LG))
        .rounded_bl(px(style::RADIUS_LG)))
    .child(
        misc_button("board-tool-lock", locked)
            .child(icon(
                if locked { "locked" } else { "unlocked" },
                style::ICON,
                tool_icon_color(locked),
            ))
            .ex_tip(
                tr(
                    "绘制后保持所选的工具栏状态",
                    "Keep selected tool active after drawing",
                ),
                None,
            )
            .on_click(
                cx.listener(|me, _, window, cx| me.run(BoardAction::ToggleToolLock, window, cx)),
            ),
    )
    .child(
        misc_button("board-tool-Hand", hand)
            .child(icon("hand", style::ICON, tool_icon_color(hand)))
            .ex_tip(tr("抓手（平移工具）", "Hand (panning tool)"), None)
            .on_click(cx.listener(|me, _, window, cx| {
                let t = if me.tool() == Tool::Hand {
                    Tool::Selection
                } else {
                    Tool::Hand
                };
                me.set_tool(t, window, cx)
            })),
    );
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            div()
                .absolute()
                .top(px(style::TOP_PADDING))
                .left(px(style::PADDING))
                .right(px(style::PADDING))
                .flex()
                .justify_center()
                .child(bar),
        )
        .child(misc)
}

/// A `ToolButton` of `type="button"`: 32px, plain until hovered.
fn button(id: &'static str, name: &str, enabled: bool, selected: bool) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .size(px(style::DEFAULT_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(style::RADIUS_LG))
        .when(selected, |d| d.bg(style::button_gray_2()))
        .when(enabled, |d| {
            d.cursor_pointer()
                .hover(|s| s.bg(style::button_hover_bg()))
                .active(|s| s.bg(style::button_gray_3()))
        })
        .child(icon(
            name,
            style::ICON,
            if enabled {
                style::text()
            } else {
                style::disabled()
            },
        ))
}

/// `App-bottom-bar`: one island across the bottom, the styles (when open)
/// above the actions row.
pub(crate) fn bottom_bar(
    me: &BoardView,
    can_edit: bool,
    sections: Option<Div>,
    cx: &mut Context<BoardView>,
) -> impl IntoElement {
    let menu_open = menu::main_menu_open(cx);
    let trigger = menu::trigger(menu_open, cx);
    // full width, 55px up from the bar's bottom (`.dropdown-menu--mobile`);
    // upstream's mobile menu doesn't close on a press outside it
    let list = menu_open.then(|| {
        div()
            .absolute()
            .left_0()
            .right_0()
            .bottom(px(55.))
            .child(menu::list(cx).w_full().max_w_full())
    });
    let run = |a: BoardAction| {
        cx.listener(move |me: &mut BoardView, _: &ClickEvent, window, cx| {
            me.run(a.clone(), window, cx)
        })
    };
    let selected = !me.selected_elements().is_empty();
    let (u, r) = (me.can_undo(), me.can_redo());
    let actions = div()
        .flex()
        .items_center()
        .justify_between()
        .p(px(8.))
        .child(trigger)
        .when(can_edit, |d| {
            d.child(
                button("board-edit-menu", "palette", true, edit_menu(cx))
                    .ex_tip(tr("编辑", "Edit"), None)
                    .on_click(cx.listener(|_, _, _, cx| toggle_edit_menu(cx))),
            )
        })
        .map(|d| {
            if me.multi.is_some() {
                d.child(
                    button("board-finalize", "done", true, false)
                        .ex_tip(tr("完成", "Done"), None)
                        .on_click(cx.listener(|me, _, _, cx| {
                            crate::board::tools::linear::finalize(me, cx)
                        })),
                )
            } else {
                d.when(selected, |d| {
                    d.child(
                        button("board-duplicate", "duplicate", true, false)
                            .ex_tip(tr("复制", "Duplicate"), Some(&shortcut("CtrlOrCmd+D")))
                            .on_click(run(BoardAction::Duplicate)),
                    )
                })
            }
        })
        .when(selected, |d| {
            d.child(
                button("board-delete", "trash", true, false)
                    .ex_tip(tr("删除", "Delete"), None)
                    .on_click(run(BoardAction::Delete)),
            )
        })
        .child(
            div()
                .flex()
                .child(
                    button("board-undo", "undo", u, false)
                        .when(u, |d| d.on_click(run(BoardAction::Undo))),
                )
                .child(
                    button("board-redo", "redo", r, false)
                        .when(r, |d| d.on_click(run(BoardAction::Redo))),
                ),
        );
    let max_h =
        me.bounds.get().size.height - px(style::TOP_PADDING + 4. * style::SPACE + BAR_MARGIN);
    div()
        .absolute()
        .left(px(BAR_MARGIN))
        .right(px(BAR_MARGIN))
        .bottom(px(BAR_MARGIN))
        .child(
            island("board-bottom-bar", 0.)
                .w_full()
                .max_h(max_h)
                .flex()
                .flex_col()
                .when_some(sections, |d, s| {
                    d.child(
                        div()
                            .id("board-mobile-menu")
                            .flex_shrink(1.)
                            .min_h_0()
                            .overflow_y_scroll()
                            .pt(px(8.))
                            .px(px(8.))
                            .mb(px(4. * style::SPACE))
                            .child(s),
                    )
                })
                .child(actions)
                .children(list),
        )
}
