//! The Terminal panel's colours (`src/terminal/terminal.css`), read from the
//! design system rather than written here, as the Tauri app reads them.
//!
//! The terminal stands on the source editor's ground in its ink, caret and
//! selection, so it follows the code theme, the tint and light or dark. The
//! ANSI hues take the status roles (red, green, yellow) and the file glyphs'
//! (blue, magenta, cyan), which already read on that ground; each bright hue
//! is its hue mixed 80% with the ink. Black is the darkest and white the
//! lightest whichever way the ground goes, so a program painting "black on
//! white" reads as it means: on a dark code ground black is the ink at 12%
//! over the ground and white the ink at 80%, on a light one black is the ink
//! and white the ink at 30%. CSS mixes these `in oklab`, and so does this.
//!
//! The colours reach Zed's terminal through the generated Zed theme
//! (`terminal.*`, [`terminal_style`]), so a program asking for a colour
//! (`OSC 4`, `OSC 10`, `OSC 11`) hears the one it is drawn in.

use gpui::Hsla;
use serde_json::{Map, Value, json};

use super::{CodeTheme, code_palette::CodePalette};
use crate::{Appearance, GlyphKind, Palette, kit::hex, token_types::Srgb};

/// The Weft & Warp selection's tint (`--editor-selection-tint`), and its
/// share of a focused selection (`--selection-mix-focused`) by appearance;
/// the unfocused one is the palette's `selection` (`--selection-mix`).
const SELECTION_TINT: Srgb = crate::token_types::hex(0x3d7af2);

/// The sixteen ANSI colours and the roles around them, as the Tauri app
/// hands them to xterm.js (`terminal-theme.ts`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerminalColors {
    /// Which way the ground goes: the code theme's own kind.
    pub kind: Appearance,
    pub ground: Hsla,
    pub ink: Hsla,
    pub caret: Hsla,
    /// The selection while the terminal has focus.
    pub selection: Hsla,
    /// The selection of a terminal without focus, and the other find
    /// matches beside the current one.
    pub selection_inactive: Hsla,
    /// Black, red, green, yellow, blue, magenta, cyan, white, then their
    /// bright forms in the same order.
    pub ansi: [Hsla; 16],
}

impl TerminalColors {
    pub fn new(theme: CodeTheme, palette: &Palette) -> Self {
        let code = CodePalette::new(theme, palette);
        let ground = srgb(code.ground);
        let ink = srgb(code.ink);
        let (selection, selection_inactive) = match theme.source() {
            Some(source) => {
                let variant = source.in_app(palette.appearance);
                (variant.selection_focused.hsla(), variant.selection.hsla())
            }
            None => {
                let focused = match palette.appearance {
                    Appearance::Light => 0.20,
                    Appearance::Dark => 0.24,
                };
                (SELECTION_TINT.alpha(focused), palette.selection)
            }
        };
        let glyph = |kind: GlyphKind| srgb(palette.glyph(kind).0);
        let hues = [
            srgb(palette.danger),
            srgb(palette.success),
            srgb(palette.warning),
            glyph(GlyphKind::Tex),
            glyph(GlyphKind::Style),
            glyph(GlyphKind::Board),
        ];
        let over_ground = |share: f32| oklab_mix(ink, share, ground);
        let (black, bright_black, white, bright_white) = match code.kind {
            Appearance::Light => (ink, over_ground(0.55), over_ground(0.30), over_ground(0.12)),
            Appearance::Dark => (over_ground(0.12), over_ground(0.45), over_ground(0.80), ink),
        };
        let mut ansi = [Hsla::default(); 16];
        ansi[0] = black.hsla();
        ansi[7] = white.hsla();
        ansi[8] = bright_black.hsla();
        ansi[15] = bright_white.hsla();
        for (index, hue) in hues.into_iter().enumerate() {
            ansi[1 + index] = hue.hsla();
            ansi[9 + index] = oklab_mix(hue, 0.80, ink).hsla();
        }
        Self {
            kind: code.kind,
            ground: code.ground,
            ink: code.ink,
            caret: code.caret,
            selection,
            selection_inactive,
            ansi,
        }
    }
}

