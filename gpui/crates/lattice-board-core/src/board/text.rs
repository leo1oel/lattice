// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Text in containers. Port of Excalidraw @ 3a317b5
//! `packages/element/src/textElement.ts` (label layout: `redrawTextBoundingBox`,
//! `handleBindTextResize`, `computeBoundTextPosition`, the container
//! metrics), `element/src/containerCache.ts`, the text half of
//! `element/src/newElement.ts` (`refreshTextDimensions`,
//! `getAdjustedDimensions`) and the element logic of
//! `excalidraw/actions/actionBoundText.tsx` (bind / unbind / wrap in a
//! container).
//!
//! Upstream mutates through `scene.mutateElement`; here functions take
//! binding's `BindingStore` (a `Scene`, history's `ElementMap`, a `Vec`), and
//! measure through `Measure`. Where upstream passes element objects that the
//! scene mutates in place, these take ids (or a clone of the text, which
//! `redrawTextBoundingBox` may be handed before it is installed) and re-read
//! the scene after each mutation, which is what the in-place objects amount
//! to. Bound arrows are the binding module's: functions that move a
//! container's geometry say so, and the caller runs `updateBoundElements`.
//! The original-container-height cache is per thread, as upstream's is per
//! page.

use super::binding::BindingStore;
use super::bounds::get_bound_text_element_position;
pub use super::bounds::{
    get_bound_text_element, get_container_element, get_text_element_with_accurate_position,
};
use super::consts::*;
use super::fractional_index::sync_moved_indices;
use super::handles::HandleType;
use super::history::{ElementMap, HistoryHooks};
use super::math::{Point, js_round, point_rotate_rads};
use super::new_element::{
    ElementOpts, adjust_xy_with_rotation, get_text_element_position_offsets, new_element,
};
use super::scene::Scene;
use super::size_helpers::{VerticalResizeAnchor, get_position_after_height_change};
use super::sticky::{
    StickyNoteLayoutOpts, normalize_sticky_note_font_size, update_sticky_note_layout,
};
use super::text_measure::{Font, Measure, measure_text};
use super::text_wrapping::wrap_text;
use super::types::*;
use super::utils::{ElementsMap, is_transparent};
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::RefCell;
use std::f64::consts::SQRT_2;

/// `scene.mutateElement` with a one-shot update, over binding's store
/// (a `Scene`, history's `ElementMap`, a plain `Vec`).
pub fn mutate_in(store: &mut dyn BindingStore, id: &str, f: impl FnOnce(&mut Element)) -> bool {
    let mut f = Some(f);
    store.update(id, &mut |e| {
        if let Some(f) = f.take() {
            f(e)
        }
    })
}

/// The font a text element is drawn with (`getFontString`).
pub fn font_of(t: &Element) -> Font {
    t.text()
        .map_or(Font::new(DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY), |d| {
            Font::new(d.font_size, d.font_family)
        })
}

// ---------------------------------------------------------------------------
// containerCache.ts
// ---------------------------------------------------------------------------

thread_local! {
    static ORIGINAL_CONTAINER_CACHE: RefCell<FxHashMap<String, f64>> = RefCell::new(FxHashMap::default());
}

/// `updateOriginalContainerCache`: the height a container had before its
/// label grew it (restored on unbind, the floor of auto-shrink).
pub fn update_original_container_cache(id: &str, height: f64) -> f64 {
    ORIGINAL_CONTAINER_CACHE.with(|c| c.borrow_mut().insert(id.into(), height));
    height
}
pub fn reset_original_container_cache(id: &str) {
    ORIGINAL_CONTAINER_CACHE.with(|c| c.borrow_mut().remove(id));
}
pub fn get_original_container_height_from_cache(id: &str) -> Option<f64> {
    ORIGINAL_CONTAINER_CACHE.with(|c| c.borrow().get(id).copied())
}

// ---------------------------------------------------------------------------
// textElement.ts
// ---------------------------------------------------------------------------

pub const DEFAULT_BOUND_TEXT_LABEL_POSITION: f64 = 0.5;

