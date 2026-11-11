//! Every colour role the interface paints, resolved for one appearance, tint
//! and accent preset.
//!
//! The roles and their derivations follow the Tauri app's CSS
//! (`src/styles/theme.css`), which `design-system/tokens.json` mirrors:
//!
//! - A tint moves only the neutral surfaces (window, chrome, panel, lift) to
//!   one hue; text and lines stay neutral. In light the editor and fields
//!   stand on the tint's lift, in dark on its panel, as the CSS has it.
//! - The titlebar is the chrome under a white veil: 45% in light, 3.5% in
//!   dark.
//! - An accent preset becomes the accent, the focus ring (Graphite keeps the
//!   blue ring) and a 10% wash (14% in dark).
//! - A selected panel tab is the ink at 10% laid opaque on the surface the
//!   tab stands on, which is why the running app draws `#DBDBDC` on the
//!   chrome-coloured Project panel and `#E5E5E5` on the editor's sheet.

use gpui::Hsla;

use crate::{
    Appearance,
    token_types::{ColorToken, Srgb, hex},
    tokens::*,
};

/// The four tints of Settings › Appearance, and Graphite, the neutral default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Tint {
    #[default]
    Graphite,
    Paper,
    Sage,
    Mist,
    Dusk,
}

impl Tint {
    pub const ALL: [Tint; 5] = [
        Tint::Graphite,
        Tint::Paper,
        Tint::Sage,
        Tint::Mist,
        Tint::Dusk,
    ];

    /// Window, chrome, panel and lift for this tint, or `None` for Graphite,
    /// whose surfaces are the base tokens.
    fn surfaces(self) -> Option<[ColorToken; 4]> {
        match self {
            Tint::Graphite => None,
            Tint::Paper => Some([
                COLOR_TINT_PAPER_WINDOW,
                COLOR_TINT_PAPER_CHROME,
                COLOR_TINT_PAPER_PANEL,
                COLOR_TINT_PAPER_RAISED,
            ]),
            Tint::Sage => Some([
                COLOR_TINT_SAGE_WINDOW,
                COLOR_TINT_SAGE_CHROME,
                COLOR_TINT_SAGE_PANEL,
                COLOR_TINT_SAGE_RAISED,
            ]),
            Tint::Mist => Some([
                COLOR_TINT_MIST_WINDOW,
                COLOR_TINT_MIST_CHROME,
                COLOR_TINT_MIST_PANEL,
                COLOR_TINT_MIST_RAISED,
            ]),
            Tint::Dusk => Some([
                COLOR_TINT_DUSK_WINDOW,
                COLOR_TINT_DUSK_CHROME,
                COLOR_TINT_DUSK_PANEL,
                COLOR_TINT_DUSK_RAISED,
            ]),
        }
    }
}

/// The accent presets of Settings › Appearance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Accent {
    #[default]
    Graphite,
    Blue,
    Purple,
    Pink,
    Orange,
    Green,
    Teal,
}

impl Accent {
    pub const ALL: [Accent; 7] = [
        Accent::Graphite,
        Accent::Blue,
        Accent::Purple,
        Accent::Pink,
        Accent::Orange,
        Accent::Green,
        Accent::Teal,
    ];

    fn token(self) -> ColorToken {
        match self {
            Accent::Graphite => COLOR_ACCENT,
            Accent::Blue => COLOR_ACCENT_BLUE,
            Accent::Purple => COLOR_ACCENT_PURPLE,
            Accent::Pink => COLOR_ACCENT_PINK,
            Accent::Orange => COLOR_ACCENT_ORANGE,
            Accent::Green => COLOR_ACCENT_GREEN,
            Accent::Teal => COLOR_ACCENT_TEAL,
        }
    }
}

/// The kinds of file the tree, tabs and pickers draw a glyph for
/// (`src/components/ui/file-glyphs.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GlyphKind {
    Tex,
    Style,
    Bib,
    Markdown,
    Pdf,
    Image,
    Board,
    Sheet,
    Slides,
    Code,
    Config,
    Text,
    Folder,
}

