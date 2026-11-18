// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Arrow bindings. Port of Excalidraw `element/src/binding.ts` @ 3a317b5,
//! with the binding half of `element/src/utils.ts` (midpoint snapping,
//! `projectFixedPointOntoDiagonal`) and `LinearElementEditor.movePoints`
//! (`linearElementEditor.ts`), which binding is the first to need.
//!
//! Differences from upstream:
//! - elements are looked up by id; functions that change elements take a
//!   `BindingStore` (a `Scene`, a history `ElementMap` or a plain `Vec`) and
//!   re-read what they changed, where upstream mutates shared objects;
//! - `BindingStrategy` names its element by id;
//! - what upstream reads from `appState` (and the linear editor's
//!   `initialState`) comes in a `BindingCtx`; `getFeatureFlag
//!   ("COMPLEX_BINDINGS")` is `BindingCtx::complex_bindings` (off, as
//!   upstream's default);
//! - elbow routing (`updateElbowArrowPoints`, elbow.rs) and relaying arrow
//!   labels (`handleBindTextResize`, textElement.ts) go through
//!   `BindingHooks`, called where upstream calls them (directly or from
//!   inside `mutateElement` for elbow arrows); the defaults route elbow
//!   arrows with `elbow::update_elbow_arrow_points` and leave labels as
//!   they are;
//! - `getSimultaneouslyUpdatedElementIds` has no cache (a perf detail of
//!   upstream's event loop);
//! - `BoundElement` / `BindableElement` `rebindAffected` live in history.rs,
//!   their only user; the visitors are shared from here.

use super::app_state::AppState;
use super::bounds::*;
use super::collision::*;
use super::deconstruct::{
    deconstruct_diamond_element, deconstruct_rectanguloid_element, get_all_midpoints,
};
use super::heading::*;
use super::history::{ElementMap, HistoryHooks};
use super::math::*;
use super::scene::Scene;
use super::types::*;
use super::utils::{ElementsMap, get_grid_point, get_size_from_points, is_transparent};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;

pub use super::collision::{BASE_BINDING_GAP, max_binding_distance_simple};
pub use super::utils::normalize_fixed_point;

pub const BASE_ARROW_MIN_LENGTH: f64 = 10.;
pub const FOCUS_POINT_SIZE: f64 = 10. / 1.5;
/// Below this size (in px) a bindable element has no meaningful interior to
/// anchor a proportional fixedPoint into.
const MIN_BINDABLE_SIZE: f64 = 1.;

// ---------------------------------------------------------------------------
// stores, hooks, context
// ---------------------------------------------------------------------------

/// Where binding reads and changes elements (upstream: `Scene`, or
/// `mutateElement` on a map's elements).
pub trait BindingStore: ElementsMap {
    /// `scene.mutateElement` / `mutateElement` on the element with `id`.
    /// Returns whether it changed.
    fn update(&mut self, id: &str, f: &mut dyn FnMut(&mut Element)) -> bool;
}
impl BindingStore for Scene {
    fn update(&mut self, id: &str, f: &mut dyn FnMut(&mut Element)) -> bool {
        self.mutate_element(id, true, f)
    }
}
impl BindingStore for ElementMap {
    fn update(&mut self, id: &str, f: &mut dyn FnMut(&mut Element)) -> bool {
        self.mutate(id, f)
    }
}
impl BindingStore for Vec<Element> {
    fn update(&mut self, id: &str, f: &mut dyn FnMut(&mut Element)) -> bool {
        self.iter_mut()
            .find(|e| e.id == id)
            .is_some_and(|e| super::mutate::mutate_element(e, f))
    }
}

/// `ElementUpdate<ExcalidrawElbowArrowElement>`: what elbow routing reads
/// (`points`, `fixedSegments`, bindings) and returns. `Some` sets a field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ElbowUpdate {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub points: Option<Vec<Point>>,
    pub fixed_segments: Option<Option<Vec<FixedSegment>>>,
    pub start_binding: Option<Option<FixedPointBinding>>,
    pub end_binding: Option<Option<FixedPointBinding>>,
    pub start_is_special: Option<Option<bool>>,
    pub end_is_special: Option<Option<bool>>,
}

impl ElbowUpdate {
    pub fn apply(&self, e: &mut Element) {
        if let Some(x) = self.x {
            e.x = x;
        }
        if let Some(y) = self.y {
            e.y = y;
        }
        if let Some(w) = self.width {
            e.width = w;
        }
        if let Some(h) = self.height {
            e.height = h;
        }
        if let Some(l) = e.linear_mut() {
            if let Some(p) = &self.points {
                l.points = p.clone();
            }
            if let Some(b) = &self.start_binding {
                l.start_binding = b.clone();
            }
            if let Some(b) = &self.end_binding {
                l.end_binding = b.clone();
            }
        }
        if let Some(el) = e.elbow_mut() {
            if let Some(f) = &self.fixed_segments {
                el.fixed_segments = f.clone();
            }
            if let Some(s) = self.start_is_special {
                el.start_is_special = s;
            }
            if let Some(s) = self.end_is_special {
                el.end_is_special = s;
            }
        }
    }
}

/// `updateElbowArrowPoints`' options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ElbowOptions {
    pub is_dragging: bool,
    pub is_binding_enabled: Option<bool>,
    pub is_midpoint_snapping_enabled: Option<bool>,
}

/// Elbow "routing" that doesn't route: the updates as given, sized to their
/// points (for hooks that want elbow arrows left as they are).
pub fn no_elbow_routing(updates: &ElbowUpdate) -> ElbowUpdate {
    let mut u = updates.clone();
    if let Some(p) = &u.points
        && u.width.is_none()
        && u.height.is_none()
    {
        let (w, h) = get_size_from_points(p);
        (u.width, u.height) = (Some(w), Some(h));
    }
    u
}

/// What binding calls in other modules: elbow routing and label layout.
pub trait BindingHooks {
    /// `updateElbowArrowPoints(arrow, elementsMap, updates, options)`
    /// (elbowArrow.ts): routes an elbow arrow. `arrow` has `x`/`y` from
    /// `updates` applied; the result is applied over `updates` (with angle
    /// 0), as upstream's `mutateElement` does. Default: elbow.rs routes it.
    fn update_elbow_arrow_points(
        &self,
        arrow: &Element,
        map: &dyn ElementsMap,
        updates: &ElbowUpdate,
        opts: &ElbowOptions,
    ) -> ElbowUpdate {
        super::elbow::update_elbow_arrow_points(arrow, map, updates, opts)
    }
    /// `handleBindTextResize(arrow, scene, false, false, false, false)`
    /// (textElement.ts): re-lay out the label of the arrow `arrow_id` along
    /// it as placed. Default: leave it.
    fn handle_bind_text_resize(&self, _arrow_id: &str, _store: &mut dyn BindingStore) {}
}

/// The defaults: elbow routing, no label layout.
pub struct NoBindingHooks;
impl BindingHooks for NoBindingHooks {}
pub static NO_BINDING_HOOKS: NoBindingHooks = NoBindingHooks;

/// The part of the linear editor's `initialState` binding reads while an
/// endpoint is dragged.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LinearDragState {
    pub origin: Option<Point>,
    pub arrow_start_is_inside: bool,
    pub alt_focus_point: Option<Point>,
    pub arrow_other_endpoint_initial_binding: Option<FixedPointBinding>,
}

/// What binding reads from `appState`, plus the hooks.
#[derive(Clone, Copy)]
pub struct BindingCtx<'a> {
    pub zoom: f64,
    pub is_binding_enabled: bool,
    pub is_midpoint_snapping_enabled: bool,
    pub grid_mode_enabled: bool,
    pub grid_size: f64,
    pub bind_mode: BindMode,
    pub complex_bindings: bool,
    /// `appState.selectedLinearElement?.initialState`.
    pub drag: Option<&'a LinearDragState>,
    pub hooks: &'a dyn BindingHooks,
}

impl Default for BindingCtx<'static> {
    fn default() -> Self {
        BindingCtx {
            zoom: 1.,
            is_binding_enabled: true,
            is_midpoint_snapping_enabled: true,
            grid_mode_enabled: false,
            grid_size: 20.,
            bind_mode: BindMode::Orbit,
            complex_bindings: false,
            drag: None,
            hooks: &NO_BINDING_HOOKS,
        }
    }
}

impl BindingCtx<'static> {
    /// From the app state.
    pub fn from_app(a: &AppState) -> Self {
        BindingCtx {
            zoom: a.zoom,
            is_binding_enabled: a.is_binding_enabled,
            is_midpoint_snapping_enabled: a.is_midpoint_snapping_enabled,
            grid_mode_enabled: a.grid_mode_enabled,
            grid_size: a.grid_size,
            bind_mode: a.bind_mode,
            ..Default::default()
        }
    }
}

/// `BindingStrategy`.
#[derive(Clone, Debug, PartialEq)]
pub enum BindingStrategy {
    /// Create a new binding with this mode.
    Bind {
        mode: BindMode,
        element: String,
        focus_point: Point,
    },
    /// Break the binding (`mode: null`).
    Unbind,
    /// Keep the existing binding (`mode: undefined`).
    Keep,
}

impl BindingStrategy {
    pub fn mode(&self) -> Option<BindMode> {
        if let BindingStrategy::Bind { mode, .. } = self {
            Some(*mode)
        } else {
            None
        }
    }
    pub fn element(&self) -> Option<&str> {
        if let BindingStrategy::Bind { element, .. } = self {
            Some(element)
        } else {
            None
        }
    }
    pub fn focus_point(&self) -> Option<Point> {
        if let BindingStrategy::Bind { focus_point, .. } = self {
            Some(*focus_point)
        } else {
            None
        }
    }
    fn bind(mode: BindMode, e: &Element, focus_point: Point) -> Self {
        BindingStrategy::Bind {
            mode,
            element: e.id.clone(),
            focus_point,
        }
    }
}

/// One dragged point (`PointsPositionUpdates` entry).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointUpdate {
    pub point: Point,
    pub is_dragging: bool,
}
impl PointUpdate {
    pub fn at(point: Point) -> Self {
        PointUpdate {
            point,
            is_dragging: false,
        }
    }
}
/// `PointsPositionUpdates`: point index → new local position.
pub type PointsPositionUpdates = BTreeMap<usize, PointUpdate>;

