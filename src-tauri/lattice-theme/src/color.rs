//! Colour arithmetic: WCAG contrast, and fitting a colour to a contrast floor
//! by moving its OKLCH lightness while keeping its hue.
//!
//! This is the one copy both shells use. It was `accent_fit.rs` in the GPUI
//! app and `fitAccent`/`fitContrast` in the Tauri app's
//! `theme-customization.ts`; the Tauri app now asks for fitted colours over
//! IPC, so the two can no longer drift apart.

use crate::Appearance;

/// The floor an accent reads at as text on every surface (the presets').
pub const ACCENT_FLOOR: f64 = 4.6;

/// The luminance of the surface closest to a custom accent with no theme:
/// Dusk's chrome (#f0edf7) in light, Graphite's lift (#252528) in dark.
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
    [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a.hypot(bb), bb.atan2(a)]
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
    if linear.iter().any(|channel| *channel < -1e-4 || *channel > 1. + 1e-4) {
        return None;
    }
    Some(linear.map(|channel| to_gamma(channel.clamp(0., 1.))))
}

/// One tone of OKLCH lightness: the step from the editor down to the side
/// panels, Graphite's light chrome under its editor (#efeff0, #fafafa).
pub const SIDE_PANEL_TONE: f64 = 0.033;

/// The side panels' surface (Project, Papers, the Agent) for a theme whose
/// chrome and editor are `chrome` and `editor`: the chrome, while it stands at
/// least half a tone off the editor, otherwise the editor a tone darker with
/// its hue, so the panels never melt into the page beside them.
pub fn side_panel(chrome: u32, editor: u32) -> u32 {
    let [chrome_lightness, ..] = to_oklch(parse(chrome));
    let [lightness, chroma, hue] = to_oklch(parse(editor));
    if (chrome_lightness - lightness).abs() >= SIDE_PANEL_TONE / 2. {
        return chrome;
    }
    let lightness = (lightness - SIDE_PANEL_TONE).max(0.);
    let mut reduced = chroma;
    while reduced > 0. {
        if let Some(candidate) = from_oklch(lightness, reduced, hue) {
            return format(candidate);
        }
        reduced -= 0.005;
    }
    format(from_oklch(lightness, 0., hue).unwrap_or([lightness; 3]))
}

/// A custom accent (`0xRRGGBB`) as `appearance` uses it when no theme is
/// active: itself when it reads at [`ACCENT_FLOOR`] on the surface closest
/// to it, otherwise the nearest colour with its hue that does.
pub fn fit_accent(rgb: u32, appearance: Appearance) -> u32 {
    let ground = ground_luminance(appearance);
    fit_lightness(
        rgb,
        |value| match appearance {
            Appearance::Light => (ground + 0.05) / (value + 0.05) >= ACCENT_FLOOR,
            Appearance::Dark => (value + 0.05) / (ground + 0.05) >= ACCENT_FLOOR,
        },
        appearance,
    )
}

/// `rgb` when it reads at `ratio` against every one of `grounds`, otherwise
/// the nearest colour with its hue that does, moving away from a ground of
/// `ground`'s kind (light grounds darken it, dark grounds lighten it).
pub fn fit_contrast(rgb: u32, grounds: &[u32], ratio: f64, ground: Appearance) -> u32 {
    let limits: Vec<f64> = grounds.iter().map(|color| luminance(parse(*color))).collect();
    fit_lightness(
        rgb,
        |value| {
            limits.iter().all(|limit| {
                let (lighter, darker) =
                    if value > *limit { (value, *limit) } else { (*limit, value) };
                (lighter + 0.05) / (darker + 0.05) >= ratio
            })
        },
        ground,
    )
}

/// The WCAG contrast between two colours.
pub fn contrast_ratio(first: u32, second: u32) -> f64 {
    let (a, b) = (luminance(parse(first)), luminance(parse(second)));
    let (lighter, darker) = if a > b { (a, b) } else { (b, a) };
    (lighter + 0.05) / (darker + 0.05)
}

/// A custom accent's contrast on the surface closest to it, with no theme.
pub fn accent_contrast(rgb: u32, appearance: Appearance) -> f64 {
    let (a, b) = (luminance(parse(rgb)), ground_luminance(appearance));
    let (lighter, darker) = if a > b { (a, b) } else { (b, a) };
    (lighter + 0.05) / (darker + 0.05)
}

