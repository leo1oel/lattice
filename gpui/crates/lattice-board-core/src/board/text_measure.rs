// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Text measuring. Port of Excalidraw `packages/element/src/textMeasurements.ts`
//! and the metrics part of `packages/common/src/font-metadata.ts` @ 3a317b5.
//!
//! Upstream measures on a canvas through a `TextMetricsProvider`; here that
//! is the `Measure` trait. The app implements it with the GPUI text system;
//! `TestMeasure` reproduces upstream's test environment, where
//! `vitest-canvas-mock` reports `text.length` (UTF-16 units) as the width and
//! the provider multiplies it by 10. The app's measurer shapes with
//! Excalidraw's own fonts (src/board/fonts.rs), so widths, wrapping and
//! auto-size follow upstream's; `FONT_METADATA` gives the baselines.

use super::consts::{BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, font_family};
use rustc_hash::FxHashMap;

/// `FontString` (`"20px Excalifont, Xiaolai, …"` upstream), kept structured.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Font {
    pub size: f64,
    pub family: u32,
}

impl Font {
    pub fn new(size: f64, family: u32) -> Font {
        Font { size, family }
    }
    /// `getFontString`, for logs and SVG export.
    pub fn css(&self) -> String {
        format!(
            "{}px {}",
            super::json::js_number(self.size),
            get_font_family_string(self.family)
        )
    }
}

/// `TextMetricsProvider`.
pub trait Measure {
    /// Advance width of one line of text.
    fn line_width(&self, text: &str, font: Font) -> f64;
}

/// Upstream's test measurements: 10px per UTF-16 code unit.
pub struct TestMeasure;
impl Measure for TestMeasure {
    fn line_width(&self, text: &str, _font: Font) -> f64 {
        text.encode_utf16().count() as f64 * 10.
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    pub width: f64,
    pub height: f64,
}

// font-metadata.ts

/// `FontMetadata.metrics`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontMetrics {
    pub units_per_em: f64,
    pub ascender: f64,
    pub descender: f64,
    pub line_height: f64,
}

/// `FONT_FAMILY_FALLBACKS`.
pub const XIAOLAI_FALLBACK: u32 = 100;
pub const SANS_SERIF_FALLBACK: u32 = 998;
pub const MONOSPACE_FALLBACK: u32 = 999;
pub const SEGOE_UI_EMOJI_FALLBACK: u32 = 1000;

/// `FONT_METADATA[family].metrics`, Excalifont's for unknown families.
pub fn font_metrics(family: u32) -> FontMetrics {
    let m = |u, a, d, l| FontMetrics {
        units_per_em: u,
        ascender: a,
        descender: d,
        line_height: l,
    };
    match family {
        font_family::NUNITO => m(1000., 1011., -353., 1.25),
        font_family::LILITA_ONE => m(1000., 923., -220., 1.15),
        font_family::COMIC_SHANNS => m(1000., 750., -250., 1.25),
        font_family::VIRGIL => m(1000., 886., -374., 1.25),
        font_family::HELVETICA => m(2048., 1577., -471., 1.15),
        font_family::CASCADIA => m(2048., 1900., -480., 1.2),
        font_family::LIBERATION_SANS => m(2048., 1854., -434., 1.15),
        font_family::ASSISTANT => m(2048., 1021., -287., 1.25),
        XIAOLAI_FALLBACK => m(1000., 880., -144., 1.25),
        SEGOE_UI_EMOJI_FALLBACK => m(1000., 886., -374., 1.25),
        _ => m(1000., 886., -374., 1.25), // Excalifont
    }
}

/// Whether the font picker lists the family (`FONT_METADATA` minus private
/// and fallback fonts). Restore uses it to vet font top picks.
pub fn is_known_font_family(family: u32) -> bool {
    font_family::ALL.contains(&family)
}

/// `getLineHeight`: the unitless line height for a family.
pub fn get_line_height(family: u32) -> f64 {
    font_metrics(family).line_height
}

/// `getVerticalOffset`: baseline offset of an alphabetic-baseline line.
pub fn get_vertical_offset(family: u32, font_size: f64, line_height_px: f64) -> f64 {
    let m = font_metrics(family);
    let em = font_size / m.units_per_em;
    let line_gap = (line_height_px - em * m.ascender + em * m.descender) / 2.;
    em * m.ascender + line_gap
}