/// The pointer state `bindOrUnbindBindingElement` and the strategies read.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BindOpts {
    pub new_arrow: bool,
    pub alt_key: bool,
    pub angle_locked: bool,
    pub shift_key: bool,
    pub finalize: bool,
    pub initial_binding: bool,
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn other_end(s: StartOrEnd) -> StartOrEnd {
    match s {
        StartOrEnd::Start => StartOrEnd::End,
        StartOrEnd::End => StartOrEnd::Start,
    }
}
fn end_idx(s: StartOrEnd) -> isize {
    if s == StartOrEnd::Start { 0 } else { -1 }
}
fn adjacent_idx(s: StartOrEnd) -> isize {
    if s == StartOrEnd::Start { 1 } else { -2 }
}
pub fn binding_of(arrow: &Element, s: StartOrEnd) -> Option<&FixedPointBinding> {
    arrow.linear().and_then(|l| {
        if s == StartOrEnd::Start {
            l.start_binding.as_ref()
        } else {
            l.end_binding.as_ref()
        }
    })
}
fn set_binding(arrow: &mut Element, s: StartOrEnd, b: Option<FixedPointBinding>) {
    if let Some(l) = arrow.linear_mut() {
        if s == StartOrEnd::Start {
            l.start_binding = b
        } else {
            l.end_binding = b
        }
    }
}
fn live<'a>(map: &'a dyn ElementsMap, id: &str) -> Option<&'a Element> {
    map.get_element(id).filter(|e| !e.is_deleted)
}
fn pts(e: &Element) -> &[Point] {
    e.points().unwrap_or(&[])
}
fn hits(e: &Element, map: &dyn ElementsMap, s: Segment, offset: f64) -> Vec<Point> {
    intersect_element_with_line_segment(e, map, s, offset, false)
}
/// The first of the points nearest `to` (a stable sort's `[0]`).
fn nearest(ps: Vec<Point>, to: Point) -> Option<Point> {
    ps.into_iter()
        .min_by(|a, b| point_distance_sq(*a, to).total_cmp(&point_distance_sq(*b, to)))
}
/// `hitElementItself` with `overrideShouldTestInside`.
fn hit_inside(p: Point, e: &Element, threshold: f64, map: &dyn ElementsMap) -> bool {
    hit_element_itself(&HitTestArgs {
        override_should_test_inside: true,
        ..HitTestArgs::new(p, e, threshold, map)
    })
}
/// JS `a || b` on numbers.
fn or(a: Option<f64>, b: f64) -> f64 {
    match a {
        Some(v) if v != 0. && !v.is_nan() => v,
        _ => b,
    }
}

/// `getBindingGap`: from the bind target's stroke width only, so it can be
/// computed for a target not created yet.
pub fn get_binding_gap(stroke_width: f64) -> f64 {
    BASE_BINDING_GAP + stroke_width / 2.
}
fn gap(e: &Element) -> f64 {
    get_binding_gap(e.stroke_width)
}

pub fn is_binding_enabled(ctx: &BindingCtx) -> bool {
    ctx.is_binding_enabled
}

// ---------------------------------------------------------------------------
// binding / unbinding while dragging
// ---------------------------------------------------------------------------

/// `bindOrUnbindBindingElement`: decides and applies the bindings of the
/// arrow `arrow_id` whose points in `dragging` are being dragged.
pub fn bind_or_unbind_binding_element(
    arrow_id: &str,
    dragging: &PointsPositionUpdates,
    scene_pointer: Point,
    scene: &mut Scene,
    ctx: &BindingCtx,
    opts: &BindOpts,
) -> (BindingStrategy, BindingStrategy) {
    let Some(arrow) = scene.get_non_deleted_element(arrow_id).cloned() else {
        return (BindingStrategy::Keep, BindingStrategy::Keep);
    };
    let (start, end) = get_binding_strategy_for_dragging_binding_element_endpoints(
        &arrow,
        dragging,
        scene_pointer,
        &*scene,
        scene.elements_including_deleted(),
        ctx,
        &BindOpts {
            finalize: true,
            ..*opts
        },
    );
    let midpoint_snapping =
        ctx.is_midpoint_snapping_enabled && !opts.angle_locked && !ctx.grid_mode_enabled;
    bind_or_unbind_binding_element_edge(
        arrow_id,
        &start,
        StartOrEnd::Start,
        scene,
        ctx,
        ctx.is_binding_enabled,
        midpoint_snapping,
    );
    bind_or_unbind_binding_element_edge(
        arrow_id,
        &end,
        StartOrEnd::End,
        scene,
        ctx,
        ctx.is_binding_enabled,
        midpoint_snapping,
    );
    if start.focus_point().is_some() || end.focus_point().is_some() {
        // the strategy overrides the focus point: point the ends at it
        let arrow = scene.get_element(arrow_id).unwrap().clone();
        let n = pts(&arrow).len();
        let mut updates = PointsPositionUpdates::new();
        for (s, strat, idx) in [
            (StartOrEnd::Start, &start, 0),
            (StartOrEnd::End, &end, n.saturating_sub(1)),
        ] {
            let Some(id) = strat.element() else { continue };
            let p = scene.get_element(id).and_then(|b| {
                update_bound_point(&arrow, s, binding_of(&arrow, s), b, scene, false)
            });
            updates.insert(idx, PointUpdate::at(p.unwrap_or(pts(&arrow)[idx])));
        }
        move_points(
            arrow_id,
            scene,
            &updates,
            None,
            &MovePointsOpts::default(),
            ctx.hooks,
        );
    }
    (start, end)
}

fn bind_or_unbind_binding_element_edge(
    arrow_id: &str,
    strat: &BindingStrategy,
    s: StartOrEnd,
    store: &mut dyn BindingStore,
    ctx: &BindingCtx,
    snap_to_outline: bool,
    midpoint_snapping: bool,
) {
    match strat {
        BindingStrategy::Unbind => {
            unbind_binding_element(arrow_id, s, store);
        }
        BindingStrategy::Bind {
            mode,
            element,
            focus_point,
        } => bind_binding_element(
            arrow_id,
            element,
            *mode,
            s,
            store,
            ctx.zoom,
            Some(*focus_point),
            snap_to_outline,
            midpoint_snapping,
        ),
        BindingStrategy::Keep => {}
    }
}

fn binding_strategy_for_elbow_arrow_endpoint_dragging(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    map: &dyn ElementsMap,
    elements: &[Element],
    zoom: f64,
) -> (BindingStrategy, BindingStrategy) {
    debug_assert!(dragging.len() == 1, "Bound elbow arrows cannot be moved");
    let Some((&idx, u)) = dragging.iter().next() else {
        return (BindingStrategy::Keep, BindingStrategy::Keep);
    };
    let global = get_point_global_coordinates(arrow, u.point, map);
    let current = match get_hovered_element_for_binding(global, elements, map, zoom) {
        Some(hit) => BindingStrategy::bind(
            BindMode::Orbit,
            hit,
            get_point_at_index_global_coordinates(arrow, idx as isize, map),
        ),
        None => BindingStrategy::Unbind,
    };
    if idx == 0 {
        (current, BindingStrategy::Keep)
    } else {
        (BindingStrategy::Keep, current)
    }
}

fn binding_strategy_for_new_simple_arrow_endpoint_dragging(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    map: &dyn ElementsMap,
    elements: &[Element],
    start_dragged: bool,
    end_dragged: bool,
    start_idx: usize,
    end_idx: usize,
    ctx: &BindingCtx,
    shift_key: bool,
) -> (BindingStrategy, BindingStrategy) {
    use BindingStrategy::*;
    let multi = pts(arrow).len() > 2;
    let start_binding = binding_of(arrow, StartOrEnd::Start);
    let point = get_point_global_coordinates(
        arrow,
        dragging[&if start_dragged { start_idx } else { end_idx }].point,
        map,
    );
    let hit = get_hovered_element_for_binding(point, elements, map, ctx.zoom);
    // with new arrows this binds at creation
    if start_dragged {
        return (
            hit.map_or(Unbind, |h| {
                BindingStrategy::bind(BindMode::Inside, h, point)
            }),
            Keep,
        );
    }
    // the continuous dragging of the end point
    if end_dragged {
        let origin = ctx.drag.and_then(|d| d.origin);
        // inside -> inside binding
        if let Some(h) = hit
            && start_binding.is_some_and(|b| b.element_id == h.id)
        {
            let center = [h.x + h.width / 2., h.y + h.height / 2.];
            return (
                if multi {
                    Keep
                } else {
                    BindingStrategy::bind(BindMode::Inside, h, origin.unwrap_or(center))
                },
                BindingStrategy::bind(
                    if multi {
                        BindMode::Orbit
                    } else {
                        BindMode::Inside
                    },
                    h,
                    point,
                ),
            );
        }
        // nested shapes
        if let (Some(h), Some(sb)) = (hit, start_binding)
            && get_all_hovered_element_at_point(point, elements, map, ctx.zoom)
                .iter()
                .any(|e| e.id == sb.element_id)
            && let Some(other) = map.get_element(&sb.element_id)
        {
            return (
                if multi {
                    Keep
                } else {
                    BindingStrategy::bind(
                        if other.id != h.id {
                            BindMode::Orbit
                        } else {
                            BindMode::Inside
                        },
                        other,
                        origin.unwrap_or([arrow.x, arrow.y]),
                    )
                },
                BindingStrategy::bind(BindMode::Orbit, h, point),
            );
        }
        // inside -> outside binding
        if let Some(sb) = start_binding
            && hit.is_none_or(|h| h.id != sb.element_id)
        {
            let Some(other) = map.get_element(&sb.element_id) else {
                return (Keep, Keep);
            };
            let other_inside = ctx.drag.is_some_and(|d| d.arrow_start_is_inside);
            let o = BindingStrategy::bind(
                if other_inside {
                    BindMode::Inside
                } else {
                    BindMode::Orbit
                },
                other,
                if shift_key {
                    element_center_point(other, map, 0., 0.)
                } else {
                    origin.unwrap_or([arrow.x, arrow.y])
                },
            );
            let current = match hit {
                Some(h) => {
                    let nested = is_bindable_element_inside_other_bindable(other, h, map);
                    let inside = matches!(ctx.bind_mode, BindMode::Inside | BindMode::Skip);
                    BindingStrategy::bind(
                        if inside && !nested {
                            BindMode::Inside
                        } else {
                            BindMode::Orbit
                        },
                        h,
                        point,
                    )
                }
                None => Unbind,
            };
            return (if multi { Keep } else { o }, current);
        }
        // no start binding
        if start_binding.is_none() {
            let inside = matches!(ctx.bind_mode, BindMode::Inside | BindMode::Skip);
            return (
                Keep,
                hit.map_or(Unbind, |h| {
                    BindingStrategy::bind(
                        if inside {
                            BindMode::Inside
                        } else {
                            BindMode::Orbit
                        },
                        h,
                        point,
                    )
                }),
            );
        }
    }
    debug_assert!(false, "New arrow creation should not reach here");
    (Keep, Keep)
}

fn binding_strategy_for_simple_arrow_endpoint_dragging_complex(
    point: Point,
    current_binding: Option<&FixedPointBinding>,
    opposite: Option<&FixedPointBinding>,
    map: &dyn ElementsMap,
    elements: &[Element],
    bind_mode: BindMode,
    arrow: &Element,
    zoom: f64,
    finalize: bool,
) -> (BindingStrategy, BindingStrategy) {
    use BindingStrategy::*;
    let multi = pts(arrow).len() > 2;
    let hit = get_hovered_element_for_binding(point, elements, map, zoom);
    let overlapping = opposite.is_some_and(|o| {
        get_all_hovered_element_at_point(point, elements, map, zoom)
            .iter()
            .any(|e| e.id == o.element_id)
    });
    let opposite_el = opposite.and_then(|o| map.get_element(&o.element_id));
    let other_transparent =
        overlapping && opposite_el.is_some_and(|o| is_transparent(&o.background_color));
    // (upstream's `isNested` picks the pointer either way)
    let other_keep = |o: BindingStrategy| if multi { Keep } else { o };
    // free binding mode: bind where the pointer is, keep the other end
    if matches!(bind_mode, BindMode::Inside | BindMode::Skip) {
        let current = match hit {
            Some(h) => BindingStrategy::bind(
                BindMode::Inside,
                match opposite_el {
                    Some(o) if overlapping && !other_transparent => o,
                    _ => h,
                },
                point,
            ),
            None => Unbind,
        };
        let other = if finalize
            && hit.is_some_and(|h| Some(h.id.as_str()) == opposite.map(|o| o.element_id.as_str()))
        {
            Unbind
        } else {
            Keep
        };
        return (current, other);
    }
    // outside of any bindable element: break the binding
    let Some(h) = hit else { return (Unbind, Keep) };
    // already inside bound to the same element stays inside
    if current_binding.is_some_and(|c| c.element_id == h.id && c.mode == BindMode::Inside) {
        return (BindingStrategy::bind(BindMode::Inside, h, point), Keep);
    }
    if let Some(o) = opposite {
        if o.element_id == h.id {
            // the opposite end orbits the same element
            if o.mode == BindMode::Orbit {
                return (
                    BindingStrategy::bind(BindMode::Orbit, h, point),
                    other_keep(if finalize { Unbind } else { Keep }),
                );
            }
            return (
                BindingStrategy::bind(BindMode::Inside, h, point),
                other_keep(Keep),
            );
        }
        // the opposite end is on a different (or nested) element
        let current = match opposite_el {
            Some(oe) if overlapping && !other_transparent => {
                BindingStrategy::bind(BindMode::Inside, oe, point)
            }
            _ => BindingStrategy::bind(BindMode::Orbit, h, point),
        };
        return (current, other_keep(Keep));
    }
    (
        BindingStrategy::bind(BindMode::Orbit, h, point),
        other_keep(Keep),
    )
}

