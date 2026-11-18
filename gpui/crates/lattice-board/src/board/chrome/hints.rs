// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The hint line under the tool bar, after Excalidraw `HintViewer.tsx` /
//! `HintViewer.scss` @ 3a317b5: `getHints` for the states we have, the
//! text centered in 12px `--color-gray-40` (dark: 60) with each shortcut in a
//! bordered monospace `<kbd>`. Strings are upstream's `hints.*` (en /
//! zh-CN). Differs: no search, sidebar, alt-cycle-selection, embed or
//! draw-to-shape hints.

use super::*;
use crate::board::action::Tool;
use crate::board::canvas::Gesture;
use crate::board::handles::HandleType;
use crate::settings::tr;

/// One hint: upstream's template ("{{shortcut}} …") and its shortcuts.
struct Hint(&'static str, Vec<String>);

fn k(s: &str) -> String {
    shortcut(s)
}
/// `getTaggedShortcutKey([…])`: a combination in one key cap, joined with " + ".
fn kk(keys: &[&str]) -> String {
    keys.iter()
        .map(|s| shortcut(s))
        .collect::<Vec<_>>()
        .join(" + ")
}

fn hints(me: &BoardView) -> Vec<Hint> {
    let a = me.app_state();
    let tool = me.tool();
    let sel = me.selected_elements();
    let one = |h: Hint| vec![h];
    if tool == Tool::Eraser {
        return one(Hint(
            tr(
                "按住{{shortcut}}反选被标记删除的元素",
                "Hold {{shortcut}} to revert the elements marked for deletion",
            ),
            vec![k("Alt")],
        ));
    }
    if me.linear.as_ref().is_some_and(|l| l.is_dragging)
        && sel.first().is_some_and(|e| e.is_arrow())
    {
        return one(Hint(
            tr(
                "按住{{shortcut_1}}取消绑定，或按住{{shortcut_2}}绑定到固定点",
                "Hold {{shortcut_1}} to disable binding, or {{shortcut_2}} to bind at a fixed point",
            ),
            vec![k("CtrlOrCmd"), k("Alt")],
        ));
    }
    if matches!(tool, Tool::Arrow | Tool::Line) {
        if me.multi.is_some() {
            return one(Hint(
                tr(
                    "点击最后的点或按{{shortcut_1}}或{{shortcut_2}}完成",
                    "Click on last point or press {{shortcut_1}} or {{shortcut_2}} to finish",
                ),
                vec![k("Esc"), k("Enter")],
            ));
        }
        if tool == Tool::Arrow {
            return one(Hint(
                tr(
                    "点击创建多个点，拖动创建直线。按 {{shortcut}} 切换箭头类型。",
                    "Click to start multiple points, drag for single line. Press {{shortcut}} again to change arrow type.",
                ),
                vec!["A".into()],
            ));
        }
        return one(Hint(
            tr(
                "点击创建多个点 拖动创建直线",
                "Click to start multiple points, drag for single line",
            ),
            vec![],
        ));
    }
    match tool {
        Tool::FreeDraw => {
            return one(Hint(
                tr(
                    "点击并拖动，完成时松开",
                    "Click and drag, release when you're finished",
                ),
                vec![],
            ));
        }
        Tool::Text => {
            return one(Hint(
                tr(
                    "提示：您也可以使用选择工具双击任意位置来添加文字",
                    "Tip: you can also add text by double-clicking anywhere with the selection tool",
                ),
                vec![],
            ));
        }
        Tool::StickyNote => {
            return one(Hint(
                tr(
                    "点击放置便签，或拖动调整大小",
                    "Click to place a note, or drag to size it",
                ),
                vec![],
            ));
        }
        _ => {}
    }
    let resize = match &me.gesture {
        Some(Gesture::Select(s)) => s.resize.as_ref().filter(|r| r.started).map(|r| r.handle),
        _ => None,
    };
    if let (Some(h), [e]) = (resize, sel.as_slice())
        && h != HandleType::Rotation
    {
        if e.is_linear() && e.linear().is_some_and(|l| l.points.len() == 2) {
            return one(Hint(
                tr(
                    "可以按住{{shortcut}}来约束角度",
                    "You can constrain angle by holding {{shortcut}}",
                ),
                vec![k("Shift")],
            ));
        }
        let corner = matches!(
            h,
            HandleType::Nw | HandleType::Ne | HandleType::Sw | HandleType::Se
        );
        if e.is_sticky_note() && corner {
            return one(Hint(
                tr(
                    "按住{{shortcut_1}}可以自由缩放，按住{{shortcut_2}}可以从中间缩放",
                    "hold {{shortcut_1}} to resize freely, {{shortcut_2}} to resize from the center",
                ),
                vec![k("Shift"), k("Alt")],
            ));
        }
        return one(if e.is_image() {
            Hint(
                tr(
                    "按住{{shortcut_1}}可以自由缩放， 按住{{shortcut_2}}可以从中间缩放",
                    "You can resize freely by holding {{shortcut_1}}, hold {{shortcut_2}} to resize from the center",
                ),
                vec![k("Shift"), k("Alt")],
            )
        } else {
            Hint(
                tr(
                    "缩放时按住{{shortcut_1}}可以约束宽高比例， 按住{{shortcut_2}}可以从中间缩放",
                    "You can constrain proportions by holding {{shortcut_1}} while resizing, hold {{shortcut_2}} to resize from the center",
                ),
                vec![k("Shift"), k("Alt")],
            )
        });
    }
    if resize == Some(HandleType::Rotation) {
        return one(Hint(
            tr(
                "旋转时可以按住{{shortcut}}来约束角度",
                "You can constrain angles by holding {{shortcut}} while rotating",
            ),
            vec![k("Shift")],
        ));
    }
    if let [e] = sel.as_slice()
        && e.is_text()
        && me.text.is_none()
    {
        return one(Hint(
            tr(
                "双击或按{{shortcut}}编辑文本",
                "Double-click or press {{shortcut}} to edit text",
            ),
            vec![k("Enter")],
        ));
    }
    if me.text.is_some() {
        return one(Hint(
            tr(
                "按{{shortcut_1}}或{{shortcut_2}}完成编辑",
                "Press {{shortcut_1}} or {{shortcut_2}} to finish editing",
            ),
            vec![k("Esc"), kk(&["CtrlOrCmd", "Enter"])],
        ));
    }
    if a.cropping_element_id.is_some() {
        return one(Hint(
            tr(
                "点击图片以外的区域或按{{shortcut_1}}或{{shortcut_2}}完成裁剪",
                "Click outside the image or press {{shortcut_1}} or {{shortcut_2}} to finish cropping",
            ),
            vec![k("Enter"), k("Esc")],
        ));
    }
    if let [e] = sel.as_slice()
        && e.is_image()
    {
        return one(Hint(
            tr(
                "双击图片或按{{shortcut}}开始裁剪",
                "Double click the image or press {{shortcut}} to crop the image",
            ),
            vec![k("Enter")],
        ));
    }
    if tool != Tool::Selection {
        return vec![];
    }
    let editing_line = me.linear.as_ref().is_some_and(|l| l.is_editing);
    if let Some(Gesture::Select(s)) = &me.gesture {
        if s.rect.is_some() && sel.is_empty() && !editing_line {
            return one(Hint(
                tr(
                    "按住{{shortcut}}深度选择，并避免拖拽",
                    "Hold {{shortcut}} to deep select, and to prevent dragging",
                ),
                vec![k("CtrlOrCmd")],
            ));
        }
        if a.grid_mode_enabled && s.dragged {
            return one(Hint(
                tr(
                    "按住{{shortcut}}禁用吸附",
                    "Hold {{shortcut}} to disable snapping",
                ),
                vec![k("CtrlOrCmd")],
            ));
        }
    }
    if sel.is_empty() {
        return one(Hint(
            tr(
                "要移动画布，请按住{{shortcut_1}}或{{shortcut_2}}同时拖拽鼠标，或使用抓手工具。",
                "To move canvas, hold {{shortcut_1}} or {{shortcut_2}} while dragging, or use the hand tool",
            ),
            vec![tr("鼠标滚轮", "Scroll wheel").into(), k("Space")],
        ));
    }
    let [e] = sel.as_slice() else { return vec![] };
    if e.is_linear() {
        let le = me.linear.as_ref().filter(|l| l.element_id == e.id);
        let n = e.linear().map(|l| l.points.len() as isize).unwrap_or(0);
        if e.is_arrow()
            && le.is_some_and(|l| l.hover_point_index == 0 || l.hover_point_index == n - 1)
        {
            return one(Hint(
                tr("双击切换箭头端点", "Double-click to toggle the arrowhead"),
                vec![],
            ));
        }
        if let Some(l) = le.filter(|l| l.is_editing) {
            return one(if l.selected_points_indices.is_some() {
                Hint(
                    tr(
                        "按{{shortcut_1}}移除点，按{{shortcut_2}}复制点，拖拽移动点",
                        "Press {{shortcut_1}} to remove point(s), {{shortcut_2}} to duplicate, or drag to move",
                    ),
                    vec![k("Delete"), kk(&["CtrlOrCmd", "D"])],
                )
            } else {
                Hint(
                    tr(
                        "选择要编辑的点 (按住{{shortcut_1}}选择多个)， 或按住{{shortcut_2}}并点击以添加新点",
                        "Select a point to edit (hold {{shortcut_1}} to select multiple), or hold {{shortcut_2}} and click to add new points",
                    ),
                    vec![k("Shift"), k("Alt")],
                )
            });
        }
        return one(if e.is_line() {
            Hint(
                tr(
                    "双击或按{{shortcut}}编辑点",
                    "Double-click or press {{shortcut}} to edit points",
                ),
                vec![k("Enter")],
            )
        } else {
            Hint(
                tr(
                    "按住{{shortcut_1}}双击，或者按{{shortcut_2}}编辑点",
                    "Hold {{shortcut_1}} and Double-click or press {{shortcut_2}} to edit points",
                ),
                vec![k("CtrlOrCmd"), kk(&["CtrlOrCmd", "Enter"])],
            )
        });
    }
    let dragging = matches!(&me.gesture, Some(Gesture::Select(s)) if s.dragged);
    if !dragging && me.gesture.is_none() && e.is_text_bindable_container(false) {
        let bind = Hint(
            tr("按{{shortcut}}添加文本", "{{shortcut}} to add text"),
            vec![k("Enter")],
        );
        if e.is_flowchart_node() {
            return vec![
                bind,
                Hint(
                    tr(
                        "按{{shortcut}}创建流程图",
                        "{{shortcut}} to create a flowchart",
                    ),
                    vec![kk(&["CtrlOrCmd", "↑↓"])],
                ),
            ];
        }
        return vec![bind];
    }
    vec![]
}

/// Text and `<kbd>` pieces, broken into words (CJK per character) so the
/// line wraps inside the tool bar's width.
enum Piece {
    Word(String, bool),
    Kbd(String, bool),
}

fn words(text: &str, space: &mut bool, out: &mut Vec<Piece>) {
    let mut buf = String::new();
    let flush = |buf: &mut String, space: &mut bool, out: &mut Vec<Piece>| {
        if !buf.is_empty() {
            out.push(Piece::Word(std::mem::take(buf), *space));
            *space = false;
        }
    };
    for ch in text.chars() {
        if ch == ' ' {
            flush(&mut buf, space, out);
            *space = true;
        } else if ch > '\u{2e7f}' {
            flush(&mut buf, space, out);
            out.push(Piece::Word(ch.to_string(), *space));
            *space = false;
        } else {
            buf.push(ch);
        }
    }
    flush(&mut buf, space, out);
}

fn pieces(hs: &[Hint]) -> Vec<Piece> {
    let mut out = vec![];
    let n = hs.len();
    let mut space = false;
    for (hi, Hint(t, keys)) in hs.iter().enumerate() {
        // several hints join with ", " without their final period
        let mut t = t.replace('\n', " ");
        if n > 1 {
            t = t.trim_end_matches(['.', '。']).to_string();
            if hi + 1 < n {
                t.push_str(", ");
            }
        }
        let mut rest = t.as_str();
        while let Some(i) = rest.find("{{") {
            words(&rest[..i], &mut space, &mut out);
            let j = rest[i..].find("}}").map_or(rest.len(), |j| i + j + 2);
            let key = keys
                .get(if rest[i..j].contains("_2") { 1 } else { 0 })
                .cloned()
                .unwrap_or_default();
            out.push(Piece::Kbd(key, space));
            space = false;
            rest = &rest[j..];
        }
        words(rest, &mut space, &mut out);
    }
    out
}

pub(crate) fn render(me: &BoardView) -> Option<Div> {
    let hs = hints(me);
    if hs.is_empty() {
        return None;
    }
    let color = style::hint_text();
    let mut line = div()
        .p(px(4.))
        .flex()
        .flex_wrap()
        .justify_center()
        .items_center()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color);
    for p in pieces(&hs) {
        line = line.child(match p {
            Piece::Word(w, sp) => div().when(sp, |d| d.ml(px(3.))).child(w),
            Piece::Kbd(k, sp) => div()
                .when(sp, |d| d.ml(px(3.)))
                .mx(px(1.))
                .px(px(3.))
                .py(px(1.))
                .border_1()
                .border_color(color)
                .rounded(px(4.))
                .font_family(crate::theme::MONO_FONT)
                .text_size(px(10.))
                .line_height(px(12.))
                .child(k),
        });
    }
    Some(
        div()
            .absolute()
            .top(relative(1.))
            .left_0()
            .right_0()
            .mt(px(8.))
            .flex()
            .justify_center()
            .child(line),
    )
}
