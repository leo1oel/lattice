// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The right-click menu, after Excalidraw `App.getContextMenuItems`, the
//! actions' `contextItemLabel` / `predicate`, `ContextMenu.tsx`,
//! `ContextMenu.scss` and `actions/shortcuts.ts` @ 3a317b5: the canvas menu
//! and the element menu, in upstream order, with the items we have (no
//! library, links, zen / view / minimap mode, stats). Separators collapse when
//! the items between them are all hidden, as upstream's. Looks: radius 4,
//! `--popup-secondary-bg-color`, a 1px `--button-gray-3` border, `0 3px 10px`
//! shadow, 8px above and below; items 4/16/4/20 padding, the shortcut faded
//! at 0.7rem; hover `--select-highlight-color` with the text in
//! `--popup-bg-color`; Delete's label red; toggles get a ✓.

use super::*;
use crate::board::action::{BoardAction, Layer};
use crate::board::actions::{
    can_group, can_toggle_element_lock, can_ungroup, can_unlock_all_elements,
    can_wrap_selection_in_frame, is_single_frame_selected, should_lock,
};
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::text::{can_bind_text, can_unbind_text, can_wrap_text_in_container};
use crate::settings::tr;

enum Item {
    Sep,
    Row(&'static str, Option<String>, BoardAction, bool),
}

fn row(label: &'static str, k: Option<&str>, a: BoardAction) -> Item {
    Item::Row(label, k.map(shortcut), a, false)
}

/// `actionCopyAsPng`, `actionCopyAsSvg`.
/// `actionCopyAsPng`, `actionCopyAsSvg`, then `copyText` when the selection
/// (labels included) has text.
fn pictures(text: bool) -> Vec<Item> {
    let mut v = vec![
        row(
            tr("复制为 PNG 到剪贴板", "Copy to clipboard as PNG"),
            Some("Shift+Alt+C"),
            BoardAction::CopyAsPng,
        ),
        row(
            tr("复制为 SVG 到剪贴板", "Copy to clipboard as SVG"),
            None,
            BoardAction::CopyAsSvg,
        ),
    ];
    if text {
        v.push(row(
            tr("复制文本到剪贴板", "Copy to clipboard as text"),
            None,
            BoardAction::CopyText,
        ));
    }
    v
}

pub(crate) fn render(
    me: &BoardView,
    _window: &mut Window,
    cx: &mut Context<BoardView>,
) -> Option<AnyElement> {
    let (pos, on_element) = me.context_menu()?;
    let (a, elements) = (me.app_state(), me.elements());
    let selected =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    let mac = cfg!(target_os = "macos");
    let has_text = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            ..Default::default()
        },
    )
    .iter()
    .any(|e| e.is_text());
    let items: Vec<Item> = if !on_element {
        let mut v = vec![
            row(tr("粘贴", "Paste"), Some("CtrlOrCmd+V"), BoardAction::Paste),
            Item::Sep,
        ];
        if elements.iter().any(|e| !e.is_deleted) {
            v.extend(pictures(has_text));
        }
        v.extend([
            Item::Sep,
            row(
                tr("全部选中", "Select all"),
                Some("CtrlOrCmd+A"),
                BoardAction::SelectAll,
            ),
        ]);
        if can_unlock_all_elements(elements, a) {
            v.push(row(
                tr("全部解锁", "Unlock all"),
                None,
                BoardAction::UnlockAll,
            ));
        }
        v.extend([
            Item::Sep,
            Item::Row(
                tr("切换网格显示", "Toggle grid"),
                Some(shortcut("CtrlOrCmd+'")),
                BoardAction::ToggleGrid,
                a.grid_mode_enabled,
            ),
            Item::Row(
                tr("吸附至对象", "Snap to objects"),
                Some(shortcut("Alt+S")),
                BoardAction::ToggleSnap,
                a.objects_snap_mode_enabled,
            ),
            Item::Row(
                tr("箭头绑定", "Arrow binding"),
                None,
                BoardAction::ToggleArrowBinding,
                a.binding_preference,
            ),
            Item::Row(
                tr("吸附到中点", "Snap to midpoints"),
                None,
                BoardAction::ToggleMidpointSnapping,
                a.is_midpoint_snapping_enabled,
            ),
        ]);
        v
    } else {
        let single_linear =
            selected.len() == 1 && selected[0].is_linear() && !selected[0].is_elbow_arrow();
        let editing_line = a
            .selected_linear_element
            .as_ref()
            .is_some_and(|l| l.is_editing);
        let line_label = if selected.first().is_some_and(|e| e.is_arrow()) {
            tr("编辑箭头", "Edit arrow")
        } else {
            tr("编辑线条", "Edit line")
        };
        let lock = should_lock(&selected);
        let mut v = vec![
            Item::Sep,
            row(tr("剪切", "Cut"), Some("CtrlOrCmd+X"), BoardAction::Cut),
            row(tr("拷贝", "Copy"), Some("CtrlOrCmd+C"), BoardAction::Copy),
            row(tr("粘贴", "Paste"), Some("CtrlOrCmd+V"), BoardAction::Paste),
            Item::Sep,
        ];
        if is_single_frame_selected(elements, a) {
            v.push(row(
                tr("选择画框中的所有元素", "Select all elements in frame"),
                None,
                BoardAction::SelectAllInFrame,
            ));
            v.push(row(
                tr("分离出画框中的所有元素", "Remove all elements from frame"),
                None,
                BoardAction::RemoveFromFrame,
            ));
        }
        if can_wrap_selection_in_frame(elements, a) {
            v.push(row(
                tr("用选中的元素创建画框", "Wrap selection in frame"),
                None,
                BoardAction::FrameFromSelection,
            ));
        }
        v.push(Item::Sep);
        if a.cropping_element_id.is_none() && selected.len() == 1 && selected[0].is_image() {
            v.push(row(
                tr("裁剪图片", "Crop image"),
                None,
                BoardAction::ToggleCrop,
            ));
        }
        v.push(Item::Sep);
        v.extend(pictures(has_text));
        v.extend([
            Item::Sep,
            row(
                tr("拷贝样式", "Copy styles"),
                Some("CtrlOrCmd+Alt+C"),
                BoardAction::CopyStyles,
            ),
            row(
                tr("粘贴样式", "Paste styles"),
                Some("CtrlOrCmd+Alt+V"),
                BoardAction::PasteStyles,
            ),
            Item::Sep,
        ]);
        if can_group(elements, a) {
            v.push(row(
                tr("编组", "Group selection"),
                Some("CtrlOrCmd+G"),
                BoardAction::Group,
            ));
        }
        // `actionTextAutoResize`, `actionUnbindText`, `actionBindText`, `actionWrapTextInContainer`
        if let [t] = selected.as_slice()
            && t.text().is_some_and(|d| !d.auto_resize)
        {
            v.push(row(
                tr("启用文本自动缩放", "Enable text auto-resizing"),
                None,
                BoardAction::TextAutoResize,
            ));
        }
        if can_unbind_text(&selected) {
            v.push(row(
                tr("取消文本绑定", "Unbind text"),
                None,
                BoardAction::UnbindText,
            ));
        }
        if can_bind_text(&selected, &me.scene) {
            v.push(row(
                tr("将文本绑定到容器", "Bind text to the container"),
                None,
                BoardAction::BindText,
            ));
        }
        if !selected.is_empty() && can_wrap_text_in_container(&selected) {
            v.push(row(
                tr("将文本包围在容器中", "Wrap text in a container"),
                None,
                BoardAction::WrapTextInContainer,
            ));
        }
        if can_ungroup(a) {
            v.push(row(
                tr("解除编组", "Ungroup selection"),
                Some("CtrlOrCmd+Shift+G"),
                BoardAction::Ungroup,
            ));
        }
        v.extend([
            Item::Sep,
            row(
                tr("下移一层", "Send backward"),
                Some("CtrlOrCmd+["),
                BoardAction::Layer(Layer::Backward),
            ),
            row(
                tr("上移一层", "Bring forward"),
                Some("CtrlOrCmd+]"),
                BoardAction::Layer(Layer::Forward),
            ),
            row(
                tr("置于底层", "Send to back"),
                Some(if mac {
                    "CtrlOrCmd+Alt+["
                } else {
                    "CtrlOrCmd+Shift+["
                }),
                BoardAction::Layer(Layer::Back),
            ),
            row(
                tr("置于顶层", "Bring to front"),
                Some(if mac {
                    "CtrlOrCmd+Alt+]"
                } else {
                    "CtrlOrCmd+Shift+]"
                }),
                BoardAction::Layer(Layer::Front),
            ),
            Item::Sep,
            row(
                tr("水平翻转", "Flip horizontal"),
                Some("Shift+H"),
                BoardAction::FlipHorizontal,
            ),
            row(
                tr("垂直翻转", "Flip vertical"),
                Some("Shift+V"),
                BoardAction::FlipVertical,
            ),
            Item::Sep,
        ]);
        if (single_linear && !editing_line) || editing_line {
            v.push(row(line_label, None, BoardAction::ToggleLinearEditor));
        }
        v.extend([
            Item::Sep,
            row(
                tr("创建副本", "Duplicate"),
                Some("CtrlOrCmd+D"),
                BoardAction::Duplicate,
            ),
        ]);
        if can_toggle_element_lock(elements, a) {
            v.push(row(
                if lock {
                    tr("锁定", "Lock")
                } else {
                    tr("解除锁定", "Unlock")
                },
                Some("CtrlOrCmd+Shift+L"),
                BoardAction::ToggleLock,
            ));
        }
        v.extend([
            Item::Sep,
            row(tr("删除", "Delete"), Some("Delete"), BoardAction::Delete),
        ]);
        v
    };

    let mut menu = eat(div()
        .id("board-context-menu")
        .occlude()
        .min_w(px(152.))
        .py(px(8.))
        .flex()
        .flex_col()
        .rounded(px(4.))
        .bg(style::popup_secondary_bg())
        .border_1()
        .border_color(style::button_gray_3())
        .shadow(style::shadow_context_menu())
        .text_size(px(style::BUTTON_TEXT))
        .line_height(style::lh(style::BUTTON_TEXT))
        .text_color(style::popup_text()))
    .on_mouse_down_out(cx.listener(|me, _, _, cx| me.close_context_menu(cx)));
    let (mut pending_sep, mut any) = (false, false);
    for (i, it) in items.into_iter().enumerate() {
        match it {
            Item::Sep => pending_sep = any,
            Item::Row(label, k, act, checked) => {
                // `<hr>`: the UA's 8px margins, a 1px `$color-gray-5` top border
                if pending_sep {
                    menu = menu.child(div().my(px(8.)).h(px(1.)).bg(style::hex(style::GRAY_5)));
                    pending_sep = false;
                }
                any = true;
                let danger = act == BoardAction::Delete;
                let group = SharedString::from(format!("board-cm-{i}"));
                let hover_text = style::popup_bg();
                menu = menu.child(
                    div()
                        .id(("board-cm", i))
                        .group(group.clone())
                        .relative()
                        .w_full()
                        .flex()
                        .items_center()
                        .pl(px(20.))
                        .pr(px(16.))
                        .py(px(4.))
                        .whitespace_nowrap()
                        .cursor_default()
                        .hover(move |s| {
                            s.bg(if danger {
                                crate::theme::palette(|p| p.danger)
                            } else {
                                style::select_highlight()
                            })
                            .text_color(hover_text)
                        })
                        .when(checked, |d| {
                            d.child(div().absolute().left(px(6.)).child("✓"))
                        })
                        .child(
                            div()
                                .flex_1()
                                .mr(px(20.))
                                .when(danger, |d| {
                                    d.text_color(crate::theme::palette(|p| p.danger))
                                })
                                .group_hover(group.clone(), |s| s.text_color(hover_text))
                                .child(label),
                        )
                        .when_some(k, |d, k| {
                            d.child(
                                div()
                                    .flex_none()
                                    .text_size(px(11.2))
                                    .line_height(style::lh(11.2))
                                    .opacity(0.6)
                                    .child(k),
                            )
                        })
                        .on_click(cx.listener(move |me, _, window, cx| {
                            me.close_context_menu(cx);
                            me.run(act.clone(), window, cx)
                        })),
                );
            }
        }
    }
    Some(
        deferred(
            anchored()
                .position(pos)
                .snap_to_window_with_margin(px(8.))
                .child(menu),
        )
        .with_priority(4)
        .into_any_element(),
    )
}
