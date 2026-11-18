// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Resizing and rotating. Port of Excalidraw
//! `packages/element/src/resizeElements.ts` @ 3a317b5, with the core of
//! `excalidraw/actions/actionFlip.ts` (`flipElements`).
//!
//! Differences from upstream:
//! - elements are named by id and changed through binding's `BindingStore`
//!   (a `Scene`, history's `ElementMap`, a `Vec`); every function re-reads
//!   what it changed, where upstream mutates shared objects. `original` is
//!   upstream's `originalElements` (the gesture-start snapshot);
//! - updates go through `mutate_element`, so `shouldInformMutation` has no
//!   counterpart (every change bumps the version; the scene nonce is the
//!   caller's to watch);
//! - elbow arrows are rerouted where upstream's `mutateElement` would, through
//!   `binding::mutate_elbow_arrow` and the given `BindingHooks`;
//! - text is measured with `Measure` (upstream's `renderEnvironment`);
//! - the pointer snapping and grid are the caller's: the pointer passed in is
//!   already offset by `get_resize_offset_xy`, snapped and on the grid, as
//!   upstream's `maybeHandleResize` does before calling `transformElements`.
//!
//! Image crops are resized by the crop tool (`crop.rs`); a plain resize only
//! scales (and mirrors) an image, as upstream.

use super::binding::{
    BindingHooks, BindingStore, ElbowOptions, ElbowUpdate, UpdateBoundOpts,
    get_arrow_local_fixed_points, mutate_elbow_arrow, unbind_binding_element,
    update_bound_elements,
};
use super::bounds::{
    BoundingBox, Bounds, get_bound_text_element, get_bound_text_element_position,
    get_common_bounding_box, get_common_bounds, get_element_absolute_coords, get_element_bounds,
    get_resized_element_absolute_coords, rescale_points,
};
use super::consts::{MIN_FONT_SIZE, SHIFT_LOCKING_ANGLE, STICKY_NOTE_MIN_SIZE};
use super::handles::HandleType;
use super::math::{Point, normalize_radians, point_center, point_rotate_rads};
use super::sticky::{
    get_sticky_note_min_size, get_sticky_note_resize_intent, update_sticky_note_layout,
};
use super::text::{
    compute_bound_text_position, font_of, get_bound_text_max_width, handle_bind_text_resize,
};
use super::text_measure::{
    Font, Measure, get_approx_min_line_height, get_approx_min_line_width,
    get_min_text_element_width, measure_text,
};
use super::text_wrapping::wrap_text;
use super::types::{Element, FixedPointBinding, FixedSegment, StartOrEnd};
use super::utils::ElementsMap;
use rustc_hash::FxHashSet;

/// The modifier keys `transformElements` reads.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TransformOpts {
    /// Shift while rotating: snap to `SHIFT_LOCKING_ANGLE`.
    pub rotate_with_discrete_angle: bool,
    /// Alt: resize around the center.
    pub resize_from_center: bool,
    /// Shift (inverted for images and a sticky note's corners, which the
    /// caller decides, as upstream's `maybeHandleResize`).
    pub maintain_aspect_ratio: bool,
}

fn has(h: HandleType, c: char) -> bool {
    h != HandleType::Rotation && h.as_str().contains(c)
}
fn is_corner(h: HandleType) -> bool {
    matches!(
        h,
        HandleType::Nw | HandleType::Ne | HandleType::Sw | HandleType::Se
    )
}

/// One element update; `Some` sets a field (upstream's `ElementUpdate`).
#[derive(Clone, Debug, Default)]
struct Upd {
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    angle: Option<f64>,
    points: Option<Vec<Point>>,
    scale: Option<[f64; 2]>,
    font_size: Option<f64>,
    start_binding: Option<Option<FixedPointBinding>>,
    end_binding: Option<Option<FixedPointBinding>>,
    fixed_segments: Option<Option<Vec<FixedSegment>>>,
}

/// `scene.mutateElement(element, updates)`: elbow arrows given points are
/// rerouted (with angle 0).
fn apply(store: &mut dyn BindingStore, id: &str, u: &Upd, hooks: &dyn BindingHooks) {
    let Some(el) = store.get_element(id) else {
        return;
    };
    if el.is_elbow_arrow() && (u.points.is_some() || u.fixed_segments.is_some()) {
        let eu = ElbowUpdate {
            x: u.x,
            y: u.y,
            width: u.width,
            height: u.height,
            points: u.points.clone(),
            fixed_segments: u.fixed_segments.clone(),
            start_binding: u.start_binding.clone(),
            end_binding: u.end_binding.clone(),
            ..Default::default()
        };
        mutate_elbow_arrow(store, id, &eu, &ElbowOptions::default(), hooks);
        return;
    }
    store.update(id, &mut |e| {
        if let Some(v) = u.x {
            e.x = v;
        }
        if let Some(v) = u.y {
            e.y = v;
        }
        if let Some(v) = u.width {
            e.width = v;
        }
        if let Some(v) = u.height {
            e.height = v;
        }
        if let Some(v) = u.angle {
            e.angle = v;
        }
        if let (Some(p), Some(ep)) = (&u.points, e.points_mut()) {
            ep.clone_from(p);
        }
        if let (Some(s), Some(i)) = (u.scale, e.image_mut()) {
            i.scale = s;
        }
        if let (Some(f), Some(t)) = (u.font_size, e.text_mut()) {
            t.font_size = f;
        }
        if let Some(l) = e.linear_mut() {
            if let Some(b) = &u.start_binding {
                l.start_binding = b.clone();
            }
            if let Some(b) = &u.end_binding {
                l.end_binding = b.clone();
            }
        }
        if let (Some(f), Some(el)) = (&u.fixed_segments, e.elbow_mut()) {
            el.fixed_segments = f.clone();
        }
    });
}

