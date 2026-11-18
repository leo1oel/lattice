// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Image cropping. Port of Excalidraw `packages/element/src/cropElement.ts`
//! @ 3a317b5. The functions return the geometry and crop to apply (upstream
//! returns a partial element for `mutateElement`); `CropUpdate::apply` does
//! that. `crop: None` in an update means "back to uncropped".
//!
//! `getNextSingleWidthAndHeightFromPointer` (resizeElements.ts) is copied in
//! privately until the resize module lands; dedupe then.

use super::bounds::{element_center_point, get_element_absolute_coords};
use super::handles::HandleType;
use super::math::*;
use super::resize::get_next_single_width_and_height_from_pointer;
use super::types::{Element, ImageCrop};
use super::utils::ElementsMap;

pub const MINIMAL_CROP_SIZE: f64 = 10.;

/// What `cropElement` / `uncropElementSides` return.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CropUpdate {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub crop: Option<ImageCrop>,
}

impl CropUpdate {
    pub fn apply(&self, e: &mut Element) {
        (e.x, e.y, e.width, e.height) = (self.x, self.y, self.width, self.height);
        if let Some(i) = e.image_mut() {
            i.crop = self.crop;
        }
    }
}

/// Crop options (`shouldMaintainAspectRatio`, `shouldResizeFromCenter`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CropOpts {
    pub maintain_aspect_ratio: bool,
    pub resize_from_center: bool,
}

fn has(h: HandleType, side: char) -> bool {
    h.as_str().contains(side)
}
fn crop_of(e: &Element) -> Option<ImageCrop> {
    e.image().and_then(|i| i.crop)
}
fn scale_of(e: &Element) -> [f64; 2] {
    e.image().map_or([1., 1.], |i| i.scale)
}

/// `cropElement`: crops the image (as it was at the drag's start) as
/// resizing it would resize it, as far as the image reaches.
pub fn crop_element(
    e: &Element,
    map: &dyn ElementsMap,
    h: HandleType,
    natural_width: f64,
    natural_height: f64,
    px: f64,
    py: f64,
    o: CropOpts,
) -> CropUpdate {
    let (width, height) = (e.width, e.height);
    let (uw, uh) = get_uncropped_width_and_height(e);
    let [left, top] = get_flip_adjusted_crop_position(e, false).unwrap_or([0., 0.]);
    let (mut nw, mut nh) =
        get_next_single_width_and_height_from_pointer(e, e, h, px, py, false, o.resize_from_center);
    // what stays put, as a fraction of the size
    let anchor_x = if o.resize_from_center || !(has(h, 'e') || has(h, 'w')) {
        0.5
    } else if has(h, 'w') {
        1.
    } else {
        0.
    };
    let anchor_y = if o.resize_from_center || !(has(h, 'n') || has(h, 's')) {
        0.5
    } else if has(h, 'n') {
        1.
    } else {
        0.
    };
    let max_size = |anchor: f64, offset: f64, size: f64, uncropped: f64| {
        let before = offset + anchor * size;
        let after = uncropped - before;
        if anchor == 0. {
            after
        } else if anchor == 1. {
            before
        } else {
            before.min(after) * 2.
        }
    };
    let max_w = max_size(anchor_x, left, width, uw);
    let max_h = max_size(anchor_y, top, height, uh);
    let (min_w, min_h) = (MINIMAL_CROP_SIZE.min(width), MINIMAL_CROP_SIZE.min(height));
    if o.maintain_aspect_ratio {
        let ratio = width / height;
        let w = match h {
            HandleType::N | HandleType::S => nh * ratio,
            HandleType::E | HandleType::W => nw,
            _ => nw.max(nh * ratio),
        };
        nw = clamp(w, min_w.max(min_h * ratio), max_w.min(max_h * ratio));
        nh = nw / ratio;
    } else {
        nw = clamp(nw, min_w, max_w);
        nh = clamp(nh, min_h, max_h);
    }
    let x1 = anchor_x * (width - nw);
    let y1 = anchor_y * (height - nh);
    crop_element_to_bounds(
        e,
        map,
        natural_width,
        natural_height,
        [x1, y1, x1 + nw, y1 + nh],
    )
}

/// `cropElementToBounds`: crops to `bounds`, relative to the element as
/// shown (flipped).
fn crop_element_to_bounds(
    e: &Element,
    map: &dyn ElementsMap,
    natural_width: f64,
    natural_height: f64,
    [x1, y1, x2, y2]: [f64; 4],
) -> CropUpdate {
    let c = crop_of(e);
    let scale = scale_of(e);
    let sx = c.map_or(natural_width, |c| c.width) / e.width;
    let sy = c.map_or(natural_height, |c| c.height) / e.height;
    let (w, h) = (x2 - x1, y2 - y1);
    let [cx, cy] = point_rotate_rads(
        [e.x + (x1 + x2) / 2., e.y + (y1 + y2) / 2.],
        element_center_point(e, map, 0., 0.),
        e.angle,
    );
    let crop = ImageCrop {
        x: c.map_or(0., |c| c.x) + (if scale[0] == -1. { e.width - x2 } else { x1 }) * sx,
        y: c.map_or(0., |c| c.y) + (if scale[1] == -1. { e.height - y2 } else { y1 }) * sy,
        width: w * sx,
        height: h * sy,
        natural_width,
        natural_height,
    };
    let back = is_close_to(crop.width, natural_width, PRECISION)
        && is_close_to(crop.height, natural_height, PRECISION);
    CropUpdate {
        x: cx - w / 2.,
        y: cy - h / 2.,
        width: w,
        height: h,
        crop: if back { None } else { Some(crop) },
    }
}