/// `getBoundTextElementId`.
pub fn get_bound_text_element_id(container: &Element) -> Option<&str> {
    container.bound_text_id()
}

/// `isValidTextContainer`.
pub fn is_valid_text_container(ty: ElementType) -> bool {
    matches!(
        ty,
        ElementType::Rectangle
            | ElementType::StickyNote
            | ElementType::Ellipse
            | ElementType::Diamond
            | ElementType::Arrow
    )
}

/// `computeContainerDimensionForBoundText`: the container size that holds a
/// label of this size.
pub fn compute_container_dimension_for_bound_text(dimension: f64, ty: ElementType) -> f64 {
    let d = dimension.ceil();
    let padding = BOUND_TEXT_PADDING * 2.;
    match ty {
        ElementType::Ellipse => js_round((d + padding) / SQRT_2 * 2.),
        ElementType::Arrow => d + padding * 8.,
        ElementType::Diamond => 2. * (d + padding),
        _ => d + padding,
    }
}

/// `getBoundTextMaxWidth`: the widest a label may get before it wraps
/// (the largest inscribed rectangle for ellipses and diamonds).
pub fn get_bound_text_max_width(container: &Element, text: Option<&Element>) -> f64 {
    let w = container.width;
    match container.ty() {
        ElementType::Arrow => {
            let min = text
                .and_then(|t| t.text())
                .map_or(DEFAULT_FONT_SIZE, |t| t.font_size)
                * ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO;
            (ARROW_LABEL_WIDTH_FRACTION * w).max(min)
        }
        ElementType::Ellipse => js_round(w / 2. * SQRT_2) - BOUND_TEXT_PADDING * 2.,
        ElementType::Diamond => js_round(w / 2.) - BOUND_TEXT_PADDING * 2.,
        ElementType::StickyNote => w - STICKY_NOTE_PADDING * 2.,
        _ => w - BOUND_TEXT_PADDING * 2.,
    }
}

/// `getBoundTextMaxHeight`.
pub fn get_bound_text_max_height(container: &Element, text: &Element) -> f64 {
    let h = container.height;
    match container.ty() {
        // the label body ends above the creation-date footer
        ElementType::StickyNote => (h - STICKY_NOTE_BODY_INSET_Y).max(0.),
        ElementType::Arrow => {
            if h - BOUND_TEXT_PADDING * 8. * 2. <= 0. {
                text.height
            } else {
                h
            }
        }
        ElementType::Ellipse => js_round(h / 2. * SQRT_2) - BOUND_TEXT_PADDING * 2.,
        ElementType::Diamond => js_round(h / 2.) - BOUND_TEXT_PADDING * 2.,
        _ => h - BOUND_TEXT_PADDING * 2.,
    }
}

/// `getContainerCoords`: top-left of the box a label lays out in.
pub fn get_container_coords(container: &Element) -> Point {
    let padding = if container.is_sticky_note() {
        STICKY_NOTE_PADDING
    } else {
        BOUND_TEXT_PADDING
    };
    let (mut ox, mut oy) = (padding, padding);
    if container.ty() == ElementType::Ellipse {
        ox += container.width / 2. * (1. - SQRT_2 / 2.);
        oy += container.height / 2. * (1. - SQRT_2 / 2.);
    }
    if container.ty() == ElementType::Diamond {
        ox += container.width / 4.;
        oy += container.height / 4.;
    }
    [container.x + ox, container.y + oy]
}

/// `getContainerCenter`: where a label centers, and where the text tool
/// snaps a new arrow label to.
pub fn get_container_center(container: &Element, map: &dyn ElementsMap) -> Point {
    if !container.is_arrow() {
        return [
            container.x + container.width / 2.,
            container.y + container.height / 2.,
        ];
    }
    super::bounds::get_bound_text_element_center(container, map)
}

/// `getTextElementAngle`.
pub fn get_text_element_angle(text: &Element, container: Option<&Element>) -> f64 {
    match container {
        Some(c) if c.is_arrow() => 0.,
        Some(c) => c.angle,
        None => text.angle,
    }
}