fn bindings(e: &Element) -> (Option<&FixedPointBinding>, Option<&FixedPointBinding>) {
    e.linear().map_or((None, None), |l| {
        (l.start_binding.as_ref(), l.end_binding.as_ref())
    })
}

/// `transformElements`: one pointer move of a resize or rotate gesture on
/// the selection. `pointer` is the scene pointer minus the resize offset
/// (`get_resize_offset_xy`), snapped; `center` the selection's center at
/// gesture start (`pointerDownState.resize.center`). Returns whether a
/// transform happened.
#[allow(clippy::too_many_arguments)]
pub fn transform_elements(
    original: &dyn ElementsMap,
    handle: HandleType,
    selected_ids: &[String],
    store: &mut dyn BindingStore,
    o: TransformOpts,
    pointer: Point,
    center: Point,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> bool {
    let [px, py] = pointer;
    match selected_ids {
        [id] => {
            let Some(element) = store.get_element(id).cloned() else {
                return false;
            };
            if handle == HandleType::Rotation {
                if !element.is_elbow_arrow() {
                    rotate_single_element(id, store, px, py, o.rotate_with_discrete_angle);
                    update_bound_elements(id, store, &UpdateBoundOpts::default(), hooks);
                }
            } else if let Some(orig) = original.get_element(id).cloned() {
                let (w, h) = get_next_single_width_and_height_from_pointer(
                    &element,
                    &orig,
                    handle,
                    px,
                    py,
                    o.maintain_aspect_ratio,
                    o.resize_from_center,
                );
                let so = SingleOpts {
                    maintain_aspect_ratio: o.maintain_aspect_ratio,
                    resize_from_center: o.resize_from_center,
                };
                resize_single_element(w, h, id, &orig, original, store, handle, so, m, hooks);
            }
            if element.is_text() {
                update_bound_elements(id, store, &UpdateBoundOpts::default(), hooks);
            }
            true
        }
        [] => false,
        _ => {
            if handle == HandleType::Rotation {
                rotate_multiple_elements(
                    original,
                    selected_ids,
                    store,
                    px,
                    py,
                    o.rotate_with_discrete_angle,
                    center,
                    hooks,
                );
                return true;
            }
            let n = get_next_multiple_width_and_height_from_pointer(
                selected_ids,
                original,
                &*store,
                handle,
                px,
                py,
                o.maintain_aspect_ratio,
                o.resize_from_center,
            );
            resize_multiple_elements(
                selected_ids,
                handle,
                store,
                original,
                &MultiOpts {
                    maintain_aspect_ratio: o.maintain_aspect_ratio,
                    resize_from_center: o.resize_from_center,
                    flip_by_x: n.flip_by_x,
                    flip_by_y: n.flip_by_y,
                    next_width: Some(n.next_width),
                    next_height: Some(n.next_height),
                    original_bounding_box: Some(n.original_bounding_box),
                },
                m,
                hooks,
            );
            true
        }
    }
}

/// `rotateSingleElement` (frames don't rotate; an arrow's bindings break).
pub fn rotate_single_element(
    id: &str,
    store: &mut dyn BindingStore,
    px: f64,
    py: f64,
    discrete: bool,
) {
    let Some(element) = store.get_element(id).cloned() else {
        return;
    };
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(&element, &*store, false);
    let (cx, cy) = ((x1 + x2) / 2., (y1 + y2) / 2.);
    let angle = if element.is_frame_like() {
        0.
    } else {
        let mut a = 5. * std::f64::consts::PI / 2. + (py - cy).atan2(px - cx);
        if discrete {
            a += SHIFT_LOCKING_ANGLE / 2.;
            a -= a % SHIFT_LOCKING_ANGLE;
        }
        normalize_radians(a)
    };
    if element.is_binding_element(true) {
        let (s, e) = bindings(&element);
        if s.is_some() {
            unbind_binding_element(id, StartOrEnd::Start, store);
        }
        if e.is_some() {
            unbind_binding_element(id, StartOrEnd::End, store);
        }
    }
    store.update(id, &mut |e| e.angle = angle);
    if let Some(tid) = element.bound_text_id().map(String::from)
        && !element.is_arrow()
        && let (Some(c), Some(t)) = (
            store.get_element(id).cloned(),
            store.get_element(&tid).cloned(),
        )
    {
        let [x, y] = compute_bound_text_position(&c, &t, &*store);
        store.update(&tid, &mut |e| (e.angle, e.x, e.y) = (angle, x, y));
    }
}

/// `rescalePointsInElement`: points of linear and freedraw elements scaled
/// to `width` × `height`.
pub fn rescale_points_in_element(
    e: &Element,
    width: f64,
    height: f64,
    normalize: bool,
) -> Option<Vec<Point>> {
    let pts = e.points()?;
    Some(rescale_points(
        0,
        width,
        &rescale_points(1, height, pts, normalize),
        normalize,
    ))
}

/// `measureFontSizeFromWidth`: the font size that scales a text (or label,
/// by its container's max width) to `next_width`; None below the minimum.
pub fn measure_font_size_from_width(
    e: &Element,
    map: &dyn ElementsMap,
    next_width: f64,
) -> Option<f64> {
    let t = e.text()?;
    let mut width = e.width;
    if let Some(c) = e.container_id().and_then(|c| map.get_element(c)) {
        width = get_bound_text_max_width(c, Some(e));
    }
    let size = t.font_size * (next_width / width);
    (size >= MIN_FONT_SIZE).then_some(size)
}

/// `resizeSingleTextElement`: corners and top/bottom scale the font; the
/// sides re-wrap the text (which then stops auto-resizing).
#[allow(clippy::too_many_arguments)]
pub fn resize_single_text_element(
    orig: &Element,
    id: &str,
    store: &mut dyn BindingStore,
    handle: HandleType,
    from_center: bool,
    next_width: f64,
    mut next_height: f64,
    m: &dyn Measure,
) {
    let Some(element) = store.get_element(id).cloned() else {
        return;
    };
    let Some(td) = element.text().cloned() else {
        return;
    };
    // a corner follows the axis it grows most, as keeping the aspect ratio
    // does (which text always does)
    if is_corner(handle) {
        next_height = next_height.max(next_width / orig.width * orig.height);
    }
    let metrics_width = element.width * (next_height / element.height);
    let Some(size) = measure_font_size_from_width(&element, &*store, metrics_width) else {
        return;
    };
    if has(handle, 'n') || has(handle, 's') {
        let (x, y) = get_resized_origin(
            [orig.x, orig.y],
            orig.width,
            orig.height,
            metrics_width,
            next_height,
            orig.angle,
            handle,
            false,
            from_center,
        );
        store.update(id, &mut |e| {
            (e.width, e.height, e.x, e.y) = (metrics_width, next_height, x, y);
            if let Some(t) = e.text_mut() {
                t.font_size = size;
            }
        });
        return;
    }
    if matches!(handle, HandleType::E | HandleType::W) {
        let font = font_of(&element);
        let min_width =
            get_min_text_element_width(m, Font::new(td.font_size, td.font_family), td.line_height);
        let new_width = min_width.max(next_width);
        let text = wrap_text(m, &td.original_text, font, new_width.abs());
        let metrics = measure_text(m, &text, font, td.line_height);
        let (x, y) = get_resized_origin(
            [orig.x, orig.y],
            orig.width,
            orig.height,
            new_width,
            metrics.height,
            element.angle,
            handle,
            false,
            from_center,
        );
        store.update(id, &mut |e| {
            (e.width, e.height, e.x, e.y) = (new_width.abs(), metrics.height.abs(), x, y);
            if let Some(t) = e.text_mut() {
                t.text.clone_from(&text);
                t.auto_resize = false;
            }
        });
    }
}

/// `rotateMultipleElements`: rotates each element around `center` by the
/// pointer's angle (from its angle at gesture start).
#[allow(clippy::too_many_arguments)]
pub fn rotate_multiple_elements(
    original: &dyn ElementsMap,
    ids: &[String],
    store: &mut dyn BindingStore,
    px: f64,
    py: f64,
    discrete: bool,
    center: Point,
    hooks: &dyn BindingHooks,
) {
    let mut center_angle = 5. * std::f64::consts::PI / 2. + (py - center[1]).atan2(px - center[0]);
    if discrete {
        center_angle += SHIFT_LOCKING_ANGLE / 2.;
        center_angle -= center_angle % SHIFT_LOCKING_ANGLE;
    }
    let rotated: FxHashSet<String> = ids.iter().cloned().collect();
    for id in ids {
        let Some(element) = store.get_element(id).cloned() else {
            continue;
        };
        if element.is_frame_like() {
            continue;
        }
        let [x1, y1, x2, y2, ..] = get_element_absolute_coords(&element, &*store, false);
        let (cx, cy) = ((x1 + x2) / 2., (y1 + y2) / 2.);
        let orig_angle = original.get_element(id).map_or(element.angle, |o| o.angle);
        let [rcx, rcy] =
            point_rotate_rads([cx, cy], center, center_angle + orig_angle - element.angle);
        let angle = normalize_radians(center_angle + orig_angle);
        let u = if element.is_elbow_arrow() {
            Upd {
                points: Some(get_arrow_local_fixed_points(&element, &*store).to_vec()),
                ..Default::default()
            }
        } else {
            Upd {
                x: Some(element.x + (rcx - cx)),
                y: Some(element.y + (rcy - cy)),
                angle: Some(angle),
                ..Default::default()
            }
        };
        apply(store, id, &u, hooks);
        update_bound_elements(
            id,
            store,
            &UpdateBoundOpts {
                simultaneously_updated: Some(&rotated),
                ..Default::default()
            },
            hooks,
        );
        if let Some(e) = store
            .get_element(id)
            .filter(|e| e.is_binding_element(true))
            .cloned()
        {
            let (s, en) = bindings(&e);
            if s.is_some_and(|b| !rotated.contains(&b.element_id)) {
                unbind_binding_element(id, StartOrEnd::Start, store);
            }
            if en.is_some_and(|b| !rotated.contains(&b.element_id)) {
                unbind_binding_element(id, StartOrEnd::End, store);
            }
        }
        let Some(e) = store.get_element(id).cloned() else {
            continue;
        };
        if let Some(t) = get_bound_text_element(&e, &*store).cloned()
            && !e.is_arrow()
        {
            let [x, y] = compute_bound_text_position(&e, &t, &*store);
            store.update(&t.id, &mut |t| (t.x, t.y, t.angle) = (x, y, angle));
        }
    }
}

/// `getResizeOffsetXY`: where the pointer grabbed the handle, relative to
/// the edge or corner it moves (in the selection's rotation).
pub fn get_resize_offset_xy(
    handle: Option<HandleType>,
    selected: &[&Element],
    map: &dyn ElementsMap,
    x: f64,
    y: f64,
) -> Point {
    let [x1, y1, x2, y2] = if selected.len() == 1 {
        let c = get_element_absolute_coords(selected[0], map, false);
        [c[0], c[1], c[2], c[3]]
    } else {
        get_common_bounds(selected.iter().copied(), map)
    };
    let (cx, cy) = ((x1 + x2) / 2., (y1 + y2) / 2.);
    let angle = if selected.len() == 1 {
        selected[0].angle
    } else {
        0.
    };
    let [x, y] = point_rotate_rads([x, y], [cx, cy], -angle);
    let r = |p: Point| point_rotate_rads(p, [0., 0.], angle);
    match handle {
        Some(HandleType::N) => r([x - cx, y - y1]),
        Some(HandleType::S) => r([x - cx, y - y2]),
        Some(HandleType::W) => r([x - x1, y - cy]),
        Some(HandleType::E) => r([x - x2, y - cy]),
        Some(HandleType::Nw) => r([x - x1, y - y1]),
        Some(HandleType::Ne) => r([x - x2, y - y1]),
        Some(HandleType::Sw) => r([x - x1, y - y2]),
        Some(HandleType::Se) => r([x - x2, y - y2]),
        _ => [0., 0.],
    }
}

/// `getResizeArrowDirection`: which end of a 2-point arrow a corner drags.
pub fn get_resize_arrow_direction(handle: Option<HandleType>, e: &Element) -> StartOrEnd {
    let [px, py] = e
        .points()
        .and_then(|p| p.get(1).copied())
        .unwrap_or([0., 0.]);
    let end = match handle {
        Some(HandleType::Nw) => px < 0. || py < 0.,
        Some(HandleType::Ne) => px >= 0.,
        Some(HandleType::Sw) => px <= 0.,
        Some(HandleType::Se) => px > 0. || py > 0.,
        _ => false,
    };
    if end {
        StartOrEnd::End
    } else {
        StartOrEnd::Start
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Anchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    WestSide,
    NorthSide,
    EastSide,
    SouthSide,
    Center,
}

fn get_resize_anchor(h: HandleType, maintain: bool, from_center: bool) -> Anchor {
    use HandleType::*;
    if from_center {
        return Anchor::Center;
    }
    if maintain {
        return match h {
            N => Anchor::SouthSide,
            E => Anchor::WestSide,
            S => Anchor::NorthSide,
            W => Anchor::EastSide,
            Ne => Anchor::BottomLeft,
            Nw => Anchor::BottomRight,
            Se => Anchor::TopLeft,
            Sw | Rotation => Anchor::TopRight,
        };
    }
    match h {
        E | Se | S => Anchor::TopLeft,
        N | Nw | W => Anchor::BottomRight,
        Ne => Anchor::BottomLeft,
        _ => Anchor::TopRight,
    }
}

/// `getResizedOrigin`: the new `x`, `y` of a (rotated) element resized from
/// `prev` to `new` size, keeping the anchor the handle implies in place.
#[allow(clippy::too_many_arguments)]
fn get_resized_origin(
    prev: Point,
    pw: f64,
    ph: f64,
    nw: f64,
    nh: f64,
    angle: f64,
    h: HandleType,
    maintain: bool,
    from_center: bool,
) -> (f64, f64) {
    let [x, y] = prev;
    let (c, s) = (angle.cos(), angle.sin());
    match get_resize_anchor(h, maintain, from_center) {
        Anchor::TopLeft => (
            x + (pw - nw) / 2. + (nw - pw) / 2. * c + (ph - nh) / 2. * s,
            y + (ph - nh) / 2. + (nw - pw) / 2. * s + (nh - ph) / 2. * c,
        ),
        Anchor::TopRight => (
            x + (pw - nw) / 2. * (c + 1.) + (ph - nh) / 2. * s,
            y + (ph - nh) / 2. + (pw - nw) / 2. * s + (nh - ph) / 2. * c,
        ),
        Anchor::BottomLeft => (
            x + (pw - nw) / 2. * (1. - c) + (nh - ph) / 2. * s,
            y + (ph - nh) / 2. * (c + 1.) + (nw - pw) / 2. * s,
        ),
        Anchor::BottomRight => (
            x + (pw - nw) / 2. * (c + 1.) + (nh - ph) / 2. * s,
            y + (ph - nh) / 2. * (c + 1.) + (pw - nw) / 2. * s,
        ),
        Anchor::Center => (x - (nw - pw) / 2., y - (nh - ph) / 2.),
        Anchor::EastSide => (
            x + (pw - nw) / 2. * (c + 1.),
            y + (pw - nw) / 2. * s + (ph - nh) / 2.,
        ),
        Anchor::WestSide => (
            x + (pw - nw) / 2. * (1. - c),
            y + (nw - pw) / 2. * s + (ph - nh) / 2.,
        ),
        Anchor::NorthSide => (
            x + (pw - nw) / 2. + (ph - nh) / 2. * s,
            y + (nh - ph) / 2. * (c - 1.),
        ),
        Anchor::SouthSide => (
            x + (pw - nw) / 2. + (nh - ph) / 2. * s,
            y + (ph - nh) / 2. * (c + 1.),
        ),
    }
}

/// `resizeSingleElement` options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SingleOpts {
    pub maintain_aspect_ratio: bool,
    pub resize_from_center: bool,
}

/// `resizeSingleElement`: resizes the element `id` to `next_width` ×
/// `next_height` (negative: flipped across the opposite edge) from its
/// gesture-start state `orig`. Labels re-wrap (or scale, keeping the aspect
/// ratio), sticky notes re-lay out, an arrow's bindings break, and the
/// arrows bound to it follow.
#[allow(clippy::too_many_arguments)]
pub fn resize_single_element(
    mut next_width: f64,
    mut next_height: f64,
    id: &str,
    orig: &Element,
    original: &dyn ElementsMap,
    store: &mut dyn BindingStore,
    handle: HandleType,
    o: SingleOpts,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) {
    let Some(latest) = store.get_element(id).cloned() else {
        return;
    };
    if latest.is_text() && orig.is_text() {
        return resize_single_text_element(
            orig,
            id,
            store,
            handle,
            o.resize_from_center,
            next_width,
            next_height,
            m,
        );
    }
    // constraints and font scaling use magnitudes; the signs flip the
    // element across the opposite edge below
    let flip_x = if next_width < 0. { -1. } else { 1. };
    let flip_y = if next_height < 0. { -1. } else { 1. };
    (next_width, next_height) = (next_width.abs(), next_height.abs());
    let bound_text = get_bound_text_element(&latest, &*store).cloned();
    let sticky = latest.is_sticky_note();
    let min_size =
        if sticky {
            // a note must fit one line at its label's font ceiling
            Some(bound_text.as_ref().and_then(|t| t.text()).map_or(
                (STICKY_NOTE_MIN_SIZE, STICKY_NOTE_MIN_SIZE),
                |t| {
                    get_sticky_note_min_size(t.base_font_size.unwrap_or(t.font_size), t.font_family)
                },
            ))
        } else {
            bound_text
                .as_ref()
                .filter(|_| !o.maintain_aspect_ratio)
                .and_then(|t| t.text().map(|td| (t, td)))
                .map(|(t, td)| {
                    (
                        get_approx_min_line_width(m, font_of(t), td.line_height),
                        get_approx_min_line_height(td.font_size, td.line_height),
                    )
                })
        };
    if let Some((mw, mh)) = min_size {
        next_width = next_width.max(mw);
        next_height = next_height.max(mh);
        if o.maintain_aspect_ratio {
            // both dimensions use the same scale even at the minimum size
            let scale = (next_width / orig.width).max(next_height / orig.height);
            (next_width, next_height) = (orig.width * scale, orig.height * scale);
        }
    }
    let mut bound_font: Option<f64> = None;
    if let Some(t) = bound_text.as_ref().filter(|_| !sticky) {
        if let Some(at_start) = original.get_element(&t.id).and_then(|e| e.text()) {
            bound_font = Some(at_start.font_size);
        }
        if o.maintain_aspect_ratio {
            let mut updated = latest.clone();
            (updated.width, updated.height) = (next_width, next_height);
            let Some(f) = measure_font_size_from_width(
                t,
                &*store,
                get_bound_text_max_width(&updated, Some(t)),
            ) else {
                return;
            };
            bound_font = Some(f);
        }
    }
    next_width *= flip_x;
    next_height *= flip_y;
    let mut points = rescale_points_in_element(orig, next_width, next_height, true);
    let mut prev_origin = [orig.x, orig.y];
    if orig.is_linear() {
        let b = get_element_bounds(orig, original, false);
        prev_origin = [b[0], b[1]];
    }
    let (mut nx, mut ny) = get_resized_origin(
        prev_origin,
        orig.width,
        orig.height,
        next_width,
        next_height,
        orig.angle,
        handle,
        o.maintain_aspect_ratio,
        o.resize_from_center,
    );
    if orig.is_linear()
        && let Some(p) = &mut points
    {
        nx += orig.x - prev_origin[0];
        ny += orig.y - prev_origin[1];
        let [sx, sy] = p[0];
        nx += sx;
        ny += sy;
        for q in p.iter_mut() {
            *q = [q[0] - sx, q[1] - sy];
        }
    }
    // flipping
    if next_width < 0. {
        nx += next_width;
    }
    if next_height < 0. {
        ny += next_height;
    }
    if let (Some(_), Some(oi)) = (latest.image(), orig.image()) {
        let sign = |v: f64, d: f64| if v == 0. || v.is_nan() { d } else { v.signum() };
        let scale = [
            sign(next_width, oi.scale[0]) * oi.scale[0],
            sign(next_height, oi.scale[1]) * oi.scale[1],
        ];
        store.update(id, &mut |e| {
            if let Some(i) = e.image_mut() {
                i.scale = scale;
            }
        });
    }
    if latest.is_arrow()
        && o.maintain_aspect_ratio
        && let Some(t) = bound_text.as_ref().and_then(|t| t.text())
    {
        let f = next_width.abs() / latest.width * t.font_size;
        if f < MIN_FONT_SIZE {
            return;
        }
        bound_font = Some(f);
    }
    if next_width == 0. || next_height == 0. || !nx.is_finite() || !ny.is_finite() {
        return;
    }
    let mut u = Upd {
        x: Some(nx),
        y: Some(ny),
        width: Some(next_width.abs()),
        height: Some(next_height.abs()),
        points,
        ..Default::default()
    };
    if latest.is_binding_element(true) {
        let (s, e) = bindings(&latest);
        if s.is_some() {
            unbind_binding_element(id, StartOrEnd::Start, store);
        }
        if e.is_some() {
            u.end_binding = Some(None);
        }
    }
    apply(store, id, &u, hooks);
    if sticky {
        let Some(c) = store.get_element(id).cloned() else {
            return;
        };
        let intent = get_sticky_note_resize_intent(
            &c,
            original,
            handle,
            o.maintain_aspect_ratio,
            o.resize_from_center,
            false,
        );
        update_sticky_note_layout(store, id, None, &intent, m);
    } else {
        if let (Some(t), Some(f)) = (&bound_text, bound_font) {
            store.update(&t.id, &mut |e| {
                if let Some(d) = e.text_mut() {
                    d.font_size = f;
                }
            });
        }
        handle_bind_text_resize(
            store,
            id,
            m,
            Some(handle),
            o.maintain_aspect_ratio,
            o.resize_from_center,
            flip_y < 0.,
        );
    }
    update_bound_elements(id, store, &UpdateBoundOpts::default(), hooks);
}

/// `getNextSingleWidthAndHeightFromPointer`: the size (signed: negative when
/// the pointer crossed the opposite edge) the pointer resizes `latest` to.
pub fn get_next_single_width_and_height_from_pointer(
    latest: &Element,
    orig: &Element,
    handle: HandleType,
    px: f64,
    py: f64,
    maintain: bool,
    from_center: bool,
) -> (f64, f64) {
    let [x1, y1, x2, y2] = get_resized_element_absolute_coords(orig, orig.width, orig.height, true);
    let (tl, br) = ([x1, y1], [x2, y2]);
    let rp = point_rotate_rads([px, py], point_center(tl, br), -orig.angle);
    let [ex1, ey1, ex2, ey2] =
        get_resized_element_absolute_coords(latest, latest.width, latest.height, true);
    let (cw, ch) = (ex2 - ex1, ey2 - ey1);
    let mut sx = (br[0] - tl[0]) / cw;
    let mut sy = (br[1] - tl[1]) / ch;
    if has(handle, 'e') {
        sx = (rp[0] - tl[0]) / cw;
    }
    if has(handle, 's') {
        sy = (rp[1] - tl[1]) / ch;
    }
    if has(handle, 'w') {
        sx = (br[0] - rp[0]) / cw;
    }
    if has(handle, 'n') {
        sy = (br[1] - rp[1]) / ch;
    }
    let mut w = latest.width * sx;
    let mut h = latest.height * sy;
    if from_center {
        w = 2. * w - orig.width;
        h = 2. * h - orig.height;
    }
    if maintain {
        let (wr, hr) = (w.abs() / orig.width, h.abs() / orig.height);
        if !is_corner(handle) {
            h *= wr;
            w *= hr;
        } else {
            let r = wr.max(hr);
            w = orig.width * r * js_sign(w);
            h = orig.height * r * js_sign(h);
        }
    }
    (w, h)
}

fn js_sign(v: f64) -> f64 {
    if v == 0. || v.is_nan() { v } else { v.signum() }
}

/// What `getNextMultipleWidthAndHeightFromPointer` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MultiSize {
    pub original_bounding_box: BoundingBox,
    pub next_width: f64,
    pub next_height: f64,
    pub flip_by_x: bool,
    pub flip_by_y: bool,
}