/// `FONT_FAMILY` names, for `getFontFamilyString`.
pub fn font_family_name(family: u32) -> Option<&'static str> {
    Some(match family {
        font_family::VIRGIL => "Virgil",
        font_family::HELVETICA => "Helvetica",
        font_family::CASCADIA => "Cascadia",
        font_family::EXCALIFONT => "Excalifont",
        font_family::NUNITO => "Nunito",
        font_family::LILITA_ONE => "Lilita One",
        font_family::COMIC_SHANNS => "Comic Shanns",
        font_family::LIBERATION_SANS => "Liberation Sans",
        font_family::ASSISTANT => "Assistant",
        _ => return None,
    })
}

/// The `FONT_FAMILY` key for a name (`getFontFamilyByName` in restore).
pub fn font_family_by_name(name: &str) -> Option<u32> {
    font_family::ALL
        .into_iter()
        .find(|&f| font_family_name(f) == Some(name))
}

/// The font file of a `FONT_FAMILY` / `FONT_FAMILY_FALLBACKS` number, for
/// SVG export's inlined `@font-face`s (upstream fetches its woff2 subsets).
/// The app sets it to its bundled Excalidraw fonts; unset (tests), nothing
/// is inlined. Local fonts (Helvetica, emoji) have none, as upstream.
pub type FontSource = fn(u32) -> Option<&'static [u8]>;
static FONT_SOURCE: std::sync::OnceLock<FontSource> = std::sync::OnceLock::new();
pub fn set_font_source(f: FontSource) {
    let _ = FONT_SOURCE.set(f);
}
pub fn font_source(family: u32) -> Option<&'static [u8]> {
    FONT_SOURCE.get().and_then(|f| f(family))
}

/// `getFontFamilyFallbacks`: what a family falls back to, as
/// `FONT_FAMILY_FALLBACKS` numbers (Xiaolai, the generic family, emoji).
pub fn get_font_family_fallbacks(family: u32) -> Vec<u32> {
    let generic = if font_family::is_monospace(family) {
        MONOSPACE_FALLBACK
    } else {
        SANS_SERIF_FALLBACK
    };
    if family == font_family::EXCALIFONT {
        vec![XIAOLAI_FALLBACK, generic, SEGOE_UI_EMOJI_FALLBACK]
    } else {
        vec![generic, SEGOE_UI_EMOJI_FALLBACK]
    }
}

/// The CSS family name of a font or fallback number.
pub fn font_or_fallback_name(family: u32) -> Option<&'static str> {
    font_family_name(family).or(match family {
        XIAOLAI_FALLBACK => Some("Xiaolai"),
        SANS_SERIF_FALLBACK => Some("sans-serif"),
        MONOSPACE_FALLBACK => Some("monospace"),
        SEGOE_UI_EMOJI_FALLBACK => Some("Segoe UI Emoji"),
        _ => None,
    })
}

/// `getFontFamilyString`.
pub fn get_font_family_string(family: u32) -> String {
    let Some(name) = font_family_name(family) else {
        return "Segoe UI Emoji".into();
    };
    get_font_family_fallbacks(family)
        .into_iter()
        .filter_map(font_or_fallback_name)
        .fold(name.to_string(), |s, f| s + ", " + f)
}

// textMeasurements.ts

/// `normalizeText`: `\r\n` / `\r` to `\n`, tabs to 8 spaces.
pub fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "        ")
}

