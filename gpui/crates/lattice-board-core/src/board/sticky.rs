// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Sticky notes. Port of Excalidraw `packages/element/src/stickyNote.ts`
//! @ 3a317b5: the color and font-size invariants, the label ink and color
//! routing, the paper outline (`getStickyNoteCornerRadius`,
//! `getStickyNoteRenderPoints`, `getStickyNotePathCommands`: corners jittered
//! by roughness, one lifted at cartoonist), the creation-date footer, and
//! the layout: the font fit
//! (`fitStickyNoteFont`), `getStickyNoteLayout`, resize intents and the
//! scene / array appliers. The bound-arrow pass `updateStickyNoteLayout`
//! runs upstream is the caller's (the binding module's `updateBoundElements`).
//! Dates take the viewer's UTC offset explicitly (core has no clock zone).

use super::binding::BindingStore;
use super::consts::*;
use super::handles::HandleType;
use super::math::{clamp, js_round};
use super::mutate::new_element_with;
use super::shape::PathCmd;
use super::size_helpers::{VerticalResizeAnchor, get_position_after_height_change};
use super::text::{compute_bound_text_position, get_bound_text_element, mutate_in};
use super::text_measure::{Font, Measure, get_line_height, measure_text};
use super::text_wrapping::wrap_text;
use super::types::{BoundType, Element, Kind};
use super::utils::{ElementsMap, array_to_map, is_transparent};
use rustc_hash::{FxHashMap, FxHashSet};

/// A note's ink is never transparent.
pub fn normalize_sticky_note_stroke_color(c: Option<&str>) -> String {
    match c {
        Some(c) if !c.is_empty() && !is_transparent(c) => c.into(),
        _ => DEFAULT_STROKE_COLOR.into(),
    }
}

/// A note is always filled.
pub fn normalize_sticky_note_background_color(c: Option<&str>) -> String {
    match c {
        Some(c) if !c.is_empty() && !is_transparent(c) => c.into(),
        _ => DEFAULT_STICKY_NOTE_BG.into(),
    }
}

/// Clamps the font ceiling: the fit steps down from it, and huge values would
/// never progress.
pub fn normalize_sticky_note_font_size(size: f64) -> f64 {
    if !size.is_finite() {
        return STICKY_NOTE_FALLBACK_FONT_SIZE;
    }
    STICKY_NOTE_MAX_FONT_SIZE.min(MIN_FONT_SIZE.max(size))
}

/// Whether the text element is the label of a sticky note.
pub fn is_sticky_note_bound_text(text: &Element, map: &(impl ElementsMap + ?Sized)) -> bool {
    text.container_id()
        .and_then(|id| map.get_element(id))
        .is_some_and(|c| c.is_sticky_note())
}

const STICKY_NOTE_CORNER_RADIUS_RATIO: f64 = 0.04;
const STICKY_NOTE_MAX_CORNER_RADIUS: f64 = 16.;
pub const STICKY_NOTE_EDGE_SHADOW_WIDTH: f64 = 0.5;
pub const STICKY_NOTE_EDGE_SHADOW_OPACITY: f64 = 0.08;

pub fn get_sticky_note_corner_radius(e: &Element) -> f64 {
    if e.roundness.is_none() {
        return 0.;
    }
    (e.width.min(e.height) * STICKY_NOTE_CORNER_RADIUS_RATIO).min(STICKY_NOTE_MAX_CORNER_RADIUS)
}

const STICKY_NOTE_RENDER_ROUGHNESS: [f64; 3] = [0., 1.5, 8.];

/// `pointAtDistance`: `distance` from `from` towards `to`, at most `to`.
fn point_at_distance(from: [f64; 2], to: [f64; 2], d: f64) -> [f64; 2] {
    let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
    let l = dx.hypot(dy);
    if l == 0. {
        return from;
    }
    let r = (d / l).min(1.);
    [from[0] + dx * r, from[1] + dy * r]
}

