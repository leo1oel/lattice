//! A custom accent as the theme can use it (`src/settings/theme-customization.ts`):
//! the accent colours text on every surface, so it must read at 4.6:1 (the
//! presets' floor) on the surface closest to it, Dusk's chrome (#f0edf7) in
//! light and Graphite's lift (#252528) in dark. A colour that already does is
//! used as it is; otherwise the nearest colour with its hue that does, found
//! in OKLCH by moving lightness away from the ground (and giving up chroma
//! only where sRGB runs out).

use crate::{Appearance, token_types::Srgb};

const ACCENT_FLOOR: f64 = 4.6;

fn ground_luminance(appearance: Appearance) -> f64 {
    match appearance {
        Appearance::Light => 0.8581,
        Appearance::Dark => 0.01871,
    }
}

type Rgb = [f64; 3];

fn to_linear(channel: f64) -> f64 {
    if channel <= 0.04045 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn to_gamma(channel: f64) -> f64 {
    if channel <= 0.0031308 {
        12.92 * channel
    } else {
        1.055 * channel.powf(1. / 2.4) - 0.055
    }
}

fn parse(rgb: u32) -> Rgb {
    [
        f64::from((rgb >> 16) & 0xff) / 255.,
        f64::from((rgb >> 8) & 0xff) / 255.,
        f64::from(rgb & 0xff) / 255.,
    ]
}

fn format(rgb: Rgb) -> u32 {
    let byte = |channel: f64| (channel * 255.).round().clamp(0., 255.) as u32;
    (byte(rgb[0]) << 16) | (byte(rgb[1]) << 8) | byte(rgb[2])
}

fn luminance(rgb: Rgb) -> f64 {
    let [r, g, b] = rgb.map(to_linear);
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

fn to_oklch(rgb: Rgb) -> [f64; 3] {
    let [r, g, b] = rgb.map(to_linear);
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    let bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a.hypot(bb),
        bb.atan2(a),
    ]
}

/// The sRGB colour at an OKLCH point, or `None` outside the gamut.
fn from_oklch(lightness: f64, chroma: f64, hue: f64) -> Option<Rgb> {
    let a = chroma * hue.cos();
    let b = chroma * hue.sin();
    let l = (lightness + 0.3963377774 * a + 0.2158037573 * b).powi(3);
    let m = (lightness - 0.1055613458 * a - 0.0638541728 * b).powi(3);
    let s = (lightness - 0.0894841775 * a - 1.291485548 * b).powi(3);
    let linear = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if linear
        .iter()
        .any(|channel| *channel < -1e-4 || *channel > 1. + 1e-4)
    {
        return None;
    }
    Some(linear.map(|channel| to_gamma(channel.clamp(0., 1.))))
}

fn fits(appearance: Appearance, value: f64) -> bool {
    let ground = ground_luminance(appearance);
    match appearance {
        Appearance::Light => (ground + 0.05) / (value + 0.05) >= ACCENT_FLOOR,
        Appearance::Dark => (value + 0.05) / (ground + 0.05) >= ACCENT_FLOOR,
    }
}

/// `fitAccent`: the custom accent `rgb` (`0xRRGGBB`) as `appearance` uses it.
pub fn fit_accent(rgb: u32, appearance: Appearance) -> u32 {
    let color = parse(rgb);
    if fits(appearance, luminance(color)) {
        return format(color);
    }
    let [start, chroma, hue] = to_oklch(color);
    let at = |lightness: f64| {
        let mut reduced = chroma;
        while reduced >= 0. {
            if let Some(candidate) = from_oklch(lightness, reduced, hue) {
                return candidate;
            }
            reduced -= 0.005;
        }
        from_oklch(lightness, 0., hue).unwrap_or([lightness; 3])
    };
    // Light grounds darken toward black, dark ones lighten toward white; the
    // first lightness that fits is the closest, to 0.001 in OKLCH.
    let (mut inside, mut outside) = match appearance {
        Appearance::Light => (0., start),
        Appearance::Dark => (1., start),
    };
    for _ in 0..14 {
        let middle = (inside + outside) / 2.;
        if fits(appearance, luminance(at(middle))) {
            inside = middle;
        } else {
            outside = middle;
        }
    }
    format(at(inside))
}

/// The accent's contrast on the surface closest to it (`accentContrast`).
pub fn accent_contrast(rgb: u32, appearance: Appearance) -> f64 {
    let (a, b) = (luminance(parse(rgb)), ground_luminance(appearance));
    let (lighter, darker) = if a > b { (a, b) } else { (b, a) };
    (lighter + 0.05) / (darker + 0.05)
}

pub(crate) fn srgb(rgb: u32) -> Srgb {
    crate::token_types::hex(rgb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_colour_that_reads_is_kept_and_one_that_does_not_is_moved_to_the_floor() {
        // The editor's selection blue reads on light grounds as it is…
        assert_eq!(fit_accent(0x2f5fc0, Appearance::Light), 0x2f5fc0);
        // …a pale yellow is darkened until it reads at 4.6:1, keeping its hue.
        let fitted = fit_accent(0xffe066, Appearance::Light);
        assert_ne!(fitted, 0xffe066);
        // At the floor, give or take the rounding to 8 bits a channel that
        // `formatHex` does in the Tauri app too.
        let ratio = accent_contrast(fitted, Appearance::Light);
        assert!((4.55..4.8).contains(&ratio), "{ratio}");
        // In dark, a deep navy is lightened.
        let fitted = fit_accent(0x10204a, Appearance::Dark);
        assert!(accent_contrast(fitted, Appearance::Dark) >= 4.55);
    }
}
