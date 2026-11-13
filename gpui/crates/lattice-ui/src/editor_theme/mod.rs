//! The source editor's code themes, as Zed theme families.
//!
//! Zed's editor draws from a Zed theme (its own JSON schema, loaded into
//! Zed's theme registry by the app). Lattice's code themes
//! (`src/settings/code-themes.ts`) each carry their own token colours, and
//! every one of them is a family here with a theme for a light app and one
//! for a dark app. A variant in the app's own appearance draws on the
//! window's editor surface, so the editor, its tab and the panels beside it
//! read as one sheet: its ground is the Lattice palette's `editor`, and its
//! current line and selection the theme's colours at their alpha over it. A
//! theme with one variant (Dracula, Nord) stays as chosen in the other
//! appearance, a dark editor in a light app, and keeps its own ground, line
//! and selection. Either way the chrome Zed draws around the buffer (its
//! toolbar and search bar) comes from the Lattice palette, and the ink,
//! caret, gutter numbers and syntax from the code theme, fitted by the app
//! to the ground they stand on ([`CodeThemeSource`]).
//!
//! The syntax captures are the ones the LaTeX query writes, named for
//! Lattice's token roles: commands are `keyword`, sectioning and title
//! commands `function`, environment names `type`, maths `variable`, paths
//! `string`, key-value keys `property`, label and reference keys `label`,
//! citation keys `citation`.

pub mod code_palette;
#[cfg(test)]
mod tests;

use gpui::Hsla;
use serde_json::{Map, Value, json};

pub use code_palette::{CodeGround, CodeSyntax, CodeThemeSource, CodeVariant};

use crate::{Accent, Appearance, Palette, Tint, kit::hex, tokens::*};
use code_palette::CodePalette;

/// The code themes of Settings › Appearance, in its order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CodeTheme {
    #[default]
    Github,
    /// Lattice's own palette.
    WeftAndWarp,
    One,
    Solarized,
    Catppuccin,
    TokyoNight,
    Dracula,
    Nord,
    Monokai,
}

impl CodeTheme {
    pub const ALL: [CodeTheme; 9] = [
        CodeTheme::Github,
        CodeTheme::WeftAndWarp,
        CodeTheme::One,
        CodeTheme::Solarized,
        CodeTheme::Catppuccin,
        CodeTheme::TokyoNight,
        CodeTheme::Dracula,
        CodeTheme::Nord,
        CodeTheme::Monokai,
    ];

    /// The theme's colours as the app computes them, or `None` for Weft &
    /// Warp, whose colours are the Lattice palette's.
    pub fn source(self) -> Option<&'static CodeThemeSource> {
        Some(match self {
            CodeTheme::Github => &CODE_THEME_GITHUB,
            CodeTheme::WeftAndWarp => return None,
            CodeTheme::One => &CODE_THEME_ONE,
            CodeTheme::Solarized => &CODE_THEME_SOLARIZED,
            CodeTheme::Catppuccin => &CODE_THEME_CATPPUCCIN,
            CodeTheme::TokyoNight => &CODE_THEME_TOKYO_NIGHT,
            CodeTheme::Dracula => &CODE_THEME_DRACULA,
            CodeTheme::Nord => &CODE_THEME_NORD,
            CodeTheme::Monokai => &CODE_THEME_MONOKAI,
        })
    }

    /// The theme's id in the app's settings (`github`, `lattice`).
    pub fn id(self) -> &'static str {
        self.source().map_or("lattice", |source| source.id)
    }

    pub fn label(self) -> &'static str {
        self.source().map_or("Weft & Warp", |source| source.name)
    }

    /// The Zed theme's name for this code theme while the app is
    /// `appearance`.
    pub fn zed_theme_name(self, appearance: Appearance) -> String {
        format!(
            "Lattice {} {}",
            self.label(),
            match appearance {
                Appearance::Light => "Light",
                Appearance::Dark => "Dark",
            }
        )
    }
}

/// The ground `theme` draws the editor on in an app painted with `palette`:
/// the window's editor sheet, or the theme's own in the other appearance.
pub fn ground(theme: CodeTheme, palette: &Palette) -> Hsla {
    CodePalette::new(theme, palette).ground
}