/// The gesture-start elements of the selection plus their arrows' labels at
/// their positions (which `getCommonBoundingBox` can't find through the
/// snapshot).
fn originals_with_labels(
    ids: &[String],
    original: &dyn ElementsMap,
    map: &dyn ElementsMap,
) -> Vec<Element> {
    let origs: Vec<Element> = ids
        .iter()
        .filter_map(|id| original.get_element(id).cloned())
        .collect();
    let mut labels = vec![];
    for o in origs.iter().filter(|o| o.is_linear()) {
        let Some(t) = o
            .bound_text_id()
            .and_then(|id| original.get_element(id))
            .filter(|t| t.is_bound_to_container())
        else {
            continue;
        };
        let [x, y] = get_bound_text_element_position(o, t, map);
        let mut t = t.clone();
        (t.x, t.y) = (x, y);
        labels.push(t);
    }
    let mut all = origs;
    all.extend(labels);
    all
}

fn anchor_for(h: HandleType, b: &BoundingBox) -> Point {
    let (w, ht) = (b.max_x - b.min_x, b.max_y - b.min_y);
    match h {
        HandleType::Ne => [b.min_x, b.max_y],
        HandleType::Se => [b.min_x, b.min_y],
        HandleType::Sw => [b.max_x, b.min_y],
        HandleType::Nw => [b.max_x, b.max_y],
        HandleType::E => [b.min_x, b.min_y + ht / 2.],
        HandleType::W => [b.max_x, b.min_y + ht / 2.],
        HandleType::N => [b.min_x + w / 2., b.max_y],
        HandleType::S | HandleType::Rotation => [b.min_x + w / 2., b.min_y],
    }
}

