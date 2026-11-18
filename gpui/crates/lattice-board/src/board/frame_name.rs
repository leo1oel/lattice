// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Renaming a frame, after Excalidraw `App.tsx`'s `renderFrameNames` (the
//! `<input>` that replaces the name while `editingFrame` is set) and
//! `resetEditingFrame` @ 3a317b5: Enter on a selected frame or a
//! double-click on its name opens our `TextField` over the name, all of it
//! selected; every change renames the frame; Enter, Escape or a press
//! elsewhere ends it with the name trimmed (empty: back to the default
//! "Frame"). The names themselves are screen-size labels here, as upstream's
//! DOM names (thumbnails and exports draw `display::frame_label` instead).

use super::BoardView;
use super::consts::FrameStyle;
use super::frame::get_frame_like_title;
use super::history::CaptureUpdateAction;
use super::types::Kind;
use crate::text_field::{TextField, TextFieldEvent};
use gpui::*;

pub struct FrameNameEditing {
    pub id: String,
    field: Entity<TextField>,
    _sub: Subscription,
}

fn set_name(me: &mut BoardView, id: &str, name: Option<String>) {
    me.scene.mutate_element(id, true, |e| {
        if let Kind::Frame { name: n } | Kind::MagicFrame { name: n } = &mut e.kind {
            *n = name.clone();
        }
    });
}

/// `editingFrame: id`: the field over the name, the name selected (`onFocus`).
pub fn begin(me: &mut BoardView, id: &str, window: &mut Window, cx: &mut Context<BoardView>) {
    let Some(f) = me
        .scene
        .get_non_deleted_element(id)
        .filter(|e| e.is_frame_like())
    else {
        return;
    };
    if !me.app.frame_rendering.enabled || !me.app.frame_rendering.name {
        return;
    }
    let title = get_frame_like_title(f).to_string();
    me.app.editing_frame = Some(id.to_string());
    let field = cx.new(|cx| {
        let mut t = TextField::new("", cx);
        t.set_text(&title, cx);
        t.select_all_text(cx);
        t
    });
    let sub = cx.subscribe_in(
        &field,
        window,
        |me, field, ev: &TextFieldEvent, window, cx| match ev {
            TextFieldEvent::Changed => {
                let v = field.read(cx).text.clone();
                if let Some(id) = me.frame_name.as_ref().map(|f| f.id.clone()) {
                    set_name(me, &id, Some(v));
                    me.commit(None, cx);
                }
            }
            TextFieldEvent::Submit | TextFieldEvent::Cancel => {
                end(me, cx);
                me.focus(window, cx);
            }
            _ => {}
        },
    );
    let fh = field.read(cx).focus_handle(cx);
    window.focus(&fh, cx);
    window.defer(cx, move |window, cx| window.focus(&fh, cx));
    me.frame_name = Some(FrameNameEditing {
        id: id.to_string(),
        field,
        _sub: sub,
    });
    cx.notify();
}

/// `resetEditingFrame`: the name trimmed, empty back to none.
pub fn end(me: &mut BoardView, cx: &mut Context<BoardView>) {
    let Some(f) = me.frame_name.take() else {
        return;
    };
    me.app.editing_frame = None;
    let name = me
        .scene
        .get_element(&f.id)
        .and_then(|e| e.frame_name())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if me
        .scene
        .get_element(&f.id)
        .is_some_and(|e| e.frame_name() != name.as_deref())
    {
        set_name(me, &f.id, name);
    }
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}

/// Upstream's frame name div: 14px, line height 1.25, its bottom 3px above
/// the frame's top-left corner, as wide as the name up to the frame's
/// zoomed width (then cut with an ellipsis). Screen pixels at any zoom.
const NAME_LINE: f32 = FrameStyle::NAME_FONT_SIZE as f32 * FrameStyle::NAME_LINE_HEIGHT as f32;

fn name_color() -> Hsla {
    let c = super::color::color_or_black(if crate::theme::dark() {
        FrameStyle::NAME_COLOR_DARK
    } else {
        FrameStyle::NAME_COLOR_LIGHT
    });
    Hsla::from(gpui::Rgba {
        r: c.r as f32 / 255.,
        g: c.g as f32 / 255.,
        b: c.b as f32 / 255.,
        a: 1.,
    })
}