impl GlyphKind {
    /// A file's kind by its extension, the longest first (`synctex.gz` before
    /// `gz`), as the app's tree resolves it.
    pub fn for_name(name: &str) -> GlyphKind {
        const KINDS: &[(GlyphKind, &[&str])] = &[
            (
                GlyphKind::Tex,
                &[
                    "tex",
                    "ltx",
                    "latex",
                    "tikz",
                    "aux",
                    "synctex",
                    "synctex.gz",
                    "dtx",
                    "ins",
                ],
            ),
            (
                GlyphKind::Style,
                &["sty", "sty.txt", "cls", "clo", "bst", "bbx", "cbx", "lbx"],
            ),
            (GlyphKind::Bib, &["bib", "bbl", "bcf", "blg"]),
            (GlyphKind::Markdown, &["md", "markdown", "mdx"]),
            (GlyphKind::Pdf, &["pdf"]),
            (
                GlyphKind::Image,
                &[
                    "png", "jpg", "jpeg", "gif", "svg", "eps", "webp", "tif", "tiff",
                ],
            ),
            (GlyphKind::Board, &["tldr"]),
            (GlyphKind::Sheet, &["lattice-sheet", "csv", "tsv", "xlsx"]),
            (
                GlyphKind::Code,
                &[
                    "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "py", "r", "jl", "sh", "css",
                ],
            ),
            (
                GlyphKind::Config,
                &["json", "toml", "yaml", "yml", "ini", "cfg", "xml", "lock"],
            ),
        ];
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let lower = name.to_lowercase();
        let segments: Vec<&str> = lower.split('.').collect();
        for start in 1..segments.len() {
            let extension = segments[start..].join(".");
            for (kind, extensions) in KINDS {
                if extensions.contains(&extension.as_str()) {
                    return *kind;
                }
            }
        }
        GlyphKind::Text
    }

    fn token(self) -> Option<ColorToken> {
        Some(match self {
            GlyphKind::Tex => COLOR_GLYPH_TEX,
            GlyphKind::Style => COLOR_GLYPH_STYLE,
            GlyphKind::Bib => COLOR_GLYPH_BIB,
            GlyphKind::Markdown => COLOR_GLYPH_MARKDOWN,
            GlyphKind::Pdf => COLOR_GLYPH_PDF,
            GlyphKind::Image => COLOR_GLYPH_IMAGE,
            GlyphKind::Board => COLOR_GLYPH_BOARD,
            GlyphKind::Sheet => COLOR_GLYPH_SHEET,
            GlyphKind::Slides => COLOR_GLYPH_SLIDES,
            GlyphKind::Code => COLOR_GLYPH_CODE,
            GlyphKind::Config => COLOR_GLYPH_CONFIG,
            GlyphKind::Folder => COLOR_GLYPH_FOLDER,
            GlyphKind::Text => return None,
        })
    }
}