/// `getBoundTextElementPosition`: arrow labels only.
pub fn get_arrow_bound_text_element_position(
    container: &Element,
    text: &Element,
    map: &dyn ElementsMap,
) -> Option<Point> {
    container
        .is_arrow()
        .then(|| get_bound_text_element_position(container, text, map))
}

/// `computeBoundTextPosition`: top-left of a label laid out by its
/// alignment in its container (arrows: on the path).
pub fn compute_bound_text_position(
    container: &Element,
    text: &Element,
    map: &dyn ElementsMap,
) -> Point {
    if container.is_arrow() {
        return get_bound_text_element_position(container, text, map);
    }
    let [cx, cy] = get_container_coords(container);
    let max_h = get_bound_text_max_height(container, text);
    let max_w = get_bound_text_max_width(container, Some(text));
    let (align, valign) = text
        .text()
        .map_or((TextAlign::Center, VerticalAlign::Middle), |t| {
            (t.text_align, t.vertical_align)
        });
    let y = match valign {
        VerticalAlign::Top => cy,
        VerticalAlign::Bottom => cy + (max_h - text.height),
        // centered in the whole padded note while clear of the footer, pushed
        // up against the body's bottom only once it would overlap
        VerticalAlign::Middle if container.is_sticky_note() => {
            cy + ((container.height - STICKY_NOTE_PADDING * 2. - text.height) / 2.)
                .min(max_h - text.height)
        }
        VerticalAlign::Middle => cy + (max_h / 2. - text.height / 2.),
    };
    let x = match align {
        TextAlign::Left => cx,
        TextAlign::Right => cx + (max_w - text.width),
        TextAlign::Center => cx + (max_w / 2. - text.width / 2.),
    };
    if container.angle == 0. {
        return [x, y];
    }
    // a note's body rotates about the note's center, not its own
    let content_center = if container.is_sticky_note() {
        [
            container.x + container.width / 2.,
            container.y + container.height / 2.,
        ]
    } else {
        [cx + max_w / 2., cy + max_h / 2.]
    };
    let [rx, ry] = point_rotate_rads(
        [x + text.width / 2., y + text.height / 2.],
        content_center,
        container.angle,
    );
    [rx - text.width / 2., ry - text.height / 2.]
}

/// `redrawTextBoundingBox`: re-wraps and re-measures `text` (the element,
/// or an uncommitted clone of it) and, in a container, grows the container
/// to fit and positions the label. Sticky notes are laid out by the note's
/// fit; then (true is returned) the caller runs `updateBoundElements` on the
/// note, which upstream does inside.
pub fn redraw_text_bounding_box(
    scene: &mut dyn BindingStore,
    text: &Element,
    container_id: Option<&str>,
    m: &dyn Measure,
) -> bool {
    let Some(td) = text.text() else { return false };
    let container = container_id.and_then(|id| scene.get_element(id)).cloned();
    if let Some(c) = &container
        && c.is_sticky_note()
    {
        update_sticky_note_layout(
            scene,
            &c.id,
            Some(Some(text)),
            &StickyNoteLayoutOpts::default(),
            m,
        );
        return true;
    }
    debug_assert!(
        container.as_ref().is_none_or(|c| !c.is_arrow()) || text.angle == 0.,
        "text element angle must be 0 if bound to arrow container"
    );
    let font = font_of(text);
    let angle = match &container {
        Some(c) if c.is_arrow() => 0.,
        Some(c) => c.angle,
        None => text.angle,
    };
    let mut s = td.text.clone();
    if container.is_some() || !td.auto_resize {
        let max_width = container
            .as_ref()
            .map_or(text.width, |c| get_bound_text_max_width(c, Some(text)));
        s = wrap_text(m, &td.original_text, font, max_width);
    }
    let metrics = measure_text(m, &s, font, td.line_height);
    // only free growing text and labels (always auto-resize) take the width
    let width = if td.auto_resize {
        metrics.width
    } else {
        text.width
    };
    let (mut x, mut y) = (text.x, text.y);
    if let Some(c) = container {
        let max_h = get_bound_text_max_height(&c, text);
        let max_w = get_bound_text_max_width(&c, Some(text));
        if !c.is_arrow() && metrics.height > max_h {
            let h = compute_container_dimension_for_bound_text(metrics.height, c.ty());
            mutate_in(scene, &c.id, |e| e.height = h);
            update_original_container_cache(&c.id, h);
        }
        if metrics.width > max_w {
            let w = compute_container_dimension_for_bound_text(metrics.width, c.ty());
            mutate_in(scene, &c.id, |e| e.width = w);
        }
        let c = scene.get_element(&c.id).cloned().unwrap_or(c);
        let mut updated = text.clone();
        (updated.width, updated.height, updated.angle) = (width, metrics.height, angle);
        if let Some(t) = updated.text_mut() {
            t.text = s.clone();
        }
        [x, y] = compute_bound_text_position(&c, &updated, &*scene);
    }
    mutate_in(scene, &text.id, |e| {
        (e.x, e.y, e.width, e.height, e.angle) = (x, y, width, metrics.height, angle);
        if let Some(t) = e.text_mut() {
            t.text = s;
        }
    });
    false
}

