// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Drawing rectangles, diamonds, ellipses, frames and sticky notes:
//! `createGenericElementOnPointerDown`, `createFrameElementOnPointerDown`,
//! `maybeDragNewGenericElement` and the new-element half of
//! `onPointerUpFromPointerDownHandler` (App.tsx @ 3a317b5). A plain click
//! leaves nothing (invisibly small), except a sticky note, which gets its
//! default size.

use super::super::BoardView;
use super::super::app_state::{StrokeRoundness, ToolType};
use super::super::canvas::{Gesture, Mods};
use super::super::consts::{DEFAULT_STICKY_NOTE_SIZE, DRAGGING_THRESHOLD, FrameStyle};
use super::super::drag::{DragNewOpts, drag_new_element};
use super::super::history::CaptureUpdateAction;
use super::super::new_element::{
    ElementOpts, new_element, new_frame_element, new_sticky_note_element,
};
use super::super::snapping::{SnapCache, snap_new_element};
use super::super::types::{ElementType, Kind, Roundness, roundness};
use super::super::utils::{get_grid_point, get_normalized_dimensions, is_invisibly_small_element};
use gpui::{Context, Window};
use std::collections::BTreeSet;

pub struct ShapeGesture {
    pub id: String,
    pub origin: [f64; 2],
    pub origin_in_grid: [f64; 2],
    pub snap: SnapCache,
}

impl BoardView {
    /// `getCurrentItemRoundness`.
    pub(crate) fn current_roundness(&self, ty: ElementType) -> Option<Roundness> {
        (self.app.current_item_roundness == StrokeRoundness::Round).then(|| Roundness {
            kind: if ty.uses_adaptive_radius() {
                roundness::ADAPTIVE_RADIUS
            } else {
                roundness::PROPORTIONAL_RADIUS
            },
            value: None,
        })
    }

    /// The current item's style at `(x, y)`.
    pub(crate) fn current_opts(&self, ty: ElementType, x: f64, y: f64) -> ElementOpts {
        let a = &self.app;
        let sticky = ty == ElementType::StickyNote;
        ElementOpts {
            stroke_color: if sticky {
                a.current_item_stickynote_stroke_color.clone()
            } else {
                a.current_item_stroke_color.clone()
            },
            background_color: if sticky {
                a.current_item_stickynote_background_color.clone()
            } else {
                a.current_item_background_color.clone()
            },
            fill_style: a.current_item_fill_style,
            stroke_width: a.current_item_stroke_width(ty == ElementType::FreeDraw),
            stroke_style: a.current_item_stroke_style,
            roughness: a.current_item_roughness,
            opacity: a.current_item_opacity,
            roundness: None,
            ..ElementOpts::at(x, y)
        }
    }
}

pub fn down(me: &mut BoardView, p: [f64; 2], mods: Mods, cx: &mut Context<BoardView>) {
    let [gx, gy] = get_grid_point(p[0], p[1], me.grid(mods));
    let frame = me.top_frame_at([gx, gy], &BTreeSet::new());
    let ty = me.app.active_tool.ty;
    let e = match ty {
        ToolType::Frame | ToolType::MagicFrame => new_frame_element(
            ElementOpts {
                stroke_color: FrameStyle::STROKE_COLOR.into(),
                stroke_width: FrameStyle::STROKE_WIDTH,
                roughness: 0.,
                background_color: "transparent".into(),
                opacity: me.app.current_item_opacity,
                ..ElementOpts::at(gx, gy)
            },
            None,
        ),
        _ => {
            let et = match ty {
                ToolType::Diamond => ElementType::Diamond,
                ToolType::Ellipse => ElementType::Ellipse,
                ToolType::StickyNote => ElementType::StickyNote,
                _ => ElementType::Rectangle,
            };
            let o = ElementOpts {
                roundness: me.current_roundness(et),
                frame_id: frame,
                ..me.current_opts(et, gx, gy)
            };
            if et == ElementType::StickyNote {
                new_sticky_note_element(o, None)
            } else {
                new_element(et, o)
            }
        }
    };
    let id = e.id.clone();
    me.scene.insert_element(e);
    me.multi = None;
    me.gesture = Some(Gesture::Shape(ShapeGesture {
        id,
        origin: p,
        origin_in_grid: [gx, gy],
        snap: SnapCache::default(),
    }));
    cx.notify();
}

