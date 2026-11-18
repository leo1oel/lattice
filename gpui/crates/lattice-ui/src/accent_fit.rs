//! A custom accent as the theme can use it, and the contrast arithmetic the
//! highlight palette shares. The one implementation is `lattice_theme::color`
//! (`src-tauri/lattice-theme`), which the Tauri app reaches over IPC, so the
//! two apps fit a colour identically; this module adapts it to the
//! [`Appearance`] and [`Srgb`] types used here.

use crate::{Appearance, token_types::Srgb};

pub(crate) fn theme_appearance(appearance: Appearance) -> lattice_theme::Appearance {
    match appearance {
        Appearance::Light => lattice_theme::Appearance::Light,
        Appearance::Dark => lattice_theme::Appearance::Dark,
    }
}

/// `fitAccent`: the custom accent `rgb` (`0xRRGGBB`) as `appearance` uses it.
pub fn fit_accent(rgb: u32, appearance: Appearance) -> u32 {
    lattice_theme::color::fit_accent(rgb, theme_appearance(appearance))
}

/// `fitContrast`: `rgb` when it reads at `ratio` against every one of
/// `grounds`, otherwise the nearest colour with its hue that does, moving
/// away from a ground of `ground`'s kind.
pub fn fit_contrast(rgb: u32, grounds: &[u32], ratio: f64, ground: Appearance) -> u32 {
    lattice_theme::color::fit_contrast(rgb, grounds, ratio, theme_appearance(ground))
}

/// The WCAG contrast between two colours (`contrastRatio`).
pub fn contrast_ratio(first: u32, second: u32) -> f64 {
    lattice_theme::color::contrast_ratio(first, second)
}

/// The accent's contrast on the surface closest to it (`accentContrast`).
pub fn accent_contrast(rgb: u32, appearance: Appearance) -> f64 {
    lattice_theme::color::accent_contrast(rgb, theme_appearance(appearance))
}

pub(crate) fn srgb(rgb: u32) -> Srgb {
    crate::token_types::hex(rgb)
}
