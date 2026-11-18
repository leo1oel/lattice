// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The board's keyboard, after Excalidraw `actions/shortcuts.ts`, the
//! actions' `keyTest`s (`actions/manager.tsx` runs them) and `App.tsx`'s
//! `onKeyDown` (tool keys, Q, arrows, Enter, Escape) @ 3a317b5. Bindings
//! live in the `Board` context, outside text fields, so they win over the
//! document's while the board is open; window-level keys (⌘W, ⌘Q) aren't
//! bound here and still work. Tool letters and digits come as key-down
//! events (any binding would shadow typing elsewhere).

use super::BoardView;
use super::Hooks;
use super::action::{BoardAction, End, Layer, Tool};
use super::align::{Axis, Position};
use super::app_state::ToolType;
use super::consts::{ELEMENT_SHIFT_TRANSLATE_AMOUNT, ELEMENT_TRANSLATE_AMOUNT};
use super::history::CaptureUpdateAction;
use super::selection::{SelectedOpts, get_selected_elements};
use gpui::*;

actions!(
    board,
    [
        Escape,
        Enter,
        Undo,
        Redo,
        SelectAll,
        Delete,
        Duplicate,
        Copy,
        Cut,
        Paste,
        PastePlain,
        CopyStyles,
        PasteStyles,
        Group,
        Ungroup,
        BringForward,
        SendBackward,
        BringToFront,
        SendToBack,
        FlipH,
        FlipV,
        ToggleLock,
        ToggleGrid,
        ToggleSnap,
        ZoomIn,
        ZoomOut,
        ResetZoom,
        ZoomToFit,
        ZoomToSelection,
        Help,
        FindOnCanvas,
        ExportImage,
        AlignTop,
        AlignBottom,
        AlignLeft,
        AlignRight,
        FontBigger,
        FontSmaller,
        SubmitText,
        NudgeLeft,
        NudgeRight,
        NudgeUp,
        NudgeDown,
        NudgeLeftBig,
        NudgeRightBig,
        NudgeUpBig,
        NudgeDownBig,
        FlowLeft,
        FlowRight,
        FlowUp,
        FlowDown,
        NavLeft,
        NavRight,
        NavUp,
        NavDown,
    ]
);