/// `getStickyNoteRenderPoints`: the paper's corners, jittered by roughness
/// (seeded by the note, so stable across redraws), moved by `offset`.
pub fn get_sticky_note_render_points(e: &Element, offset: f64, seed_offset: i64) -> [[f64; 2]; 4] {
    let roughness = js_round(e.roughness).clamp(0., 2.) as usize;
    let amount = STICKY_NOTE_RENDER_ROUGHNESS[roughness].min(e.width.min(e.height) * 0.012);
    let (o, w, h) = (offset, e.width, e.height);
    if amount == 0. || amount.is_nan() {
        return [[o, o], [o + w, o], [o + w, o + h], [o, o + h]];
    }
    let mut random = super::random::seeded_random(e.seed + seed_offset);
    let mut j = || (random() * 2. - 1.) * amount;
    let mut p = [[0.; 2]; 4];
    for (i, (x, y)) in [(o, o), (o + w, o), (o + w, o + h), (o, o + h)]
        .into_iter()
        .enumerate()
    {
        let jx = x + j();
        p[i] = [jx, y + j()];
    }
    p
}

/// `getStickyNotePathCommands`, local coordinates; `shadow` offsets it by
/// `STICKY_NOTE_SHADOW_OFFSET`. Closed by the caller.
pub fn get_sticky_note_path_commands(e: &Element, shadow: bool) -> Vec<PathCmd> {
    let pts = if shadow {
        get_sticky_note_render_points(e, STICKY_NOTE_SHADOW_OFFSET, 1)
    } else {
        get_sticky_note_render_points(e, 0., 0)
    };
    let radius = get_sticky_note_corner_radius(e);
    // the note's seed keeps the same corner for the paper and shadow
    let lifted = if e.roughness == 2. {
        Some((super::random::seeded_random(e.seed)() * 4.).floor() as usize)
    } else {
        None
    };
    if radius == 0. && lifted.is_none() {
        return std::iter::once(PathCmd::MoveTo(pts[0]))
            .chain(pts[1..].iter().map(|&p| PathCmd::LineTo(p)))
            .collect();
    }
    let corners: Vec<Vec<PathCmd>> = (0..4)
        .map(|i| {
            let (p, prev, next) = (pts[i], pts[(i + 3) % 4], pts[(i + 1) % 4]);
            let r = radius
                .min((p[0] - prev[0]).hypot(p[1] - prev[1]) / 2.)
                .min((p[0] - next[0]).hypot(p[1] - next[1]) / 2.);
            if lifted == Some(i) {
                let size = e.width.min(e.height);
                let reach = (size * 0.18).min(40.);
                // the shadow follows the paper inward at half the bend
                let lift = (size * 0.02).min(5.) * if shadow { 0.5 } else { 1. };
                let tip = [
                    p[0] + if i == 1 || i == 2 { -lift } else { lift },
                    p[1] + if i >= 2 { -lift } else { lift },
                ];
                let (start, end) = (
                    point_at_distance(p, prev, reach),
                    point_at_distance(p, next, reach),
                );
                return vec![
                    PathCmd::LineTo(start),
                    PathCmd::QuadTo(
                        point_at_distance(p, prev, reach / 2.),
                        point_at_distance(tip, start, r),
                    ),
                    PathCmd::QuadTo(tip, point_at_distance(tip, end, r)),
                    PathCmd::QuadTo(point_at_distance(p, next, reach / 2.), end),
                ];
            }
            vec![
                PathCmd::LineTo(point_at_distance(p, prev, r)),
                PathCmd::QuadTo(p, point_at_distance(p, next, r)),
            ]
        })
        .collect();
    let start = match corners[0].last() {
        Some(PathCmd::QuadTo(_, p)) => *p,
        _ => pts[0],
    };
    let mut out = vec![PathCmd::MoveTo(start)];
    for i in 1..=4 {
        out.extend(corners[i % 4].iter().copied());
    }
    out
}

// ---------------------------------------------------------------------------
// ink and color routing
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorProperty {
    Stroke,
    Background,
}

