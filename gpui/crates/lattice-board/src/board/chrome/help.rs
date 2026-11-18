// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The help dialog and the clear-canvas confirmation, after Excalidraw
//! `HelpDialog.tsx`, `ConfirmDialog.tsx`, `Dialog.tsx` / `Modal.tsx` and their
//! SCSS @ 3a317b5: a modal (`--overlay-bg-color` scrim, 12px-radius island
//! with `--modal-shadow`, 40px padding) titled "Help" over "Keyboard
//! shortcuts" in three islands (tools, view, editor; two columns), each row
//! a label and its keys as `--color-primary-light` chips with "or" between.
//! Differs: no header links (docs, blog, GitHub, YouTube); only the
//! shortcuts the board has, plus 退出画板 (Esc).

use super::*;
use crate::board::action::{BoardAction, Tool};
use crate::settings::tr;

/// A row: the label and its alternatives, each a `+`-joined key list
/// (`getShortcutKey` already applied); `and` joins them without "or".
struct Row(&'static str, Vec<String>, bool);

fn r(label: &'static str, keys: &[&str]) -> Row {
    Row(label, keys.iter().map(|k| shortcut(k)).collect(), false)
}

fn tools() -> Vec<Row> {
    use super::toolbar::tool_label;
    let click = tr("单击", "click");
    let mut v: Vec<Row> = [
        (Tool::Hand, "H", None),
        (Tool::Selection, "V", Some("1")),
        (Tool::Rectangle, "R", Some("2")),
        (Tool::Diamond, "D", Some("3")),
        (Tool::Ellipse, "O", Some("4")),
        (Tool::Arrow, "A", Some("5")),
        (Tool::Line, "L", Some("6")),
        (Tool::FreeDraw, "P", Some("7")),
        (Tool::Text, "T", Some("8")),
        (Tool::Image, "9", None),
        (Tool::Eraser, "E", Some("0")),
        (Tool::Frame, "F", None),
    ]
    .into_iter()
    .map(|(t, k, n)| {
        Row(
            tool_label(t),
            std::iter::once(k.to_string())
                .chain(n.map(str::to_string))
                .collect(),
            false,
        )
    })
    .collect();
    v.extend([
        r(
            tr("编辑线条或箭头的点", "Edit line/arrow points"),
            &["CtrlOrCmd+Enter"],
        ),
        r(tr("添加或编辑文本", "Edit text / add label"), &["Enter"]),
        r(
            tr("添加新行(文本编辑器)", "Add new line (text editor)"),
            &["Enter", "Shift+Enter"],
        ),
        r(
            tr("完成编辑 (文本编辑器)", "Finish editing (text editor)"),
            &["Esc", "CtrlOrCmd+Enter"],
        ),
        Row(
            tr("曲线箭头", "Curved arrow"),
            vec!["A".into(), click.into(), click.into(), click.into()],
            true,
        ),
        Row(
            tr("曲线", "Curved line"),
            vec!["L".into(), click.into(), click.into(), click.into()],
            true,
        ),
        Row(
            tr("裁剪图片", "Crop image"),
            vec![tr("双击", "double-click").into(), shortcut("Enter")],
            false,
        ),
        r(
            tr("完成图片裁剪", "Finish image cropping"),
            &["Enter", "Esc"],
        ),
        r(
            tr(
                "绘制后保持所选的工具栏状态",
                "Keep selected tool active after drawing",
            ),
            &["Q"],
        ),
        r(tr("禁用箭头吸附", "Prevent arrow binding"), &["CtrlOrCmd"]),
    ]);
    v
}

fn view() -> Vec<Row> {
    vec![
        r(tr("放大", "Zoom in"), &["CtrlOrCmd++"]),
        r(tr("缩小", "Zoom out"), &["CtrlOrCmd+-"]),
        r(tr("重置缩放", "Reset zoom"), &["CtrlOrCmd+0"]),
        r(
            tr("缩放以适应所有元素", "Zoom to fit all elements"),
            &["Shift+1"],
        ),
        r(tr("缩放到选区", "Zoom to selection"), &["Shift+2"]),
        r(tr("吸附至对象", "Snap to objects"), &["Alt+S"]),
        r(tr("切换网格显示", "Toggle grid"), &["CtrlOrCmd+'"]),
        r(tr("退出画板", "Exit board"), &["Esc"]),
    ]
}

fn editor() -> Vec<Row> {
    let (click, drag) = (tr("单击", "click"), tr("拖动", "drag"));
    let with = |m: &str, s: &str| shortcut(&format!("{m}+{s}"));
    let mac = cfg!(target_os = "macos");
    vec![
        Row(
            tr(
                "从一个基本元素创建流程图",
                "Create a flowchart from a generic element",
            ),
            vec![shortcut("CtrlOrCmd+Arrow Key")],
            false,
        ),
        Row(
            tr("在流程图元素间移动", "Navigate a flowchart"),
            vec![shortcut("Alt+Arrow Key")],
            false,
        ),
        Row(
            tr("移动画布", "Move canvas"),
            vec![with("Space", drag), with("Wheel", drag)],
            false,
        ),
        r(tr("重置画布", "Reset the canvas"), &["CtrlOrCmd+Delete"]),
        r(tr("在画布上查找", "Find on canvas"), &["CtrlOrCmd+F"]),
        r(tr("导出图片", "Export image"), &["CtrlOrCmd+Shift+E"]),
        r(tr("删除", "Delete"), &["Delete"]),
        r(tr("剪切", "Cut"), &["CtrlOrCmd+X"]),
        r(tr("拷贝", "Copy"), &["CtrlOrCmd+C"]),
        r(tr("粘贴", "Paste"), &["CtrlOrCmd+V"]),
        r(
            tr("粘贴为纯文本", "Paste as plaintext"),
            &["CtrlOrCmd+Shift+V"],
        ),
        r(tr("全部选中", "Select all"), &["CtrlOrCmd+A"]),
        Row(
            tr("添加元素到选区", "Add element to selection"),
            vec![with("Shift", click)],
            false,
        ),
        Row(
            tr("深度选择", "Deep select"),
            vec![with("CtrlOrCmd", click)],
            false,
        ),
        Row(
            tr(
                "在方框内深度选择并避免拖拽",
                "Deep select within box, and prevent dragging",
            ),
            vec![with("CtrlOrCmd", drag)],
            false,
        ),
        r(tr("拷贝样式", "Copy styles"), &["CtrlOrCmd+Alt+C"]),
        r(tr("粘贴样式", "Paste styles"), &["CtrlOrCmd+Alt+V"]),
        r(
            tr("置于底层", "Send to back"),
            &[if mac {
                "CtrlOrCmd+Alt+["
            } else {
                "CtrlOrCmd+Shift+["
            }],
        ),
        r(
            tr("置于顶层", "Bring to front"),
            &[if mac {
                "CtrlOrCmd+Alt+]"
            } else {
                "CtrlOrCmd+Shift+]"
            }],
        ),
        r(tr("下移一层", "Send backward"), &["CtrlOrCmd+["]),
        r(tr("上移一层", "Bring forward"), &["CtrlOrCmd+]"]),
        r(tr("顶部对齐", "Align top"), &["CtrlOrCmd+Shift+Up"]),
        r(tr("底端对齐", "Align bottom"), &["CtrlOrCmd+Shift+Down"]),
        r(tr("左对齐", "Align left"), &["CtrlOrCmd+Shift+Left"]),
        r(tr("右对齐", "Align right"), &["CtrlOrCmd+Shift+Right"]),
        Row(
            tr("创建副本", "Duplicate"),
            vec![shortcut("CtrlOrCmd+D"), with("Alt", drag)],
            false,
        ),
        r(
            tr("锁定/解锁", "Lock/unlock selection"),
            &["CtrlOrCmd+Shift+L"],
        ),
        r(tr("撤销", "Undo"), &["CtrlOrCmd+Z"]),
        r(
            tr("重做", "Redo"),
            if mac {
                &["CtrlOrCmd+Shift+Z"]
            } else {
                &["CtrlOrCmd+Y", "CtrlOrCmd+Shift+Z"]
            },
        ),
        r(tr("编组", "Group selection"), &["CtrlOrCmd+G"]),
        r(tr("解除编组", "Ungroup selection"), &["CtrlOrCmd+Shift+G"]),
        r(tr("水平翻转", "Flip horizontal"), &["Shift+H"]),
        r(tr("垂直翻转", "Flip vertical"), &["Shift+V"]),
        r(
            tr("缩小字体大小", "Decrease font size"),
            &["CtrlOrCmd+Shift+<"],
        ),
        r(
            tr("放大字体大小", "Increase font size"),
            &["CtrlOrCmd+Shift+>"],
        ),
    ]
}

/// `HelpDialog__key`: 10px, `--color-primary-light`, radius 6, padding 8.
fn key(k: &str) -> Div {
    let k = if k.chars().count() == 1 {
        k.to_uppercase()
    } else {
        k.to_string()
    };
    div()
        .flex_none()
        .p(px(8.))
        .rounded(px(style::RADIUS_MD))
        .bg(style::primary_light())
        .text_size(px(10.))
        .line_height(px(10.))
        .whitespace_nowrap()
        .child(k)
}

/// `ShortcutIsland`: the 16px bold caption 10 above the bordered rows.
fn island_rows(caption: &'static str, rows: Vec<Row>) -> Div {
    let mut list = div()
        .flex()
        .flex_col()
        .rounded(px(style::RADIUS_LG))
        .border_1()
        .border_color(style::dialog_border());
    let n = rows.len();
    for (i, Row(label, alts, and)) in rows.into_iter().enumerate() {
        let mut keys = div().flex_none().flex().items_center().gap(px(4.));
        for (j, alt) in alts.iter().enumerate() {
            if j > 0 && !and {
                keys = keys.child(div().child(tr("或", "or")));
            }
            // `split("+")`, keeping a trailing "+" key ("Cmd++")
            let parts: Vec<String> = if let Some(s) = alt.strip_suffix("++") {
                s.split('+')
                    .map(str::to_string)
                    .chain(std::iter::once("+".to_string()))
                    .collect()
            } else {
                alt.split('+').map(str::to_string).collect()
            };
            for p in parts {
                keys = keys.child(key(&p));
            }
        }
        list = list.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .text_size(px(14.))
                .line_height(style::lh(14.))
                .when(i + 1 < n, |d| {
                    d.border_b_1().border_color(style::dialog_border())
                })
                .child(div().child(label))
                .child(keys),
        );
    }
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .mb(px(10.))
                .text_size(px(16.))
                .line_height(style::lh(16.))
                .font_weight(FontWeight::BOLD)
                .child(caption),
        )
        .child(list)
}