/// `maybeDragNewGenericElement`.
pub fn drag(
    me: &mut BoardView,
    mut g: ShapeGesture,
    p: [f64; 2],
    mods: Mods,
    cx: &mut Context<BoardView>,
) -> Option<Gesture> {
    let e = me.scene.get_element(&g.id).cloned()?;
    let [mut gx, mut gy] = get_grid_point(p[0], p[1], me.grid(mods));
    let els: Vec<_> = me.scene.non_deleted_elements().cloned().collect();
    let ctx = me.snap_ctx(false);
    g.snap
        .maybe_cache_reference_snap_points(&els, &[&e], &ctx, &me.scene, mods.snap(), false);
    let snap = snap_new_element(
        &e,
        &ctx,
        mods.snap(),
        g.origin_in_grid,
        [gx - g.origin_in_grid[0], gy - g.origin_in_grid[1]],
        &me.scene,
        &g.snap,
    );
    gx += snap.snap_offset[0];
    gy += snap.snap_offset[1];
    me.snap_lines = snap.snap_lines;
    let sticky = e.is_sticky_note();
    let mut o = DragNewOpts::new(
        me.app.active_tool.ty,
        g.origin_in_grid,
        [gx, gy],
        me.app.zoom,
    );
    o.maintain_aspect_ratio = if sticky { !mods.shift } else { mods.shift };
    o.resize_from_center = mods.alt;
    let m = me.m.clone();
    drag_new_element(&mut me.scene, &g.id, &o, &*m);
    if e.is_frame_like() {
        me.app.frame_to_highlight = None;
    }
    cx.notify();
    Some(Gesture::Shape(g))
}

pub fn up(
    me: &mut BoardView,
    g: ShapeGesture,
    p: [f64; 2],
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let Some(e) = me.scene.get_element(&g.id).cloned() else {
        return;
    };
    let locked = me.app.active_tool.locked;
    if let Kind::StickyNote { .. } = e.kind {
        let z = me.app.zoom;
        let (x, y, w, h) = if e.width * z < DRAGGING_THRESHOLD && e.height * z < DRAGGING_THRESHOLD
        {
            let s = DEFAULT_STICKY_NOTE_SIZE;
            let [x, y] = get_grid_point(g.origin[0] - s / 2., g.origin[1] - s / 2., me.grid(mods));
            (x, y, s, s)
        } else {
            let (mw, mh) = super::super::sticky::get_sticky_note_min_size(
                me.app.current_item_font_size,
                me.app.current_item_font_family,
            );
            let (mut w, mut h) = (e.width.max(mw), e.height.max(mh));
            if !mods.shift {
                w = w.max(h);
                h = w;
            }
            let o = g.origin_in_grid;
            (
                if e.x < o[0] { o[0] - w } else { e.x },
                if e.y < o[1] { o[1] - h } else { e.y },
                w,
                h,
            )
        };
        me.scene.mutate_element(&g.id, true, |e| {
            (e.x, e.y, e.width, e.height) = (x, y, w, h);
            e.kind = Kind::StickyNote { base_height: h };
        });
        if locked {
            me.clear_selection();
            me.commit(Some(CaptureUpdateAction::Immediately), cx);
            return;
        }
        super::tool_done(me);
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
        super::text::start_editing(
            me,
            [x + w / 2., y + h / 2.],
            Some(g.id.clone()),
            true,
            None,
            window,
            cx,
        );
        return;
    }
    if is_invisibly_small_element(&e) {
        // nothing drawn: not a step
        me.scene
            .mutate_element(&g.id, true, |e| e.is_deleted = true);
        let els: Vec<_> = me
            .scene
            .elements_including_deleted()
            .iter()
            .filter(|x| x.id != g.id)
            .cloned()
            .collect();
        me.scene.replace_all_elements(els);
        me.commit(Some(CaptureUpdateAction::Never), cx);
        return;
    }
    if e.is_frame_like() {
        let mut all = me.scene.elements_including_deleted().to_vec();
        let inside: Vec<String> =
            super::super::frame::get_elements_in_new_frame(&all, &e, &me.scene)
                .iter()
                .map(|x| x.id.clone())
                .collect();
        super::super::frame::add_elements_to_frame(&mut all, &inside, &g.id);
        me.scene.replace_all_elements(all);
    }
    let (x, y, w, h) = get_normalized_dimensions(e.x, e.y, e.width, e.height);
    me.scene.mutate_element(&g.id, true, |e| {
        (e.x, e.y, e.width, e.height) = (x, y, w, h)
    });
    let _ = p;
    if !locked {
        me.app.selected_element_ids = BTreeSet::from([g.id.clone()]);
        me.app.selected_group_ids.clear();
    }
    super::tool_done(me);
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}