/// `getColorTargetElement`: a background pick on a note's label (the styles
/// panel while editing it) goes to the note.
pub fn get_color_target_element<'a>(
    e: &'a Element,
    prop: ColorProperty,
    map: &'a dyn ElementsMap,
) -> &'a Element {
    if prop == ColorProperty::Background && e.is_text() && is_sticky_note_bound_text(e, map) {
        return e
            .container_id()
            .and_then(|c| map.get_element(c))
            .unwrap_or(e);
    }
    e
}

/// `getColorUpdate`: the color a pick sets on `e`, under the note policy (a
/// note is always filled, its label's ink never transparent).
pub fn get_color_update(
    e: &Element,
    prop: ColorProperty,
    color: &str,
    map: &dyn ElementsMap,
) -> (ColorProperty, String) {
    if e.is_sticky_note() {
        return match prop {
            ColorProperty::Background => {
                (prop, normalize_sticky_note_background_color(Some(color)))
            }
            ColorProperty::Stroke => (prop, normalize_sticky_note_stroke_color(Some(color))),
        };
    }
    if prop == ColorProperty::Stroke
        && e.is_text()
        && is_sticky_note_bound_text(e, map)
        && is_transparent(color)
    {
        let container = e.container_id().and_then(|c| map.get_element(c));
        return (
            prop,
            normalize_sticky_note_stroke_color(container.map(|c| c.stroke_color.as_str())),
        );
    }
    (prop, color.into())
}