/// The `terminal.*` entries of a Zed theme: what Zed's terminal reads a
/// named or indexed colour from. Dim colours are the normal ones (the
/// renderer dims a faint cell's ink itself, as xterm.js does).
pub(super) fn terminal_style(theme: CodeTheme, palette: &Palette) -> Map<String, Value> {
    const NAMES: [&str; 8] = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    ];
    let colors = TerminalColors::new(theme, palette);
    let mut style = Map::new();
    let mut set = |key: String, color: Hsla| {
        style.insert(key, json!(hex(color)));
    };
    set("terminal.background".into(), colors.ground);
    set("terminal.ansi.background".into(), colors.ground);
    set("terminal.foreground".into(), colors.ink);
    set("terminal.bright_foreground".into(), colors.ink);
    set("terminal.dim_foreground".into(), colors.ink);
    for (index, name) in NAMES.iter().enumerate() {
        set(format!("terminal.ansi.{name}"), colors.ansi[index]);
        set(format!("terminal.ansi.dim_{name}"), colors.ansi[index]);
        set(
            format!("terminal.ansi.bright_{name}"),
            colors.ansi[8 + index],
        );
    }
    style
}

fn srgb(color: Hsla) -> Srgb {
    Srgb::from_hsla(color)
}

/// `color-mix(in oklab, a <share>, b)` for opaque colours.
pub fn oklab_mix(a: Srgb, share: f32, b: Srgb) -> Srgb {
    let (la, lb) = (to_oklab(a), to_oklab(b));
    let mixed = [0, 1, 2].map(|i| la[i] * share + lb[i] * (1. - share));
    let alpha = a.a * share + b.a * (1. - share);
    from_oklab(mixed, alpha)
}

fn to_linear(channel: u8) -> f32 {
    let c = channel as f32 / 255.;
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(c: f32) -> u8 {
    let c = c.clamp(0., 1.);
    let encoded = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1. / 2.4) - 0.055
    };
    (encoded * 255.).round().clamp(0., 255.) as u8
}

/// Björn Ottosson's Oklab, as CSS Color 4 defines it.
fn to_oklab(color: Srgb) -> [f32; 3] {
    let (r, g, b) = (to_linear(color.r), to_linear(color.g), to_linear(color.b));
    let l = (0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn from_oklab([l, a, b]: [f32; 3], alpha: f32) -> Srgb {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    Srgb {
        r: from_linear(4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s),
        g: from_linear(-1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s),
        b: from_linear(-0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s),
        a: alpha,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Accent, Tint};

    fn hex6(color: Srgb) -> String {
        format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
    }

    #[test]
    fn oklab_mixes_as_css_does() {
        let white = crate::token_types::hex(0xffffff);
        let black = crate::token_types::hex(0x000000);
        // `color-mix(in oklab, white 50%, black)` is oklab(0.5 0 0): #636363.
        assert_eq!(hex6(oklab_mix(white, 0.5, black)), "#636363");
        assert_eq!(hex6(oklab_mix(white, 1., black)), "#ffffff");
        assert_eq!(hex6(oklab_mix(white, 0., black)), "#000000");
    }

    #[test]
    fn black_is_darkest_and_white_lightest_on_either_ground() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let palette = Palette::new(appearance, Tint::Graphite, Accent::Graphite);
            for theme in CodeTheme::ALL {
                let colors = TerminalColors::new(theme, &palette);
                let black = colors.ansi[0].l;
                let white = colors.ansi[15].l;
                assert!(black < white, "{theme:?} in {appearance:?}");
            }
        }
    }

    #[test]
    fn the_ground_ink_and_hues_are_the_design_systems() {
        let palette = Palette::new(Appearance::Light, Tint::Graphite, Accent::Graphite);
        let colors = TerminalColors::new(CodeTheme::WeftAndWarp, &palette);
        assert_eq!(colors.ground, palette.editor);
        assert_eq!(colors.ink, palette.text);
        assert_eq!(colors.ansi[1], palette.danger);
        assert_eq!(colors.ansi[2], palette.success);
        assert_eq!(colors.ansi[3], palette.warning);
        assert_eq!(colors.ansi[4], palette.glyph(GlyphKind::Tex).0);
        // Black is the ink on a light ground.
        assert_eq!(colors.ansi[0], palette.text);
        // A dark-only theme in a light app keeps its own dark ground, and
        // its brightest white is its ink.
        let dracula = TerminalColors::new(CodeTheme::Dracula, &palette);
        assert_eq!(dracula.kind, Appearance::Dark);
        assert_eq!(dracula.ansi[15], dracula.ink);
    }

    #[test]
    fn the_zed_theme_names_every_ansi_colour() {
        let palette = Palette::new(Appearance::Dark, Tint::Graphite, Accent::Graphite);
        let style = terminal_style(CodeTheme::Github, &palette);
        for name in [
            "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        ] {
            for key in [
                format!("terminal.ansi.{name}"),
                format!("terminal.ansi.bright_{name}"),
                format!("terminal.ansi.dim_{name}"),
            ] {
                assert!(style.contains_key(&key), "{key}");
            }
        }
        assert!(style.contains_key("terminal.background"));
        assert!(style.contains_key("terminal.foreground"));
    }
}
