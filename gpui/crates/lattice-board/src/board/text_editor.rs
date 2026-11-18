// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The wysiwyg text editor, after Excalidraw `wysiwyg/textWysiwyg.tsx` and
//! `App.text.ts`'s `handleTextWysiwyg` @ 3a317b5: our `TextField` (IME,
//! selection, caret) laid over the text where core's `TextEditSession`
//! places it, at the zoomed font size; every change re-lays the element
//! out (containers grow, labels re-center) and arrows bound to it follow.
//! Tab / ⇧Tab indent / outdent the selected lines. Escape, ⌘Enter or a
//! click elsewhere submits; empty text is deleted.
//! GPUI can't rotate the field: a rotated text is edited upright.

use super::BoardView;
use super::Hooks;
use super::app_state::ToolType;
use super::binding::{UpdateBoundOpts, fix_bindings_after_deletion, update_bound_elements};
use super::history::CaptureUpdateAction;
use super::text_edit::{
    EditView, EditorLayout, TextEditSession, caret_index_at, get_max_text_width, indent, outdent,
};
use super::types::TextAlign;
use crate::text_field::{TextField, TextFieldEvent};
use gpui::*;

pub struct TextEditing {
    pub session: TextEditSession,
    pub field: Entity<TextField>,
    _sub: Subscription,
    pub layout: Option<EditorLayout>,
    /// The view or the element moved: lay the editor out again.
    pub restyle: bool,
}

fn edit_view(me: &BoardView) -> EditView {
    EditView {
        viewport: me.viewport(),
        canvas: me.canvas(),
    }
}

fn max_width(me: &BoardView) -> f64 {
    let pad = super::consts::TEXT_VIEWPORT_PADDING;
    get_max_text_width(me.canvas().width, pad, pad, me.app.zoom)
}

/// The field's look from the layout.
fn style_field(f: &mut TextField, l: &EditorLayout) {
    let z = l.placement.zoom as f32;
    f.size = l.font.size as f32 * z;
    f.line_height = (l.font.size * l.line_height) as f32 * z;
    f.color = super::render::color(super::color::color_or_black(&l.color), l.opacity);
    f.align = match l.text_align {
        TextAlign::Center => crate::text_field::Align::Center,
        TextAlign::Right => crate::text_field::Align::Right,
        TextAlign::Left => crate::text_field::Align::Left,
    };
    f.wrap = l.wraps;
    let family = l.font.family;
    f.font = super::fonts::font(family);
}

/// `handleTextWysiwyg`: starts editing the text `id`.
pub fn begin(
    me: &mut BoardView,
    id: &str,
    existing: bool,
    caret_at: Option<[f64; 2]>,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let m = me.m.clone();
    let mut session = TextEditSession::new(&me.scene, id, existing);
    let original = me
        .scene
        .get_element(id)
        .and_then(|e| e.text())
        .map(|t| t.original_text.clone())
        .unwrap_or_default();
    let mw = max_width(me);
    session.update_element(&mut me.scene, &*m, &original, false, mw);
    let view = edit_view(me);
    let layout = session.update_style(&mut me.scene, &view).layout;
    me.app.editing_text_element = Some(id.to_string());
    // editing deselects (the container shows through the editor)
    me.clear_selection();
    me.set_linear(None);
    // a caret where the click landed, else everything selected (`autoSelect`)
    let caret = match (&layout, caret_at) {
        (Some(l), Some(p)) => {
            let i = caret_index_at(&*m, &l.text, &original, p, l.wraps);
            i..i
        }
        _ => 0..original.len(),
    };
    let field = cx.new(|cx| {
        let mut f = TextField::new("", cx);
        f.multiline = true;
        f.tab_events = true;
        if let Some(l) = &layout {
            style_field(&mut f, l);
        }
        f.set_text(&original, cx);
        f.select_range(caret, cx);
        f
    });
    let sub = cx.subscribe_in(
        &field,
        window,
        |me, field, ev: &TextFieldEvent, window, cx| match ev {
            TextFieldEvent::Changed => {
                let value = field.read(cx).text.clone();
                changed(me, &value, cx);
            }
            TextFieldEvent::Cancel => submit(me, true, window, cx),
            // Tab / ⇧Tab: indent / outdent the selected lines
            TextFieldEvent::Tab | TextFieldEvent::ShiftTab => {
                let (v, r) = {
                    let f = field.read(cx);
                    (f.text.clone(), f.selection())
                };
                let (next, a, b) = if *ev == TextFieldEvent::Tab {
                    indent(&v, r.start, r.end)
                } else {
                    outdent(&v, r.start, r.end)
                };
                if next == v {
                    return;
                }
                field.update(cx, |f, cx| {
                    f.set_text(&next, cx);
                    f.select_range(a..b, cx);
                });
                changed(me, &next, cx);
            }
            _ => {}
        },
    );
    // after the press that started the edit is done with focus
    let fh = field.read(cx).focus_handle(cx);
    window.focus(&fh, cx);
    window.defer(cx, move |window, cx| window.focus(&fh, cx));
    me.text = Some(TextEditing {
        session,
        field,
        _sub: sub,
        layout,
        restyle: false,
    });
    me.commit(None, cx);
}