/// `syncStickyNoteInk`: after a property write, copies the side of a note /
/// label pair whose `strokeColor` changed onto the other; the label wins
/// when both or neither changed, a transparent label takes the note's.
/// Returns None when nothing needs to change.
pub fn sync_sticky_note_ink(elements: &[Element], prev: &dyn ElementsMap) -> Option<Vec<Element>> {
    let map = array_to_map(elements);
    let mut ink: FxHashMap<String, String> = FxHashMap::default();
    for c in elements
        .iter()
        .filter(|e| e.is_sticky_note() && !e.is_deleted)
    {
        let Some(label) = get_bound_text_element(c, &map) else {
            continue;
        };
        if label.stroke_color == c.stroke_color {
            continue;
        }
        let container_changed = prev
            .get_element(&c.id)
            .is_none_or(|p| p.stroke_color != c.stroke_color);
        let label_changed = prev
            .get_element(&label.id)
            .is_none_or(|p| p.stroke_color != label.stroke_color);
        if is_transparent(&label.stroke_color) || (container_changed && !label_changed) {
            ink.insert(
                label.id.clone(),
                normalize_sticky_note_stroke_color(Some(&c.stroke_color)),
            );
        } else {
            ink.insert(
                c.id.clone(),
                normalize_sticky_note_stroke_color(Some(&label.stroke_color)),
            );
        }
    }
    if ink.is_empty() {
        return None;
    }
    Some(
        elements
            .iter()
            .map(|e| match ink.get(&e.id) {
                Some(s) => new_element_with(e, |e| e.stroke_color = s.clone(), false),
                None => e.clone(),
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// font size: `baseFontSize` is what the user picked, `fontSize` the fit
// ---------------------------------------------------------------------------

/// `getBaseFontSize`: a note label's ceiling, any other text's `fontSize`.
pub fn get_base_font_size(text: &Element, map: &dyn ElementsMap) -> f64 {
    let Some(t) = text.text() else {
        return DEFAULT_FONT_SIZE;
    };
    if is_sticky_note_bound_text(text, map) {
        t.base_font_size.unwrap_or(t.font_size)
    } else {
        t.font_size
    }
}

/// `getBaseFontSizeUpdate`: applies a picked font size (the ceiling of a
/// note label, `fontSize` otherwise).
pub fn apply_base_font_size(text: &mut Element, font_size: f64, map: &dyn ElementsMap) {
    let sticky = is_sticky_note_bound_text(text, map);
    if let Some(t) = text.text_mut() {
        if sticky {
            t.base_font_size = Some(normalize_sticky_note_font_size(font_size));
        } else {
            t.font_size = font_size;
        }
    }
}

// ---------------------------------------------------------------------------
// footer
// ---------------------------------------------------------------------------

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Civil date of epoch milliseconds: `(year, month0, day)`.
fn civil_date(ms: f64) -> (i64, usize, u32) {
    let days = (ms / 86_400_000.).floor() as i64;
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), (m - 1) as usize, d)
}

/// `getStickyNoteDateLabel`: "7 Sep", or "7 Sep 2024" outside the current
/// year (unless `short`). `utc_offset_ms` is the viewer's zone. None without
/// a usable timestamp.
pub fn get_sticky_note_date_label(
    created: Option<i64>,
    short: bool,
    now: i64,
    utc_offset_ms: i64,
) -> Option<String> {
    let created = created? as f64;
    // the range of a JS Date
    if created.abs() > 8.64e15 {
        return None;
    }
    let (y, m, d) = civil_date(created + utc_offset_ms as f64);
    let label = format!("{d} {}", MONTHS[m]);
    Some(
        if short || y == civil_date((now + utc_offset_ms) as f64).0 {
            label
        } else {
            format!("{label} {y}")
        },
    )
}

/// `getStickyNoteFooter`: the footer's text and its right-aligned baseline
/// anchor in note-local coordinates (font: `STICKY_NOTE_FOOTER_FONT_SIZE`).
/// None for notes under the minimum size or without a timestamp.
pub fn get_sticky_note_footer(
    e: &Element,
    now: i64,
    utc_offset_ms: i64,
) -> Option<(String, f64, f64)> {
    if e.width < STICKY_NOTE_MIN_SIZE || e.height < STICKY_NOTE_MIN_SIZE {
        return None;
    }
    let short = e.width - STICKY_NOTE_PADDING * 2. < STICKY_NOTE_FOOTER_MIN_BODY_WIDTH_FOR_YEAR;
    let text = get_sticky_note_date_label(e.created, short, now, utc_offset_ms)?;
    Some((
        text,
        e.width - STICKY_NOTE_PADDING,
        e.height - STICKY_NOTE_FOOTER_BASELINE_FROM_BOTTOM,
    ))
}

/// `getStickyNoteMinSize`: one line at the label's ceiling plus padding
/// (and the footer), never under `STICKY_NOTE_MIN_SIZE`. `(width, height)`.
pub fn get_sticky_note_min_size(font_size: f64, font_family: u32) -> (f64, f64) {
    let lh = (normalize_sticky_note_font_size(font_size) * get_line_height(font_family)).ceil();
    (
        STICKY_NOTE_MIN_SIZE.max(lh + STICKY_NOTE_PADDING * 2.),
        STICKY_NOTE_MIN_SIZE.max(lh + STICKY_NOTE_BODY_INSET_Y),
    )
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/// `StickyNoteLayoutOpts`. Every value is absolute (never a multiplier of
/// the live value).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StickyNoteLayoutOpts {
    /// Unwrapped text to lay out; None: the label's `originalText`.
    pub original_text: Option<String>,
    /// Base-height intent; None: the note's live `baseHeight`.
    pub base_height: Option<f64>,
    /// Font-ceiling intent; None: the label's live ceiling.
    pub base_font_size: Option<f64>,
    /// The edge that stays put when the content changes the height (top).
    pub anchor: Option<VerticalResizeAnchor>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StickyNoteContainerLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub base_height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StickyNoteTextLayout {
    pub text: String,
    pub font_size: f64,
    pub base_font_size: f64,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub angle: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StickyNoteLayout {
    pub container: StickyNoteContainerLayout,
    pub text: Option<StickyNoteTextLayout>,
}

impl StickyNoteContainerLayout {
    pub fn apply(&self, e: &mut Element) {
        (e.x, e.y, e.width, e.height) = (self.x, self.y, self.width, self.height);
        if let Kind::StickyNote { base_height } = &mut e.kind {
            *base_height = self.base_height;
        }
    }
}
impl StickyNoteTextLayout {
    pub fn apply(&self, e: &mut Element) {
        (e.x, e.y, e.width, e.height, e.angle) =
            (self.x, self.y, self.width, self.height, self.angle);
        if let Some(t) = e.text_mut() {
            t.text = self.text.clone();
            t.font_size = self.font_size;
            t.base_font_size = Some(self.base_font_size);
        }
    }
}

fn base_height_of(e: &Element) -> f64 {
    match e.kind {
        Kind::StickyNote { base_height } => base_height,
        _ => 0.,
    }
}

#[derive(Clone)]
struct FontFit {
    text: String,
    font_size: f64,
    width: f64,
    height: f64,
}

/// `fitStickyNoteFont`: the largest size on the grid `{ceiling − k·STEP} ∪
/// {min}` whose wrapped text fits, `min` when none does; warm-started from
/// the previously fitted size.
fn fit_sticky_note_font(
    fit: &dyn Fn(f64) -> FontFit,
    base_font_size: f64,
    font_size_min: f64,
    max_width: f64,
    max_height: f64,
    warm_start: f64,
) -> FontFit {
    let steps = ((base_font_size - font_size_min) / STICKY_NOTE_FONT_STEP)
        .ceil()
        .max(0.) as i64;
    let size_at = |i: i64| {
        if i >= steps {
            font_size_min
        } else {
            base_font_size - i as f64 * STICKY_NOTE_FONT_STEP
        }
    };
    let mut fits: FxHashMap<i64, FontFit> = FxHashMap::default();
    let mut get = |i: i64| fits.entry(i).or_insert_with(|| fit(size_at(i))).clone();
    let fits_box = |r: &FontFit| r.width <= max_width && r.height <= max_height;
    if steps == 0 {
        return get(0);
    }
    // the previous fitted size, snapped onto the grid and clamped into it
    let warm = clamp(
        js_round((base_font_size - warm_start) / STICKY_NOTE_FONT_STEP),
        0.,
        steps as f64,
    ) as i64;
    // binary search for the smallest index (largest font) that fits
    let w = get(warm);
    let (mut lo, mut hi) = if fits_box(&w) {
        if warm == 0 || !fits_box(&get(warm - 1)) {
            return w;
        }
        (0, warm - 1)
    } else {
        if warm == steps {
            return w;
        }
        (warm + 1, steps)
    };
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if fits_box(&get(mid)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    get(lo)
}

/// `getStickyNoteLayout`: wraps the label at the note's width, fits the font
/// under the ceiling, grows the note past `baseHeight` only when the text
/// overflows at the minimum size, and positions the label. Pure.
pub fn get_sticky_note_layout(
    container: &Element,
    text: Option<&Element>,
    opts: &StickyNoteLayoutOpts,
    m: &dyn Measure,
) -> StickyNoteLayout {
    let base_width = container.width.max(STICKY_NOTE_MIN_SIZE);
    let live_base = base_height_of(container);
    let base_height = opts
        .base_height
        .unwrap_or(if live_base != 0. && !live_base.is_nan() {
            live_base
        } else {
            container.height
        })
        .max(STICKY_NOTE_MIN_SIZE);
    let anchor = opts.anchor.unwrap_or(VerticalResizeAnchor::Top);
    let container_at = |height: f64| {
        let (x, y) = get_position_after_height_change(container, height, anchor);
        StickyNoteContainerLayout {
            x,
            y,
            width: base_width,
            height,
            base_height,
        }
    };
    let Some((t, td)) = text.and_then(|t| t.text().map(|d| (t, d))) else {
        // an empty note sits at its base height
        return StickyNoteLayout {
            container: container_at(base_height),
            text: None,
        };
    };
    let original_text = opts.original_text.as_deref().unwrap_or(&td.original_text);
    let base_font_size = normalize_sticky_note_font_size(
        opts.base_font_size
            .or(td.base_font_size)
            .unwrap_or(td.font_size),
    );
    let font_size_min = STICKY_NOTE_MIN_FONT_SIZE.min(base_font_size);
    let max_width = (base_width - STICKY_NOTE_PADDING * 2.).max(1.);
    let max_height = (base_height - STICKY_NOTE_BODY_INSET_Y).max(0.);
    let (family, lh) = (td.font_family, td.line_height);
    let fit = |font_size: f64| {
        let font = Font::new(font_size, family);
        let text = wrap_text(m, original_text, font, max_width);
        let mt = measure_text(m, &text, font, lh);
        FontFit {
            text,
            font_size,
            width: mt.width,
            height: mt.height,
        }
    };
    let blank = original_text.trim().is_empty();
    let fitted = if blank {
        let mt = measure_text(m, "", Font::new(base_font_size, family), lh);
        FontFit {
            text: String::new(),
            font_size: base_font_size,
            width: mt.width,
            height: mt.height,
        }
    } else {
        fit_sticky_note_font(
            &fit,
            base_font_size,
            font_size_min,
            max_width,
            max_height,
            td.font_size,
        )
    };
    let height = if blank {
        base_height
    } else {
        base_height.max(fitted.height + STICKY_NOTE_BODY_INSET_Y)
    };
    let next = container_at(height);
    let mut c = container.clone();
    next.apply(&mut c);
    let mut lt = t.clone();
    (lt.width, lt.height) = (fitted.width, fitted.height);
    if let Some(d) = lt.text_mut() {
        d.text = fitted.text.clone();
        d.font_size = fitted.font_size;
    }
    let [x, y] = compute_bound_text_position(&c, &lt, &Vec::<Element>::new());
    StickyNoteLayout {
        container: next,
        text: Some(StickyNoteTextLayout {
            text: fitted.text,
            font_size: fitted.font_size,
            base_font_size,
            width: fitted.width,
            height: fitted.height,
            x,
            y,
            angle: container.angle,
        }),
    }
}

/// `getStickyNoteResizeIntent`: the layout intents of a resize gesture,
/// derived from the gesture-start snapshot (`original`) on every move.
/// `container` has the requested geometry applied.
pub fn get_sticky_note_resize_intent(
    container: &Element,
    original: &dyn ElementsMap,
    handle: HandleType,
    proportional: bool,
    from_center: bool,
    flip: bool,
) -> StickyNoteLayoutOpts {
    let orig = original
        .get_element(&container.id)
        .filter(|e| e.is_sticky_note())
        .unwrap_or(container);
    let ceiling = get_bound_text_element(orig, original)
        .and_then(|t| t.text())
        .map(|t| t.base_font_size.unwrap_or(t.font_size));
    if flip {
        return StickyNoteLayoutOpts {
            base_height: Some(base_height_of(orig)),
            base_font_size: ceiling,
            ..Default::default()
        };
    }
    use HandleType::*;
    let north = matches!(handle, N | Ne | Nw);
    let changes_height = proportional || north || matches!(handle, S | Se | Sw);
    let scale = if proportional && orig.width != 0. {
        container.width / orig.width
    } else {
        1.
    };
    let anchor = if from_center {
        VerticalResizeAnchor::Center
    } else if north {
        VerticalResizeAnchor::Bottom
    }
    // Shift+E/W holds the opposite side's midpoint
    else if proportional && matches!(handle, E | W) {
        VerticalResizeAnchor::Center
    } else {
        VerticalResizeAnchor::Top
    };
    StickyNoteLayoutOpts {
        base_height: Some(if changes_height {
            container.height
        } else {
            base_height_of(orig)
        }),
        base_font_size: ceiling.map(|c| c * scale),
        anchor: Some(anchor),
        original_text: None,
    }
}

/// `updateStickyNoteLayout`: applies the layout to a live scene. `text`:
/// None looks the label up; Some(t) lays out `t` (an uncommitted clone, or
/// no label). The bound-arrow pass is the caller's.
pub fn update_sticky_note_layout(
    scene: &mut dyn BindingStore,
    container_id: &str,
    text: Option<Option<&Element>>,
    opts: &StickyNoteLayoutOpts,
    m: &dyn Measure,
) -> Option<StickyNoteLayout> {
    let container = scene.get_element(container_id)?.clone();
    let text = match text {
        Some(t) => t.cloned(),
        None => get_bound_text_element(&container, &*scene)
            .filter(|t| !t.is_deleted)
            .cloned(),
    };
    let layout = get_sticky_note_layout(&container, text.as_ref(), opts, m);
    mutate_in(scene, container_id, |e| layout.container.apply(e));
    if let (Some(t), Some(lt)) = (&text, &layout.text) {
        mutate_in(scene, &t.id, |e| lt.apply(e));
    }
    Some(layout)
}

fn has_sticky_note_layout_input_changed(
    container: &Element,
    text: Option<&Element>,
    prev: &dyn ElementsMap,
) -> bool {
    let Some(pc) = prev.get_element(&container.id) else {
        return true;
    };
    let pt = text.and_then(|t| prev.get_element(&t.id));
    if (text.is_some() && pt.is_none())
        || (text.is_none()
            && pc
                .bound_elements
                .iter()
                .flatten()
                .any(|b| b.kind == BoundType::Text))
    {
        return true;
    }
    if pc.x != container.x
        || pc.y != container.y
        || pc.width != container.width
        || base_height_of(pc) != base_height_of(container)
        || pc.angle != container.angle
    {
        return true;
    }
    let (Some(t), Some(pt)) = (text.and_then(|t| t.text()), pt.and_then(|t| t.text())) else {
        return text.is_some();
    };
    pt.original_text != t.original_text
        || pt.base_font_size != t.base_font_size
        || pt.font_family != t.font_family
        || pt.line_height != t.line_height
        || pt.text_align != t.text_align
        || pt.vertical_align != t.vertical_align
}

/// `relayoutStickyNotes`: lays out, in an element array, the notes among
/// `affected` and the notes whose labels are (skipping those whose layout
/// inputs didn't change since `prev`). Changed elements are new versions.
/// Bound arrows are the caller's job.
pub fn relayout_sticky_notes(
    elements: &[Element],
    affected: &FxHashSet<String>,
    prev: Option<&dyn ElementsMap>,
    m: &dyn Measure,
) -> Vec<Element> {
    let map = array_to_map(elements);
    let mut notes: Vec<&str> = vec![];
    for id in affected {
        let Some(e) = map.get(id.as_str()).filter(|e| !e.is_deleted) else {
            continue;
        };
        let note = if e.is_sticky_note() {
            Some(e.id.as_str())
        } else {
            e.container_id()
                .and_then(|c| map.get(c))
                .filter(|c| !c.is_deleted && c.is_sticky_note())
                .map(|c| c.id.as_str())
        };
        if let Some(n) = note
            && !notes.contains(&n)
        {
            notes.push(n);
        }
    }
    let mut out: FxHashMap<String, Element> = FxHashMap::default();
    for id in notes {
        let c = map[id];
        let t = get_bound_text_element(c, &map);
        if prev.is_some_and(|p| !has_sticky_note_layout_input_changed(c, t, p)) {
            continue;
        }
        let layout = get_sticky_note_layout(c, t, &StickyNoteLayoutOpts::default(), m);
        out.insert(
            c.id.clone(),
            new_element_with(c, |e| layout.container.apply(e), false),
        );
        if let (Some(t), Some(lt)) = (t, &layout.text) {
            out.insert(t.id.clone(), new_element_with(t, |e| lt.apply(e), false));
        }
    }
    elements
        .iter()
        .map(|e| out.remove(&e.id).unwrap_or_else(|| e.clone()))
        .collect()
}