/// `rgb` itself when its luminance `fits`, otherwise the nearest colour with
/// its hue that does, found by moving lightness away from a `ground` of that
/// kind (giving up chroma only where sRGB runs out).
fn fit_lightness(rgb: u32, fits: impl Fn(f64) -> bool, ground: Appearance) -> u32 {
    let color = parse(rgb);
    if fits(luminance(color)) {
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
    let (mut inside, mut outside) = match ground {
        Appearance::Light => (0., start),
        Appearance::Dark => (1., start),
    };
    for _ in 0..14 {
        let middle = (inside + outside) / 2.;
        if fits(luminance(at(middle))) {
            inside = middle;
        } else {
            outside = middle;
        }
    }
    format(at(inside))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_colour_that_reads_is_kept_and_one_that_does_not_is_moved_to_the_floor() {
        assert_eq!(fit_accent(0x2f5fc0, Appearance::Light), 0x2f5fc0);
        let fitted = fit_accent(0xffe066, Appearance::Light);
        assert_ne!(fitted, 0xffe066);
        let ratio = accent_contrast(fitted, Appearance::Light);
        assert!((4.55..4.8).contains(&ratio), "{ratio}");
        let fitted = fit_accent(0x10204a, Appearance::Dark);
        assert!(accent_contrast(fitted, Appearance::Dark) >= 4.55);
    }

    #[test]
    fn contrast_is_wcags_ratio() {
        assert!((contrast_ratio(0xffffff, 0x000000) - 21.).abs() < 1e-9);
        assert!((contrast_ratio(0x777777, 0x777777) - 1.).abs() < 1e-9);
    }

    #[test]
    fn a_colour_too_dark_for_its_ink_is_lightened_to_the_ratio() {
        const INK: u32 = 0x242426;
        assert!(contrast_ratio(0x806000, INK) < 4.5);
        let fixed = fit_contrast(0x806000, &[INK], 9., Appearance::Dark);
        let ratio = contrast_ratio(fixed, INK);
        assert!((8.9..9.4).contains(&ratio), "{ratio}");
        let [r, g, b] = [fixed >> 16, (fixed >> 8) & 0xff, fixed & 0xff];
        assert!(r > b && g > b, "{fixed:06X} is no longer a yellow");
        assert_eq!(fit_contrast(0xfff1a6, &[INK], 9., Appearance::Dark), 0xfff1a6);
    }

    #[test]
    fn side_panels_keep_a_chrome_off_the_editor_and_step_a_tone_below_one_that_is_not() {
        // Graphite, Rosé Pine and Nord light: the theme's own chrome.
        assert_eq!(side_panel(0xefeff0, 0xfafafa), 0xefeff0);
        assert_eq!(side_panel(0x131315, 0x1f1f22), 0x131315);
        assert_eq!(side_panel(0x191724, 0x1f1d2e), 0x191724);
        // Nord's Polar Night paints its chrome and editor alike.
        let nord = side_panel(0x2e3440, 0x2e3440);
        let [editor, chroma, hue] = to_oklch(parse(0x2e3440));
        let [lightness, panel_chroma, panel_hue] = to_oklch(parse(nord));
        assert!((editor - lightness - SIDE_PANEL_TONE).abs() < 0.003, "{nord:06x}");
        assert!((chroma - panel_chroma).abs() < 0.005 && (hue - panel_hue).abs() < 0.05, "{nord:06x}");
    }

    /// Golden vectors for the Tauri app's copy of `fitContrast` and
    /// `contrastRatio` (`src/settings/theme-customization.ts`, kept for the
    /// build-time code-theme export): `src/settings/color-parity.test.ts`
    /// must reproduce every one. `LATTICE_UPDATE_THEME_SCHEMA=1` rewrites them.
    #[test]
    fn colour_vectors_are_current() {
        const PATH: &str =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../design-system/themes/color-vectors.json");
        let colours = [
            0xffe066u32,
            0x806000,
            0x10204a,
            0x2f5fc0,
            0x9ccfd8,
            0x31748f,
            0xeb6f92,
            0x6e6a86,
            0xa3be8c,
            0x616e88,
        ];
        let grounds: [(&str, Vec<u32>, Appearance); 4] = [
            ("light sheets", vec![0xfafafa, 0xefeff0, 0xffffff], Appearance::Light),
            ("dark sheets", vec![0x1f1f22, 0x131315, 0x252528], Appearance::Dark),
            ("rose pine", vec![0x1f1d2e, 0x191724], Appearance::Dark),
            ("paper ink", vec![0x242426], Appearance::Dark),
        ];
        let hex = |rgb: u32| format!("#{rgb:06x}");
        let mut cases = Vec::new();
        for (name, on, kind) in &grounds {
            for ratio in [3.0, 4.5, 9.0] {
                for colour in colours {
                    cases.push(serde_json::json!({
                        "grounds": name,
                        "on": on.iter().map(|rgb| hex(*rgb)).collect::<Vec<_>>(),
                        "kind": if *kind == Appearance::Dark { "dark" } else { "light" },
                        "ratio": ratio,
                        "color": hex(colour),
                        "fitted": hex(fit_contrast(colour, on, ratio, *kind)),
                        "contrast": (contrast_ratio(colour, on[0]) * 1e6).round() / 1e6,
                    }));
                }
            }
        }
        let generated = serde_json::to_string_pretty(&serde_json::json!({
            "about": "Written by src-tauri/lattice-theme/src/color.rs; checked by src/settings/color-parity.test.ts. Do not edit.",
            "cases": cases,
        }))
        .unwrap()
            + "\n";
        if std::env::var_os("LATTICE_UPDATE_THEME_SCHEMA").is_some() {
            std::fs::write(PATH, &generated).unwrap();
        }
        assert!(
            std::fs::read_to_string(PATH).unwrap_or_default() == generated,
            "design-system/themes/color-vectors.json is out of date: run LATTICE_UPDATE_THEME_SCHEMA=1 cargo test -p lattice-theme"
        );
    }
}
