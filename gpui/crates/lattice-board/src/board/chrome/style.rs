// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Excalidraw's UI design tokens, mapped to Lattice's as the Tauri app's
//! restyled Excalidraw maps them (`.board-editor-root .excalidraw`, the LATA-10
//! theme table); sizes and the token names follow `packages/excalidraw/css/theme.scss`
//! (`.excalidraw` and `.excalidraw.theme--dark`), `variables.module.scss` and
//! `styles.scss` @ 3a317b5: one function per CSS variable, read from the
//! app's palette (upstream's UI isn't filtered in dark mode; only colors shown
//! as scene colors, like swatches, go through the canvas mapping). Sizes are px at upstream's 16px
//! rem (`--default-button-size: 2rem` = 32 …); the ≥1921px-wide variants are
//! left out.

use gpui::{BoxShadow, Hsla, Rgba, point, px};

fn p<T>(read: impl FnOnce(&lattice_ui::Palette) -> T) -> T {
    crate::theme::palette(read)
}
pub fn hex(c: u32) -> Hsla {
    Rgba {
        r: (c >> 16 & 0xff) as f32 / 255.,
        g: (c >> 8 & 0xff) as f32 / 255.,
        b: (c & 0xff) as f32 / 255.,
        a: 1.,
    }
    .into()
}
pub fn hexa(c: u32, a: f32) -> Hsla {
    let mut h = hex(c);
    h.a = a;
    h
}

/// `--ui-font`: Lattice's interface family, as the Tauri app's restyled
/// Excalidraw sets it.
pub fn ui_font() -> gpui::SharedString {
    crate::theme::ui_family()
}

// ---- sizes (`theme.scss`, `styles.scss`)
pub const SPACE: f32 = 4.; // --space-factor: 0.25rem
pub const DEFAULT_BUTTON: f32 = 32.; // --default-button-size
pub const LG_BUTTON: f32 = 36.; // --lg-button-size
pub const ICON: f32 = 16.; // --default-icon-size, --lg-icon-size
pub const RADIUS_LG: f32 = 10.; // --border-radius-lg: --radius-surface
pub const RADIUS_MD: f32 = 6.; // --border-radius-md: --radius-control
pub const PADDING: f32 = 16.; // --editor-container-padding
/// Above the top row (menu, toolbar): ours, as the board sits under the
/// app's header, which already leaves room (upstream: `PADDING`).
pub const TOP_PADDING: f32 = 8.;
/// `.excalidraw button { font-size: 0.8333rem }`.
pub const BUTTON_TEXT: f32 = 13.333;
pub const LABEL_TEXT: f32 = 12.; // 0.75rem
/// CSS `line-height: normal` for Assistant (hhea 1021 / -287, no gap) as
/// Chrome computes it: ascent and descent rounded separately. GPUI's default
/// (1.618em) would make every text box taller than upstream's.
pub fn lh(size: f32) -> gpui::Pixels {
    px((size * 1.021).round() + (size * 0.287).round())
}