/// `onChange`.
fn changed(me: &mut BoardView, value: &str, cx: &mut Context<BoardView>) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let mw = max_width(me);
    let view = edit_view(me);
    let Some(t) = &mut me.text else { return };
    let res = t.session.on_change(&mut me.scene, &*m, value, mw, &view);
    let id = t.session.element_id.clone();
    if let Some(l) = &res.style.layout {
        t.field.update(cx, |f, _| style_field(f, l));
    }
    t.layout = res.style.layout.clone();
    if res.value != value {
        let v = res.value.clone();
        t.field.update(cx, |f, cx| {
            let c = f.caret().min(v.len());
            f.set_text(&v, cx);
            f.select_range(c..c, cx);
        });
    }
    update_bound_elements(&id, &mut me.scene, &UpdateBoundOpts::default(), &hooks);
    for c in res
        .style
        .resized_containers
        .iter()
        .chain(res.sticky_container.iter())
    {
        update_bound_elements(c, &mut me.scene, &UpdateBoundOpts::default(), &hooks);
    }
    me.commit(None, cx);
}

/// `handleSubmit`: Escape / ⌘Enter (`via_keyboard`) or a click elsewhere.
pub fn submit(
    me: &mut BoardView,
    via_keyboard: bool,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    if me.text.is_none() {
        return;
    }
    me.focus(window, cx);
    submit_text(me, via_keyboard, cx);
}

/// `submit` without moving focus (a flush before the host saves).
pub fn submit_text(me: &mut BoardView, via_keyboard: bool, cx: &mut Context<BoardView>) {
    let Some(mut t) = me.text.take() else { return };
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let value = t.field.read(cx).text.clone();
    let mw = max_width(me);
    let id = t.session.element_id.clone();
    let out = t
        .session
        .submit(&mut me.scene, &*m, &value, via_keyboard, mw);
    me.app.editing_text_element = None;
    let mut capture = false;
    if let Some(o) = out {
        if o.is_deleted {
            if let Some(e) = me.scene.get_element(&id).cloned() {
                fix_bindings_after_deletion(&mut me.scene, &[e]);
            }
        } else {
            update_bound_elements(&id, &mut me.scene, &UpdateBoundOpts::default(), &hooks);
        }
        if let Some(c) = &o.sticky_container {
            update_bound_elements(c, &mut me.scene, &UpdateBoundOpts::default(), &hooks);
        }
        if let Some(c) = t.session.container_id.clone() {
            update_bound_elements(&c, &mut me.scene, &UpdateBoundOpts::default(), &hooks);
        }
        if let Some(s) = o
            .select_id
            .filter(|s| !me.app.active_tool.locked && me.scene.get_non_deleted_element(s).is_some())
        {
            super::tools::selection::select_only(me, &[s], false);
        }
        capture = o.capture;
    }
    if !me.app.active_tool.locked && me.app.active_tool.ty == ToolType::Text {
        me.app.active_tool = super::actions::update_active_tool(&me.app, ToolType::Selection);
    }
    me.commit(
        Some(if capture {
            CaptureUpdateAction::Immediately
        } else {
            CaptureUpdateAction::Eventually
        }),
        cx,
    );
}

/// Before a render: the editor follows zoom, scroll and style changes
/// (`updateWysiwygStyle`).
pub fn restyle(me: &mut BoardView, _: &mut Window, cx: &mut Context<BoardView>) {
    let view = edit_view(me);
    let Some(t) = &mut me.text else { return };
    if !t.restyle {
        return;
    }
    t.restyle = false;
    let up = t.session.update_style(&mut me.scene, &view);
    if let Some(l) = &up.layout {
        t.field.update(cx, |f, _| style_field(f, l));
    }
    t.layout = up.layout;
}

/// The field, placed over the text (relative to the board view, which the
/// canvas fills).
pub fn element(me: &BoardView) -> Option<AnyElement> {
    let t = me.text.as_ref()?;
    let l = t.layout.as_ref()?;
    let p = &l.placement;
    let z = p.zoom as f32;
    let left = px(p.anchor[0] as f32 + p.origin_x as f32 * z);
    let top = px(p.anchor[1] as f32);
    // room for the caret past the last glyph: an unwrapped field keeps the
    // caret 8pt inside its box (`hscroll`) and would scroll the text left
    let w = (p.width as f32 * z).max(1.) + 10.;
    Some(
        div()
            .key_context("BoardText")
            .absolute()
            .left(left)
            .top(top)
            .w(px(w))
            .min_h(px(l.height as f32 * z))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .child(div().flex().w_full().child(t.field.clone()))
            .into_any_element(),
    )
}