/// `getBindingStrategyForDraggingBindingElementEndpoints`: what to do with
/// each end's binding while the points in `dragging` move. `elements` in
/// z-order (deleted ones are skipped).
pub fn get_binding_strategy_for_dragging_binding_element_endpoints(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    scene_pointer: Point,
    map: &dyn ElementsMap,
    elements: &[Element],
    ctx: &BindingCtx,
    opts: &BindOpts,
) -> (BindingStrategy, BindingStrategy) {
    if ctx.complex_bindings {
        return strategy_complex(arrow, dragging, map, elements, ctx, opts);
    }
    strategy_simple(arrow, dragging, scene_pointer, map, elements, ctx, opts)
}

/// The checks both strategies start with; Some is the answer.
fn strategy_preamble(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    map: &dyn ElementsMap,
    elements: &[Element],
    ctx: &BindingCtx,
) -> Option<(BindingStrategy, BindingStrategy)> {
    use BindingStrategy::*;
    let n = pts(arrow).len();
    // a single point can't be bound
    if n < 2 {
        return Some((Keep, Keep));
    }
    let (sd, ed) = (dragging.contains_key(&0), dragging.contains_key(&(n - 1)));
    if !sd && !ed {
        return Some((Keep, Keep));
    }
    // both ends dragged: bind to nothing
    if sd && ed {
        return Some((Unbind, Unbind));
    }
    // binding disabled: a dragged end lets go
    if !is_binding_enabled(ctx) {
        return Some((
            if sd { Unbind } else { Keep },
            if ed { Unbind } else { Keep },
        ));
    }
    if arrow.is_elbow_arrow() {
        return Some(binding_strategy_for_elbow_arrow_endpoint_dragging(
            arrow, dragging, map, elements, ctx.zoom,
        ));
    }
    None
}

fn strategy_simple(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    [px, py]: Point,
    map: &dyn ElementsMap,
    elements: &[Element],
    ctx: &BindingCtx,
    opts: &BindOpts,
) -> (BindingStrategy, BindingStrategy) {
    use BindingStrategy::*;
    if let Some(r) = strategy_preamble(arrow, dragging, map, elements, ctx) {
        return r;
    }
    let n = pts(arrow).len();
    let (sd, ed) = (dragging.contains_key(&0), dragging.contains_key(&(n - 1)));
    let dragged = if sd {
        StartOrEnd::Start
    } else {
        StartOrEnd::End
    };
    let other_binding = binding_of(arrow, other_end(dragged));
    let local = dragging[&if sd { 0 } else { n - 1 }].point;
    let global = get_point_global_coordinates(arrow, local, map);
    let pointer = [px, py];
    let hit = get_hovered_element_for_binding(
        if opts.angle_locked || ctx.grid_mode_enabled {
            pointer
        } else {
            global
        },
        elements,
        map,
        ctx.zoom,
    );
    let point_in_element = hit.is_some_and(|h| {
        is_point_in_element(if opts.angle_locked { pointer } else { global }, h, map)
    });
    let other_el = other_binding.and_then(|b| map.get_element(&b.element_id));
    let other_focus = other_binding
        .zip(other_el)
        .map(|(b, e)| get_global_fixed_point_for_bindable_element(b.fixed_point, e, map));
    let other_focus_in = other_el
        .zip(other_focus)
        .is_some_and(|(e, f)| hit_inside(f, e, 0., map));
    let drag = ctx.drag;
    let other_initial = drag.and_then(|d| d.arrow_other_endpoint_initial_binding.as_ref());

    // outside-outside binding to the same element
    if let (Some(ob), Some(h)) = (other_binding, hit)
        && ob.element_id == h.id
        && (!opts.new_arrow || drag.is_some_and(|d| d.origin.is_some()))
    {
        let other_fp = |idx: isize| match other_el {
            Some(oe) => get_global_fixed_point_for_bindable_element(ob.fixed_point, oe, map),
            None => get_point_at_index_global_coordinates(arrow, idx, map),
        };
        let start_fp = if sd {
            global
        } else if opts.new_arrow {
            // only the start: new arrows always drag the end
            let o = drag.and_then(|d| d.origin).unwrap();
            get_grid_point(o[0], o[1], ctx.grid_mode_enabled.then_some(ctx.grid_size))
        } else {
            other_fp(0)
        };
        let end_fp = if ed { global } else { other_fp(-1) };
        return (
            BindingStrategy::bind(BindMode::Inside, h, start_fp),
            BindingStrategy::bind(BindMode::Inside, h, end_fp),
        );
    }

    // alt: bind inside no matter what
    if opts.alt_key {
        let b = || {
            hit.map_or(Unbind, |h| {
                BindingStrategy::bind(BindMode::Inside, h, global)
            })
        };
        return (if sd { b() } else { Keep }, if ed { b() } else { Keep });
    }

    let current = match hit {
        None => Unbind,
        Some(h) if point_in_element => BindingStrategy::bind(BindMode::Inside, h, global),
        Some(h) => {
            let target = if opts.angle_locked {
                global
            } else if ctx.grid_mode_enabled {
                snap_bound_point_to_grid(
                    pointer,
                    h,
                    map,
                    Some(ctx.grid_size),
                    Some(get_point_at_index_global_coordinates(
                        arrow,
                        if sd { 1 } else { -2 },
                        map,
                    )),
                )
            } else {
                global
            };
            let fp = project_fixed_point_onto_diagonal(
                arrow,
                target,
                h,
                dragged,
                map,
                ctx.zoom,
                ctx.is_midpoint_snapping_enabled && !opts.angle_locked && !ctx.grid_mode_enabled,
            );
            BindingStrategy::bind(BindMode::Orbit, h, fp.unwrap_or(global))
        }
    };
    let other_endpoint = get_point_at_index_global_coordinates(arrow, if sd { -1 } else { 0 }, map);
    let close_to_other = other_focus.is_some()
        && other_el
            .is_some_and(|oe| hit_inside(global, oe, max_binding_distance_simple(ctx.zoom), map));
    let other_was_inside = other_initial.is_some_and(|b| b.mode == BindMode::Inside);
    let never_override = if opts.new_arrow {
        drag.is_some_and(|d| d.arrow_start_is_inside)
    } else {
        other_binding.is_some_and(|b| b.mode == BindMode::Inside) && other_was_inside
    };
    let mut other = Keep;
    if !never_override && let Some(oe) = other_el {
        if other_binding.is_some_and(|b| b.mode == BindMode::Inside)
            && !other_was_inside
            && !opts.new_arrow
        {
            other =
                BindingStrategy::bind(BindMode::Orbit, oe, other_focus.unwrap_or(other_endpoint));
        } else if !other_focus_in
            && !close_to_other
            && let Some(alt) = drag.and_then(|d| d.alt_focus_point)
        {
            other = BindingStrategy::bind(BindMode::Orbit, oe, alt);
        } else if opts.angle_locked {
            let fp = project_fixed_point_onto_diagonal(
                arrow,
                other_endpoint,
                oe,
                other_end(dragged),
                map,
                ctx.zoom,
                ctx.is_midpoint_snapping_enabled,
            );
            other = BindingStrategy::bind(BindMode::Orbit, oe, fp.unwrap_or(other_endpoint));
        }
    }
    if sd {
        (current, other)
    } else {
        (other, current)
    }
}

fn strategy_complex(
    arrow: &Element,
    dragging: &PointsPositionUpdates,
    map: &dyn ElementsMap,
    elements: &[Element],
    ctx: &BindingCtx,
    opts: &BindOpts,
) -> (BindingStrategy, BindingStrategy) {
    use BindingStrategy::*;
    if let Some(r) = strategy_preamble(arrow, dragging, map, elements, ctx) {
        return r;
    }
    let n = pts(arrow).len();
    let (sd, ed) = (dragging.contains_key(&0), dragging.contains_key(&(n - 1)));
    // new arrows are special
    if opts.new_arrow {
        return binding_strategy_for_new_simple_arrow_endpoint_dragging(
            arrow,
            dragging,
            map,
            elements,
            sd,
            ed,
            0,
            n - 1,
            ctx,
            opts.shift_key,
        );
    }
    let (sb, eb) = (
        binding_of(arrow, StartOrEnd::Start),
        binding_of(arrow, StartOrEnd::End),
    );
    if sd {
        let g = get_point_global_coordinates(arrow, dragging[&0].point, map);
        return binding_strategy_for_simple_arrow_endpoint_dragging_complex(
            g,
            sb,
            eb,
            map,
            elements,
            ctx.bind_mode,
            arrow,
            ctx.zoom,
            opts.finalize,
        );
    }
    if ed {
        let g = get_point_global_coordinates(arrow, dragging[&(n - 1)].point, map);
        let (current, other) = binding_strategy_for_simple_arrow_endpoint_dragging_complex(
            g,
            eb,
            sb,
            map,
            elements,
            ctx.bind_mode,
            arrow,
            ctx.zoom,
            opts.finalize,
        );
        return (other, current);
    }
    (Keep, Keep)
}

/// `bindOrUnbindBindingElements`: re-decides the bindings of the given
/// arrows where they are (no dragged points: keeps them).
pub fn bind_or_unbind_binding_elements(arrow_ids: &[String], scene: &mut Scene, ctx: &BindingCtx) {
    for id in arrow_ids {
        bind_or_unbind_binding_element(
            id,
            &PointsPositionUpdates::new(),
            [f64::INFINITY, f64::INFINITY],
            scene,
            ctx,
            &BindOpts::default(),
        );
    }
}

// ---------------------------------------------------------------------------
// bind / unbind
// ---------------------------------------------------------------------------

/// `applyBinding`: writes the binding onto the arrow and lists the arrow on
/// the target.
fn apply_binding(
    arrow_id: &str,
    bindable_id: &str,
    binding: FixedPointBinding,
    s: StartOrEnd,
    store: &mut dyn BindingStore,
) {
    let mut b = Some(binding);
    store.update(arrow_id, &mut |e| set_binding(e, s, b.take()));
    let listed = store
        .get_element(bindable_id)
        .is_some_and(|b| b.bound_elements.iter().flatten().any(|x| x.id == arrow_id));
    if !listed {
        store.update(bindable_id, &mut |e| {
            e.bound_elements
                .get_or_insert_with(Vec::new)
                .push(BoundElement {
                    id: arrow_id.into(),
                    kind: BoundType::Arrow,
                })
        });
    }
}

