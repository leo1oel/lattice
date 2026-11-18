// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element helpers that don't need geometry beyond points. Port of the
//! non-rendering parts of Excalidraw @ 3a317b5: `element/src/utils.ts`
//! (`isPathALoop`, `getCornerRadius`), `element/src/comparisons.ts`,
//! `element/src/index.ts` (scene version hashes, non-deleted filters),
//! `element/src/sizeHelpers.ts` (`isInvisiblySmallElement`,
//! `getNormalizedDimensions`), `element/src/arrowheads.ts`
//! (`normalizeArrowhead`), `binding.ts` (`normalizeFixedPoint`),
//! `common/src/points.ts` (`getSizeFromPoints`, `getGridPoint`), `common/src/url.ts`
//! (`normalizeLink`) and `common/src/colors.ts` (`isTransparent`).
//! The shape deconstruction in `utils.ts` (`deconstruct*`, midpoints,
//! `projectFixedPointOntoDiagonal`) needs bounds and collision and lives with
//! them.

use super::consts::*;
use super::math::{Point, point_distance, points_equal};
use super::types::{Arrowhead, Element, ElementType, roundness};
use rustc_hash::FxHashMap;

/// Upstream's `ElementsMap` (`Map<id, element>`): anything that can look an
/// element up by id. Geometry and binding code takes `&impl ElementsMap` or
/// `&dyn ElementsMap`, so a `Scene`, a map or a plain slice all work.
pub trait ElementsMap {
    fn get_element(&self, id: &str) -> Option<&Element>;
    fn has_element(&self, id: &str) -> bool {
        self.get_element(id).is_some()
    }
    /// All elements in z-order, deleted ones included, for the few callers
    /// that scan the scene (upstream iterates the Map). None: this map can't
    /// list them.
    fn element_list(&self) -> Option<std::borrow::Cow<'_, [Element]>> {
        None
    }
}
impl ElementsMap for FxHashMap<String, Element> {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.get(id)
    }
}
impl ElementsMap for FxHashMap<&str, &Element> {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.get(id).copied()
    }
}
/// Linear scan; fine for tests and small inputs.
impl ElementsMap for [Element] {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.iter().find(|e| e.id == id)
    }
    fn element_list(&self) -> Option<std::borrow::Cow<'_, [Element]>> {
        Some(self.into())
    }
}
impl ElementsMap for Vec<Element> {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.iter().find(|e| e.id == id)
    }
    fn element_list(&self) -> Option<std::borrow::Cow<'_, [Element]>> {
        Some(self.as_slice().into())
    }
}

/// `arrayToMap`.
pub fn array_to_map(elements: &[Element]) -> FxHashMap<&str, &Element> {
    elements.iter().map(|e| (e.id.as_str(), e)).collect()
}

// element/src/index.ts

/// `getSceneVersion` (deprecated upstream, kept for parity).
pub fn get_scene_version(elements: &[Element]) -> i64 {
    elements.iter().map(|e| e.version).sum()
}

/// `hashElementsVersion`: djb2 over `versionNonce`, order matters.
pub fn hash_elements_version<'a>(elements: impl IntoIterator<Item = &'a Element>) -> u32 {
    let mut hash: i32 = 5381;
    for e in elements {
        hash = (hash << 5)
            .wrapping_add(hash)
            .wrapping_add(e.version_nonce as i32);
    }
    hash as u32
}

/// `hashString`: djb2 over UTF-16 code units.
pub fn hash_string(s: &str) -> u32 {
    let mut hash: i32 = 5381;
    for c in s.encode_utf16() {
        hash = (hash << 5).wrapping_add(hash).wrapping_add(c as i32);
    }
    hash as u32
}

pub fn is_non_deleted_element(e: &Element) -> bool {
    !e.is_deleted
}
pub fn get_non_deleted_elements(elements: &[Element]) -> impl Iterator<Item = &Element> {
    elements.iter().filter(|e| !e.is_deleted)
}
pub fn get_visible_elements(elements: &[Element]) -> impl Iterator<Item = &Element> {
    elements
        .iter()
        .filter(|e| !e.is_deleted && !is_invisibly_small_element(e))
}

// sizeHelpers.ts

pub const INVISIBLY_SMALL_ELEMENT_SIZE: f64 = 0.1;

pub fn is_invisibly_small_element(e: &Element) -> bool {
    if let Some(points) = e.points() {
        return points.len() < 2
            || (points.len() == 2
                && e.is_arrow()
                && points_equal(
                    points[0],
                    points[points.len() - 1],
                    INVISIBLY_SMALL_ELEMENT_SIZE,
                ));
    }
    e.width == 0. && e.height == 0.
}