// ---- colors (`.excalidraw` / `.theme--dark`)
/// `--color-primary` (and its darker steps, `--color-brand-*`): `--control-active`.
pub fn primary() -> Hsla {
    p(|p| p.accent)
}
pub fn primary_darker() -> Hsla {
    primary()
}
pub fn primary_darkest() -> Hsla {
    primary()
}
/// `--color-primary-light`: `--control-pressed-surface`.
pub fn primary_light() -> Hsla {
    p(|p| p.pressed)
}
/// `--island-bg-color`: `--surface-elevated` (the lift).
pub fn island_bg() -> Hsla {
    p(|p| p.raised)
}
pub fn popup_bg() -> Hsla {
    island_bg()
}
/// `--color-surface-high` (`--button-active-bg`): `--control-pressed-surface`.
pub fn surface_high() -> Hsla {
    p(|p| p.pressed)
}
/// `--color-surface-mid`: `--control-hover-surface`.
pub fn surface_mid() -> Hsla {
    p(|p| p.hover)
}
/// `--color-surface-low`: `--surface-chrome`.
pub fn surface_low() -> Hsla {
    p(|p| p.chrome)
}
pub fn surface_lowest() -> Hsla {
    p(|p| p.raised)
}
/// `--color-on-surface`: `--text-primary`.
pub fn on_surface() -> Hsla {
    p(|p| p.text)
}
pub fn brand_active() -> Hsla {
    primary()
}
pub fn on_primary_container() -> Hsla {
    p(|p| p.text)
}
/// `--color-surface-primary-container` (the selected tool): `--control-pressed-surface`.
pub fn surface_primary_container() -> Hsla {
    p(|p| p.pressed)
}
/// `--text-primary-color`, `--icon-fill-color`.
pub fn text() -> Hsla {
    on_surface()
}
/// `--default-border-color`: `--border-subtle`.
pub fn border() -> Hsla {
    p(|p| p.line)
}
/// `--button-hover-bg`: `--control-hover-surface`.
pub fn button_hover_bg() -> Hsla {
    p(|p| p.hover)
}
/// `--button-active-border`: none (selection is a fill, never a second outline).
pub fn button_active_border() -> Hsla {
    gpui::transparent_black()
}
pub fn disabled() -> Hsla {
    p(|p| p.disabled_ink)
}
pub fn keybinding() -> Hsla {
    p(|p| p.text_secondary)
}
pub fn button_gray_2() -> Hsla {
    p(|p| p.hover)
}
pub fn button_gray_3() -> Hsla {
    p(|p| p.pressed)
}
pub fn popup_secondary_bg() -> Hsla {
    p(|p| p.raised)
}
pub fn popup_text() -> Hsla {
    p(|p| p.text)
}
pub fn select_highlight() -> Hsla {
    p(|p| p.focus)
}
pub fn dialog_border() -> Hsla {
    p(|p| p.line)
}
pub fn list_border() -> Hsla {
    p(|p| p.line)
}
/// `--overlay-bg-color`: `--surface-backdrop`.
pub fn overlay_bg() -> Hsla {
    p(|p| p.backdrop)
}
pub fn input_label() -> Hsla {
    p(|p| p.text_secondary)
}
pub fn slider_track() -> Hsla {
    p(|p| p.pressed)
}
pub fn slider_thumb() -> Hsla {
    p(|p| p.accent)
}
pub fn color_outline() -> Hsla {
    p(|p| p.line)
}
pub fn panel_button_bg() -> Hsla {
    p(|p| p.hover)
}
pub fn panel_button_hover_bg() -> Hsla {
    p(|p| p.pressed)
}
pub fn hint_text() -> Hsla {
    p(|p| p.text_secondary)
}
/// `$color-red-7` / `$color-red-6` (the context menu's dangerous item).
pub const RED_7: u32 = 0xf03e3e;
pub const RED_6: u32 = 0xfa5252;
/// `--color-gray-*`.
pub const GRAY_20: u32 = 0xebebeb;
pub const GRAY_40: u32 = 0xb8b8b8;
pub const GRAY_60: u32 = 0x7a7a7a;
pub const GRAY_70: u32 = 0x5c5c5c;
pub const GRAY_80: u32 = 0x3d3d3d;
/// `$color-gray-5` (`.context-menu-item-separator`).
pub const GRAY_5: u32 = 0xadb5bd;
/// `--color-selection`: `--focus`.
pub fn selection() -> Hsla {
    p(|p| p.focus)
}

// ---- shadows
/// `--shadow-island`: `--elevation-popover-shadow`.
pub fn shadow_island() -> Vec<BoxShadow> {
    p(|p| lattice_ui::Elevation::Popover.shadows(p))
}
pub fn shadow_island_stronger() -> Vec<BoxShadow> {
    p(|p| lattice_ui::Elevation::Floating.shadows(p))
}
/// `--modal-shadow`: `--elevation-dialog-shadow`.
pub fn shadow_modal() -> Vec<BoxShadow> {
    p(|p| lattice_ui::Elevation::Dialog.shadows(p))
}
pub fn shadow_context_menu() -> Vec<BoxShadow> {
    shadow_island()
}
/// A 1px ring (`box-shadow: 0 0 0 1px …`).
pub fn ring(c: Hsla) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: c,
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(1.),
        inset: false,
    }]
}