/// `getNextMultipleWidthAndHeightFromPointer`.
#[allow(clippy::too_many_arguments)]
pub fn get_next_multiple_width_and_height_from_pointer(
    ids: &[String],
    original: &dyn ElementsMap,
    map: &dyn ElementsMap,
    handle: HandleType,
    px: f64,
    py: f64,
    maintain: bool,
    from_center: bool,
) -> MultiSize {
    let all = originals_with_labels(ids, original, map);
    let bb = get_common_bounding_box(all.iter(), &all);
    let (width, height) = (bb.max_x - bb.min_x, bb.max_y - bb.min_y);
    let [ax, ay] = if from_center {
        [bb.mid_x, bb.mid_y]
    } else {
        anchor_for(handle, &bb)
    };
    let k = if from_center { 2. } else { 1. };
    let or0 = |v: f64| if v.is_nan() { 0. } else { v };
    let scale = or0((px - ax).abs() / width).max(or0((py - ay).abs() / height)) * k;
    let mut nw = if has(handle, 'e') || has(handle, 'w') {
        (px - ax).abs() * k
    } else {
        width
    };
    let mut nh = if has(handle, 'n') || has(handle, 's') {
        (py - ay).abs() * k
    } else {
        height
    };
    if maintain {
        nw = width * scale * js_sign(px - ax);
        nh = height * scale * js_sign(py - ay);
    }
    let (fx, fy) = match handle {
        HandleType::Ne => (px < ax, py > ay),
        HandleType::Se => (px < ax, py < ay),
        HandleType::Sw => (px > ax, py < ay),
        HandleType::Nw => (px > ax, py > ay),
        HandleType::E => (px < ax, false),
        HandleType::W => (px > ax, false),
        HandleType::N => (false, py > ay),
        HandleType::S => (false, py < ay),
        HandleType::Rotation => (false, false),
    };
    MultiSize {
        original_bounding_box: bb,
        next_width: nw,
        next_height: nh,
        flip_by_x: fx,
        flip_by_y: fy,
    }
}