/// The current line's wash in `theme`, over [`ground`].
pub fn current_line(theme: CodeTheme, palette: &Palette) -> Hsla {
    CodePalette::new(theme, palette).line
}

/// A code theme's colours for Settings' preview card, in one of its
/// variants (`codeThemeProperties`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodePreview {
    pub kind: Appearance,
    pub ground: gpui::Hsla,
    pub ink: gpui::Hsla,
    pub syntax: code_palette::CodeSyntax<gpui::Hsla>,
}

impl CodeTheme {
    /// The appearances the theme comes in: both, or only dark.
    pub fn kinds(self) -> Vec<Appearance> {
        match self.source() {
            None => vec![Appearance::Light, Appearance::Dark],
            Some(source) => {
                let mut kinds = vec![source.light_app.kind];
                if source.dark_app.kind != source.light_app.kind {
                    kinds.push(source.dark_app.kind);
                }
                kinds
            }
        }
    }

    /// The theme as it is drawn in an app of appearance `kind`, tinted
    /// `tint` (Weft & Warp's colours are the app's own).
    pub fn preview(self, kind: Appearance, tint: Tint, accent: Accent) -> CodePreview {
        let palette = Palette::new(kind, tint, accent);
        let code = CodePalette::new(self, &palette);
        CodePreview {
            kind: code.kind,
            ground: code.ground,
            ink: code.ink,
            syntax: code.syntax,
        }
    }
}

/// One Zed theme family per code theme, holding its light-app and dark-app
/// themes, as the bytes `theme_settings::load_user_theme` reads.
pub fn zed_theme_families(tint: Tint, accent: Accent) -> Vec<Vec<u8>> {
    let palettes = [Appearance::Light, Appearance::Dark]
        .map(|appearance| Palette::new(appearance, tint, accent));
    CodeTheme::ALL
        .into_iter()
        .map(|theme| {
            let themes: Vec<Value> = palettes
                .iter()
                .map(|palette| zed_theme(theme, palette))
                .collect();
            let family = json!({
                "name": format!("Lattice {}", theme.label()),
                "author": "Lattice",
                "themes": themes,
            });
            serde_json::to_vec(&family).expect("a theme family serializes")
        })
        .collect()
}