/// `getNormalizedDimensions`: negative sizes flipped into positive ones.
/// Returns `(x, y, width, height)`.
pub fn get_normalized_dimensions(x: f64, y: f64, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let (mut rx, mut ry, mut rw, mut rh) = (x, y, width, height);
    if width < 0. {
        rw = width.abs();
        rx = x - rw;
    }
    if height < 0. {
        rh = height.abs();
        ry = y - rh;
    }
    (rx, ry, rw, rh)
}

// common/src/points.ts

/// `getSizeFromPoints`: `(width, height)`. Empty input gives `-inf`, like
/// `Math.max()` of nothing minus `Math.min()` of nothing.
pub fn get_size_from_points(points: &[Point]) -> (f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in points {
        x0 = x0.min(p[0]);
        x1 = x1.max(p[0]);
        y0 = y0.min(p[1]);
        y1 = y1.max(p[1]);
    }
    (x1 - x0, y1 - y0)
}

/// `getGridPoint`: rounded to the grid when there is one (`gridSize` 0 or
/// None: no grid).
pub fn get_grid_point(x: f64, y: f64, grid_size: Option<f64>) -> Point {
    match grid_size.filter(|g| *g != 0. && !g.is_nan()) {
        Some(g) => [
            super::math::js_round(x / g) * g,
            super::math::js_round(y / g) * g,
        ],
        None => [x, y],
    }
}

// utils.ts

/// `isPathALoop`: first and last point close enough to count as a loop.
pub fn is_path_a_loop(points: &[Point], zoom: f64) -> bool {
    if points.len() >= 3 {
        point_distance(points[0], points[points.len() - 1]) <= LINE_CONFIRM_THRESHOLD / zoom
    } else {
        false
    }
}

pub fn get_corner_radius(x: f64, e: &Element) -> f64 {
    match e.roundness {
        Some(r) if r.kind == roundness::PROPORTIONAL_RADIUS || r.kind == roundness::LEGACY => {
            x * DEFAULT_PROPORTIONAL_RADIUS
        }
        Some(r) if r.kind == roundness::ADAPTIVE_RADIUS => {
            let fixed = r.value.unwrap_or(DEFAULT_ADAPTIVE_RADIUS);
            if x <= fixed / DEFAULT_PROPORTIONAL_RADIUS {
                x * DEFAULT_PROPORTIONAL_RADIUS
            } else {
                fixed
            }
        }
        _ => 0.,
    }
}

// comparisons.ts. Upstream takes element or tool types; tool-only types
// (`autoshape`, `bucketfill`) belong to the app's tool code.

pub fn has_background(t: ElementType) -> bool {
    use ElementType::*;
    matches!(
        t,
        Rectangle | StickyNote | Iframe | Embeddable | Ellipse | Diamond | Line | FreeDraw
    )
}
pub fn has_fill_style(t: ElementType) -> bool {
    has_background(t) && t != ElementType::StickyNote
}
pub fn has_stroke_color(t: ElementType) -> bool {
    use ElementType::*;
    matches!(
        t,
        Rectangle | StickyNote | Ellipse | Diamond | FreeDraw | Arrow | Line | Text | Embeddable
    )
}
pub fn has_stroke_width(t: ElementType) -> bool {
    use ElementType::*;
    matches!(
        t,
        Rectangle | Iframe | Embeddable | Ellipse | Diamond | FreeDraw | Arrow | Line
    )
}
pub fn has_stroke_style(t: ElementType) -> bool {
    use ElementType::*;
    matches!(
        t,
        Rectangle | Iframe | Embeddable | Ellipse | Diamond | Arrow | Line
    )
}
pub fn has_roughness(t: ElementType) -> bool {
    has_stroke_style(t) || t == ElementType::StickyNote
}
pub fn has_freedraw_mode(t: ElementType) -> bool {
    t == ElementType::FreeDraw
}
pub fn can_change_roundness(t: ElementType) -> bool {
    use ElementType::*;
    matches!(
        t,
        Rectangle | Iframe | Embeddable | Line | Diamond | StickyNote | Image
    )
}
pub fn tool_is_arrow(t: ElementType) -> bool {
    t == ElementType::Arrow
}
pub fn can_have_arrowheads(t: ElementType) -> bool {
    t == ElementType::Arrow
}

// arrowheads.ts