/// `bindBindingElement`: binds the arrow's end to `hovered_id` with `mode`
/// (elbow arrows always orbit), its fixed point from `focus_point` (or the
/// end as it is).
pub fn bind_binding_element(
    arrow_id: &str,
    hovered_id: &str,
    mode: BindMode,
    s: StartOrEnd,
    store: &mut dyn BindingStore,
    zoom: f64,
    focus_point: Option<Point>,
    snap_to_outline: bool,
    midpoint_snapping: bool,
) {
    let (Some(arrow), Some(hovered)) = (live(store, arrow_id), live(store, hovered_id)) else {
        return;
    };
    let binding = if arrow.is_elbow_arrow() {
        FixedPointBinding {
            element_id: hovered.id.clone(),
            mode: BindMode::Orbit,
            fixed_point: calculate_fixed_point_for_elbow_arrow_binding(
                arrow,
                hovered,
                s,
                store,
                zoom,
                snap_to_outline,
                midpoint_snapping,
            ),
        }
    } else {
        FixedPointBinding {
            element_id: hovered.id.clone(),
            mode,
            fixed_point: calculate_fixed_point_for_non_elbow_arrow_binding(
                arrow,
                hovered,
                s,
                store,
                focus_point,
            ),
        }
    };
    apply_binding(arrow_id, hovered_id, binding, s, store);
}

/// `isEndBoundBeyondBindingArea`: the end is bound to an element it is too
/// far from to have been bound in the editor (e.g. laid out by mermaid).
pub fn is_end_bound_beyond_binding_area(
    arrow: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    zoom: f64,
) -> bool {
    let Some(b) = binding_of(arrow, s)
        .and_then(|b| live(map, &b.element_id))
        .filter(|b| b.is_bindable(true))
    else {
        return false;
    };
    !is_point_in_binding_area(
        get_point_at_index_global_coordinates(arrow, end_idx(s), map),
        b,
        map,
        zoom,
    )
}

/// How far at least to extend an arrow's end segment looking for what it's
/// bound to.
const MIN_BOUND_END_EXTENSION: f64 = 100.;

/// `getBoundEndExtension`: where the bound end, extended along its end
/// segment (by the segment's length, at least 100), reaches its element off
/// by the binding gap; None if it doesn't.
pub fn get_bound_end_extension(
    arrow: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
) -> Option<Point> {
    let b = binding_of(arrow, s)
        .and_then(|b| live(map, &b.element_id))
        .filter(|b| b.is_bindable(true))?;
    if pts(arrow).len() < 2 {
        return None;
    }
    let end = get_point_at_index_global_coordinates(arrow, end_idx(s), map);
    let adjacent = get_point_at_index_global_coordinates(arrow, adjacent_idx(s), map);
    let len = point_distance(adjacent, end);
    if len < PRECISION {
        return None;
    }
    let ext = [
        end,
        point_from_vector(
            vector_scale(
                vector_normalize(vector_from_point(end, adjacent)),
                len.max(MIN_BOUND_END_EXTENSION),
            ),
            end,
        ),
    ];
    nearest(hits(b, map, ext, gap(b)), end)
}

/// `unbindBindingElement`: drops the end's binding (and the arrow from the
/// target's `boundElements` unless the other end is bound to it too).
/// Returns the id it was bound to.
pub fn unbind_binding_element(
    arrow_id: &str,
    s: StartOrEnd,
    store: &mut dyn BindingStore,
) -> Option<String> {
    let arrow = store.get_element(arrow_id)?;
    let b = binding_of(arrow, s)?.clone();
    if binding_of(arrow, other_end(s)).is_none_or(|o| o.element_id != b.element_id)
        && live(store, &b.element_id).is_some()
    {
        store.update(&b.element_id, &mut |e| {
            if let Some(be) = &mut e.bound_elements {
                be.retain(|x| x.id != arrow_id)
            }
        });
    }
    store.update(arrow_id, &mut |e| set_binding(e, s, None));
    Some(b.element_id)
}

/// `reanchorBindingsToOutline`: bindings to `changed_id` whose fixed point
/// fell off the element (beyond the gap) move to its outline, toward the
/// center.
pub fn reanchor_bindings_to_outline(changed_id: &str, store: &mut dyn BindingStore, zoom: f64) {
    let Some(changed) = live(store, changed_id).cloned() else {
        return;
    };
    let center = element_center_point(&changed, store, 0., 0.);
    let reach = changed.width.max(changed.height) * 2.;
    for id in bound_targets(&changed) {
        let Some(el) = live(store, &id).filter(|e| e.is_arrow()).cloned() else {
            continue;
        };
        let mut updates: [Option<FixedPointBinding>; 2] = [None, None];
        for (k, s) in [StartOrEnd::Start, StartOrEnd::End].into_iter().enumerate() {
            let Some(b) = binding_of(&el, s).filter(|b| b.element_id == changed.id) else {
                continue;
            };
            if el.is_elbow_arrow() {
                updates[k] = Some(FixedPointBinding {
                    fixed_point: calculate_fixed_point_for_elbow_arrow_binding(
                        &el, &changed, s, store, zoom, true, true,
                    ),
                    ..b.clone()
                });
                continue;
            }
            let focus = get_global_fixed_point_for_bindable_element(b.fixed_point, &changed, store);
            if hit_inside(focus, &changed, gap(&changed), store) {
                continue;
            }
            let dir = vector_from_point(focus, center);
            if dir == [0., 0.] {
                continue;
            }
            let Some(outline) = nearest(
                hits(
                    &changed,
                    store,
                    [
                        center,
                        point_from_vector(vector_scale(vector_normalize(dir), reach), center),
                    ],
                    0.,
                ),
                focus,
            ) else {
                continue;
            };
            updates[k] = Some(FixedPointBinding {
                fixed_point: calculate_fixed_point_for_non_elbow_arrow_binding(
                    &el,
                    &changed,
                    s,
                    store,
                    Some(outline),
                ),
                ..b.clone()
            });
        }
        if updates.iter().any(Option::is_some) {
            store.update(&id, &mut |e| {
                if let Some(b) = &updates[0] {
                    set_binding(e, StartOrEnd::Start, Some(b.clone()));
                }
                if let Some(b) = &updates[1] {
                    set_binding(e, StartOrEnd::End, Some(b.clone()));
                }
            });
        }
    }
}

/// `bindBindingElementToFixedPoint`: binds (orbit) at an explicit fixed
/// point, for targets placed to fit the arrow.
pub fn bind_binding_element_to_fixed_point(
    arrow_id: &str,
    bindable_id: &str,
    s: StartOrEnd,
    fixed_point: [f64; 2],
    store: &mut dyn BindingStore,
) {
    let b = FixedPointBinding {
        element_id: bindable_id.into(),
        fixed_point: normalize_fixed_point(Some(fixed_point)),
        mode: BindMode::Orbit,
    };
    apply_binding(arrow_id, bindable_id, b, s, store);
}

// ---------------------------------------------------------------------------
// moving points (linearElementEditor.ts)
// ---------------------------------------------------------------------------

/// `movePoints`' `otherUpdates`: Some sets the binding.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BindingUpdates {
    pub start_binding: Option<Option<FixedPointBinding>>,
    pub end_binding: Option<Option<FixedPointBinding>>,
}

/// `movePoints`' options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MovePointsOpts {
    pub is_binding_enabled: Option<bool>,
    pub is_midpoint_snapping_enabled: Option<bool>,
    pub move_mid_points_with_element: bool,
}

/// `mutateElement` on an elbow arrow: the update, then the route
/// (`BindingHooks::update_elbow_arrow_points`) over it, with angle 0.
pub fn mutate_elbow_arrow(
    store: &mut dyn BindingStore,
    id: &str,
    updates: &ElbowUpdate,
    opts: &ElbowOptions,
    hooks: &dyn BindingHooks,
) -> bool {
    let Some(mut arrow) = store.get_element(id).cloned() else {
        return false;
    };
    if let Some(x) = updates.x {
        arrow.x = x;
    }
    if let Some(y) = updates.y {
        arrow.y = y;
    }
    let routed = if pts(&arrow).len() < 2 {
        ElbowUpdate {
            points: Some(
                updates
                    .points
                    .clone()
                    .unwrap_or_else(|| pts(&arrow).to_vec()),
            ),
            ..Default::default()
        }
    } else {
        hooks.update_elbow_arrow_points(&arrow, store, updates, opts)
    };
    store.update(id, &mut |e| {
        updates.apply(e);
        e.angle = 0.;
        routed.apply(e);
    })
}

/// `LinearElementEditor.movePoints`: moves the points in `updates` (local
/// coordinates), keeping the first point at [0, 0] by moving the element.
pub fn move_points(
    id: &str,
    store: &mut dyn BindingStore,
    updates: &PointsPositionUpdates,
    other: Option<&BindingUpdates>,
    opts: &MovePointsOpts,
    hooks: &dyn BindingHooks,
) {
    let Some(el) = store.get_element(id).cloned() else {
        return;
    };
    let points = pts(&el).to_vec();
    if points.is_empty() {
        return;
    }
    let last = points.len() - 1;
    let mut upd = updates.clone();
    // polygons move their start and end together
    if el.is_line_polygon() {
        if let Some(f) = upd.get(&0).copied() {
            upd.insert(last, f);
        } else if let Some(l) = upd.get(&last).copied() {
            upd.insert(0, l);
        }
    }
    // moving the start point moves the element and the other points back
    let [ox, oy] = upd.get(&0).map_or([0., 0.], |u| u.point);
    let is_dragging = upd.values().any(|u| u.is_dragging);
    let next: Vec<Point> = if el.is_elbow_arrow() {
        vec![
            upd.get(&0).map_or(points[0], |u| u.point),
            upd.get(&last).map_or(points[last], |u| u.point),
        ]
    } else {
        points
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                let cur = upd.get(&i).map_or(p, |u| u.point);
                if opts.move_mid_points_with_element && i != 0 && i != last && !upd.contains_key(&i)
                {
                    return cur;
                }
                [cur[0] - ox, cur[1] - oy]
            })
            .collect()
    };
    let eo = ElbowOptions {
        is_dragging,
        is_binding_enabled: opts.is_binding_enabled,
        is_midpoint_snapping_enabled: opts.is_midpoint_snapping_enabled,
    };
    update_points(id, store, &next, [ox, oy], other, &eo, hooks);
}

/// `LinearElementEditor._updatePoints`: sets the points (local, already
/// moved back by `offset` when the start moved), moving the element so the
/// rest stays put; elbow arrows are routed with the new ends instead.
pub fn update_points(
    id: &str,
    store: &mut dyn BindingStore,
    next: &[Point],
    [ox, oy]: Point,
    other: Option<&BindingUpdates>,
    opts: &ElbowOptions,
    hooks: &dyn BindingHooks,
) {
    let Some(el) = store.get_element(id).cloned() else {
        return;
    };
    if el.is_elbow_arrow() {
        let u = ElbowUpdate {
            points: Some(next.to_vec()),
            start_binding: other.and_then(|o| o.start_binding.clone()),
            end_binding: other.and_then(|o| o.end_binding.clone()),
            ..Default::default()
        };
        mutate_elbow_arrow(store, id, &u, opts, hooks);
        return;
    }
    let nc = get_element_points_coords(&el, next);
    let pc = get_element_points_coords(&el, pts(&el));
    let d = [
        (pc[0] + pc[2]) / 2. - (nc[0] + nc[2]) / 2.,
        (pc[1] + pc[3]) / 2. - (nc[1] + nc[3]) / 2.,
    ];
    let r = point_rotate_rads([ox, oy], d, el.angle);
    store.update(id, &mut |e| {
        if let Some(o) = other {
            if let Some(b) = &o.start_binding {
                set_binding(e, StartOrEnd::Start, b.clone());
            }
            if let Some(b) = &o.end_binding {
                set_binding(e, StartOrEnd::End, b.clone());
            }
        }
        if let Some(p) = e.points_mut() {
            *p = next.to_vec();
        }
        e.x += r[0];
        e.y += r[1];
    });
}