/// The resolved colours. Fields hold what is painted; `*_srgb` fields keep
/// the opaque surfaces as sRGB so other colours can be laid over them.
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub appearance: Appearance,
    pub tint: Tint,
    pub accent_preset: Accent,

    // Surfaces.
    pub window: Hsla,
    pub chrome: Hsla,
    pub titlebar: Hsla,
    pub panel: Hsla,
    pub raised: Hsla,
    pub input: Hsla,
    pub editor: Hsla,
    pub pdf_ground: Hsla,
    pub pdf_page: Hsla,

    // Inks.
    pub text: Hsla,
    pub text_secondary: Hsla,
    pub nav_text_strong: Hsla,
    pub line_number: Hsla,

    // Lines and edges.
    pub line: Hsla,
    pub line_strong: Hsla,
    /// A docked panel's 1px edge: the hairline at 70%.
    pub panel_ring: Hsla,
    /// A floating surface's 1px edge.
    pub ring: Hsla,
    pub field_border: Hsla,
    pub field_border_hover: Hsla,
    pub control_hover_border: Hsla,
    pub control_active_border: Hsla,

    // Accent.
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub accent_contrast: Hsla,
    pub focus: Hsla,
    pub tinted: Hsla,
    pub tinted_hover: Hsla,
    pub tinted_pressed: Hsla,
    pub toolbar_active: Hsla,
    pub primary_hover: Hsla,
    pub primary_pressed: Hsla,

    // States.
    pub hover: Hsla,
    pub pressed: Hsla,
    pub chrome_hover: Hsla,
    pub row_selected: Hsla,
    pub selection: Hsla,
    pub current_line: Hsla,
    pub settings_control_hover: Hsla,
    pub disabled_surface: Hsla,
    pub disabled_border: Hsla,
    pub disabled_ink: Hsla,

    // Status.
    pub danger: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub info: Hsla,
    pub annotation: Hsla,
    pub danger_soft: Hsla,
    pub danger_soft_hover: Hsla,
    pub danger_soft_pressed: Hsla,
    pub success_soft: Hsla,
    pub warning_soft: Hsla,
    pub annotation_highlight: Hsla,

    // Overlays and marks.
    pub scrim: Hsla,
    pub drop_target: Hsla,
    pub search_match: Hsla,
    pub search_match_current: Hsla,
    pub brand_weft: Hsla,
    pub brand_warp: Hsla,

    pub window_srgb: Srgb,
    pub chrome_srgb: Srgb,
    pub panel_srgb: Srgb,
    pub editor_srgb: Srgb,
    pub raised_srgb: Srgb,
    text_srgb: Srgb,
}

const WHITE: Srgb = hex(0xFFFFFF);

