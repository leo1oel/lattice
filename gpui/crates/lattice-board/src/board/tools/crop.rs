// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The image crop editor, after Excalidraw `App.tsx`'s
//! `startImageCropping` / `finishImageCropping`, `actionCropEditor.tsx` and
//! `App.selectionTool.ts`'s `maybeHandleCrop` (the handles crop instead of
//! resizing), the "move crop region" drag and `maybeUncropSides` (a
//! double-click on a handle uncrops that side; Alt, the opposite one too)
//! @ 3a317b5. Enter or a double-click on a lone image starts it; Enter,
//! Escape or a press on anything else ends it. The geometry is core's
//! `crop`.

use super::super::BoardView;
use super::super::Hooks;
use super::super::binding::{UpdateBoundOpts, update_bound_elements};
use super::super::canvas::Mods;
use super::super::crop::{CropOpts, crop_element, move_crop, uncrop_element_sides};
use super::super::handles::HandleType;
use super::super::snapping::snap_resizing_elements;
use super::super::types::Element;
use super::super::utils::get_grid_point;
use super::selection::{Resize, SelectGesture};
use gpui::Context;

/// `startImageCropping`.
pub fn start(me: &mut BoardView, id: &str, cx: &mut Context<BoardView>) {
    if !me
        .scene
        .get_non_deleted_element(id)
        .is_some_and(|e| e.is_image())
    {
        return;
    }
    me.store.schedule_capture();
    me.app.cropping_element_id = Some(id.to_string());
    me.app.is_cropping = false;
    me.commit(None, cx);
}

/// `finishImageCropping`: false if not cropping.
pub fn finish(me: &mut BoardView, cx: &mut Context<BoardView>) -> bool {
    if me.app.cropping_element_id.is_none() {
        return false;
    }
    me.store.schedule_capture();
    me.app.cropping_element_id = None;
    me.app.is_cropping = false;
    me.commit(None, cx);
    true
}

/// The image's pixel size (`image.naturalWidth` / `Height`): the crop's
/// record of it, else read off the file's header.
pub fn natural_size(me: &BoardView, e: &Element) -> Option<(f64, f64)> {
    let i = e.image()?;
    if let Some(c) = i.crop {
        return Some((c.natural_width, c.natural_height));
    }
    let f = me.files.get(i.file_id.as_deref()?)?;
    let bytes = {
        use base64::Engine;
        let (_, b64) = f.data_url.as_deref()?.split_once(";base64,")?;
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .ok()?
    };
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    Some((w as f64, h as f64))
}

/// `maybeHandleCrop`: a handle dragged in the crop editor crops the image
/// as it was when the drag started.
pub fn drag_handle(me: &mut BoardView, g: &mut SelectGesture, r: &Resize, p: [f64; 2], mods: Mods) {
    let Some(id) = me.app.cropping_element_id.clone() else {
        return;
    };
    if r.handle == HandleType::Rotation {
        return;
    }
    let (Some(cur), Some(start)) = (
        me.scene
            .get_non_deleted_element(&id)
            .filter(|e| e.is_image())
            .cloned(),
        g.ds.original_elements.get(&id).cloned(),
    ) else {
        return;
    };
    let Some((nw, nh)) = natural_size(me, &start) else {
        return;
    };
    let grid = me.grid(mods);
    let [x, y] = get_grid_point(p[0] - r.offset[0], p[1] - r.offset[1], grid);
    let [gx, gy] = get_grid_point(p[0], p[1], grid);
    let drag_offset = [gx - g.origin_in_grid[0], gy - g.origin_in_grid[1]];
    let els: Vec<Element> = me.scene.non_deleted_elements().cloned().collect();
    let ctx = me.snap_ctx(false);
    g.snap
        .maybe_cache_reference_snap_points(&els, &[&cur], &ctx, &me.scene, mods.snap(), false);
    let snap = snap_resizing_elements(
        &[&cur],
        &[&start],
        &ctx,
        mods.snap(),
        drag_offset,
        Some(r.handle),
        &me.scene,
        &g.snap,
    );
    let u = crop_element(
        &start,
        &me.scene,
        r.handle,
        nw,
        nh,
        x + snap.snap_offset[0],
        y + snap.snap_offset[1],
        CropOpts {
            maintain_aspect_ratio: mods.shift,
            resize_from_center: mods.alt,
        },
    );
    me.scene.mutate_element(&id, true, |e| u.apply(e));
    let m = me.m.clone();
    update_bound_elements(&id, &mut me.scene, &UpdateBoundOpts::default(), &Hooks(&*m));
    me.app.is_cropping = true;
    me.snap_lines = snap.snap_lines;
}

/// "move crop region": dragging the cropped image inside the crop editor
/// moves the image under its crop. False if that isn't the drag.
pub fn drag_image(me: &mut BoardView, g: &mut SelectGesture, off: [f64; 2]) -> bool {
    let Some(id) = me.app.cropping_element_id.clone() else {
        return false;
    };
    if g.hit.as_deref() != Some(id.as_str()) {
        return false;
    }
    let Some(e) = me
        .scene
        .get_non_deleted_element(&id)
        .filter(|e| e.image().is_some_and(|i| i.crop.is_some()))
        .cloned()
    else {
        return false;
    };
    let Some((nw, nh)) = natural_size(me, &e) else {
        return false;
    };
    let instant = [off[0] - g.crop_last[0], off[1] - g.crop_last[1]];
    g.crop_last = off;
    if let Some(c) = move_crop(&e, &me.scene, instant, nw, nh) {
        me.scene.mutate_element(&id, true, |x| {
            if let Some(i) = x.image_mut() {
                i.crop = Some(c);
            }
        });
    }
    true
}

/// `maybeUncropSides`: a double-click on a crop handle uncrops its side(s).
/// False if not on a handle of the image being cropped.
pub fn maybe_uncrop_sides(
    me: &mut BoardView,
    image: &str,
    handle: Option<HandleType>,
    mirrored: bool,
    cx: &mut Context<BoardView>,
) -> bool {
    if me.app.cropping_element_id.as_deref() != Some(image) {
        return false;
    }
    let Some(h) = handle.filter(|h| *h != HandleType::Rotation) else {
        return false;
    };
    let Some(e) = me.scene.get_non_deleted_element(image).cloned() else {
        return false;
    };
    if let Some(u) = uncrop_element_sides(&e, &me.scene, h, mirrored) {
        me.store.schedule_capture();
        me.scene.mutate_element(image, true, |x| u.apply(x));
        let m = me.m.clone();
        update_bound_elements(
            image,
            &mut me.scene,
            &UpdateBoundOpts::default(),
            &Hooks(&*m),
        );
        me.commit(None, cx);
    }
    true
}