fn split_into_lines(text: &str) -> Vec<String> {
    normalize_text(text)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

/// `measureText`.
pub fn measure_text(m: &dyn Measure, text: &str, font: Font, line_height: f64) -> Metrics {
    // empty lines become a space: leading/trailing empty lines would be lost
    let text = text
        .split('\n')
        .map(|l| if l.is_empty() { " " } else { l })
        .collect::<Vec<_>>()
        .join("\n");
    Metrics {
        width: get_text_width(m, &text, font),
        height: get_text_height(&text, font.size, line_height),
    }
}

const DUMMY_TEXT: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// `getApproxMinLineWidth`: the narrowest a container can get (from the
/// widest single token measured so far, see `char_width`).
pub fn get_approx_min_line_width(m: &dyn Measure, font: Font, line_height: f64) -> f64 {
    let max = get_max_char_width(m, font);
    if max == 0. {
        let lines = DUMMY_TEXT
            .chars()
            .map(String::from)
            .collect::<Vec<_>>()
            .join("\n");
        return measure_text(m, &lines, font, line_height).width + BOUND_TEXT_PADDING * 2.;
    }
    max + BOUND_TEXT_PADDING * 2.
}

pub fn get_min_text_element_width(m: &dyn Measure, font: Font, line_height: f64) -> f64 {
    measure_text(m, "", font, line_height).width + BOUND_TEXT_PADDING * 2.
}

pub fn is_measure_text_supported(m: &dyn Measure) -> bool {
    get_text_width(
        m,
        DUMMY_TEXT,
        Font::new(DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY),
    ) > 0.
}

/// `detectLineHeight`: unitless line height from a laid-out text's height.
pub fn detect_line_height(text: &str, height: f64, font_size: f64) -> f64 {
    height / split_into_lines(text).len() as f64 / font_size
}

/// `getLineHeightInPx`.
pub fn get_line_height_in_px(font_size: f64, line_height: f64) -> f64 {
    font_size * line_height
}

/// `getApproxMinLineHeight`.
pub fn get_approx_min_line_height(font_size: f64, line_height: f64) -> f64 {
    get_line_height_in_px(font_size, line_height) + BOUND_TEXT_PADDING * 2.
}

/// `getLineWidth`.
pub fn get_line_width(m: &dyn Measure, text: &str, font: Font) -> f64 {
    m.line_width(text, font)
}

/// `getTextWidth`: the widest line.
pub fn get_text_width(m: &dyn Measure, text: &str, font: Font) -> f64 {
    split_into_lines(text)
        .iter()
        .fold(0., |w, l| f64::max(w, m.line_width(l, font)))
}

pub fn get_text_height(text: &str, font_size: f64, line_height: f64) -> f64 {
    get_line_height_in_px(font_size, line_height) * split_into_lines(text).len() as f64
}

/// `charWidth`: per-font cache of single-token widths, keyed by the first
/// UTF-16 unit as upstream. One cache per measurer (upstream: per render
/// environment).
#[derive(Default)]
pub struct CharWidth {
    cache: FxHashMap<(u64, u32), FxHashMap<u16, f64>>,
}

impl CharWidth {
    fn key(font: Font) -> (u64, u32) {
        (font.size.to_bits(), font.family)
    }
    pub fn calculate(&mut self, m: &dyn Measure, ch: &str, font: Font) -> f64 {
        let unit = ch.encode_utf16().next().unwrap_or(0);
        *self
            .cache
            .entry(Self::key(font))
            .or_default()
            .entry(unit)
            .or_insert_with(|| m.line_width(ch, font))
    }
    pub fn get_cache(&self, font: Font) -> Option<&FxHashMap<u16, f64>> {
        self.cache.get(&Self::key(font))
    }
    pub fn clear_cache(&mut self, font: Font) {
        self.cache.remove(&Self::key(font));
    }
    /// `getMinCharWidth`: 0 without a cache.
    pub fn min(&self, font: Font) -> f64 {
        self.get_cache(font)
            .map_or(0., |c| c.values().copied().fold(f64::INFINITY, f64::min))
    }
    /// `getMaxCharWidth`: 0 without a cache.
    pub fn max(&self, font: Font) -> f64 {
        self.get_cache(font).map_or(0., |c| {
            c.values().copied().fold(f64::NEG_INFINITY, f64::max)
        })
    }
}

thread_local! {
    /// Upstream's module-level `charWidth` cache: one measurer's widths at a
    /// time (upstream: one render environment), dropped when another
    /// measurer asks. Measurers are told apart by address.
    static CHAR_WIDTH: std::cell::RefCell<(usize, CharWidth)> = std::cell::RefCell::new((0, CharWidth::default()));
}

fn measurer_key(m: &dyn Measure) -> usize {
    m as *const dyn Measure as *const () as usize
}

fn with_char_width<R>(m: &dyn Measure, f: impl FnOnce(&mut CharWidth) -> R) -> R {
    CHAR_WIDTH.with(|c| {
        let mut c = c.borrow_mut();
        let key = measurer_key(m);
        if c.0 != key {
            *c = (key, CharWidth::default());
        }
        f(&mut c.1)
    })
}

/// `charWidth.calculate`: the cached width of a single token (keyed by its
/// first UTF-16 unit, as upstream).
pub fn char_width(m: &dyn Measure, ch: &str, font: Font) -> f64 {
    with_char_width(m, |c| c.calculate(m, ch, font))
}
/// `charWidth.clearCache`: after a font finished loading, say.
pub fn clear_char_width_cache(m: &dyn Measure, font: Font) {
    with_char_width(m, |c| c.clear_cache(font))
}
/// Drops every cached width (tests start from a clean slate).
pub fn reset_char_width_cache() {
    CHAR_WIDTH.with(|c| *c.borrow_mut() = (0, CharWidth::default()))
}
/// `getMinCharWidth`.
pub fn get_min_char_width(m: &dyn Measure, font: Font) -> f64 {
    with_char_width(m, |c| c.min(font))
}
/// `getMaxCharWidth`.
pub fn get_max_char_width(m: &dyn Measure, font: Font) -> f64 {
    with_char_width(m, |c| c.max(font))
}