impl Palette {
    pub fn new(appearance: Appearance, tint: Tint, accent_preset: Accent) -> Self {
        let get = |token: ColorToken| token.get(appearance);
        let paint = |token: ColorToken| token.hsla(appearance);
        let dark = appearance == Appearance::Dark;

        let [window, chrome, panel, raised] = match tint.surfaces() {
            Some(surfaces) => surfaces.map(get),
            None => [
                get(COLOR_WINDOW),
                get(COLOR_CHROME),
                get(COLOR_PANEL),
                get(COLOR_RAISED),
            ],
        };
        // The editor and fields: Graphite's own tokens, or the tint's lift in
        // light and its panel in dark (theme.css `--side-surface`).
        let editor = match (tint, appearance) {
            (Tint::Graphite, _) => get(COLOR_EDITOR),
            (_, Appearance::Light) => raised,
            (_, Appearance::Dark) => panel,
        };
        let input = match tint {
            Tint::Graphite => get(COLOR_INPUT),
            _ => editor,
        };
        let titlebar = chrome.mix(WHITE, if dark { 0.035 } else { 0.45 });
        // The PDF ground: the chrome in light; in dark the window mixed 16%
        // toward mid grey (theme.css `--pdf-bg`).
        let pdf_ground = if dark {
            window.mix(hex(0x888888), 0.16)
        } else {
            chrome
        };

        let text = get(COLOR_TEXT);
        let accent_srgb = get(accent_preset.token());
        let graphite = accent_preset == Accent::Graphite;
        let accent_soft = if graphite {
            paint(COLOR_ACCENT_SOFT)
        } else {
            accent_srgb.alpha(if dark { 0.14 } else { 0.10 })
        };
        let focus = if graphite {
            paint(COLOR_FOCUS)
        } else {
            accent_srgb.hsla()
        };
        let line = get(COLOR_LINE);

        Self {
            appearance,
            tint,
            accent_preset,

            window: window.hsla(),
            chrome: chrome.hsla(),
            titlebar: titlebar.hsla(),
            panel: panel.hsla(),
            raised: raised.hsla(),
            input: input.hsla(),
            editor: editor.hsla(),
            pdf_ground: pdf_ground.hsla(),
            pdf_page: paint(COLOR_PDF_PAGE),

            text: text.hsla(),
            text_secondary: paint(COLOR_TEXT_SECONDARY),
            nav_text_strong: paint(COLOR_NAV_TEXT_STRONG),
            line_number: paint(COLOR_LINE_NUMBER),

            line: line.hsla(),
            line_strong: paint(COLOR_LINE_STRONG),
            panel_ring: line.alpha(0.7),
            ring: paint(COLOR_RING),
            field_border: paint(COLOR_FIELD_BORDER),
            field_border_hover: paint(COLOR_FIELD_BORDER_HOVER),
            control_hover_border: paint(COLOR_CONTROL_HOVER_BORDER),
            control_active_border: paint(COLOR_CONTROL_ACTIVE_BORDER),

            accent: accent_srgb.hsla(),
            accent_soft,
            accent_contrast: paint(COLOR_ACCENT_CONTRAST),
            focus,
            tinted: accent_srgb.alpha(0.12),
            tinted_hover: accent_srgb.alpha(0.18),
            tinted_pressed: accent_srgb.alpha(0.24),
            toolbar_active: accent_srgb.alpha(0.14),
            primary_hover: paint(COLOR_PRIMARY_HOVER),
            primary_pressed: paint(COLOR_PRIMARY_PRESSED),

            hover: paint(COLOR_HOVER),
            pressed: paint(COLOR_PRESSED),
            chrome_hover: paint(COLOR_CHROME_HOVER),
            row_selected: paint(COLOR_ROW_SELECTED),
            selection: paint(COLOR_SELECTION),
            current_line: paint(COLOR_CURRENT_LINE),
            settings_control_hover: paint(COLOR_SETTINGS_CONTROL_HOVER),
            disabled_surface: paint(COLOR_DISABLED_SURFACE),
            disabled_border: paint(COLOR_DISABLED_BORDER),
            disabled_ink: paint(COLOR_DISABLED_INK),

            danger: paint(COLOR_DANGER),
            success: paint(COLOR_SUCCESS),
            warning: paint(COLOR_WARNING),
            info: paint(COLOR_INFO),
            annotation: paint(COLOR_ANNOTATION),
            danger_soft: paint(COLOR_DANGER_SOFT),
            danger_soft_hover: paint(COLOR_DANGER_SOFT_HOVER),
            danger_soft_pressed: paint(COLOR_DANGER_SOFT_PRESSED),
            success_soft: paint(COLOR_SUCCESS_SOFT),
            warning_soft: paint(COLOR_WARNING_SOFT),
            annotation_highlight: paint(COLOR_ANNOTATION_HIGHLIGHT),

            scrim: paint(COLOR_SCRIM),
            drop_target: paint(COLOR_DROP_TARGET),
            search_match: paint(COLOR_MATCH),
            search_match_current: paint(COLOR_MATCH_CURRENT),
            brand_weft: paint(COLOR_BRAND_WEFT),
            brand_warp: paint(COLOR_BRAND_WARP),

            window_srgb: window,
            chrome_srgb: chrome,
            panel_srgb: panel,
            editor_srgb: editor,
            raised_srgb: raised,
            text_srgb: text,
        }
    }

    pub fn is_dark(&self) -> bool {
        self.appearance == Appearance::Dark
    }

    /// Any colour token in this appearance, for roles the palette does not
    /// name (syntax colours, accent swatches).
    pub fn token(&self, token: ColorToken) -> Hsla {
        token.hsla(self.appearance)
    }

    /// A selected panel tab on `surface`: the ink at 10%
    /// (`--opacity-tab-selected`), laid opaque.
    pub fn tab_selected_on(&self, surface: Srgb) -> Hsla {
        self.ink_on(OPACITY_TAB_SELECTED, surface)
    }

    /// The ink at `alpha` laid opaque on `surface`: a state wash that keeps
    /// its exact colour wherever it is drawn over other content.
    pub fn ink_on(&self, alpha: f32, surface: Srgb) -> Hsla {
        Srgb {
            a: alpha,
            ..self.text_srgb
        }
        .over(surface)
        .hsla()
    }