/// `handleBindTextResize`: after a container's resize, re-wraps its label
/// (not for pure vertical resizes, which keep the wrap), grows the container
/// back if the label overflows it, and re-positions the label. `handle` is
/// the transform handle used (None: not a handle resize).
pub fn handle_bind_text_resize(
    scene: &mut dyn BindingStore,
    container_id: &str,
    m: &dyn Measure,
    handle: Option<HandleType>,
    maintain_aspect_ratio: bool,
    resize_from_center: bool,
    flip_by_y: bool,
) {
    let Some(container) = scene.get_element(container_id).cloned() else {
        return;
    };
    if container.is_sticky_note() {
        // resize callers pass their intents to the sticky layout and own the
        // bound-arrow pass; this is the fallback for generic callers
        update_sticky_note_layout(
            scene,
            container_id,
            None,
            &StickyNoteLayoutOpts::default(),
            m,
        );
        return;
    }
    let Some(text_id) = container.bound_text_id().map(str::to_owned) else {
        return;
    };
    reset_original_container_cache(container_id);
    let Some(t) = scene
        .get_element(&text_id)
        .filter(|t| !t.is_deleted)
        .cloned()
    else {
        return;
    };
    let Some(td) = t.text().filter(|d| !d.text.is_empty()) else {
        return;
    };
    let (mut text, mut next_h, mut next_w) = (td.text.clone(), t.height, t.width);
    let max_w = get_bound_text_max_width(&container, Some(&t));
    let max_h = get_bound_text_max_height(&container, &t);
    if maintain_aspect_ratio || !matches!(handle, Some(HandleType::N | HandleType::S)) {
        text = wrap_text(m, &td.original_text, font_of(&t), max_w);
        let metrics = measure_text(m, &text, font_of(&t), td.line_height);
        (next_h, next_w) = (metrics.height, metrics.width);
    }
    // grow the container back for the label (an arrow's points decide its size)
    if !container.is_arrow() && next_h > max_h {
        let h = compute_container_dimension_for_bound_text(next_h, container.ty());
        // crossing the opposite edge swaps the anchor for text-driven growth
        let from_top = matches!(
            handle,
            Some(HandleType::N | HandleType::Ne | HandleType::Nw)
        ) != flip_by_y;
        let anchor = if resize_from_center {
            VerticalResizeAnchor::Center
        } else if from_top {
            VerticalResizeAnchor::Bottom
        } else {
            VerticalResizeAnchor::Top
        };
        let (x, y) = get_position_after_height_change(&container, h, anchor);
        mutate_in(scene, container_id, |e| (e.height, e.x, e.y) = (h, x, y));
    }
    mutate_in(scene, &text_id, |e| {
        (e.width, e.height) = (next_w, next_h);
        if let Some(d) = e.text_mut() {
            d.text = text;
        }
    });
    if !container.is_arrow() {
        let (Some(c), Some(t)) = (
            scene.get_element(container_id).cloned(),
            scene.get_element(&text_id).cloned(),
        ) else {
            return;
        };
        let [x, y] = compute_bound_text_position(&c, &t, &*scene);
        mutate_in(scene, &text_id, |e| (e.x, e.y) = (x, y));
    }
}