/// `Modal` + `Dialog`: the scrim, and the island (`max_w`) with its title.
pub(crate) fn modal(
    id: &'static str,
    max_w: f32,
    title: &'static str,
    body: impl IntoElement,
    on_close: impl Fn(&mut BoardView, &mut Context<BoardView>) + Clone + 'static,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> impl IntoElement {
    let _ = window;
    let close = on_close.clone();
    // the scrim covers the board (upstream: the Excalidraw container)
    let dialog = div()
        .id(id)
        .occlude()
        .w_full()
        .max_w(px(max_w))
        .max_h(relative(1.))
        .overflow_y_scroll()
        .bg(style::island_bg())
        .border_1()
        .border_color(style::dialog_border())
        .shadow(style::shadow_modal())
        .rounded(px(12.))
        .p(px(40.))
        .text_color(style::text())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_scroll(|_, _, cx| cx.stop_propagation())
        .child(
            div()
                .pb(px(12.))
                .mb(px(24.))
                .border_b_1()
                .border_color(style::dialog_border())
                .text_size(px(20.))
                .line_height(style::lh(20.))
                .font_weight(FontWeight::BOLD)
                .child(title),
        )
        .child(body);
    deferred(
        div()
            .id((id, 1usize))
            .occlude()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .p(px(40.))
            .bg(style::overlay_bg())
            .flex()
            .items_center()
            .justify_center()
            .font_family(style::ui_font())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |me, _, _, cx| close(me, cx)),
            )
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(dialog),
    )
    .with_priority(5)
}

