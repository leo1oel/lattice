// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Viewport math: zoom, scroll, coordinate conversion. Port of Excalidraw
//! @ 3a317b5 `packages/excalidraw/viewport.ts`, `scene/normalize.ts`
//! (`getNormalizedZoom`, grid normalizing lives in `restore.rs`),
//! `common/src/utils.ts` (`viewportCoordsToSceneCoords`,
//! `sceneCoordsToViewportCoords`), the zoom steps of
//! `actions/actionCanvas.tsx` and `element/src/sizeHelpers.ts`
//! (`isElementInViewport`, over bounds).
//!
//! Pure functions: the viewport size and the canvas offset in the window are
//! passed in (`Canvas`). Element bounds come from the caller (the bounds
//! module), so `getScrollToContentState` takes them as arguments. Animation
//! and the "follow user" collaboration hooks of `App.viewport.ts` are left to
//! the app.

use super::consts::{MAX_ZOOM, MIN_ZOOM, ZOOM_STEP};
use super::math::{RoundFn, clamp, round, round_to_step};

/// `[minX, minY, maxX, maxY]` in scene coordinates.
pub type Bounds = [f64; 4];

/// The scene-to-screen transform the board keeps in `AppState`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub zoom: f64,
}

/// Where the canvas sits and how big it is: `offsetLeft` / `offsetTop` /
/// `width` / `height`.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Canvas {
    pub offset_left: f64,
    pub offset_top: f64,
    pub width: f64,
    pub height: f64,
}

/// Per-side insets in screen px (`Offsets`): UI covering the canvas edges.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Offsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// `ScrollConstraints`: a scene box the viewport is locked to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollConstraints {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub lock_scroll: bool,
    pub lock_zoom: bool,
    /// The minimum zoom when `lock_zoom`.
    pub zoom: f64,
    pub offsets: Option<Offsets>,
    /// Rubberband give past the lock, screen px.
    pub overscroll: f64,
}

/// `DEFAULT_OVERSCROLL`: rubberband give for scroll locks, screen px.
pub const DEFAULT_OVERSCROLL: f64 = 150.;

/// `getNormalizedZoom`: rounded to 6 decimals, within `MIN_ZOOM..MAX_ZOOM`.
pub fn get_normalized_zoom(zoom: f64) -> f64 {
    clamp(round(zoom, 6, RoundFn::Round), MIN_ZOOM, MAX_ZOOM)
}

/// `viewportCoordsToSceneCoords`: window (client) coordinates to scene.
pub fn viewport_coords_to_scene_coords(client: [f64; 2], v: Viewport, c: Canvas) -> [f64; 2] {
    [
        (client[0] - c.offset_left) / v.zoom - v.scroll_x,
        (client[1] - c.offset_top) / v.zoom - v.scroll_y,
    ]
}

/// `sceneCoordsToViewportCoords`.
pub fn scene_coords_to_viewport_coords(scene: [f64; 2], v: Viewport, c: Canvas) -> [f64; 2] {
    [
        (scene[0] + v.scroll_x) * v.zoom + c.offset_left,
        (scene[1] + v.scroll_y) * v.zoom + c.offset_top,
    ]
}

/// `constrainScrollAxis`: keeps the visible span `[-scroll, -scroll + visible]`
/// inside the box widened by the offsets; a box smaller than the view rests
/// centered. `overscroll` widens the allowed range on both sides.
fn constrain_scroll_axis(
    scroll: f64,
    box_start: f64,
    box_size: f64,
    visible: f64,
    offset_start: f64,
    offset_end: f64,
    overscroll: f64,
) -> f64 {
    let max = -box_start + offset_start;
    let min = visible - (box_start + box_size) - offset_end;
    if min > max {
        let center = (min + max) / 2.;
        return clamp(scroll, center - overscroll, center + overscroll);
    }
    clamp(scroll, min - overscroll, max + overscroll)
}