    /// A file glyph's stroke, and the tint its body is filled with: 16% of
    /// the hue in light, 20% in dark (18% for a folder in the tree).
    pub fn glyph(&self, kind: GlyphKind) -> (Hsla, Hsla) {
        let hue = match kind.token() {
            Some(token) => token.get(self.appearance),
            None => COLOR_TEXT_SECONDARY.get(self.appearance),
        };
        let tint = match (kind, self.appearance) {
            (GlyphKind::Folder, _) => 0.18,
            (_, Appearance::Light) => 0.16,
            (_, Appearance::Dark) => 0.20,
        };
        (hue.hsla(), hue.alpha(tint))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_of(color: Hsla) -> String {
        let rgba = gpui::Rgba::from(color);
        format!(
            "#{:02X}{:02X}{:02X}",
            (rgba.r * 255.).round() as u8,
            (rgba.g * 255.).round() as u8,
            (rgba.b * 255.).round() as u8
        )
    }

    #[test]
    fn the_titlebar_veil_reproduces_the_titlebar_token() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let palette = Palette::new(appearance, Tint::Graphite, Accent::Graphite);
            assert_eq!(
                hex_of(palette.titlebar),
                hex_of(COLOR_TITLEBAR.hsla(appearance)),
                "{appearance:?}"
            );
        }
    }

    #[test]
    fn a_selected_tab_matches_the_running_app_on_both_surfaces() {
        let light = Palette::new(Appearance::Light, Tint::Graphite, Accent::Graphite);
        // The editor's sheet: the token.
        assert_eq!(
            hex_of(light.tab_selected_on(light.editor_srgb)),
            hex_of(COLOR_TAB_SELECTED.light.hsla())
        );
        // The chrome-coloured Project panel: what Paper measured on the
        // running app's Main window.
        assert_eq!(hex_of(light.tab_selected_on(light.chrome_srgb)), "#DBDBDC");
        let dark = Palette::new(Appearance::Dark, Tint::Graphite, Accent::Graphite);
        assert_eq!(
            hex_of(dark.tab_selected_on(dark.panel_srgb)),
            hex_of(COLOR_TAB_SELECTED.dark.hsla())
        );
    }

    #[test]
    fn the_dark_pdf_ground_matches_its_token() {
        let dark = Palette::new(Appearance::Dark, Tint::Graphite, Accent::Graphite);
        assert_eq!(
            hex_of(dark.pdf_ground),
            hex_of(COLOR_PDF_GROUND.dark.hsla())
        );
    }

    #[test]
    fn a_preset_accent_becomes_the_focus_ring() {
        let graphite = Palette::new(Appearance::Light, Tint::Graphite, Accent::Graphite);
        assert_eq!(graphite.focus, COLOR_FOCUS.light.hsla());
        let teal = Palette::new(Appearance::Light, Tint::Graphite, Accent::Teal);
        assert_eq!(teal.focus, COLOR_ACCENT_TEAL.light.hsla());
        assert_eq!(teal.accent, COLOR_ACCENT_TEAL.light.hsla());
    }

    #[test]
    fn a_tint_moves_the_surfaces_and_leaves_the_inks() {
        let paper = Palette::new(Appearance::Light, Tint::Paper, Accent::Graphite);
        let graphite = Palette::new(Appearance::Light, Tint::Graphite, Accent::Graphite);
        assert_eq!(paper.chrome, COLOR_TINT_PAPER_CHROME.light.hsla());
        assert_eq!(paper.editor, COLOR_TINT_PAPER_RAISED.light.hsla());
        assert_eq!(paper.text, graphite.text);
        assert_eq!(paper.line, graphite.line);
    }

    #[test]
    fn file_kinds_resolve_by_their_longest_extension() {
        assert_eq!(GlyphKind::for_name("main.tex"), GlyphKind::Tex);
        assert_eq!(GlyphKind::for_name("main.synctex.gz"), GlyphKind::Tex);
        assert_eq!(
            GlyphKind::for_name("attention-results.lattice-sheet"),
            GlyphKind::Sheet
        );
        assert_eq!(GlyphKind::for_name("project.toml"), GlyphKind::Config);
        assert_eq!(GlyphKind::for_name("README"), GlyphKind::Text);
        assert_eq!(GlyphKind::for_name("dir/Figure.PNG"), GlyphKind::Image);
    }
}