// ---------------------------------------------------------------------------
// keeping bound arrows glued
// ---------------------------------------------------------------------------

/// A store's elements with some replaced (`changedElements`).
struct Overlay<'a> {
    base: &'a dyn ElementsMap,
    over: &'a [Element],
}
impl ElementsMap for Overlay<'_> {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.over
            .iter()
            .find(|e| e.id == id)
            .or_else(|| self.base.get_element(id))
    }
}

/// `getBoundPointUpdates`: where the arrow's bindings put its bound ends.
fn get_bound_point_updates(arrow: &Element, map: &dyn ElementsMap) -> PointsPositionUpdates {
    let mut out = PointsPositionUpdates::new();
    for (prop, id) in bindable_targets(arrow) {
        let s = match prop {
            "startBinding" => StartOrEnd::Start,
            "endBinding" => StartOrEnd::End,
            _ => continue,
        };
        let Some(b) = map.get_element(&id).filter(|b| b.is_bindable(true)) else {
            continue;
        };
        if let Some(p) = update_bound_point(arrow, s, binding_of(arrow, s), b, map, false) {
            out.insert(
                if s == StartOrEnd::Start {
                    0
                } else {
                    pts(arrow).len() - 1
                },
                PointUpdate::at(p),
            );
        }
    }
    out
}

/// `updateArrowLabel`: re-lays out the arrow's label as placed.
fn update_arrow_label(arrow_id: &str, store: &mut dyn BindingStore, hooks: &dyn BindingHooks) {
    let alive = store
        .get_element(arrow_id)
        .and_then(|a| get_bound_text_element(a, store))
        .is_some_and(|t| !t.is_deleted);
    if alive {
        hooks.handle_bind_text_resize(arrow_id, store);
    }
}

/// `updateBoundArrow`: puts both bound ends where the bindings put them (on
/// the elements in `changed` or the store) and re-lays out the label.
/// `bound_element_moved`: an arrow bound to one element at both ends then
/// moves whole with it.
pub fn update_bound_arrow(
    arrow_id: &str,
    store: &mut dyn BindingStore,
    changed: &[Element],
    hooks: &dyn BindingHooks,
    bound_element_moved: bool,
) {
    let Some(arrow) = store.get_element(arrow_id).cloned() else {
        return;
    };
    let map = Overlay {
        base: &*store,
        over: changed,
    };
    let sb = binding_of(&arrow, StartOrEnd::Start)
        .and_then(|b| map.get_element(&b.element_id))
        .map(|e| e.id.clone());
    let eb = binding_of(&arrow, StartOrEnd::End)
        .and_then(|b| map.get_element(&b.element_id))
        .map(|e| e.id.clone());
    let updates = get_bound_point_updates(&arrow, &map);
    let opts = MovePointsOpts {
        move_mid_points_with_element: bound_element_moved && sb.is_some() && sb == eb,
        ..Default::default()
    };
    move_points(arrow_id, store, &updates, None, &opts, hooks);
    update_arrow_label(arrow_id, store, hooks);
}

/// `isBoundToElementNotIn`.
pub fn is_bound_to_element_not_in(arrow: &Element, ids: &FxHashSet<String>) -> bool {
    [StartOrEnd::Start, StartOrEnd::End]
        .iter()
        .any(|&s| binding_of(arrow, s).is_some_and(|b| !ids.contains(&b.element_id)))
}

/// `getSimultaneouslyUpdatedElementIds` (uncached).
pub fn get_simultaneously_updated_element_ids<'a>(
    elements: impl IntoIterator<Item = &'a Element>,
) -> FxHashSet<String> {
    elements.into_iter().map(|e| e.id.clone()).collect()
}

/// `getFrameArrowIdsToReattach`: arrows moving with a moved frame but bound
/// to elements that don't move; move the rest without them, then them with
/// `move_frame_arrows`.
pub fn get_frame_arrow_ids_to_reattach(moved: &[&Element]) -> FxHashSet<String> {
    let ids = get_simultaneously_updated_element_ids(moved.iter().copied());
    moved
        .iter()
        .filter(|e| {
            e.is_arrow()
                && e.frame_id.as_ref().is_some_and(|f| ids.contains(f))
                && is_bound_to_element_not_in(e, &ids)
        })
        .map(|e| e.id.clone())
        .collect()
}

/// `moveFrameArrows`: moves the arrows by `offset` from where they were in
/// `original` (or are), then puts their bound ends on what they're bound to.
pub fn move_frame_arrows(
    arrow_ids: &FxHashSet<String>,
    offset: [f64; 2],
    store: &mut dyn BindingStore,
    original: Option<&dyn ElementsMap>,
    hooks: &dyn BindingHooks,
) {
    let mut ids: Vec<&String> = arrow_ids.iter().collect();
    ids.sort();
    for id in ids {
        let Some(arrow) = live(store, id).filter(|e| e.is_arrow()).cloned() else {
            continue;
        };
        let orig = original
            .and_then(|o| o.get_element(id))
            .cloned()
            .unwrap_or_else(|| arrow.clone());
        let (x, y, points) = (orig.x + offset[0], orig.y + offset[1], pts(&orig).to_vec());
        if arrow.is_elbow_arrow() {
            if let Some(oe) = orig
                .elbow()
                .filter(|e| e.fixed_segments.as_ref().is_some_and(|f| !f.is_empty()))
            {
                // route from where it was, moved, keeping its fixed segments
                let u = ElbowUpdate {
                    x: Some(x),
                    y: Some(y),
                    points: Some(points.clone()),
                    fixed_segments: Some(oe.fixed_segments.clone()),
                    start_is_special: Some(oe.start_is_special),
                    end_is_special: Some(oe.end_is_special),
                    ..Default::default()
                };
                mutate_elbow_arrow(store, id, &u, &ElbowOptions::default(), hooks);
            }
            // route once, with the bound ends already on what they're bound to
            let mut moved = store.get_element(id).unwrap().clone();
            (moved.x, moved.y) = (x, y);
            if let Some(p) = moved.points_mut() {
                p.clone_from(&points);
            }
            let mut next = points.clone();
            for (i, u) in get_bound_point_updates(&moved, store) {
                next[i] = u.point;
            }
            mutate_elbow_arrow(
                store,
                id,
                &ElbowUpdate {
                    x: Some(x),
                    y: Some(y),
                    points: Some(next),
                    ..Default::default()
                },
                &ElbowOptions::default(),
                hooks,
            );
            update_arrow_label(id, store, hooks);
        } else {
            store.update(id, &mut |e| {
                (e.x, e.y) = (x, y);
                if let Some(p) = e.points_mut() {
                    p.clone_from(&points);
                }
            });
            // it moved, not what it's bound to
            update_bound_arrow(id, store, &[], hooks, false);
        }
    }
}

/// `updateBoundElements` options.
#[derive(Clone, Copy, Default)]
pub struct UpdateBoundOpts<'a> {
    /// Elements moving together with the changed one (their arrows are
    /// moved by the caller).
    pub simultaneously_updated: Option<&'a FxHashSet<String>>,
    /// Elements to read in place of the store's.
    pub changed_elements: &'a [Element],
}

/// `updateBoundElements`: after `changed_id` moved, resized or rotated,
/// re-places the arrows bound to it.
pub fn update_bound_elements(
    changed_id: &str,
    store: &mut dyn BindingStore,
    opts: &UpdateBoundOpts,
    hooks: &dyn BindingHooks,
) {
    let changed = {
        let map = Overlay {
            base: &*store,
            over: opts.changed_elements,
        };
        match map.get_element(changed_id) {
            Some(c) if c.is_bindable(true) => c.clone(),
            _ => return,
        }
    };
    for id in bound_targets(&changed) {
        let need = Overlay {
            base: &*store,
            over: opts.changed_elements,
        }
        .get_element(&id)
        .filter(|e| e.is_arrow() && !e.is_deleted)
        // stale boundElements
        .is_some_and(|a| {
            [StartOrEnd::Start, StartOrEnd::End]
                .iter()
                .any(|&s| binding_of(a, s).is_some_and(|b| b.element_id == changed.id))
        });
        // being moved / scaled already
        if !need || opts.simultaneously_updated.is_some_and(|s| s.contains(&id)) {
            continue;
        }
        update_bound_arrow(&id, store, opts.changed_elements, hooks, true);
    }
}

fn update_arrow_bindings(arrow_id: &str, s: StartOrEnd, scene: &mut Scene, ctx: &BindingCtx) {
    let Some(latest) = scene.get_non_deleted_element(arrow_id).cloned() else {
        return;
    };
    debug_assert!(
        !latest.is_elbow_arrow(),
        "Elbow arrows not supported for indirect updates"
    );
    let bindable = binding_of(&latest, s)
        .and_then(|b| scene.get_non_deleted_element(&b.element_id))
        .cloned();
    let point = get_point_at_index_global_coordinates(&latest, end_idx(s), scene);
    let hit = bindable.as_ref().is_some_and(|b| {
        hit_element_itself(&HitTestArgs::new(
            point,
            b,
            max_binding_distance_simple(ctx.zoom),
            scene,
        ))
    });
    unbind_binding_element(arrow_id, s, scene);
    let (true, Some(b)) = (hit, bindable) else {
        return;
    };
    let latest = scene.get_element(arrow_id).unwrap().clone();
    let idx = if s == StartOrEnd::Start {
        0
    } else {
        pts(&latest).len() - 1
    };
    let dragging = PointsPositionUpdates::from([(idx, PointUpdate::at(pts(&latest)[idx]))]);
    let (st, en) = strategy_simple(
        &latest,
        &dragging,
        point,
        &*scene,
        scene.elements_including_deleted(),
        ctx,
        &BindOpts::default(),
    );
    if let BindingStrategy::Bind {
        mode,
        element,
        focus_point,
    } = if s == StartOrEnd::Start { st } else { en }
        && element == b.id
    {
        bind_binding_element(
            arrow_id,
            &b.id,
            mode,
            s,
            scene,
            ctx.zoom,
            Some(focus_point),
            true,
            true,
        );
    }
}

/// `updateBindings`: an arrow re-decides its bindings where its ends are; any
/// other element re-places the arrows bound to it.
pub fn update_bindings(
    latest_id: &str,
    scene: &mut Scene,
    ctx: &BindingCtx,
    simultaneously_updated: Option<&FxHashSet<String>>,
) {
    let Some(latest) = scene.get_non_deleted_element(latest_id).cloned() else {
        return;
    };
    if latest.is_arrow() {
        for s in [StartOrEnd::Start, StartOrEnd::End] {
            if scene
                .get_element(latest_id)
                .and_then(|a| binding_of(a, s))
                .is_some()
            {
                update_arrow_bindings(latest_id, s, scene, ctx);
            }
        }
    } else {
        update_bound_elements(
            latest_id,
            scene,
            &UpdateBoundOpts {
                simultaneously_updated,
                changed_elements: &[],
            },
            ctx.hooks,
        );
    }
}