/// `constrainScrollState`: clamps scroll and zoom against the lock, if any.
/// `overscroll` (screen px) is rubberband give; 0 for a hard clamp.
pub fn constrain_scroll_state(
    v: Viewport,
    c: Canvas,
    constraints: Option<&ScrollConstraints>,
    overscroll: f64,
) -> Viewport {
    let Some(sc) = constraints else { return v };
    let min_zoom = if sc.lock_zoom { sc.zoom } else { MIN_ZOOM };
    let zoom = get_normalized_zoom(clamp(v.zoom, min_zoom, MAX_ZOOM));
    if !sc.lock_scroll {
        return Viewport { zoom, ..v };
    }
    let give = overscroll.max(0.) / zoom;
    let o = sc.offsets.unwrap_or_default();
    Viewport {
        scroll_x: constrain_scroll_axis(
            v.scroll_x,
            sc.x,
            sc.width,
            c.width / zoom,
            o.left / zoom,
            o.right / zoom,
            give,
        ),
        scroll_y: constrain_scroll_axis(
            v.scroll_y,
            sc.y,
            sc.height,
            c.height / zoom,
            o.top / zoom,
            o.bottom / zoom,
            give,
        ),
        zoom,
    }
}

/// `getViewportForZoom`: zooms to `next_zoom` keeping the window point
/// `(viewport_x, viewport_y)` over the same scene point.
pub fn get_viewport_for_zoom(
    viewport_x: f64,
    viewport_y: f64,
    next_zoom: f64,
    v: Viewport,
    c: Canvas,
) -> Viewport {
    let (ax, ay) = (viewport_x - c.offset_left, viewport_y - c.offset_top);
    let z = v.zoom;
    // scroll without zoom, then the offsets for the target zoom
    let base_x = v.scroll_x + (ax - ax / z);
    let base_y = v.scroll_y + (ay - ay / z);
    Viewport {
        scroll_x: base_x - (ax - ax / next_zoom),
        scroll_y: base_y - (ay - ay / next_zoom),
        zoom: next_zoom,
    }
}

/// `getViewportForZoomWithScrollConstraints`: a focal-point zoom resolved
/// against the lock, keeping the current rubberband displacement in screen
/// px. Without constraints this is `get_viewport_for_zoom`.
pub fn get_viewport_for_zoom_with_scroll_constraints(
    viewport_x: f64,
    viewport_y: f64,
    next_zoom: f64,
    v: Viewport,
    c: Canvas,
    constraints: Option<&ScrollConstraints>,
) -> Viewport {
    let resting = constrain_scroll_state(v, c, constraints, 0.);
    let over_x = (v.scroll_x - resting.scroll_x) * v.zoom;
    let over_y = (v.scroll_y - resting.scroll_y) * v.zoom;
    let zoomed = constrain_scroll_state(
        get_viewport_for_zoom(viewport_x, viewport_y, next_zoom, v, c),
        c,
        constraints,
        0.,
    );
    let Some(sc) = constraints.filter(|sc| sc.lock_scroll && (over_x != 0. || over_y != 0.)) else {
        return zoomed;
    };
    let z = zoomed.zoom;
    constrain_scroll_state(
        Viewport {
            scroll_x: zoomed.scroll_x + over_x / z,
            scroll_y: zoomed.scroll_y + over_y / z,
            zoom: z,
        },
        c,
        constraints,
        sc.overscroll,
    )
}

/// The window point a zoom keeps in place by default (`getZoomAnchor`): the
/// canvas center.
pub fn zoom_anchor(c: Canvas) -> [f64; 2] {
    [c.width / 2. + c.offset_left, c.height / 2. + c.offset_top]
}