pub fn bind_keys(cx: &mut App) {
    let c = Some("Board && !BoardTextField");
    let m = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    let k = |s: &str| -> &'static str { Box::leak(s.replace("mod", m).into_boxed_str()) };
    cx.bind_keys([
        KeyBinding::new("escape", Escape, c),
        KeyBinding::new("enter", Enter, c),
        KeyBinding::new(k("mod-enter"), Enter, c),
        KeyBinding::new(k("mod-z"), Undo, c),
        KeyBinding::new(k("mod-shift-z"), Redo, c),
        KeyBinding::new(k("mod-y"), Redo, c),
        KeyBinding::new(k("mod-a"), SelectAll, c),
        KeyBinding::new("backspace", Delete, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new(k("mod-d"), Duplicate, c),
        KeyBinding::new(k("mod-c"), Copy, c),
        KeyBinding::new(k("mod-x"), Cut, c),
        KeyBinding::new(k("mod-v"), Paste, c),
        KeyBinding::new(k("mod-shift-v"), PastePlain, c),
        KeyBinding::new(k("mod-alt-c"), CopyStyles, c),
        KeyBinding::new(k("mod-alt-v"), PasteStyles, c),
        KeyBinding::new(k("mod-g"), Group, c),
        KeyBinding::new(k("mod-shift-g"), Ungroup, c),
        KeyBinding::new(k("mod-]"), BringForward, c),
        KeyBinding::new(k("mod-["), SendBackward, c),
        KeyBinding::new(
            k(if cfg!(target_os = "macos") {
                "mod-alt-]"
            } else {
                "mod-shift-]"
            }),
            BringToFront,
            c,
        ),
        KeyBinding::new(
            k(if cfg!(target_os = "macos") {
                "mod-alt-["
            } else {
                "mod-shift-["
            }),
            SendToBack,
            c,
        ),
        KeyBinding::new("shift-h", FlipH, c),
        KeyBinding::new("shift-v", FlipV, c),
        KeyBinding::new(k("mod-shift-l"), ToggleLock, c),
        KeyBinding::new(k("mod-'"), ToggleGrid, c),
        KeyBinding::new("alt-s", ToggleSnap, c),
        KeyBinding::new(k("mod-="), ZoomIn, c),
        KeyBinding::new(k("mod-+"), ZoomIn, c),
        KeyBinding::new("shift-=", ZoomIn, c),
        KeyBinding::new(k("mod--"), ZoomOut, c),
        KeyBinding::new("shift--", ZoomOut, c),
        KeyBinding::new(k("mod-0"), ResetZoom, c),
        KeyBinding::new("shift-0", ResetZoom, c),
        KeyBinding::new("shift-1", ZoomToFit, c),
        KeyBinding::new("shift-!", ZoomToFit, c),
        KeyBinding::new("shift-2", ZoomToSelection, c),
        KeyBinding::new("shift-@", ZoomToSelection, c),
        KeyBinding::new("shift-?", Help, c),
        KeyBinding::new("?", Help, c),
        KeyBinding::new(k("mod-f"), FindOnCanvas, c),
        KeyBinding::new(k("mod-shift-e"), ExportImage, c),
        KeyBinding::new(k("mod-shift-up"), AlignTop, c),
        KeyBinding::new(k("mod-shift-down"), AlignBottom, c),
        KeyBinding::new(k("mod-shift-left"), AlignLeft, c),
        KeyBinding::new(k("mod-shift-right"), AlignRight, c),
        KeyBinding::new(k("mod-shift-."), FontBigger, c),
        KeyBinding::new(k("mod-shift->"), FontBigger, c),
        KeyBinding::new(k("mod-shift-,"), FontSmaller, c),
        KeyBinding::new(k("mod-shift-<"), FontSmaller, c),
        KeyBinding::new("left", NudgeLeft, c),
        KeyBinding::new("right", NudgeRight, c),
        KeyBinding::new("up", NudgeUp, c),
        KeyBinding::new("down", NudgeDown, c),
        KeyBinding::new("shift-left", NudgeLeftBig, c),
        KeyBinding::new("shift-right", NudgeRightBig, c),
        KeyBinding::new("shift-up", NudgeUpBig, c),
        KeyBinding::new("shift-down", NudgeDownBig, c),
        KeyBinding::new(k("mod-left"), FlowLeft, c),
        KeyBinding::new(k("mod-right"), FlowRight, c),
        KeyBinding::new(k("mod-up"), FlowUp, c),
        KeyBinding::new(k("mod-down"), FlowDown, c),
        KeyBinding::new("alt-left", NavLeft, c),
        KeyBinding::new("alt-right", NavRight, c),
        KeyBinding::new("alt-up", NavUp, c),
        KeyBinding::new("alt-down", NavDown, c),
        // in the text editor
        KeyBinding::new(k("mod-enter"), SubmitText, Some("BoardText")),
    ]);
}

macro_rules! on {
    ($d:expr, $cx:expr, $($a:ident => $b:expr),* $(,)?) => {
        $d$(.on_action($cx.listener(|me, _: &$a, window, cx| { let f: fn(&mut BoardView, &mut Window, &mut Context<BoardView>) = $b; f(me, window, cx) })))*
    };
}

fn run(a: BoardAction) -> impl Fn(&mut BoardView, &mut Window, &mut Context<BoardView>) {
    move |me, window, cx| me.run(a.clone(), window, cx)
}

pub fn listeners(d: Stateful<Div>, cx: &mut Context<BoardView>) -> Stateful<Div> {
    let d = on!(d, cx,
        Escape => escape,
        Enter => enter,
        SubmitText => |me, window, cx| super::text_editor::submit(me, true, window, cx),
        NudgeLeft => |me, w, cx| nudge(me, [-1., 0.], false, w, cx),
        NudgeRight => |me, w, cx| nudge(me, [1., 0.], false, w, cx),
        NudgeUp => |me, w, cx| nudge(me, [0., -1.], false, w, cx),
        NudgeDown => |me, w, cx| nudge(me, [0., 1.], false, w, cx),
        NudgeLeftBig => |me, w, cx| nudge(me, [-1., 0.], true, w, cx),
        NudgeRightBig => |me, w, cx| nudge(me, [1., 0.], true, w, cx),
        NudgeUpBig => |me, w, cx| nudge(me, [0., -1.], true, w, cx),
        NudgeDownBig => |me, w, cx| nudge(me, [0., 1.], true, w, cx),
        FlowLeft => |me, _, cx| super::tools::flowchart::create(me, super::flowchart::LinkDirection::Left, cx),
        FlowRight => |me, _, cx| super::tools::flowchart::create(me, super::flowchart::LinkDirection::Right, cx),
        FlowUp => |me, _, cx| super::tools::flowchart::create(me, super::flowchart::LinkDirection::Up, cx),
        FlowDown => |me, _, cx| super::tools::flowchart::create(me, super::flowchart::LinkDirection::Down, cx),
        NavLeft => |me, _, cx| super::tools::flowchart::navigate(me, super::flowchart::LinkDirection::Left, cx),
        NavRight => |me, _, cx| super::tools::flowchart::navigate(me, super::flowchart::LinkDirection::Right, cx),
        NavUp => |me, _, cx| super::tools::flowchart::navigate(me, super::flowchart::LinkDirection::Up, cx),
        NavDown => |me, _, cx| super::tools::flowchart::navigate(me, super::flowchart::LinkDirection::Down, cx),
    );
    let d = d
        .on_action(cx.listener(|me, _: &Undo, w, cx| run(BoardAction::Undo)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Redo, w, cx| run(BoardAction::Redo)(me, w, cx)))
        .on_action(cx.listener(|me, _: &SelectAll, w, cx| run(BoardAction::SelectAll)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Delete, w, cx| delete(me, w, cx)))
        .on_action(cx.listener(|me, _: &Duplicate, w, cx| run(BoardAction::Duplicate)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Copy, w, cx| run(BoardAction::Copy)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Cut, w, cx| run(BoardAction::Cut)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Paste, w, cx| run(BoardAction::Paste)(me, w, cx)))
        .on_action(cx.listener(|me, _: &PastePlain, w, cx| super::run::paste(me, true, w, cx)))
        .on_action(cx.listener(|me, _: &CopyStyles, w, cx| run(BoardAction::CopyStyles)(me, w, cx)))
        .on_action(
            cx.listener(|me, _: &PasteStyles, w, cx| run(BoardAction::PasteStyles)(me, w, cx)),
        )
        .on_action(cx.listener(|me, _: &Group, w, cx| run(BoardAction::Group)(me, w, cx)))
        .on_action(cx.listener(|me, _: &Ungroup, w, cx| run(BoardAction::Ungroup)(me, w, cx)))
        .on_action(cx.listener(|me, _: &BringForward, w, cx| {
            run(BoardAction::Layer(Layer::Forward))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &SendBackward, w, cx| {
            run(BoardAction::Layer(Layer::Backward))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &BringToFront, w, cx| {
            run(BoardAction::Layer(Layer::Front))(me, w, cx)
        }))
        .on_action(
            cx.listener(|me, _: &SendToBack, w, cx| {
                run(BoardAction::Layer(Layer::Back))(me, w, cx)
            }),
        )
        .on_action(cx.listener(|me, _: &FlipH, w, cx| run(BoardAction::FlipHorizontal)(me, w, cx)))
        .on_action(cx.listener(|me, _: &FlipV, w, cx| run(BoardAction::FlipVertical)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ToggleLock, w, cx| run(BoardAction::ToggleLock)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ToggleGrid, w, cx| run(BoardAction::ToggleGrid)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ToggleSnap, w, cx| run(BoardAction::ToggleSnap)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ZoomIn, w, cx| run(BoardAction::ZoomIn)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ZoomOut, w, cx| run(BoardAction::ZoomOut)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ResetZoom, w, cx| run(BoardAction::ResetZoom)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ZoomToFit, w, cx| run(BoardAction::ZoomToFit)(me, w, cx)))
        .on_action(cx.listener(|me, _: &ZoomToSelection, w, cx| {
            run(BoardAction::ZoomToSelection)(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &Help, w, cx| run(BoardAction::ShowHelp)(me, w, cx)))
        .on_action(
            cx.listener(|me, _: &FindOnCanvas, w, cx| run(BoardAction::FindOnCanvas)(me, w, cx)),
        )
        .on_action(
            cx.listener(|me, _: &ExportImage, w, cx| run(BoardAction::ExportImage)(me, w, cx)),
        )
        .on_action(cx.listener(|me, _: &AlignTop, w, cx| {
            run(BoardAction::Align(Axis::Y, Position::Start))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &AlignBottom, w, cx| {
            run(BoardAction::Align(Axis::Y, Position::End))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &AlignLeft, w, cx| {
            run(BoardAction::Align(Axis::X, Position::Start))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &AlignRight, w, cx| {
            run(BoardAction::Align(Axis::X, Position::End))(me, w, cx)
        }))
        .on_action(cx.listener(|me, _: &FontBigger, w, cx| super::run::font_step(me, true, w, cx)))
        .on_action(
            cx.listener(|me, _: &FontSmaller, w, cx| super::run::font_step(me, false, w, cx)),
        );
    let _ = End::Start;
    d.on_key_down(cx.listener(key_down))
}

/// Tool keys (`findShapeByKey`) and Q (tool lock), with no modifiers but
/// Shift for digits' symbols, on the board itself.
fn key_down(
    me: &mut BoardView,
    ev: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    if !me.focus.is_focused(window) || me.text.is_some() {
        return;
    }
    if super::chrome::color_picker::hotkey(me, ev, window, cx) {
        cx.stop_propagation();
        return;
    }
    let m = &ev.keystroke.modifiers;
    let key = ev.keystroke.key.as_str();
    let cmd = if cfg!(target_os = "macos") {
        m.platform
    } else {
        m.control
    };
    // `onKeyDown`: ⌘⌫ asks to reset the canvas; G / S open the background /
    // stroke picker and ⇧F the font list, for the selection or the tool
    if cmd && !m.alt && matches!(key, "backspace" | "delete") {
        super::chrome::set_pop(Some(super::chrome::Pop::ClearCanvas), cx);
        cx.stop_propagation();
        return;
    }
    if !cmd
        && !m.alt
        && !m.control
        && !ev.is_held
        && (matches!(key, "g" | "s") && !m.shift || key == "f" && m.shift)
    {
        use super::utils::has_background;
        let tool = me.app.active_tool.ty;
        let sel: Vec<_> = me.selected_elements().into_iter().cloned().collect();
        if tool == ToolType::Selection && sel.is_empty() {
            return;
        }
        let tool_ty = super::types::ElementType::parse(tool.as_str());
        let pop = match key {
            "g" if tool_ty.is_some_and(has_background)
                || sel.iter().any(|e| has_background(e.ty())) =>
            {
                Some(super::chrome::Pop::Background)
            }
            "s" => Some(super::chrome::Pop::Stroke),
            "f" if tool == ToolType::Text
                || sel
                    .iter()
                    .any(|e| e.is_text() || e.bound_text_id().is_some()) =>
            {
                Some(super::chrome::Pop::Font)
            }
            _ => None,
        };
        if let Some(p) = pop {
            super::chrome::set_pop(Some(p), cx);
            cx.stop_propagation();
        }
        return;
    }
    if m.platform || m.control || m.alt || m.shift || ev.is_held {
        return;
    }
    if key == "q" {
        me.run(BoardAction::ToggleToolLock, window, cx);
        cx.stop_propagation();
        return;
    }
    let tools = [
        Tool::Selection,
        Tool::Rectangle,
        Tool::Diamond,
        Tool::Ellipse,
        Tool::Arrow,
        Tool::Line,
        Tool::FreeDraw,
        Tool::Text,
        Tool::Image,
        Tool::Eraser,
        Tool::Hand,
        Tool::Frame,
    ];
    let hit = tools.into_iter().find(|t| {
        t.shortcut()
            .is_some_and(|(l, n)| l == key || n.is_some_and(|n| n.to_string() == key))
    });
    if let Some(t) = hit {
        // toggle tools go back when pressed again
        if t == Tool::Image {
            me.run(BoardAction::InsertImage, window, cx);
        } else if matches!(t, Tool::Hand | Tool::Eraser) && me.tool() == t {
            let back = me
                .app
                .active_tool
                .last_active_tool
                .map(super::tool_of)
                .unwrap_or(Tool::Selection);
            me.set_tool(back, window, cx);
        } else {
            me.set_tool(t, window, cx);
        }
        cx.stop_propagation();
    }
}

/// Escape: finish or cancel what's going on, then leave a group or the
/// selection, then the tool; with nothing left, close the board.
fn escape(me: &mut BoardView, window: &mut Window, cx: &mut Context<BoardView>) {
    if super::tools::flowchart::cancel(me, cx) {
        return;
    }
    if super::tools::crop::finish(me, cx) {
        return;
    }
    if me.menu.is_some() {
        me.menu = None;
        cx.notify();
        return;
    }
    if super::chrome::pop(cx).is_some() {
        super::chrome::set_pop(None, cx);
        return;
    }
    if me.help {
        me.help = false;
        cx.notify();
        return;
    }
    if me.gesture.is_some() {
        return;
    }
    if me.multi.is_some() {
        super::tools::linear::finalize(me, cx);
        return;
    }
    if me.linear.as_ref().is_some_and(|l| l.is_editing) {
        // `actionFinalize`
        let m = me.m.clone();
        let hooks = Hooks(&*m);
        let le = me.linear.clone().unwrap();
        let ctx = crate::board::lctx(&me.app, &hooks, false);
        let (_, next) = super::linear::finalize_element(
            &le.element_id,
            Some(&le),
            &Default::default(),
            &mut me.scene,
            &ctx,
        );
        me.set_linear(next.map(|l| super::linear::LinearElementEditor {
            is_editing: false,
            ..l
        }));
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
        return;
    }
    let tool = me.app.active_tool.ty;
    if !me.app.selected_element_ids.is_empty()
        || me.app.editing_group_id.is_some()
        || tool != ToolType::Selection
    {
        me.run(BoardAction::Deselect, window, cx);
        return;
    }
    // nothing left to cancel: the app's Escape
    cx.propagate();
}

/// Enter: edit the selected text or label, open the line editor (⌘ for
/// arrows), rename a frame.
fn enter(me: &mut BoardView, window: &mut Window, cx: &mut Context<BoardView>) {
    if me.multi.is_some() {
        super::tools::linear::finalize(me, cx);
        return;
    }
    if super::tools::crop::finish(me, cx) {
        return;
    }
    let sel: Vec<_> = me.selected_elements().into_iter().cloned().collect();
    let [e] = sel.as_slice() else { return };
    if e.is_image() {
        super::tools::crop::start(me, &e.id, cx);
        return;
    }
    let mods = window.modifiers();
    let cmd = if cfg!(target_os = "macos") {
        mods.platform
    } else {
        mods.control
    };
    if cmd || e.is_line() {
        if e.is_linear()
            && !me
                .linear
                .as_ref()
                .is_some_and(|l| l.is_editing && l.element_id == e.id)
            && !e.is_elbow_arrow()
        {
            me.store.schedule_capture();
            me.run(BoardAction::ToggleLinearEditor, window, cx);
        }
    } else if e.is_text() || super::text::is_valid_text_container(e.ty()) {
        let c = super::text::get_container_center(e, &me.scene);
        let container = (!e.is_text()).then(|| e.id.clone());
        super::tools::text::start_editing(me, c, container, true, None, window, cx);
    } else if e.is_frame_like() {
        super::frame_name::begin(me, &e.id, window, cx);
    }
}

/// Delete / Backspace: the selected points while editing a line, else the
/// selection.
fn delete(me: &mut BoardView, window: &mut Window, cx: &mut Context<BoardView>) {
    if let Some(le) = me.linear.clone().filter(|l| l.is_editing)
        && let Some(sel) = le.selected_points_indices.clone().filter(|s| !s.is_empty())
    {
        {
            let m = me.m.clone();
            let hooks = Hooks(&*m);
            super::linear::delete_points(&mut me.scene, &le.element_id, &sel, Some(&le), &hooks);
            let gone = me
                .scene
                .get_element(&le.element_id)
                .is_none_or(|e| e.is_deleted || e.points().is_none_or(|p| p.len() < 2));
            if gone {
                me.scene
                    .mutate_element(&le.element_id, true, |e| e.is_deleted = true);
                me.clear_selection();
                me.set_linear(None);
            } else {
                me.set_linear(Some(super::linear::LinearElementEditor {
                    selected_points_indices: None,
                    ..le
                }));
            }
            me.commit(Some(CaptureUpdateAction::Immediately), cx);
            return;
        }
    }
    me.run(BoardAction::Delete, window, cx);
}

/// Arrow keys: move the selection one pixel (Shift: 5), or a grid step.
fn nudge(
    me: &mut BoardView,
    dir: [f64; 2],
    big: bool,
    _: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let grid = me.app.grid_mode_enabled.then_some(me.app.grid_size);
    let step = match grid {
        Some(g) => {
            if big {
                ELEMENT_TRANSLATE_AMOUNT
            } else {
                g
            }
        }
        None => {
            if big {
                ELEMENT_SHIFT_TRANSLATE_AMOUNT
            } else {
                ELEMENT_TRANSLATE_AMOUNT
            }
        }
    };
    let (dx, dy) = (dir[0] * step, dir[1] * step);
    let els = me.scene.elements_including_deleted().to_vec();
    let sel: Vec<_> = get_selected_elements(
        &els,
        &me.app.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    );
    if sel.is_empty() {
        return;
    }
    let ids: rustc_hash::FxHashSet<String> = sel.iter().map(|e| e.id.clone()).collect();
    let frame_arrows = super::binding::get_frame_arrow_ids_to_reattach(&sel);
    let moved: Vec<String> = sel
        .iter()
        .filter(|e| {
            !e.is_binding_element(false)
                || frame_arrows.contains(&e.id)
                || !super::binding::is_bound_to_element_not_in(e, &ids)
        })
        .map(|e| e.id.clone())
        .collect();
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let simul: rustc_hash::FxHashSet<String> = moved.iter().cloned().collect();
    for id in &moved {
        if frame_arrows.contains(id) {
            continue;
        }
        me.scene.mutate_element(id, true, |e| {
            e.x += dx;
            e.y += dy;
        });
        super::binding::update_bound_elements(
            id,
            &mut me.scene,
            &super::binding::UpdateBoundOpts {
                simultaneously_updated: Some(&simul),
                changed_elements: &[],
            },
            &hooks,
        );
    }
    super::binding::move_frame_arrows(&frame_arrows, [dx, dy], &mut me.scene, None, &hooks);
    super::frame::remove_arrows_without_end_in_frame(&moved, &mut me.scene);
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}