/// `normalizeArrowhead`: legacy names mapped to current ones; unknown names
/// are dropped (upstream keeps the string, which then draws nothing).
pub fn normalize_arrowhead(s: Option<&str>) -> Option<Arrowhead> {
    match s? {
        "dot" => Some(Arrowhead::Circle),
        "crowfoot_one" => Some(Arrowhead::CardinalityOne),
        "crowfoot_many" => Some(Arrowhead::CardinalityMany),
        "crowfoot_one_or_many" => Some(Arrowhead::CardinalityOneOrMany),
        s => Arrowhead::parse(s),
    }
}

// binding.ts

/// Fixed point ratios should stay close to the 0.0-1.0 range.
const FIXED_POINT_BOUND: f64 = 10.;

/// `normalizeFixedPoint`. `None` stands for a value that isn't a pair of
/// finite numbers.
pub fn normalize_fixed_point(p: Option<[f64; 2]>) -> [f64; 2] {
    let Some(p) = p.filter(|p| p.iter().all(|c| c.is_finite())) else {
        return [0.5001, 0.5001];
    };
    const EPS: f64 = 0.0001;
    let c = p.map(|r| super::math::clamp(r, -FIXED_POINT_BOUND, FIXED_POINT_BOUND));
    // no precise 0.5, to avoid a jumping arrow heading from float imprecision
    if (c[0] - 0.5).abs() < EPS || (c[1] - 0.5).abs() < EPS {
        c.map(|r| if (r - 0.5).abs() < EPS { 0.5001 } else { r })
    } else {
        c
    }
}

// common/src/colors.ts

/// `isTransparent`: tinycolor's alpha is 0. Covers the notations tinycolor
/// reads with an alpha: `transparent`, `#rgba`, `#rrggbbaa`, `rgba()` and
/// `hsla()`/`hsva()`. Unparseable colors are opaque, as in tinycolor.
pub fn is_transparent(color: &str) -> bool {
    let c = color.trim().to_ascii_lowercase();
    if c == "transparent" {
        return true;
    }
    if let Some(hex) = c.strip_prefix('#') {
        return hex.bytes().all(|b| b.is_ascii_hexdigit())
            && match hex.len() {
                4 => &hex[3..] == "0",
                8 => &hex[6..] == "00",
                _ => false,
            };
    }
    for f in ["rgba", "hsla", "hsva", "rgb", "hsl", "hsv"] {
        if let Some(rest) = c.strip_prefix(f) {
            let Some(args) = rest
                .trim()
                .strip_prefix('(')
                .and_then(|r| r.strip_suffix(')'))
            else {
                return false;
            };
            let parts: Vec<&str> = args
                .split(|ch: char| ch == ',' || ch == '/' || ch.is_whitespace())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.len() != 4 {
                return false;
            }
            let a = parts[3];
            let alpha = if let Some(p) = a.strip_suffix('%') {
                p.parse::<f64>().map(|v| v / 100.)
            } else {
                a.parse::<f64>()
            };
            return alpha.is_ok_and(|a| a <= 0.);
        }
    }
    false
}

// common/src/url.ts

/// `normalizeLink`: trimmed, `"` escaped, and unsafe schemes
/// (`javascript:`, `data:`, `vbscript:`, also when hidden behind control
/// characters or leading punctuation) replaced with `about:blank`.
/// A reduction of `@braintree/sanitize-url`: links are kept otherwise
/// verbatim (no URL re-encoding).
pub fn normalize_link(link: &str) -> String {
    let link = link.trim();
    if link.is_empty() {
        return String::new();
    }
    let escaped = link.replace('"', "&quot;");
    let cleaned: String = escaped
        .chars()
        .filter(|&c| {
            !(c <= '\u{1f}'
                || ('\u{7f}'..='\u{9f}').contains(&c)
                || ('\u{2000}'..='\u{200d}').contains(&c)
                || c == '\u{feff}')
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return "about:blank".into();
    }
    if cleaned.starts_with('.') || cleaned.starts_with('/') {
        return cleaned.into();
    }
    // the scheme, ignoring leading non-word characters (`^([^\w]*)(javascript|data|vbscript)`)
    let rest = cleaned
        .trim_start_matches(|c: char| !(c.is_alphanumeric() || c == '_'))
        .to_ascii_lowercase();
    if cleaned.contains(':') || cleaned.contains("&colon;") {
        for bad in ["javascript", "data", "vbscript"] {
            if rest.starts_with(bad) {
                return "about:blank".into();
            }
        }
    }
    cleaned.into()
}