/// `actionZoomIn`: one `ZOOM_STEP` in, about `anchor` (default: center).
pub fn zoom_in(
    v: Viewport,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> Viewport {
    let [x, y] = anchor.unwrap_or_else(|| zoom_anchor(c));
    get_viewport_for_zoom_with_scroll_constraints(
        x,
        y,
        get_normalized_zoom(v.zoom + ZOOM_STEP),
        v,
        c,
        constraints,
    )
}

/// `actionZoomOut`.
pub fn zoom_out(
    v: Viewport,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> Viewport {
    let [x, y] = anchor.unwrap_or_else(|| zoom_anchor(c));
    get_viewport_for_zoom_with_scroll_constraints(
        x,
        y,
        get_normalized_zoom(v.zoom - ZOOM_STEP),
        v,
        c,
        constraints,
    )
}

/// `actionResetZoom`: back to 100% (or the locked minimum zoom).
pub fn reset_zoom(
    v: Viewport,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> Viewport {
    let [x, y] = anchor.unwrap_or_else(|| zoom_anchor(c));
    let next = constraints
        .filter(|sc| sc.lock_zoom)
        .map_or(1., |sc| sc.zoom);
    get_viewport_for_zoom_with_scroll_constraints(
        x,
        y,
        get_normalized_zoom(next),
        v,
        c,
        constraints,
    )
}

/// `fit` of `zoomToFitBounds` (CSS `object-fit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// Fit, never zooming past 100%.
    ScaleDown,
    /// Fill the viewport (may exceed 100%).
    Contain,
    /// Keep the zoom, only center.
    None,
}

/// `zoomValueToFitBoundsOnViewport`.
fn zoom_value_to_fit_bounds(b: Bounds, width: f64, height: f64) -> f64 {
    let for_width = width / (b[2] - b[0]);
    let for_height = height / (b[3] - b[1]);
    for_width.min(for_height).min(1.)
}

/// Options of `zoomToFitBounds`; `Default` is upstream's defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FitOpts {
    pub fit: Fit,
    pub offsets: Option<Offsets>,
    pub min_zoom: f64,
    pub max_zoom: f64,
    pub stepped_zoom: bool,
}
impl Default for FitOpts {
    fn default() -> Self {
        FitOpts {
            fit: Fit::ScaleDown,
            offsets: None,
            min_zoom: f64::NEG_INFINITY,
            max_zoom: f64::INFINITY,
            stepped_zoom: false,
        }
    }
}

/// `zoomToFitBounds`: the viewport that centers `bounds` and fits them per
/// `fit`, within the canvas less the offsets. Upstream's result is captured
/// `EVENTUALLY` (not undoable).
pub fn zoom_to_fit_bounds(bounds: Bounds, v: Viewport, c: Canvas, o: FitOpts) -> Viewport {
    let [x1, y1, x2, y2] = bounds;
    let off = o.offsets.unwrap_or_default();
    let w = c.width - off.left - off.right;
    let h = c.height - off.top - off.bottom;
    let zoom = match o.fit {
        Fit::None => v.zoom,
        Fit::Contain => (w / (x2 - x1)).min(h / (y2 - y1)),
        Fit::ScaleDown => zoom_value_to_fit_bounds(bounds, w, h),
    };
    let target = if o.stepped_zoom && o.fit != Fit::None {
        round_to_step(zoom, ZOOM_STEP, RoundFn::Floor)
    } else {
        zoom
    };
    let zoom = get_normalized_zoom(clamp(target, o.min_zoom, o.max_zoom));
    let (scroll_x, scroll_y) = center_scroll_on(
        [(x1 + x2) / 2., (y1 + y2) / 2.],
        c.width,
        c.height,
        zoom,
        o.offsets,
    );
    Viewport {
        scroll_x,
        scroll_y,
        zoom,
    }
}

/// `actionZoomToFit` / `actionZoomToFitSelection(InViewport)`: fit `bounds`
/// (the elements', the selection's, or the lock box), then re-clamp to the
/// lock. `fit` is `ScaleDown` for zoom-to-fit and fit-in-viewport,
/// `Contain` for zoom-to-selection.
pub fn zoom_to_fit(
    bounds: Bounds,
    fit: Fit,
    v: Viewport,
    c: Canvas,
    offsets: Option<Offsets>,
    constraints: Option<&ScrollConstraints>,
) -> Viewport {
    let r = zoom_to_fit_bounds(
        bounds,
        v,
        c,
        FitOpts {
            fit,
            offsets,
            ..Default::default()
        },
    );
    constrain_scroll_state(r, c, constraints, 0.)
}

/// The box a lock constrains to (`getScrollConstraintsBounds`); zoom to fit
/// targets it instead of the elements under a lock.
pub fn scroll_constraints_bounds(sc: &ScrollConstraints) -> Bounds {
    [sc.x, sc.y, sc.x + sc.width, sc.y + sc.height]
}

/// `centerScrollOn`: the scroll that puts `scene_point` at the center of the
/// canvas less the offsets. Returns `(scrollX, scrollY)`.
pub fn center_scroll_on(
    scene_point: [f64; 2],
    width: f64,
    height: f64,
    zoom: f64,
    offsets: Option<Offsets>,
) -> (f64, f64) {
    let o = offsets.unwrap_or_default();
    let x = (width - o.right) / 2. / zoom - scene_point[0] + o.left / 2. / zoom;
    let y = (height - o.bottom) / 2. / zoom - scene_point[1] + o.top / 2. / zoom;
    (x, y)
}

/// What `scroll_bounds_into_view` does along an axis the bounds don't fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TooLarge {
    AlignStart,
    Leave,
}

