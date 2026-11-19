// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Constants used by the board. Port of the relevant part of Excalidraw
//! `packages/common/src/constants.ts` @ 3a317b5 (browser, collaboration and
//! UI-library constants are left out).

use std::f64::consts::PI;

pub const TEXT_AUTOWRAP_THRESHOLD: f64 = 36.;
pub const TEXT_VIEWPORT_PADDING: f64 = 20.;
pub const TEXT_MAX_WRAP_WIDTH: f64 = 800.;
pub const DRAGGING_THRESHOLD: f64 = 10.;
pub const MINIMUM_ARROW_SIZE: f64 = 20.;
pub const LINE_CONFIRM_THRESHOLD: f64 = 8.;
pub const ELEMENT_SHIFT_TRANSLATE_AMOUNT: f64 = 5.;
pub const ELEMENT_TRANSLATE_AMOUNT: f64 = 1.;
pub const TEXT_TO_CENTER_SNAP_THRESHOLD: f64 = 30.;
pub const SHIFT_LOCKING_ANGLE: f64 = PI / 12.;

/// `FONT_SIZES`: sm, md, lg, xl.
pub const FONT_SIZES: [f64; 4] = [16., 20., 28., 36.];

/// `FONT_FAMILY`.
pub mod font_family {
    pub const VIRGIL: u32 = 1;
    pub const HELVETICA: u32 = 2;
    pub const CASCADIA: u32 = 3;
    pub const EXCALIFONT: u32 = 5;
    pub const NUNITO: u32 = 6;
    pub const LILITA_ONE: u32 = 7;
    pub const COMIC_SHANNS: u32 = 8;
    pub const LIBERATION_SANS: u32 = 9;
    pub const ASSISTANT: u32 = 10;
    pub const ALL: [u32; 9] = [
        VIRGIL,
        HELVETICA,
        CASCADIA,
        EXCALIFONT,
        NUNITO,
        LILITA_ONE,
        COMIC_SHANNS,
        LIBERATION_SANS,
        ASSISTANT,
    ];
    /// Monospaced families (`getGenericFontFamilyFallback`).
    pub fn is_monospace(f: u32) -> bool {
        f == CASCADIA || f == COMIC_SHANNS
    }
}

pub struct FrameStyle;
impl FrameStyle {
    pub const STROKE_COLOR: &'static str = "#bbb";
    pub const STROKE_WIDTH: f64 = 2.;
    pub const RADIUS: f64 = 8.;
    pub const NAME_OFFSET_Y: f64 = 3.;
    pub const NAME_COLOR_LIGHT: &'static str = "#999999";
    pub const NAME_COLOR_DARK: &'static str = "#7a7a7a";
    pub const NAME_FONT_SIZE: f64 = 14.;
    pub const NAME_LINE_HEIGHT: f64 = 1.25;
}

pub const MIN_FONT_SIZE: f64 = 1.;
pub const DEFAULT_FONT_SIZE: f64 = 20.;
pub const STICKY_NOTE_MIN_FONT_SIZE: f64 = 16.;
pub const STICKY_NOTE_MAX_FONT_SIZE: f64 = 512.;
pub const STICKY_NOTE_FALLBACK_FONT_SIZE: f64 = 28.;
pub const STICKY_NOTE_FONT_STEP: f64 = 2.;
pub const STICKY_NOTE_PADDING: f64 = 16.;
pub const STICKY_NOTE_FOOTER_HEIGHT: f64 = 20.;
pub const STICKY_NOTE_FOOTER_FONT_SIZE: f64 = 12.;
pub const STICKY_NOTE_FOOTER_BASELINE_FROM_BOTTOM: f64 = 14.;
pub const STICKY_NOTE_FOOTER_MIN_BODY_WIDTH_FOR_YEAR: f64 = 80.;
pub const STICKY_NOTE_BODY_INSET_Y: f64 = STICKY_NOTE_PADDING * 2. + STICKY_NOTE_FOOTER_HEIGHT;
pub const DEFAULT_STICKY_NOTE_SIZE: f64 = 250.;
pub const STICKY_NOTE_MIN_SIZE: f64 = 75.;
pub const STICKY_NOTE_SHADOW_OFFSET: f64 = 3.;
pub const STICKY_NOTE_SHADOW_OPACITY: f64 = 0.16;
pub const DEFAULT_STICKY_NOTE_BG: &str = "#ffdf6b";