/// The frame names (`renderFrameNames`): one label per frame in view, but
/// not the one being renamed. Remembers where they are for the double-click.
pub fn labels(me: &mut BoardView, window: &mut Window) -> Vec<AnyElement> {
    me.frame_labels.clear();
    if !me.app.frame_rendering.enabled || !me.app.frame_rendering.name {
        return vec![];
    }
    let v = me.view();
    // labels sit in the board view, which the canvas fills; `frame_labels`
    // keeps window rects (the pointer's coordinates)
    let cb = me.bounds.get();
    let (o, vp) = (cb.origin, cb.size);
    let font = gpui::font(crate::board::chrome::style::ui_font());
    let fs = px(FrameStyle::NAME_FONT_SIZE as f32);
    let mut out = vec![];
    for f in me.scene.non_deleted_frame_likes() {
        let a = v.to_screen([f.x, f.y]);
        let max_w = px(f.width as f32 * v.zoom);
        let top = a.y - px(FrameStyle::NAME_OFFSET_Y as f32 + NAME_LINE);
        if a.x > o.x + vp.width
            || a.x + max_w < o.x
            || top > o.y + vp.height
            || a.y + px(f.height as f32 * v.zoom) < o.y
        {
            continue;
        }
        let title: SharedString = get_frame_like_title(f).to_string().into();
        let run = TextRun {
            len: title.len(),
            font: font.clone(),
            color: name_color(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        // (rounded up: a hair short and the ellipsis would cut it)
        let w = (window
            .text_system()
            .shape_line(title.clone(), fs, &[run], None)
            .width
            .ceil()
            + px(1.))
        .min(max_w);
        me.frame_labels.push((
            f.id.clone(),
            Bounds {
                origin: point(a.x, top),
                size: size(w, px(NAME_LINE)),
            },
        ));
        if me.frame_name.as_ref().is_some_and(|n| n.id == f.id) {
            continue;
        }
        out.push(
            div()
                .absolute()
                .left(a.x - o.x)
                .top(top - o.y)
                .w(w)
                .font_family(crate::board::chrome::style::ui_font())
                .h(px(NAME_LINE))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(fs)
                .line_height(px(NAME_LINE))
                .text_color(name_color())
                .child(title)
                .into_any_element(),
        );
    }
    out
}

/// The frame name under `p` (window), for a double-click.
pub fn frame_name_at(me: &BoardView, p: Point<Pixels>) -> Option<String> {
    me.frame_labels
        .iter()
        .rev()
        .find(|(_, b)| b.contains(&p))
        .map(|(id, _)| id.clone())
}

/// Upstream's `<input>` in the name div: padding 6, shifted (-6, 6), so the
/// text stays where the name was; the canvas color behind, the name color
/// (not mapped), an inset 1px `--color-primary` ring, radius 4.
pub fn element(me: &BoardView, cx: &mut Context<BoardView>) -> Option<AnyElement> {
    let f = me.frame_name.as_ref()?;
    let (_, b) = me.frame_labels.iter().find(|(id, _)| *id == f.id)?;
    let o = me.bounds.get().origin;
    let pad = 6.;
    let size = FrameStyle::NAME_FONT_SIZE as f32;
    let text = f.field.read(cx).text.clone();
    let e = me.scene.get_non_deleted_element(&f.id)?;
    let _ = e;
    let w = px((text.chars().count() as f32 + 1.) * size * 0.6).max(px(size));
    let bg = crate::theme::canvas();
    f.field.update(cx, |t, _| {
        t.size = size;
        t.line_height = NAME_LINE;
        t.color = name_color();
    });
    Some(
        div()
            .absolute()
            .left(b.origin.x - o.x - px(pad))
            .top(b.origin.y - o.y)
            .p(px(pad))
            .rounded(px(4.))
            .bg(bg)
            .border_1()
            .border_color(super::chrome::style::primary())
            .font_family(super::chrome::style::ui_font())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .child(div().w(w).child(f.field.clone()))
            .into_any_element(),
    )
}