/// `uncropElementSides`: uncrops the image on the handle's side (a corner's
/// two); `mirrored`, on the opposite side(s) too. None if not cropped.
pub fn uncrop_element_sides(
    e: &Element,
    map: &dyn ElementsMap,
    h: HandleType,
    mirrored: bool,
) -> Option<CropUpdate> {
    let c = crop_of(e)?;
    let (w, hh) = get_uncropped_width_and_height(e);
    let [left, top] = get_flip_adjusted_crop_position(e, false)?;
    let uncrops = |side: char, opposite: char| has(h, side) || (mirrored && has(h, opposite));
    Some(crop_element_to_bounds(
        e,
        map,
        c.natural_width,
        c.natural_height,
        [
            if uncrops('w', 'e') { -left } else { 0. },
            if uncrops('n', 's') { -top } else { 0. },
            if uncrops('e', 'w') { w - left } else { e.width },
            if uncrops('s', 'n') {
                hh - top
            } else {
                e.height
            },
        ],
    ))
}

/// `getUncroppedImageElement`: the whole image as it lies under the crop.
pub fn get_uncropped_image_element(e: &Element, map: &dyn ElementsMap) -> Element {
    let Some(c) = crop_of(e) else {
        return e.clone();
    };
    let (width, height) = get_uncropped_width_and_height(e);
    let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, false);
    let tl = point_rotate_rads([x1, y1], [cx, cy], e.angle);
    let tr = point_rotate_rads([x2, y1], [cx, cy], e.angle);
    let top = vector_normalize(vector_subtract(tr, tl));
    let bl = point_rotate_rads([x1, y2], [cx, cy], e.angle);
    let left = vector_normalize(vector_subtract(bl, tl));
    let (crop_x, crop_y) = adjust_crop_position(&c, scale_of(e));
    let rtl = vector_add(
        vector_add(tl, vector_scale(top, -crop_x * width / c.natural_width)),
        vector_scale(left, -crop_y * height / c.natural_height),
    );
    let center = vector_add(
        vector_add(rtl, vector_scale(top, width / 2.)),
        vector_scale(left, height / 2.),
    );
    let [x, y] = point_rotate_rads(rtl, center, -e.angle);
    let mut out = e.clone();
    (out.x, out.y, out.width, out.height) = (x, y, width, height);
    if let Some(i) = out.image_mut() {
        i.crop = None;
    }
    out
}

/// `getUncroppedWidthAndHeight`.
pub fn get_uncropped_width_and_height(e: &Element) -> (f64, f64) {
    match crop_of(e) {
        Some(c) => (
            e.width / (c.width / c.natural_width),
            e.height / (c.height / c.natural_height),
        ),
        None => (e.width, e.height),
    }
}

fn adjust_crop_position(c: &ImageCrop, scale: [f64; 2]) -> (f64, f64) {
    let x = if scale[0] == -1. {
        c.natural_width - c.x.abs() - c.width
    } else {
        c.x
    };
    let y = if scale[1] == -1. {
        c.natural_height - c.y.abs() - c.height
    } else {
        c.y
    };
    (x, y)
}

/// `getFlipAdjustedCropPosition`: the crop's top-left as shown, in element
/// units (`natural`: in the image's pixels). None if not cropped.
pub fn get_flip_adjusted_crop_position(e: &Element, natural: bool) -> Option<Point> {
    let c = crop_of(e)?;
    let scale = scale_of(e);
    let x = if scale[0] == -1. {
        c.natural_width - c.width - c.x
    } else {
        c.x
    };
    let y = if scale[1] == -1. {
        c.natural_height - c.height - c.y
    } else {
        c.y
    };
    if natural {
        return Some([x, y]);
    }
    let (w, h) = get_uncropped_width_and_height(e);
    Some([x / (c.natural_width / w), y / (c.natural_height / h)])
}

/// Dragging the image inside its crop while cropping (`App.selectionTool.ts`
/// "move crop region"): the crop moved by `instant_offset`, the drag since
/// the previous pointer move (scene units, already axis-locked), kept inside
/// the image. None if the image isn't cropped.
pub fn move_crop(
    e: &Element,
    map: &dyn ElementsMap,
    instant_offset: Vector,
    natural_width: f64,
    natural_height: f64,
) -> Option<ImageCrop> {
    let c = crop_of(e)?;
    let (uw, uh) = get_uncropped_width_and_height(e);
    let d = [
        instant_offset[0] * natural_width / uw,
        instant_offset[1] * natural_height / uh,
    ];
    let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, false);
    let tl = point_rotate_rads([x1, y1], [cx, cy], e.angle);
    let top = vector_normalize(vector_subtract(
        point_rotate_rads([x2, y1], [cx, cy], e.angle),
        tl,
    ));
    let left = vector_normalize(vector_subtract(
        point_rotate_rads([x1, y2], [cx, cy], e.angle),
        tl,
    ));
    let o = [vector_dot(d, top), vector_dot(d, left)];
    let scale = scale_of(e);
    Some(ImageCrop {
        x: clamp(c.x - o[0] * scale[0].signum(), 0., natural_width - c.width),
        y: clamp(
            c.y - o[1] * scale[1].signum(),
            0.,
            natural_height - c.height,
        ),
        ..c
    })
}