/// `HistoryHooks` with binding's `updateBoundElements`; labels laid out by
/// `text` (and arrow labels by `hooks`).
pub struct BindingHistoryHooks<'a, H: HistoryHooks> {
    pub text: H,
    pub hooks: &'a dyn BindingHooks,
}
impl<H: HistoryHooks> HistoryHooks for BindingHistoryHooks<'_, H> {
    fn redraw_text_bounding_box(
        &mut self,
        text_id: &str,
        container_id: &str,
        elements: &mut ElementMap,
    ) {
        self.text
            .redraw_text_bounding_box(text_id, container_id, elements)
    }
    fn update_bound_elements(
        &mut self,
        element_id: &str,
        elements: &mut ElementMap,
        _changed: &FxHashSet<String>,
    ) {
        // the changed elements are in `elements` already
        update_bound_elements(
            element_id,
            elements,
            &UpdateBoundOpts::default(),
            self.hooks,
        )
    }
}

// ---------------------------------------------------------------------------
// snapping and focus points
// ---------------------------------------------------------------------------

/// `getHeadingForElbowArrowSnap`.
pub fn get_heading_for_elbow_arrow_snap(
    p: Point,
    other: Point,
    bindable: Option<&Element>,
    aabb: Option<Bounds>,
    orig: Point,
    map: &dyn ElementsMap,
    zoom: f64,
) -> Heading {
    let other_heading = vector_to_heading(vector_from_point(other, p));
    let (Some(b), Some(aabb)) = (bindable, aabb) else {
        return other_heading;
    };
    if get_distance_for_binding(orig, b, map, zoom).is_none() {
        return vector_to_heading(vector_from_point(p, element_center_point(b, map, 0., 0.)));
    }
    heading_for_point_from_element(b, aabb, p)
}

/// `getDistanceForBinding`: None beyond the binding distance. (Upstream's
/// `!distance` also treats 0 as "too far".)
fn get_distance_for_binding(
    p: Point,
    b: &Element,
    map: &dyn ElementsMap,
    zoom: f64,
) -> Option<f64> {
    let d = distance_to_element(b, map, p);
    (d <= max_binding_distance_simple(zoom) && d != 0.).then_some(d)
}

/// `bindPointToSnapToElementOutline`: where the arrow's end lands on the
/// target's outline, grown by the binding gap.
pub fn bind_point_to_snap_to_element_outline(
    arrow: &Element,
    b: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    zoom: f64,
    custom_intersector: Option<Segment>,
    midpoint_snapping: bool,
) -> Point {
    let elbowed = arrow.is_elbow_arrow();
    let point = get_point_at_index_global_coordinates(arrow, end_idx(s), map);
    // new arrow creation: no snapping
    if pts(arrow).len() < 2 {
        return point;
    }
    let edge = if b.is_rectanguloid() && elbowed {
        avoid_rectangular_corner(arrow, b, map, point)
    } else {
        point
    };
    let adjacent = match custom_intersector {
        Some(c) if !elbowed => c[1],
        _ => get_point_at_index_global_coordinates(arrow, adjacent_idx(s), map),
    };
    let g = gap(b);
    let aabb = aabb_for_element(b, map, None);
    let center = get_center_for_bounds(aabb);
    let reach = b.width.max(b.height) * 2.;
    let intersection = if elbowed {
        let snap = if midpoint_snapping {
            get_elbow_arrow_snap_mid_point(edge, b, map, zoom)
        } else {
            None
        };
        let resolved = snap.map_or(point, |s| s.0);
        // a midpoint on the axes fixes the side to bind to
        let horizontal = heading_is_horizontal(match snap {
            Some((p, true)) => vector_to_heading(vector_from_point(p, center)),
            _ => heading_for_point_from_element(b, aabb, point),
        });
        let other = [
            if horizontal { center[0] } else { resolved[0] },
            if !horizontal { center[1] } else { resolved[1] },
        ];
        let ray = |from: Point| {
            [
                from,
                point_from_vector(
                    vector_scale(vector_normalize(vector_from_point(resolved, from)), reach),
                    from,
                ),
            ]
        };
        // the ray can cross the outline twice: take the crossing nearest the aim
        nearest(
            hits(b, map, custom_intersector.unwrap_or_else(|| ray(other)), g),
            resolved,
        )
        .or_else(|| {
            let another = [
                if !horizontal { center[0] } else { resolved[0] },
                if horizontal { center[1] } else { resolved[1] },
            ];
            nearest(hits(b, map, ray(another), BASE_BINDING_GAP), resolved)
        })
    } else {
        let intersector = custom_intersector.unwrap_or_else(|| {
            let half = vector_scale(
                vector_normalize(vector_from_point(edge, adjacent)),
                point_distance(edge, adjacent) + b.width.max(b.height) + g * 2.,
            );
            [
                point_from_vector(half, adjacent),
                point_from_vector(vector_scale(half, -1.), adjacent),
            ]
        });
        if point_distance(edge, adjacent) < 1. {
            Some(edge)
        } else {
            nearest(hits(b, map, intersector, g), adjacent)
        }
    };
    // too close to tell a direction
    match intersection {
        Some(i) if point_distance_sq(edge, i) >= PRECISION => i,
        _ => edge,
    }
}

/// `avoidRectangularCorner`: a point off a corner of the (unrotated) target
/// moves to the nearer side's end, a gap away.
pub fn avoid_rectangular_corner(
    _arrow: &Element,
    t: &Element,
    map: &dyn ElementsMap,
    p: Point,
) -> Point {
    let c = element_center_point(t, map, 0., 0.);
    let [nx, ny] = point_rotate_rads(p, c, -t.angle);
    let g = gap(t);
    let r = |x: f64, y: f64| point_rotate_rads([x, y], c, t.angle);
    let (x, y, w, h) = (t.x, t.y, t.width, t.height);
    if nx < x && ny < y {
        // top left
        if ny - y > -g {
            return r(x - g, y);
        }
        return r(x, y - g);
    } else if nx < x && ny > y + h {
        // bottom left
        if nx - x > -g {
            return r(x, y + h + g);
        }
        return r(x - g, y + h);
    } else if nx > x + w && ny > y + h {
        // bottom right
        if nx - x < w + g {
            return r(x + w, y + h + g);
        }
        return r(x + w + g, y + h);
    } else if nx > x + w && ny < y {
        // top right
        if nx - x < w + g {
            return r(x + w, y - g);
        }
        return r(x + w + g, y);
    }
    p
}

/// `extractBinding`: the element and focus point of the arrow's end binding.
fn extract_binding<'a>(
    arrow: &Element,
    s: StartOrEnd,
    map: &'a dyn ElementsMap,
) -> (Option<&'a Element>, Option<Point>) {
    let Some(b) = binding_of(arrow, s) else {
        return (None, None);
    };
    let Some(e) = map.get_element(&b.element_id) else {
        return (None, None);
    };
    (
        Some(e),
        Some(get_global_fixed_point_for_bindable_element(
            normalize_fixed_point(Some(b.fixed_point)),
            e,
            map,
        )),
    )
}

/// `snapBoundPointToGrid`: snaps along the target's side to the grid,
/// keeping the gap across it.
pub fn snap_bound_point_to_grid(
    outline: Point,
    b: &Element,
    map: &dyn ElementsMap,
    grid_size: Option<f64>,
    adjacent: Option<Point>,
) -> Point {
    if grid_size.is_none_or(|g| g == 0.) {
        return outline;
    }
    let aabb = aabb_for_element(b, map, None);
    // ellipses and diamonds: the arrow's incoming direction
    let heading = match adjacent {
        Some(a) if matches!(b.ty(), ElementType::Ellipse | ElementType::Diamond) => {
            vector_to_heading(vector_from_point(a, outline))
        }
        _ => heading_for_point_from_element(b, aabb, outline),
    };
    let g = gap(b);
    let extent = b.width.max(b.height) + g * 2.;
    let center = get_center_for_bounds(aabb);
    let [sx, sy] = get_grid_point(outline[0], outline[1], grid_size);
    if heading[0].abs() >= heading[1].abs() {
        let i = nearest(
            hits(
                b,
                map,
                [[center[0] - extent, sy], [center[0] + extent, sy]],
                g,
            ),
            outline,
        );
        return i.unwrap_or([outline[0], sy]);
    }
    let i = nearest(
        hits(
            b,
            map,
            [[sx, center[1] - extent], [sx, center[1] + extent]],
            g,
        ),
        outline,
    );
    i.unwrap_or([sx, outline[1]])
}

fn element_area(e: &Element) -> f64 {
    e.width * e.height
}

/// `updateBoundPoint`: where the binding puts the arrow's end, in the
/// arrow's local coordinates; None when it stays.
pub fn update_bound_point(
    arrow: &Element,
    s: StartOrEnd,
    binding: Option<&FixedPointBinding>,
    bindable: &Element,
    map: &dyn ElementsMap,
    dragging: bool,
) -> Option<Point> {
    let points = pts(arrow);
    let b = binding?;
    let l = arrow.linear()?;
    // only a 2-point arrow updates its other end too; the initial arrow on
    // pointer down keeps its points
    if (b.element_id != bindable.id && points.len() > 2)
        || points_equal(*points.last()?, [0., 0.], PRECISION)
    {
        return None;
    }
    let create = |p: Point| Some(create_point_at(arrow, map, p[0], p[1], None));
    let focus = get_global_fixed_point_for_bindable_element(
        normalize_fixed_point(Some(b.fixed_point)),
        bindable,
        map,
    );
    // 0. inside bindings go to the focus point
    if b.mode == BindMode::Inside {
        return create(focus);
    }
    let (other_bindable, other_focus) = extract_binding(arrow, other_end(s), map);
    let other_arrow_point = get_point_at_index_global_coordinates(arrow, adjacent_idx(s), map);
    let other_fp_or_ap = if points.len() == 2 {
        other_focus.unwrap_or(other_arrow_point)
    } else {
        other_arrow_point
    };
    let intersector = [focus, other_fp_or_ap];
    let other_outline =
        other_bindable.and_then(|o| nearest(hits(o, map, intersector, gap(o)), focus));
    let outline = nearest(
        hits(bindable, map, intersector, gap(bindable)),
        other_fp_or_ap,
    );
    let (sh, eh) = (l.start_arrowhead.is_some(), l.end_arrowhead.is_some());
    let resolved = if (!sh && !eh) || (s == StartOrEnd::Start && sh) || (s == StartOrEnd::End && eh)
    {
        focus
    } else {
        outline.unwrap_or(focus)
    };
    // 1. the outline point inside the other shape: the focus point, or the
    //    arrow would invert (the area check is for wireframing)
    if let (Some(ob), Some(op)) = (other_bindable, outline)
        && !dragging
        && element_area(ob) < element_area(bindable) * 2.
        && hit_inside(op, ob, gap(ob), map)
    {
        return create(resolved);
    }
    let other_target = if other_bindable.is_some() {
        other_outline.or(other_focus).unwrap_or(other_arrow_point)
    } else {
        other_arrow_point
    };
    let too_short = point_distance(other_target, outline.unwrap_or(focus)) <= BASE_ARROW_MIN_LENGTH;
    // 2. free at the other end: the focus point if too short
    if other_bindable.is_none() {
        return create(if too_short {
            focus
        } else {
            outline.unwrap_or(focus)
        });
    }
    // 3. bound at both ends and too short
    if too_short {
        return create([
            or(Some(resolved[0]), focus[0]),
            or(Some(resolved[1]), focus[1]),
        ]);
    }
    // 4. the outline if possible
    create([
        or(outline.map(|p| p[0]), focus[0]),
        or(outline.map(|p| p[1]), focus[1]),
    ])
}