/// `scrollBoundsIntoView`: the scroll that brings `bounds` into the canvas
/// less `offsets` by the least movement, keeping the zoom; None when they are
/// in view already (or the offsets leave no room). Returns `(scrollX, scrollY)`.
pub fn scroll_bounds_into_view(
    bounds: Bounds,
    v: Viewport,
    width: f64,
    height: f64,
    offsets: Option<Offsets>,
    too_large: TooLarge,
) -> Option<(f64, f64)> {
    let [x1, y1, x2, y2] = bounds;
    let o = offsets.unwrap_or_default();
    let (left, right, top, bottom) = (o.left, width - o.right, o.top, height - o.bottom);
    if right <= left || bottom <= top {
        return None;
    }
    // screen px to move a span into [start, end]
    let shift = |s0: f64, s1: f64, scroll: f64, start: f64, end: f64| {
        let (a, b) = ((s0 + scroll) * v.zoom, (s1 + scroll) * v.zoom);
        if b - a > end - start {
            return if too_large == TooLarge::AlignStart {
                start - a
            } else {
                0.
            };
        }
        if b > end {
            return end - b;
        }
        if a < start {
            return start - a;
        }
        0.
    };
    let dx = shift(x1, x2, v.scroll_x, left, right);
    let dy = shift(y1, y2, v.scroll_y, top, bottom);
    if dx == 0. && dy == 0. {
        return None;
    }
    Some((v.scroll_x + dx / v.zoom, v.scroll_y + dy / v.zoom))
}

/// `doBoundsExceedViewport`.
pub fn do_bounds_exceed_viewport(b: Bounds, v: Viewport, c: Canvas) -> bool {
    (b[2] - b[0]) * v.zoom > c.width || (b[3] - b[1]) * v.zoom > c.height
}

/// `getScrollToContentState`: centers the visible elements' `common` bounds;
/// when they don't fit, centers the element closest to the view center
/// instead (`closest` gets that center in scene coordinates and returns the
/// element's bounds, `getClosestElementBounds`). `common` is None when there
/// are no visible elements. Returns `(scrollX, scrollY)`.
pub fn get_scroll_to_content_state(
    common: Option<Bounds>,
    closest: impl FnOnce([f64; 2]) -> Bounds,
    v: Viewport,
    c: Canvas,
) -> (f64, f64) {
    let Some(mut b) = common else { return (0., 0.) };
    if do_bounds_exceed_viewport(b, v, c) {
        b = closest(viewport_coords_to_scene_coords(
            [c.offset_left + c.width / 2., c.offset_top + c.height / 2.],
            v,
            c,
        ));
    }
    center_scroll_on(
        [(b[0] + b[2]) / 2., (b[1] + b[3]) / 2.],
        c.width,
        c.height,
        v.zoom,
        None,
    )
}

/// `isElementInViewport` over the element's scene bounds.
pub fn is_bounds_in_viewport(b: Bounds, v: Viewport, c: Canvas) -> bool {
    let tl = viewport_coords_to_scene_coords([c.offset_left, c.offset_top], v, c);
    let br =
        viewport_coords_to_scene_coords([c.offset_left + c.width, c.offset_top + c.height], v, c);
    tl[0] <= b[2] && tl[1] <= b[3] && br[0] >= b[0] && br[1] >= b[1]
}

/// The visible scene rectangle `[minX, minY, maxX, maxY]` (for culling).
pub fn visible_scene_bounds(v: Viewport, c: Canvas) -> Bounds {
    let tl = viewport_coords_to_scene_coords([c.offset_left, c.offset_top], v, c);
    let br =
        viewport_coords_to_scene_coords([c.offset_left + c.width, c.offset_top + c.height], v, c);
    [tl[0], tl[1], br[0], br[1]]
}

impl super::app_state::AppState {
    pub fn viewport(&self) -> Viewport {
        Viewport {
            scroll_x: self.scroll_x,
            scroll_y: self.scroll_y,
            zoom: self.zoom,
        }
    }
    pub fn set_viewport(&mut self, v: Viewport) {
        (self.scroll_x, self.scroll_y, self.zoom) = (v.scroll_x, v.scroll_y, v.zoom);
    }
}