pub(crate) fn render(window: &mut Window, cx: &mut Context<BoardView>) -> impl IntoElement {
    let wide = window.viewport_size().width >= px(1024.);
    let islands = if wide {
        div()
            .flex()
            .items_start()
            .gap(px(24.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(32.))
                    .child(island_rows(tr("工具", "Tools"), tools()))
                    .child(island_rows(tr("视图", "View"), view())),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(island_rows(tr("编辑器", "Editor"), editor())),
            )
    } else {
        div()
            .flex()
            .flex_col()
            .gap(px(32.))
            .child(island_rows(tr("工具", "Tools"), tools()))
            .child(island_rows(tr("视图", "View"), view()))
            .child(island_rows(tr("编辑器", "Editor"), editor()))
    };
    let body = div()
        .flex()
        .flex_col()
        .child(
            div()
                .mt(px(24.))
                .mb(px(24.))
                .text_size(px(18.))
                .line_height(style::lh(18.))
                .font_weight(FontWeight::BOLD)
                .child(tr("快捷键列表", "Keyboard shortcuts")),
        )
        .child(islands);
    modal(
        "board-help-dialog",
        960.,
        tr("帮助", "Help"),
        body,
        |me, cx| me.set_help_open(false, cx),
        window,
        cx,
    )
}