/// The Zed theme for `theme` in an app painted with `p`. Its `appearance`
/// is the app's, the chrome's: a dark variant on its own ground in a light
/// app is still a light theme to Zed, with every editor colour set here.
fn zed_theme(theme: CodeTheme, p: &Palette) -> Value {
    let code = CodePalette::new(theme, p);
    // The washes laid over the buffer (indent guides, highlights, search
    // hits, the scrollbar) are the Lattice palette's for the ground's
    // appearance, so a dark ground in a light app takes the dark ones.
    let own_kind;
    let w = if code.kind == p.appearance {
        p
    } else {
        own_kind = Palette::new(code.kind, p.tint, p.accent_preset);
        &own_kind
    };
    let transparent = "#00000000";
    let text_12 = Hsla {
        a: w.text.a * 0.12,
        ..w.text
    };
    let text_16 = Hsla {
        a: w.text.a * 0.16,
        ..w.text
    };
    let style = json!({
        "background": hex(p.editor),
        "surface.background": hex(p.editor),
        "elevated_surface.background": hex(p.raised),
        "panel.background": hex(p.editor),
        "toolbar.background": hex(p.editor),
        "tab_bar.background": hex(p.editor),
        "status_bar.background": hex(p.editor),
        "title_bar.background": hex(p.titlebar),
        "border": hex(p.line),
        "border.variant": hex(p.line),
        "border.focused": hex(p.focus),
        "border.selected": hex(p.focus),
        "border.transparent": transparent,
        "border.disabled": hex(p.disabled_border),
        "element.background": hex(p.input),
        "element.hover": hex(p.hover),
        "element.active": hex(p.pressed),
        "element.selected": hex(p.row_selected),
        "element.disabled": hex(p.disabled_surface),
        "ghost_element.background": transparent,
        "ghost_element.hover": hex(p.hover),
        "ghost_element.active": hex(p.pressed),
        "ghost_element.selected": hex(p.row_selected),
        "ghost_element.disabled": hex(p.disabled_surface),
        "drop_target.background": hex(p.drop_target),
        "text": hex(p.text),
        "text.muted": hex(p.text_secondary),
        "text.placeholder": hex(p.text_secondary),
        "text.disabled": hex(p.disabled_ink),
        "text.accent": hex(p.accent),
        "icon": hex(p.text_secondary),
        "icon.muted": hex(p.text_secondary),
        "icon.disabled": hex(p.disabled_ink),
        "icon.placeholder": hex(p.text_secondary),
        "icon.accent": hex(p.accent),
        "link_text.hover": hex(p.accent),

        // The ground and the current line are painted under Zed's editor
        // by the adapter (`lattice-editor`, [`ground`] and [`current_line`]):
        // Zed draws its active line from edge to edge, where the app's is a
        // rounded wash inset from the right, so the editor itself is clear.
        "editor.background": transparent,
        "editor.foreground": hex(code.ink),
        "editor.gutter.background": transparent,
        "editor.subheader.background": hex(code.ground),
        "editor.line_number": hex(code.line_number),
        "editor.active_line_number": hex(code.ink),
        "editor.hover_line_number": hex(code.ink),
        "editor.active_line.background": transparent,
        "editor.highlighted_line.background": hex(code.line),
        "editor.document_highlight.read_background": hex(w.hover),
        "editor.document_highlight.write_background": hex(w.pressed),
        "editor.invisible": hex(code.line_number),
        "editor.wrap_guide": transparent,
        "editor.active_wrap_guide": transparent,
        "editor.indent_guide": hex(w.line),
        "editor.indent_guide_active": hex(w.line_strong),

        "scrollbar.thumb.background": hex(text_12),
        "scrollbar.thumb.hover_background": hex(text_16),
        "scrollbar.thumb.active_background": hex(text_16),
        "scrollbar.thumb.border": transparent,
        "scrollbar.track.background": transparent,
        "scrollbar.track.border": transparent,
        "search.match_background": hex(w.search_match),
        "search.active_match_background": hex(w.search_match_current),

        "error": hex(p.danger),
        "error.background": hex(p.danger_soft),
        "error.border": hex(p.danger),
        "warning": hex(p.warning),
        "warning.background": hex(p.warning_soft),
        "warning.border": hex(p.warning),
        "success": hex(p.success),
        "success.background": hex(p.success_soft),
        "success.border": hex(p.success),
        "info": hex(p.info),
        "info.background": hex(p.accent_soft),
        "info.border": hex(p.info),
        "hint": hex(p.text_secondary),
        "hint.background": hex(p.hover),
        "hint.border": hex(p.line),

        "players": [{
            "cursor": hex(code.caret),
            "background": hex(code.caret),
            "selection": hex(code.selection),
        }],
        "syntax": syntax(&code),
    });
    json!({
        "name": theme.zed_theme_name(p.appearance),
        "appearance": match p.appearance {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        },
        "style": style,
    })
}

fn syntax(code: &CodePalette) -> Value {
    let mut map = Map::new();
    let mut set = |name: &str, color: Hsla, weight: Option<u16>, italic: bool| {
        map.insert(
            name.into(),
            json!({
                "color": hex(color),
                "font_weight": weight,
                "font_style": if italic { Some("italic") } else { None },
            }),
        );
    };
    let s = &code.syntax;
    // The app sets commands and sectioning at medium weight
    // (`src/editor/latex/latex-editor.ts`), comments and keys in italic.
    set("keyword", s.keyword, Some(500), false);
    set("function", s.function, Some(500), false);
    set("title", s.function, Some(500), false);
    set("type", s.type_, None, false);
    set("variable", s.variable, None, false);
    set("variable.special", s.variable_special, None, false);
    set("string", s.string, None, false);
    set("string.special", s.variable, None, false);
    set("comment", s.comment, None, true);
    set("comment.doc", s.comment_doc, None, true);
    set("number", s.number, None, false);
    set("constant", s.constant, None, false);
    set("operator", s.operator, None, false);
    set("property", s.property, None, false);
    set("attribute", s.attribute, None, false);
    set("label", s.reference, None, true);
    set("citation", s.citation, None, false);
    set("punctuation", s.bracket, None, false);
    set("punctuation.bracket", s.bracket, None, false);
    set("emphasis", code.ink, None, true);
    set("emphasis.strong", code.ink, Some(700), false);
    Value::Object(map)
}
