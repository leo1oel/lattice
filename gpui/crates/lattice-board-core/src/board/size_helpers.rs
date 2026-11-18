// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Size helpers. Port of Excalidraw `element/src/sizeHelpers.ts` @ 3a317b5.
//! `isInvisiblySmallElement` and `getNormalizedDimensions` were ported with
//! the model and live in `utils.rs` (re-exported here). The viewport tests
//! take the viewport as a plain struct; scene coordinates follow
//! `viewportCoordsToSceneCoords`: `(client - offset) / zoom - scroll`.

use super::bounds::{get_common_bounds, get_element_bounds};
use super::consts::SHIFT_LOCKING_ANGLE;
use super::math::*;
use super::types::{Element, ElementType};
use super::utils::ElementsMap;
pub use super::utils::{
    INVISIBLY_SMALL_ELEMENT_SIZE, get_normalized_dimensions, is_invisibly_small_element,
};

/// Which edge `getPositionAfterHeightChange` keeps in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerticalResizeAnchor {
    Top,
    Center,
    Bottom,
}

/// `getPositionAfterHeightChange`: the new `(x, y)` keeping the anchor fixed.
pub fn get_position_after_height_change(
    e: &Element,
    next_height: f64,
    anchor: VerticalResizeAnchor,
) -> (f64, f64) {
    let delta = (e.height - next_height) / 2.;
    if anchor == VerticalResizeAnchor::Center {
        return (e.x, e.y + delta);
    }
    let (s, c) = e.angle.sin_cos();
    if anchor == VerticalResizeAnchor::Bottom {
        (e.x - delta * s, e.y + delta * (1. + c))
    } else {
        (e.x + delta * s, e.y + delta * (1. - c))
    }
}

/// The view transformations `isElementInViewport` takes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewTransform {
    pub zoom: f64,
    pub offset_left: f64,
    pub offset_top: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

impl ViewTransform {
    fn to_scene(self, cx: f64, cy: f64) -> Point {
        [
            (cx - self.offset_left) / self.zoom - self.scroll_x,
            (cy - self.offset_top) / self.zoom - self.scroll_y,
        ]
    }
}

/// `isElementInViewport`.
pub fn is_element_in_viewport(
    e: &Element,
    width: f64,
    height: f64,
    v: &ViewTransform,
    map: &dyn ElementsMap,
) -> bool {
    let [x1, y1, x2, y2] = get_element_bounds(e, map, false);
    let tl = v.to_scene(v.offset_left, v.offset_top);
    let br = v.to_scene(v.offset_left + width, v.offset_top + height);
    tl[0] <= x2 && tl[1] <= y2 && br[0] >= x1 && br[1] >= y1
}

/// `Offsets` (top, right, bottom, left).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Offsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// `isElementCompletelyInViewport`.
pub fn is_element_completely_in_viewport(
    elements: &[Element],
    width: f64,
    height: f64,
    v: &ViewTransform,
    map: &dyn ElementsMap,
    padding: Offsets,
) -> bool {
    let [x1, y1, x2, y2] = get_common_bounds(elements, map);
    let tl = v.to_scene(v.offset_left + padding.left, v.offset_top + padding.top);
    let br = v.to_scene(
        v.offset_left + width - padding.right,
        v.offset_top + height - padding.bottom,
    );
    x1 >= tl[0] && y1 >= tl[1] && x2 <= br[0] && y2 <= br[1]
}

/// `getPerfectElementSize`: shift-drawn squares and 15°-locked lines. `tool`
/// None stands for the selection tool.
pub fn get_perfect_element_size(
    tool: Option<ElementType>,
    width: f64,
    mut height: f64,
) -> (f64, f64) {
    let mut width = width;
    let (aw, ah) = (width.abs(), height.abs());
    let sign = |v: f64| {
        if v > 0. {
            1.
        } else if v < 0. {
            -1.
        } else {
            v
        }
    };
    match tool {
        Some(ElementType::Line | ElementType::Arrow | ElementType::FreeDraw) => {
            let locked = js_round((ah / aw).atan() / SHIFT_LOCKING_ANGLE) * SHIFT_LOCKING_ANGLE;
            if locked == 0. {
                height = 0.
            } else if locked == PI / 2. {
                width = 0.
            } else {
                let h = aw * locked.tan() * sign(height);
                height = if h == 0. || h.is_nan() { height } else { h }
            }
        }
        Some(t) if t != ElementType::Selection => height = aw * sign(height),
        _ => {}
    }
    (width, height)
}

/// `getLockedLinearCursorAlignSize`: the line from the origin to the cursor
/// snapped to 15° steps (or to `custom_angle` when close).
pub fn get_locked_linear_cursor_align_size(
    ox: f64,
    oy: f64,
    x: f64,
    y: f64,
    custom_angle: Option<f64>,
) -> (f64, f64) {
    let (mut width, mut height) = (x - ox, y - oy);
    let angle = height.atan2(width);
    let mut locked = js_round(angle / SHIFT_LOCKING_ANGLE) * SHIFT_LOCKING_ANGLE;
    if let Some(custom) = custom_angle.filter(|&a| a != 0.) {
        let lower = (custom / SHIFT_LOCKING_ANGLE).floor() * SHIFT_LOCKING_ANGLE;
        if radians_between_angles(angle, lower, lower + SHIFT_LOCKING_ANGLE) {
            locked = if radians_difference(angle, custom) < SHIFT_LOCKING_ANGLE / 6. {
                custom
            } else if normalize_radians(angle) > normalize_radians(custom) {
                lower + SHIFT_LOCKING_ANGLE
            } else {
                lower
            };
        }
    }
    if locked == 0. {
        height = 0.
    } else if locked == PI / 2. {
        width = 0.
    } else {
        let (a1, b1) = (locked.tan(), -1.);
        let c1 = oy - a1 * ox;
        let (a2, b2) = (-1. / a1, -1.);
        let c2 = y - a2 * x;
        let ix = (b1 * c2 - b2 * c1) / (a1 * b2 - a2 * b1);
        let iy = (c1 * a2 - c2 * a1) / (a1 * b2 - a2 * b1);
        width = ix - ox;
        height = iy - oy;
    }
    (width, height)
}