/// `shouldAllowVerticalAlign`: some selected label isn't an arrow's.
pub fn should_allow_vertical_align(selected: &[&Element], map: &dyn ElementsMap) -> bool {
    selected.iter().any(|e| {
        e.is_bound_to_container() && get_container_element(e, map).is_none_or(|c| !c.is_arrow())
    })
}

/// `suppportsHorizontalAlign`: some selected text or non-arrow label.
pub fn supports_horizontal_align(selected: &[&Element], map: &dyn ElementsMap) -> bool {
    selected.iter().any(|e| {
        if e.is_bound_to_container() {
            get_container_element(e, map).is_none_or(|c| !c.is_arrow())
        } else {
            e.is_text()
        }
    })
}

/// `getTextFromElements`: the texts joined with `separator` ("\n\n").
pub fn get_text_from_elements(elements: &[Element], separator: &str) -> String {
    elements
        .iter()
        .filter_map(|e| e.text().map(|t| t.text.as_str()))
        .collect::<Vec<_>>()
        .join(separator)
}

// ---------------------------------------------------------------------------
// newElement.ts: refreshTextDimensions
// ---------------------------------------------------------------------------

/// What `refreshTextDimensions` returns: the (wrapped) text and its box;
/// `auto_resize` is Some(false) when a growing text just started wrapping.
#[derive(Clone, Debug, PartialEq)]
pub struct TextDimensions {
    pub text: String,
    pub auto_resize: Option<bool>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl TextDimensions {
    /// `Object.assign(element, dims)` (wrap in `mutate_element` for a
    /// versioned update).
    pub fn apply(&self, e: &mut Element) {
        (e.x, e.y, e.width, e.height) = (self.x, self.y, self.width, self.height);
        if let Some(t) = e.text_mut() {
            t.text = self.text.clone();
            if let Some(a) = self.auto_resize {
                t.auto_resize = a;
            }
        }
    }
}

/// `getAdjustedDimensions`: the box for `next_text`, keeping the point the
/// alignment anchors in place. Returns `(x, y, width, height)`.
fn get_adjusted_dimensions(
    e: &Element,
    map: &dyn ElementsMap,
    next_text: &str,
    next_fixed_width: Option<f64>,
    m: &dyn Measure,
) -> (f64, f64, f64, f64) {
    let td = e.text().expect("text element");
    let font = font_of(e);
    let metrics = measure_text(m, next_text, font, td.line_height);
    let (mut w, h) = (metrics.width, metrics.height);
    if let Some(fw) = next_fixed_width {
        w = fw;
    } else if !td.auto_resize {
        w = e.width;
    }
    let (x, y) = if td.text_align == TextAlign::Center
        && td.vertical_align == VerticalAlign::Middle
        && td.container_id.is_none()
        && td.auto_resize
    {
        let prev = measure_text(m, &td.text, font, td.line_height);
        let (ox, oy) = get_text_element_position_offsets(
            td.text_align,
            td.vertical_align,
            w - prev.width,
            h - prev.height,
        );
        (e.x - ox, e.y - oy)
    } else {
        let [x1, y1, x2, y2, ..] = super::bounds::get_element_absolute_coords(e, map, false);
        let [nx1, ny1, nx2, ny2] =
            super::bounds::get_resized_element_absolute_coords(e, w, h, false);
        let (dx1, dy1, dx2, dy2) = (
            (x1 - nx1) / 2.,
            (y1 - ny1) / 2.,
            (x2 - nx2) / 2.,
            (y2 - ny2) / 2.,
        );
        // grow away from the edges the alignment anchors the text to
        let (a, v) = (td.text_align, td.vertical_align);
        let sides = [
            matches!(v, VerticalAlign::Middle | VerticalAlign::Bottom),
            matches!(a, TextAlign::Center | TextAlign::Left),
            matches!(v, VerticalAlign::Middle | VerticalAlign::Top),
            matches!(a, TextAlign::Center | TextAlign::Right),
        ];
        adjust_xy_with_rotation(sides, e.x, e.y, e.angle, dx1, dy1, dx2, dy2)
    };
    (
        if x.is_finite() { x } else { e.x },
        if y.is_finite() { y } else { e.y },
        w,
        h,
    )
}

/// `refreshTextDimensions`: `text` (default: the element's) wrapped as the
/// element wraps and its new box. `max_width`: for a free text that grows
/// with its content, the widest it may grow; past it the text wraps at that
/// width from then on (`auto_resize: Some(false)`). None for deleted text.
pub fn refresh_text_dimensions(
    e: &Element,
    container: Option<&Element>,
    map: &dyn ElementsMap,
    text: Option<&str>,
    max_width: Option<f64>,
    m: &dyn Measure,
) -> Option<TextDimensions> {
    if e.is_deleted {
        return None;
    }
    let td = e.text()?;
    let mut text = text.unwrap_or(&td.text).to_owned();
    let font = font_of(e);
    if let Some(mw) = max_width
        && container.is_none()
        && td.auto_resize
        && e.width <= mw
        && measure_text(m, &text, font, td.line_height).width > mw
    {
        let wrapped = wrap_text(m, &text, font, mw);
        let (x, y, width, height) = get_adjusted_dimensions(e, map, &wrapped, Some(mw), m);
        return Some(TextDimensions {
            text: wrapped,
            auto_resize: Some(false),
            x,
            y,
            width,
            height,
        });
    }
    if container.is_some() || !td.auto_resize {
        text = wrap_text(
            m,
            &text,
            font,
            container.map_or(e.width, |c| get_bound_text_max_width(c, Some(e))),
        );
    }
    let (x, y, width, height) = get_adjusted_dimensions(e, map, &text, None, m);
    Some(TextDimensions {
        text,
        auto_resize: None,
        x,
        y,
        width,
        height,
    })
}

// ---------------------------------------------------------------------------
// actionBoundText.tsx
// ---------------------------------------------------------------------------

/// `unbindTextFromContainer`: frees the label as it rendered, wrapped the
/// same at a fixed width.
pub fn unbind_text_from_container(scene: &mut dyn BindingStore, container_id: &str, text_id: &str) {
    let (Some(c), Some(t)) = (
        scene.get_element(container_id).cloned(),
        scene.get_element(text_id).cloned(),
    ) else {
        return;
    };
    let [x, y] = compute_bound_text_position(&c, &t, &*scene);
    mutate_in(scene, text_id, |e| {
        (e.x, e.y) = (x, y);
        if let Some(d) = e.text_mut() {
            d.container_id = None;
            d.auto_resize = false;
            d.base_font_size = None;
            d.label_position = Some(None);
        }
    });
    mutate_in(scene, container_id, |e| {
        if let Some(b) = &mut e.bound_elements {
            b.retain(|b| b.id != text_id)
        }
    });
}

/// `actionUnbindText.predicate`.
pub fn can_unbind_text(selected: &[&Element]) -> bool {
    selected.iter().any(|e| e.has_bound_text())
}

/// `actionUnbindText.perform` for one selected element: frees its label and
/// gives the container back the height it had before the label grew it.
/// Returns the freed text's id (it joins the selection). For a sticky note
/// the note goes back to its base height: run `updateBoundElements` on it.
pub fn unbind_text(
    scene: &mut dyn BindingStore,
    container_id: &str,
    m: &dyn Measure,
) -> Option<String> {
    let c = scene.get_element(container_id)?.clone();
    let text_id = get_bound_text_element(&c, &*scene).map(|t| t.id.clone())?;
    let original = get_original_container_height_from_cache(container_id);
    reset_original_container_cache(container_id);
    unbind_text_from_container(scene, container_id, &text_id);
    if c.is_sticky_note() {
        update_sticky_note_layout(
            scene,
            container_id,
            None,
            &StickyNoteLayoutOpts::default(),
            m,
        );
    } else {
        let h = original.filter(|&h| h != 0.).unwrap_or(c.height);
        mutate_in(scene, container_id, |e| e.height = h);
    }
    Some(text_id)
}

/// `actionBindText.predicate`: a text and a label-less container selected.
pub fn can_bind_text(selected: &[&Element], map: &dyn ElementsMap) -> bool {
    if selected.len() != 2 || !(selected[0].is_text() || selected[1].is_text()) {
        return false;
    }
    let container = if selected[0].is_text_bindable_container(false) {
        selected[0]
    } else if selected[1].is_text_bindable_container(false) {
        selected[1]
    } else {
        return false;
    };
    get_bound_text_element(container, map).is_none()
}

/// The (text, container) ids `actionBindText.perform` binds.
pub fn bind_text_pair(selected: &[&Element]) -> Option<(String, String)> {
    let [a, b] = selected else { return None };
    Some(if a.is_text() && b.is_text_bindable_container(false) {
        (a.id.clone(), b.id.clone())
    } else {
        (b.id.clone(), a.id.clone())
    })
}

/// `getStickyNoteInk`: a note and its label share one ink, the label's
/// unless it is transparent.
pub fn get_sticky_note_ink(text: &Element, container: &Element) -> Option<String> {
    container.is_sticky_note().then(|| {
        if is_transparent(&text.stroke_color) {
            container.stroke_color.clone()
        } else {
            text.stroke_color.clone()
        }
    })
}

/// `bindTextToContainer`: binds the text to the label-less container and
/// puts it right above it. The caller selects the container.
pub fn bind_text_to_container(
    scene: &mut Scene,
    text_id: &str,
    container_id: &str,
    m: &dyn Measure,
) {
    let (Some(t), Some(c)) = (
        scene.get_element(text_id).cloned(),
        scene.get_element(container_id).cloned(),
    ) else {
        return;
    };
    let ink = get_sticky_note_ink(&t, &c);
    mutate_in(scene, text_id, |e| {
        e.angle = if c.is_arrow() { 0. } else { c.angle };
        if let Some(ink) = &ink {
            e.stroke_color = ink.clone();
        }
        if let Some(d) = e.text_mut() {
            d.container_id = Some(container_id.into());
            (d.vertical_align, d.text_align, d.auto_resize) =
                (VerticalAlign::Middle, TextAlign::Center, true);
            d.label_position = Some(c.is_arrow().then_some(DEFAULT_BOUND_TEXT_LABEL_POSITION));
            if ink.is_some() {
                d.base_font_size = Some(normalize_sticky_note_font_size(
                    d.base_font_size.unwrap_or(d.font_size),
                ));
            }
        }
    });
    mutate_in(scene, container_id, |e| {
        e.bound_elements
            .get_or_insert_with(Vec::new)
            .push(BoundElement {
                id: text_id.into(),
                kind: BoundType::Text,
            });
        if let Some(ink) = ink {
            e.stroke_color = ink;
        }
    });
    let original_height = c.height;
    if let Some(t) = scene.get_element(text_id).cloned() {
        redraw_text_bounding_box(scene, &t, Some(container_id), m);
    }
    // so unbinding can restore it
    update_original_container_cache(container_id, original_height);
    let mut els = scene.elements_including_deleted().to_vec();
    push_text_above_container(&mut els, container_id, text_id);
    scene.replace_all_elements(els);
}

fn moved_pair(a: &str, b: &str) -> FxHashSet<String> {
    [a.to_owned(), b.to_owned()].into_iter().collect()
}

/// `pushTextAboveContainer`.
pub fn push_text_above_container(elements: &mut Vec<Element>, container_id: &str, text_id: &str) {
    let Some(ti) = elements.iter().position(|e| e.id == text_id) else {
        return;
    };
    let t = elements.remove(ti);
    let ci = elements
        .iter()
        .position(|e| e.id == container_id)
        .map_or(elements.len(), |i| i + 1);
    elements.insert(ci, t);
    sync_moved_indices(elements, &moved_pair(container_id, text_id));
}

/// `pushContainerBelowText`.
pub fn push_container_below_text(elements: &mut Vec<Element>, container_id: &str, text_id: &str) {
    let Some(ci) = elements.iter().position(|e| e.id == container_id) else {
        return;
    };
    let c = elements.remove(ci);
    let ti = elements
        .iter()
        .position(|e| e.id == text_id)
        .unwrap_or(elements.len());
    elements.insert(ti, c);
    sync_moved_indices(elements, &moved_pair(container_id, text_id));
}

/// `actionWrapTextInContainer.predicate`: some selected free text.
pub fn can_wrap_text_in_container(selected: &[&Element]) -> bool {
    selected
        .iter()
        .any(|e| e.is_text() && !e.is_bound_to_container())
}

/// `wrapTextsInContainers`: each free text gets a new default rectangle in
/// its color (`round`: the default roundness is "round"; upstream's tests
/// run with "sharp"), arrows bound to the text move to the rectangle.
/// Returns the new containers' ids, which the caller selects.
pub fn wrap_texts_in_containers(
    scene: &mut Scene,
    text_ids: &[String],
    round: bool,
    m: &dyn Measure,
) -> Vec<String> {
    let mut els = scene.elements_including_deleted().to_vec();
    let mut ids = vec![];
    for text_id in text_ids {
        let Some(t) = els
            .get_element(text_id)
            .filter(|t| t.is_text() && !t.is_bound_to_container())
            .cloned()
        else {
            continue;
        };
        let mut bound = t.bound_elements.clone().unwrap_or_default();
        bound.push(BoundElement {
            id: t.id.clone(),
            kind: BoundType::Text,
        });
        let container = new_element(
            ElementType::Rectangle,
            ElementOpts {
                bound_elements: Some(bound),
                angle: t.angle,
                stroke_color: t.stroke_color.clone(),
                roundness: round.then_some(Roundness {
                    kind: roundness::ADAPTIVE_RADIUS,
                    value: None,
                }),
                x: t.x - BOUND_TEXT_PADDING,
                y: t.y - BOUND_TEXT_PADDING,
                width: compute_container_dimension_for_bound_text(t.width, ElementType::Rectangle),
                height: compute_container_dimension_for_bound_text(
                    t.height,
                    ElementType::Rectangle,
                ),
                group_ids: t.group_ids.clone(),
                frame_id: t.frame_id.clone(),
                ..Default::default()
            },
        );
        let cid = container.id.clone();
        // arrows bound to the text bind to the container
        for b in t
            .bound_elements
            .iter()
            .flatten()
            .filter(|b| b.kind == BoundType::Arrow)
        {
            mutate_in(&mut els, &b.id, |e| {
                if let Some(l) = e.linear_mut() {
                    for binding in [&mut l.start_binding, &mut l.end_binding]
                        .into_iter()
                        .flatten()
                    {
                        if binding.element_id == t.id {
                            binding.element_id = cid.clone();
                        }
                    }
                }
            });
        }
        mutate_in(&mut els, text_id, |e| {
            e.bound_elements = None;
            if let Some(d) = e.text_mut() {
                d.container_id = Some(cid.clone());
                (d.vertical_align, d.text_align, d.auto_resize) =
                    (VerticalAlign::Middle, TextAlign::Center, true);
            }
        });
        els.push(container);
        if let Some(t) = els.get_element(text_id).cloned() {
            redraw_text_bounding_box(&mut els, &t, Some(&cid), m);
        }
        push_container_below_text(&mut els, &cid, text_id);
        ids.push(cid);
    }
    scene.replace_all_elements(els);
    ids
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/// `redrawTextBoundingBox` as history applies it (`ElementsDelta.redrawElements`).
pub fn history_redraw_text_bounding_box(
    m: &dyn Measure,
    text_id: &str,
    container_id: &str,
    elements: &mut ElementMap,
) {
    let Some(t) = elements.get(text_id).cloned() else {
        return;
    };
    redraw_text_bounding_box(elements, &t, Some(container_id), m);
}

/// History hooks with text layout (no arrow routing: combine with the
/// binding module's `update_bound_elements` in the app's own hooks).
pub struct TextHooks<'a>(pub &'a dyn Measure);
impl HistoryHooks for TextHooks<'_> {
    fn redraw_text_bounding_box(
        &mut self,
        text_id: &str,
        container_id: &str,
        elements: &mut ElementMap,
    ) {
        history_redraw_text_bounding_box(self.0, text_id, container_id, elements)
    }
}