/// `calculateFixedPointForElbowArrowBinding`.
pub fn calculate_fixed_point_for_elbow_arrow_binding(
    arrow: &Element,
    h: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    zoom: f64,
    snap_to_outline: bool,
    midpoint_snapping: bool,
) -> [f64; 2] {
    let snapped = if snap_to_outline {
        bind_point_to_snap_to_element_outline(arrow, h, s, map, zoom, None, midpoint_snapping)
    } else {
        get_point_at_index_global_coordinates(arrow, end_idx(s), map)
    };
    let mid = [h.x + h.width / 2., h.y + h.height / 2.];
    let [nx, ny] = point_rotate_rads(snapped, mid, -h.angle);
    // point-like: bind to the center, so resizing keeps the arrow put
    if h.width < MIN_BINDABLE_SIZE || h.height < MIN_BINDABLE_SIZE {
        return normalize_fixed_point(Some([0.5, 0.5]));
    }
    // floor at the gap, so tiny elements don't blow up the ratio
    let f = gap(h);
    normalize_fixed_point(Some([
        (nx - h.x) / h.width.max(f),
        (ny - h.y) / h.height.max(f),
    ]))
}

/// `calculateFixedPointForNonElbowArrowBinding`: `focus_point` (or the end
/// as it is) as a ratio of the target's unrotated box.
pub fn calculate_fixed_point_for_non_elbow_arrow_binding(
    arrow: &Element,
    h: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    focus_point: Option<Point>,
) -> [f64; 2] {
    let edge = focus_point
        .unwrap_or_else(|| get_point_at_index_global_coordinates(arrow, end_idx(s), map));
    let [nx, ny] = point_rotate_rads(edge, element_center_point(h, map, 0., 0.), -h.angle);
    if h.width < MIN_BINDABLE_SIZE || h.height < MIN_BINDABLE_SIZE {
        return normalize_fixed_point(Some([0.5, 0.5]));
    }
    let f = gap(h);
    normalize_fixed_point(Some([
        (nx - h.x) / h.width.max(f),
        (ny - h.y) / h.height.max(f),
    ]))
}

// utils.ts

/// `getDiagonalsForBindableElement`: corner diagonals (rectangular) or the
/// center lines, shrunk on rectangles.
fn get_diagonals_for_bindable_element(e: &Element, map: &dyn ElementsMap) -> [Segment; 2] {
    let off = if e.ty() == ElementType::Rectangle {
        15.
    } else {
        0.
    };
    let shrink = |s: Segment| {
        let o = vector_scale(vector_normalize(vector_from_point(s[1], s[0])), off);
        [
            point_translate(s[0], o),
            point_translate(s[1], vector_scale(o, -1.)),
        ]
    };
    let c = element_center_point(e, map, 0., 0.);
    let r = |x: f64, y: f64| point_rotate_rads([x, y], c, e.angle);
    let (x, y, w, h) = (e.x, e.y, e.width, e.height);
    if e.is_rectangular() {
        [
            shrink([r(x, y), r(x + w, y + h)]),
            shrink([r(x + w, y), r(x, y + h)]),
        ]
    } else {
        [
            shrink([r(x + w / 2., y), r(x + w / 2., y + h)]),
            shrink([r(x, y + h / 2.), r(x + w, y + h / 2.)]),
        ]
    }
}

/// `getSnappedMidpointForElbowArrow`: the snapped midpoint and whether it is
/// on the element's axes (side midpoints, a diamond's vertices) rather than
/// a diamond's edge midpoint.
fn get_snapped_midpoint_for_elbow_arrow(
    e: &Element,
    p: Point,
    map: &dyn ElementsMap,
    center: Point,
    ht: f64,
    vt: f64,
) -> Option<(Point, bool)> {
    let (x, y, w, h) = (e.x, e.y, e.width, e.height);
    let n = point_rotate_rads(p, center, -e.angle);
    let g = gap(e);
    if point_distance(center, n) < g {
        return None;
    }
    let [right, bottom, left, top] = get_all_midpoints(e, map);
    if n[0] <= x + w / 2. && n[1] > center[1] - vt && n[1] < center[1] + vt {
        return Some((left, true));
    }
    if n[1] <= y + h / 2. && n[0] > center[0] - ht && n[0] < center[0] + ht {
        return Some((top, true));
    }
    if n[0] >= x + w / 2. && n[1] > center[1] - vt && n[1] < center[1] + vt {
        return Some((right, true));
    }
    if n[1] >= y + h / 2. && n[0] > center[0] - ht && n[0] < center[0] + ht {
        return Some((bottom, true));
    }
    if e.ty() == ElementType::Diamond {
        // a diamond's edge midpoints too; the zone sits a gap outside the edge
        let t = ht.max(vt);
        for (ex, ey, dx, dy) in [
            (x + w / 4., y + h / 4., -1., -1.),
            (x + 3. * w / 4., y + h / 4., 1., -1.),
            (x + w / 4., y + 3. * h / 4., -1., 1.),
            (x + 3. * w / 4., y + 3. * h / 4., 1., 1.),
        ] {
            if point_distance([ex + dx * g, ey + dy * g], n) < t {
                return Some((point_rotate_rads([ex, ey], center, e.angle), false));
            }
        }
    }
    None
}

fn get_snapped_midpoint_index_for_simple_arrow(
    e: &Element,
    p: Point,
    map: &dyn ElementsMap,
    threshold: f64,
) -> Option<usize> {
    get_all_midpoints(e, map)
        .iter()
        .position(|&m| point_distance(m, p) <= threshold && !hit_inside(p, e, 0., map))
}

/// `getElbowArrowSnapMidPoint`: (point, on the axes).
pub fn get_elbow_arrow_snap_mid_point(
    p: Point,
    e: &Element,
    map: &dyn ElementsMap,
    zoom: f64,
) -> Option<(Point, bool)> {
    const TOLERANCE: f64 = 0.05;
    let max = max_binding_distance_simple(zoom) + e.stroke_width / 2.;
    get_snapped_midpoint_for_elbow_arrow(
        e,
        p,
        map,
        element_center_point(e, map, 0., 0.),
        clamp(TOLERANCE * e.width, 5., max),
        clamp(TOLERANCE * e.height, 5., max),
    )
}

/// `getSnapOutlineMidPoint`.
pub fn get_snap_outline_mid_point(
    p: Point,
    e: &Element,
    map: &dyn ElementsMap,
    zoom: f64,
    elbowed: bool,
) -> Option<Point> {
    if elbowed {
        return get_elbow_arrow_snap_mid_point(p, e, map, zoom).map(|s| s.0);
    }
    let max = max_binding_distance_simple(zoom) + e.stroke_width / 2.;
    get_snapped_midpoint_index_for_simple_arrow(e, p, map, max)
        .map(|i| get_all_midpoints(e, map)[i])
}

/// `projectFixedPointOntoDiagonal`: the snapped side midpoint, else where the
/// line from the arrow's other end through `point` crosses the target's
/// diagonals (if inside the target).
pub fn project_fixed_point_onto_diagonal(
    arrow: &Element,
    point: Point,
    e: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    zoom: f64,
    midpoint_snapping: bool,
) -> Option<Point> {
    let n = pts(arrow).len();
    if n < 2 {
        return None;
    }
    if midpoint_snapping
        && let Some(m) = get_snap_outline_mid_point(point, e, map, zoom, arrow.is_elbow_arrow())
    {
        return Some(m);
    }
    // projecting needs an arrow direction
    if arrow.width < 3. && arrow.height < 3. {
        return None;
    }
    let [d1, d2] = get_diagonals_for_bindable_element(e, map);
    // the opposite focus point doesn't change while this end moves
    let mut a = get_point_at_index_global_coordinates(
        arrow,
        if s == StartOrEnd::Start {
            1
        } else {
            n as isize - 2
        },
        map,
    );
    if n == 2
        && let (_, Some(f)) = extract_binding(arrow, other_end(s), map)
    {
        a = f;
    }
    let b = point_from_vector(
        vector_scale(
            vector_from_point(point, a),
            2. * point_distance(a, point)
                + point_distance(d1[0], d1[1]).max(point_distance(d2[0], d2[1])),
        ),
        a,
    );
    let intersector = [b, a];
    let p1 = line_segment_intersection_points(d1, intersector, PRECISION);
    let p2 = line_segment_intersection_points(d2, intersector, PRECISION);
    let projection = match (p1, p2) {
        (Some(p1), Some(p2)) => {
            if point_distance(a, p1) < point_distance(a, p2) {
                Some(p1)
            } else {
                Some(p2)
            }
        }
        _ => p1.or(p2),
    };
    projection.filter(|&p| is_point_in_element(p, e, map))
}

// ---------------------------------------------------------------------------
// duplication and deletion
// ---------------------------------------------------------------------------

/// `fixDuplicatedBindingsAfterDuplication`: points the duplicates' bindings
/// at the duplicated elements (dropping those to elements not duplicated),
/// and reroutes elbow arrows against `map`.
pub fn fix_duplicated_bindings_after_duplication(
    duplicated: &mut [Element],
    orig_to_dup: &FxHashMap<String, String>,
    map: &dyn ElementsMap,
    hooks: &dyn BindingHooks,
) {
    for e in duplicated.iter_mut() {
        if let Some(be) = &mut e.bound_elements {
            *be = be
                .iter()
                .filter_map(|b| {
                    orig_to_dup.get(&b.id).map(|id| BoundElement {
                        id: id.clone(),
                        kind: b.kind,
                    })
                })
                .collect();
        }
        if let Some(t) = e.text_mut()
            && let Some(c) = &t.container_id
        {
            t.container_id = orig_to_dup.get(c).cloned();
        }
        if let Some(l) = e.linear_mut() {
            for b in [&mut l.end_binding, &mut l.start_binding] {
                if let Some(x) = b {
                    *b = orig_to_dup.get(&x.element_id).map(|id| FixedPointBinding {
                        element_id: id.clone(),
                        ..x.clone()
                    });
                }
            }
        }
        if e.is_elbow_arrow() {
            let p = pts(e);
            let u = ElbowUpdate {
                points: Some(vec![p[0], p[p.len() - 1]]),
                ..Default::default()
            };
            let routed = hooks.update_elbow_arrow_points(e, map, &u, &ElbowOptions::default());
            routed.apply(e);
        }
    }
}

/// `fixBindingsAfterDeletion`: unbinds what pointed at or listed the deleted
/// elements.
pub fn fix_bindings_after_deletion(store: &mut dyn BindingStore, deleted: &[Element]) {
    for e in deleted {
        unbind_affected_bound_element(store, e);
        unbind_affected_bindable_element(store, e);
    }
}

/// `bindingProperties`.
pub const BINDING_PROPERTIES: [&str; 5] = [
    "boundElements",
    "frameId",
    "containerId",
    "startBinding",
    "endBinding",
];