pub const DEFAULT_FONT_FAMILY: u32 = font_family::EXCALIFONT;
pub const DEFAULT_TRANSFORM_HANDLE_SPACING: f64 = 2.;
pub const SIDE_RESIZING_THRESHOLD: f64 = 2. * DEFAULT_TRANSFORM_HANDLE_SPACING;
pub const EPSILON: f64 = 0.00001;
pub const DEFAULT_COLLISION_THRESHOLD: f64 = 2. * SIDE_RESIZING_THRESHOLD - EPSILON;
pub const COLOR_WHITE: &str = "#ffffff";
pub const COLOR_CHARCOAL_BLACK: &str = "#1e1e1e";
pub const DEFAULT_GRID_SIZE: f64 = 20.;
pub const DEFAULT_GRID_STEP: u32 = 5;

pub const ZOOM_STEP: f64 = 0.1;
pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 30.;
pub const TAP_TWICE_TIMEOUT_MS: u64 = 300;

pub const MAX_DECIMALS_FOR_SVG_EXPORT: i32 = 2;
pub const DEFAULT_EXPORT_PADDING: f64 = 10.;
pub const MAX_IMAGE_WIDTH_OR_HEIGHT: f64 = 1440.;
pub const MAX_IMAGE_FILE_SIZE_BYTES: usize = 4 * 1024 * 1024;

/// `VERSIONS.excalidraw`: the `.excalidraw` file format version.
pub const EXCALIDRAW_FILE_VERSION: u32 = 2;
pub const EXPORT_DATA_TYPE_EXCALIDRAW: &str = "excalidraw";
pub const EXPORT_DATA_TYPE_CLIPBOARD: &str = "excalidraw/clipboard";

pub const BOUND_TEXT_PADDING: f64 = 5.;
pub const ARROW_LABEL_WIDTH_FRACTION: f64 = 0.7;
pub const ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO: f64 = 11.;

pub const ELEMENT_READY_TO_ERASE_OPACITY: f64 = 20.;
pub const ELEMENT_PENDING_DRAW_SHAPE_OPACITY: f64 = 70.;
pub const DEFAULT_PROPORTIONAL_RADIUS: f64 = 0.25;
pub const DEFAULT_ADAPTIVE_RADIUS: f64 = 32.;

/// `ROUGHNESS`: architect, artist, cartoonist.
pub const ROUGHNESS_ARCHITECT: f64 = 0.;
pub const ROUGHNESS_ARTIST: f64 = 1.;
pub const ROUGHNESS_CARTOONIST: f64 = 2.;

/// `STROKE_WIDTH` thin / medium / bold / extraBold.
pub const STROKE_WIDTH: [f64; 4] = [1., 2., 4., 8.];
/// `FREEDRAW_STROKE_WIDTH`, at the shapes' widths as Excalidraw 0.18 (the
/// Tauri board's) draws the pen: upstream @ 3a317b5 halves them, which puts
/// a new stroke at width 1, a hairline that breaks up when zoomed out.
pub const FREEDRAW_STROKE_WIDTH: [f64; 4] = STROKE_WIDTH;

/// `DEFAULT_ELEMENT_PROPS`.
pub const DEFAULT_STROKE_COLOR: &str = COLOR_CHARCOAL_BLACK;
pub const DEFAULT_BACKGROUND_COLOR: &str = "transparent";
pub const DEFAULT_STROKE_WIDTH: f64 = 2.;
pub const DEFAULT_ROUGHNESS: f64 = ROUGHNESS_ARTIST;
pub const DEFAULT_OPACITY: f64 = 100.;

pub const MIN_WIDTH_OR_HEIGHT: f64 = 1.;
pub const DEFAULT_STROKE_STREAMLINE: f64 = 0.5;
/// `DEFAULT_ZOOM` value; `MIN_ZOOM`..`MAX_ZOOM` bound it.
pub const DEFAULT_ZOOM: f64 = 1.;
pub const COLOR_TRANSPARENT: &str = "transparent";
pub const DEFAULT_LINE_HEIGHT: f64 = 1.25;