/// `resizeMultipleElements` options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MultiOpts {
    pub maintain_aspect_ratio: bool,
    pub resize_from_center: bool,
    pub flip_by_x: bool,
    pub flip_by_y: bool,
    /// None (both): keep the size (just flipping).
    pub next_width: Option<f64>,
    pub next_height: Option<f64>,
    /// The selection's box at gesture start, if already computed.
    pub original_bounding_box: Option<BoundingBox>,
}

/// `resizeMultipleElements`: scales (and flips) the selection from its
/// gesture-start state. Rotated, text and grouped elements keep their
/// aspect ratio; labels scale with their containers; bindings to elements
/// outside the selection break.
pub fn resize_multiple_elements(
    ids: &[String],
    handle: HandleType,
    store: &mut dyn BindingStore,
    original: &dyn ElementsMap,
    o: &MultiOpts,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) {
    let (mut next_width, mut next_height) = (o.next_width, o.next_height);
    // no zero sizes
    if next_height == Some(0.) || next_width == Some(0.) {
        return;
    }
    // the selection's snapshots (and latest versions)
    let targets: Vec<(Element, Element)> = ids
        .iter()
        .filter_map(|id| {
            Some((
                original.get_element(id)?.clone(),
                store.get_element(id)?.clone(),
            ))
        })
        .collect();
    let bb = o.original_bounding_box.unwrap_or_else(|| {
        let all = originals_with_labels(ids, original, &*store);
        get_common_bounding_box(all.iter(), &all)
    });
    let (width, height) = (bb.max_x - bb.min_x, bb.max_y - bb.min_y);
    if next_width.is_none() && next_height.is_none() {
        (next_width, next_height) = (Some(width), Some(height));
    }
    if o.maintain_aspect_ratio {
        match (next_width, next_height) {
            (None, Some(h)) => next_width = Some(h * (width / height)),
            (Some(w), None) => next_height = Some(w * (height / width)),
            (Some(w), Some(h)) if (w / h - width / height).abs() > 0.001 => {
                next_width = Some(h * (width / height))
            }
            _ => {}
        }
    }
    let (Some(nw), Some(nh)) = (next_width, next_height) else {
        return;
    };
    if nw == 0. || nh == 0. || nw.is_nan() || nh.is_nan() {
        return;
    }
    let or0 = |v: f64| if v.is_nan() { 0. } else { v };
    let mut sx = if has(handle, 'e') || has(handle, 'w') {
        nw.abs() / width
    } else {
        1.
    };
    let mut sy = if has(handle, 'n') || has(handle, 's') {
        nh.abs() / height
    } else {
        1.
    };
    let scale = if !is_corner(handle) {
        if has(handle, 'e') || has(handle, 'w') {
            sx
        } else {
            sy
        }
    } else {
        or0(nw.abs() / width).max(or0(nh.abs() / height))
    };
    let [ax, ay] = if o.resize_from_center {
        [bb.mid_x, bb.mid_y]
    } else {
        anchor_for(handle, &bb)
    };
    let keep = o.maintain_aspect_ratio
        || targets
            .iter()
            .any(|(_, l)| l.angle != 0. || l.is_text() || !l.group_ids.is_empty());
    if keep {
        (sx, sy) = (scale, scale);
    }
    // to flip: mirror across the axis, shifting by the size (linear and
    // freedraw elements mirror their points instead), and mirror the angle
    let (fx, fy) = (
        if o.flip_by_x { -1. } else { 1. },
        if o.flip_by_y { -1. } else { 1. },
    );
    let mut updates: Vec<(String, Upd, Option<f64>)> = vec![];
    for (orig, _) in &targets {
        // labels follow their containers
        if orig.is_bound_to_container() {
            continue;
        }
        let (w, h) = (orig.width * sx, orig.height * sy);
        let angle = normalize_radians(orig.angle * fx * fy);
        let lf = orig.is_linear() || orig.is_freedraw();
        let shift_x = if o.flip_by_x && !lf { w } else { 0. };
        let shift_y = if o.flip_by_y && !lf { h } else { 0. };
        let x = ax + fx * ((orig.x - ax) * sx + shift_x);
        let y = ay + fy * ((orig.y - ay) * sy + shift_y);
        let points = rescale_points_in_element(orig, w * fx, h * fy, false);
        let mut u = Upd {
            x: Some(x),
            y: Some(y),
            width: Some(w),
            height: Some(h),
            angle: Some(angle),
            ..Default::default()
        };
        if orig.is_elbow_arrow() {
            // mirror the fixed points when flipped
            let mirror = |b: &FixedPointBinding| FixedPointBinding {
                fixed_point: [
                    if o.flip_by_x {
                        1. - b.fixed_point[0]
                    } else {
                        b.fixed_point[0]
                    },
                    if o.flip_by_y {
                        1. - b.fixed_point[1]
                    } else {
                        b.fixed_point[1]
                    },
                ],
                ..b.clone()
            };
            let (s, e) = bindings(orig);
            if let Some(s) = s {
                u.start_binding = Some(Some(mirror(s)));
            }
            if let Some(e) = e {
                u.end_binding = Some(Some(mirror(e)));
            }
            if let (Some(fs), Some(p)) = (
                orig.elbow().and_then(|e| e.fixed_segments.as_ref()),
                &points,
            ) {
                u.fixed_segments = Some(Some(
                    fs.iter()
                        .map(|s| FixedSegment {
                            start: p[s.index - 1],
                            end: p[s.index],
                            ..*s
                        })
                        .collect(),
                ));
            }
        }
        u.points = points;
        if let Some(i) = orig.image() {
            u.scale = Some([i.scale[0] * fx, i.scale[1] * fy]);
        }
        if orig.is_text() {
            let Some(f) = measure_font_size_from_width(orig, &*store, w) else {
                return;
            };
            u.font_size = Some(f);
        }
        let mut bound_font = None;
        // sticky notes size their label from the layout below
        if let Some(t) = orig
            .bound_text_id()
            .and_then(|id| original.get_element(id))
            .and_then(|t| t.text())
            && !orig.is_sticky_note()
        {
            if keep {
                let f = t.font_size * scale;
                if f < MIN_FONT_SIZE {
                    return;
                }
                bound_font = Some(f);
            } else {
                bound_font = Some(t.font_size);
            }
        }
        updates.push((orig.id.clone(), u, bound_font));
    }
    let resized: FxHashSet<String> = updates.iter().map(|(id, ..)| id.clone()).collect();
    for (id, u, bound_font) in &updates {
        apply(store, id, u, hooks);
        let Some(e) = store.get_element(id).cloned() else {
            continue;
        };
        if e.is_sticky_note() {
            // the content correction runs before the (single) arrow pass
            let intent = get_sticky_note_resize_intent(
                &e,
                original,
                handle,
                keep,
                o.resize_from_center,
                o.flip_by_x || o.flip_by_y,
            );
            update_sticky_note_layout(store, id, None, &intent, m);
        }
        update_bound_elements(
            id,
            store,
            &UpdateBoundOpts {
                simultaneously_updated: Some(&resized),
                ..Default::default()
            },
            hooks,
        );
        if e.is_binding_element(true) {
            let (s, en) = bindings(&e);
            if s.is_some_and(|b| !resized.contains(&b.element_id)) {
                unbind_binding_element(id, StartOrEnd::Start, store);
            }
            if en.is_some_and(|b| !resized.contains(&b.element_id)) {
                unbind_binding_element(id, StartOrEnd::End, store);
            }
        }
        let Some(e) = store.get_element(id).cloned() else {
            continue;
        };
        if let (Some(t), Some(f)) = (
            get_bound_text_element(&e, &*store).map(|t| t.id.clone()),
            *bound_font,
        ) && !e.is_sticky_note()
        {
            let linear = e.is_linear();
            store.update(&t, &mut |t| {
                if let Some(d) = t.text_mut() {
                    d.font_size = f;
                }
                if !linear && let Some(a) = u.angle {
                    t.angle = a;
                }
            });
            handle_bind_text_resize(
                store,
                id,
                m,
                Some(handle),
                true,
                o.resize_from_center,
                o.flip_by_y,
            );
        }
    }
}

/// The selection's bounds (`getCommonBounds`); their center is
/// `pointerDownState.resize.center`, the rotation center `transform_elements` takes.
pub fn selection_bounds(ids: &[String], map: &dyn ElementsMap) -> Bounds {
    get_common_bounds(ids.iter().filter_map(|id| map.get_element(id)), map)
}