/// `bindableElementsVisitor`: what `e` points at, as (property, id).
pub fn bindable_targets(e: &Element) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    if let Some(f) = &e.frame_id {
        out.push(("frameId", f.clone()));
    }
    if let Some(c) = e.container_id() {
        out.push(("containerId", c.to_owned()));
    }
    if e.is_arrow()
        && let Some(l) = e.linear()
    {
        if let Some(b) = &l.start_binding {
            out.push(("startBinding", b.element_id.clone()));
        }
        if let Some(b) = &l.end_binding {
            out.push(("endBinding", b.element_id.clone()));
        }
    }
    out
}
/// `boundElementsVisitor`: the ids in `e.boundElements` if it is bindable.
pub fn bound_targets(e: &Element) -> Vec<String> {
    if !e.is_bindable(true) {
        return vec![];
    }
    e.bound_elements
        .iter()
        .flatten()
        .map(|b| b.id.clone())
        .collect()
}

/// Clears a binding property (`{ [prop]: null }`).
pub fn clear_binding_prop(e: &mut Element, prop: &str) {
    match prop {
        "frameId" => e.frame_id = None,
        "containerId" => {
            if let Some(t) = e.text_mut() {
                t.container_id = None;
            }
        }
        "startBinding" => set_binding(e, StartOrEnd::Start, None),
        "endBinding" => set_binding(e, StartOrEnd::End, None),
        _ => {}
    }
}

/// `BoundElement.unbindAffected`: drops `bound` from the `boundElements` of
/// the live elements it points at.
pub fn unbind_affected_bound_element(store: &mut dyn BindingStore, bound: &Element) {
    for (_, bid) in bindable_targets(bound) {
        let listed = live(store, &bid).is_some_and(|b| bound_targets(b).contains(&bound.id));
        if listed {
            store.update(&bid, &mut |b| {
                if let Some(be) = &mut b.bound_elements {
                    be.retain(|x| x.id != bound.id)
                }
            });
        }
    }
}

/// `BindableElement.unbindAffected`: clears the bindings of the live bound
/// elements that point at `bindable`.
pub fn unbind_affected_bindable_element(store: &mut dyn BindingStore, bindable: &Element) {
    for id in bound_targets(bindable) {
        let Some(bound) = live(store, &id) else {
            continue;
        };
        let props: Vec<&'static str> = bindable_targets(bound)
            .into_iter()
            .filter(|(_, b)| *b == bindable.id)
            .map(|(p, _)| p)
            .collect();
        if !props.is_empty() {
            store.update(&id, &mut |e| {
                for p in &props {
                    clear_binding_prop(e, p)
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------
// fixed points
// ---------------------------------------------------------------------------

/// `getGlobalFixedPointForBindableElement`.
pub fn get_global_fixed_point_for_bindable_element(
    fixed: [f64; 2],
    e: &Element,
    map: &dyn ElementsMap,
) -> Point {
    let [fx, fy] = normalize_fixed_point(Some(fixed));
    point_rotate_rads(
        [e.x + e.width * fx, e.y + e.height * fy],
        element_center_point(e, map, 0., 0.),
        e.angle,
    )
}

/// `getGlobalFixedPoints`: the arrow's ends where its bindings put them (or
/// where they are).
pub fn get_global_fixed_points(arrow: &Element, map: &dyn ElementsMap) -> [Point; 2] {
    let p = pts(arrow);
    let at = |s: StartOrEnd, i: usize| match binding_of(arrow, s)
        .and_then(|b| map.get_element(&b.element_id).map(|e| (b, e)))
    {
        Some((b, e)) => get_global_fixed_point_for_bindable_element(b.fixed_point, e, map),
        None => p
            .get(i)
            .map_or([arrow.x, arrow.y], |q| [arrow.x + q[0], arrow.y + q[1]]),
    };
    [
        at(StartOrEnd::Start, 0),
        at(StartOrEnd::End, p.len().saturating_sub(1)),
    ]
}

/// `getArrowLocalFixedPoints`.
pub fn get_arrow_local_fixed_points(arrow: &Element, map: &dyn ElementsMap) -> [Point; 2] {
    get_global_fixed_points(arrow, map).map(|p| point_from_absolute_coords(arrow, p, map))
}

/// A side or corner of a shape, for `getBindingSideMidPoint`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    TopLeft,
}

/// `SHAPE_CONFIGS`: (center angle, sector width) per side, in degrees.
fn sector_config(ty: ElementType) -> [(f64, f64, Side); 8] {
    use Side::*;
    let (edge, corner) = if matches!(ty, ElementType::Ellipse | ElementType::Diamond) {
        (15., 75.)
    } else {
        (75., 15.)
    };
    [
        (0., edge, Right),
        (45., corner, BottomRight),
        (90., edge, Bottom),
        (135., corner, BottomLeft),
        (180., edge, Left),
        (225., corner, TopLeft),
        (270., edge, Top),
        (315., corner, TopRight),
    ]
}

/// `getShapeSideAdaptive`.
fn get_shape_side_adaptive([x, y]: [f64; 2], ty: ElementType) -> Side {
    let mut a = (y - 0.5).atan2(x - 0.5);
    if a < 0. {
        a += 2. * PI;
    }
    let deg = a * 180. / PI;
    let cfg = sector_config(ty);
    for &(c, w, side) in &cfg {
        let start = ((c - w / 2.) % 360. + 360.) % 360.;
        let end = ((c + w / 2.) % 360. + 360.) % 360.;
        if start <= end {
            if deg >= start && deg <= end {
                return side;
            }
        } else if deg >= start || deg <= end {
            return side;
        }
    }
    // the nearest sector center
    let mut best = (f64::INFINITY, cfg[0].2);
    for &(c, _, side) in &cfg {
        let mut d = (deg - c).abs();
        if d > 180. {
            d = 360. - d;
        }
        if d < best.0 {
            best = (d, side);
        }
    }
    best.1
}

/// `getBindingSideMidPoint`: the midpoint of the side (or corner) the
/// binding's fixed point is on, just outside the outline.
pub fn get_binding_side_mid_point(
    binding: &FixedPointBinding,
    map: &dyn ElementsMap,
) -> Option<Point> {
    use Side::*;
    let b = live(map, &binding.element_id).filter(|b| b.is_bindable(true))?;
    let center = element_center_point(b, map, 0., 0.);
    let side = get_shape_side_adaptive(normalize_fixed_point(Some(binding.fixed_point)), b.ty());
    // small offset against elbow precision issues
    const O: f64 = 0.01;
    const D: f64 = O * 0.707;
    let mid = |p: Point, q: Point| [(p[0] + q[0]) / 2., (p[1] + q[1]) / 2.];
    let p = if b.ty() == ElementType::Diamond {
        let (sides, corners) = deconstruct_diamond_element(b, 0.);
        let (br, bl, tl, tr) = (sides[0], sides[1], sides[2], sides[3]);
        match side {
            Left => {
                let m = if corners.len() >= 3 {
                    corners[2][1]
                } else {
                    mid(bl[1], tl[0])
                };
                [m[0] - O, m[1]]
            }
            Right => {
                let m = if !corners.is_empty() {
                    corners[0][1]
                } else {
                    mid(tr[1], br[0])
                };
                [m[0] + O, m[1]]
            }
            Top => {
                let m = if corners.len() >= 4 {
                    corners[3][1]
                } else {
                    mid(tl[1], tr[0])
                };
                [m[0], m[1] - O]
            }
            Bottom => {
                let m = if corners.len() >= 2 {
                    corners[1][1]
                } else {
                    mid(br[1], bl[0])
                };
                [m[0], m[1] + O]
            }
            TopRight => {
                let m = mid(tr[0], tr[1]);
                [m[0] + D, m[1] - D]
            }
            BottomRight => {
                let m = mid(br[0], br[1]);
                [m[0] + D, m[1] + D]
            }
            BottomLeft => {
                let m = mid(bl[0], bl[1]);
                [m[0] - D, m[1] + D]
            }
            TopLeft => {
                let m = mid(tl[0], tl[1]);
                [m[0] - D, m[1] - D]
            }
        }
    } else if b.ty() == ElementType::Ellipse {
        let (cx, cy, rx, ry) = (
            b.x + b.width / 2.,
            b.y + b.height / 2.,
            b.width / 2.,
            b.height / 2.,
        );
        let at = |a: f64, dx: f64, dy: f64| [cx + rx * a.cos() + dx, cy + ry * a.sin() + dy];
        match side {
            Top => [cx, cy - ry - O],
            Right => [cx + rx + O, cy],
            Bottom => [cx, cy + ry + O],
            Left => [cx - rx - O, cy],
            TopRight => at(-PI / 4., D, -D),
            BottomRight => at(PI / 4., D, D),
            BottomLeft => at(3. * PI / 4., -D, D),
            TopLeft => at(-3. * PI / 4., -D, -D),
        }
    } else if b.is_rectangular() {
        let (sides, corners) = deconstruct_rectanguloid_element(b, 0.);
        let (top, right, bottom, left) = (sides[0], sides[1], sides[2], sides[3]);
        let corner = |i: usize, dx: f64, dy: f64, fx: f64, fy: f64| match corners.get(i) {
            Some(c) => {
                let m = mid(c[0], c[3]);
                [m[0] + dx, m[1] + dy]
            }
            None => [fx, fy],
        };
        let (x, y, w, h) = (b.x, b.y, b.width, b.height);
        match side {
            Top => {
                let m = mid(top[0], top[1]);
                [m[0], m[1] - O]
            }
            Right => {
                let m = mid(right[0], right[1]);
                [m[0] + O, m[1]]
            }
            Bottom => {
                let m = mid(bottom[0], bottom[1]);
                [m[0], m[1] + O]
            }
            Left => {
                let m = mid(left[0], left[1]);
                [m[0] - O, m[1]]
            }
            TopLeft => corner(0, -D, -D, x - O, y - O),
            TopRight => corner(1, D, -D, x + w + O, y - O),
            BottomRight => corner(2, D, D, x + w + O, y + h + O),
            BottomLeft => corner(3, -D, D, x - O, y + h + O),
        }
    } else {
        return None;
    };
    Some(point_rotate_rads(p, center, b.angle))
}

// ---------------------------------------------------------------------------
// restore.ts: v1 bindings
// ---------------------------------------------------------------------------

/// `repairBinding`'s legacy branch: migrates a v1 (focus / gap) binding of
/// `arrow`'s end to `bound`. `arrow` carries its v1 bindings (fixed points
/// normalized). Inside when the end is in the element; orbit otherwise, at
/// the end projected onto the element's diagonals.
pub fn repair_legacy_binding(
    arrow: &Element,
    s: StartOrEnd,
    bound: &Element,
    map: &dyn ElementsMap,
) -> Option<FixedPointBinding> {
    let p = get_point_at_index_global_coordinates(
        arrow,
        if s == StartOrEnd::Start {
            0
        } else {
            pts(arrow).len() as isize - 1
        },
        map,
    );
    let mode = if is_point_in_element(p, bound, map) {
        BindMode::Inside
    } else {
        BindMode::Orbit
    };
    let focus = if mode == BindMode::Inside {
        p
    } else {
        project_fixed_point_onto_diagonal(
            arrow,
            p,
            bound,
            s,
            map,
            super::consts::DEFAULT_ZOOM,
            true,
        )
        .unwrap_or(p)
    };
    Some(FixedPointBinding {
        element_id: bound.id.clone(),
        mode,
        fixed_point: calculate_fixed_point_for_non_elbow_arrow_binding(
            arrow,
            bound,
            s,
            map,
            Some(focus),
        ),
    })
}