/// `ConfirmDialog` for `actionClearCanvas` ("small", 550): the text, then
/// Cancel and Confirm (the latter `danger`-filled).
pub(crate) fn clear_canvas(window: &mut Window, cx: &mut Context<BoardView>) -> impl IntoElement {
    let button = |id: &'static str, label: &'static str, danger: bool| {
        div()
            .id(id)
            .h(px(40.))
            .px(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(style::RADIUS_LG))
            .cursor_pointer()
            .text_size(px(14.))
            .font_weight(FontWeight::SEMIBOLD)
            .when(danger, |d| {
                d.bg(style::hex(0xdb6965))
                    .text_color(style::hex(0xffffff))
                    .hover(|s| s.bg(style::hex(0xd65550)))
                    .active(|s| s.bg(style::hex(0xd1413c)))
            })
            .when(!danger, |d| {
                d.border_1()
                    .border_color(style::border())
                    .hover(|s| s.bg(style::button_hover_bg()))
            })
            .child(label)
    };
    let body = div()
        .flex()
        .flex_col()
        .gap(px(24.))
        .text_size(px(16.))
        .line_height(style::lh(16.))
        .child(div().child(tr(
            "这将会清除整个画布。您是否要继续?",
            "This will clear the whole canvas. Are you sure?",
        )))
        .child(
            div()
                .flex()
                .justify_end()
                .gap(px(12.))
                .child(
                    button("board-clear-cancel", tr("取消", "Cancel"), false)
                        .on_click(cx.listener(|_, _, _, cx| set_pop(None, cx))),
                )
                .child(
                    button("board-clear-confirm", tr("确定", "Confirm"), true).on_click(
                        cx.listener(|me, _, window, cx| {
                            set_pop(None, cx);
                            me.run(BoardAction::ClearCanvas, window, cx)
                        }),
                    ),
                ),
        );
    modal(
        "board-clear-dialog",
        550.,
        tr("清除画布", "Clear canvas"),
        body,
        |_, cx| set_pop(None, cx),
        window,
        cx,
    )
}
