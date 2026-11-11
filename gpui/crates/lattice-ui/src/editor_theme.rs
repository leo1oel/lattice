//! The source editor's code themes, as Zed theme families.
//!
//! Zed's editor draws from a Zed theme (its own JSON schema, loaded into
//! Zed's theme registry by the app). Lattice's code themes
//! (`src/settings/code-themes.ts`) each carry their own token colours; a
//! variant in the app's own appearance draws on the window's editor surface,
//! so the editor, its tab and the panels beside it read as one sheet. That is
//! the rule here: the ground, current line, selection and the chrome Zed draws
//! around the buffer (its search bar, scrollbar) come from the Lattice
//! palette, and the ink, caret, gutter numbers and syntax from the code theme.
//!
//! The syntax captures are the ones the LaTeX query writes, named for
//! Lattice's token roles: commands are `keyword`, sectioning and title
//! commands `function`, environment names `type`, maths `variable`, paths
//! `string`, label and reference keys `label`, citation keys `citation`.

use gpui::Hsla;
use serde_json::{Map, Value, json};

use crate::{Accent, Appearance, Palette, Tint, kit::hex, token_types::ColorToken, tokens::*};

/// The code themes ported so far: GitHub, the default, and Weft & Warp,
/// Lattice's own palette.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CodeTheme {
    #[default]
    Github,
    WeftAndWarp,
}

impl CodeTheme {
    pub fn label(self) -> &'static str {
        match self {
            CodeTheme::Github => "GitHub",
            CodeTheme::WeftAndWarp => "Weft & Warp",
        }
    }

    /// The Zed theme's name for one appearance of this code theme.
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

/// The colours one code theme paints a buffer with.
struct CodePalette {
    ink: Hsla,
    line_number: Hsla,
    caret: Hsla,
    keyword: Hsla,
    operator: Hsla,
    function: Hsla,
    type_: Hsla,
    variable: Hsla,
    string: Hsla,
    comment: Hsla,
    number: Hsla,
    citation: Hsla,
    reference: Hsla,
    bracket: Hsla,
}

impl CodePalette {
    fn new(theme: CodeTheme, palette: &Palette) -> Self {
        let get = |token: ColorToken| palette.token(token);
        match theme {
            CodeTheme::Github => Self {
                ink: get(COLOR_SYNTAX_GITHUB_INK),
                line_number: get(COLOR_SYNTAX_GITHUB_LINE_NUMBER),
                caret: get(COLOR_SYNTAX_GITHUB_CARET),
                keyword: get(COLOR_SYNTAX_GITHUB_KEYWORD),
                operator: get(COLOR_SYNTAX_GITHUB_OPERATOR),
                function: get(COLOR_SYNTAX_GITHUB_FUNCTION),
                type_: get(COLOR_SYNTAX_GITHUB_TYPE),
                variable: get(COLOR_SYNTAX_GITHUB_VARIABLE),
                string: get(COLOR_SYNTAX_GITHUB_STRING),
                comment: get(COLOR_SYNTAX_GITHUB_COMMENT),
                number: get(COLOR_SYNTAX_GITHUB_NUMBER),
                citation: get(COLOR_SYNTAX_GITHUB_CITATION),
                reference: get(COLOR_SYNTAX_GITHUB_REFERENCE),
                bracket: get(COLOR_SYNTAX_GITHUB_INK),
            },
            CodeTheme::WeftAndWarp => Self {
                ink: palette.text,
                line_number: palette.line_number,
                caret: palette.text,
                keyword: get(COLOR_SYNTAX_KEYWORD),
                operator: get(COLOR_SYNTAX_OPERATOR),
                function: get(COLOR_SYNTAX_FUNCTION),
                type_: get(COLOR_SYNTAX_TYPE),
                variable: get(COLOR_SYNTAX_VARIABLE),
                string: get(COLOR_SYNTAX_STRING),
                comment: get(COLOR_SYNTAX_COMMENT),
                number: get(COLOR_SYNTAX_NUMBER),
                citation: get(COLOR_SYNTAX_CITATION),
                reference: get(COLOR_SYNTAX_REFERENCE),
                bracket: palette.text_secondary,
            },
        }
    }
}

/// One Zed theme family per code theme, holding its light and dark themes,
/// as the bytes `theme_settings::load_user_theme` reads.
pub fn zed_theme_families(tint: Tint, accent: Accent) -> Vec<Vec<u8>> {
    [CodeTheme::Github, CodeTheme::WeftAndWarp]
        .into_iter()
        .map(|theme| {
            let themes: Vec<Value> = [Appearance::Light, Appearance::Dark]
                .into_iter()
                .map(|appearance| zed_theme(theme, &Palette::new(appearance, tint, accent)))
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

fn zed_theme(theme: CodeTheme, p: &Palette) -> Value {
    let code = CodePalette::new(theme, p);
    let transparent = "#00000000";
    let text_12 = Hsla {
        a: p.text.a * 0.12,
        ..p.text
    };
    let text_16 = Hsla {
        a: p.text.a * 0.16,
        ..p.text
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

        "editor.background": hex(p.editor),
        "editor.foreground": hex(code.ink),
        "editor.gutter.background": hex(p.editor),
        "editor.subheader.background": hex(p.editor),
        "editor.line_number": hex(code.line_number),
        "editor.active_line_number": hex(code.ink),
        "editor.hover_line_number": hex(code.ink),
        "editor.active_line.background": hex(p.current_line),
        "editor.highlighted_line.background": hex(p.current_line),
        "editor.document_highlight.read_background": hex(p.hover),
        "editor.document_highlight.write_background": hex(p.pressed),
        "editor.invisible": hex(code.line_number),
        "editor.wrap_guide": transparent,
        "editor.active_wrap_guide": transparent,
        "editor.indent_guide": hex(p.line),
        "editor.indent_guide_active": hex(p.line_strong),

        "scrollbar.thumb.background": hex(text_12),
        "scrollbar.thumb.hover_background": hex(text_16),
        "scrollbar.thumb.active_background": hex(text_16),
        "scrollbar.thumb.border": transparent,
        "scrollbar.track.background": transparent,
        "scrollbar.track.border": transparent,
        "search.match_background": hex(p.search_match),
        "search.active_match_background": hex(p.search_match_current),

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
            "selection": hex(p.selection),
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
    // The app sets commands and sectioning at medium weight
    // (`src/editor/latex/latex-editor.ts`), comments and keys in italic.
    set("keyword", code.keyword, Some(500), false);
    set("function", code.function, Some(500), false);
    set("title", code.function, Some(500), false);
    set("type", code.type_, None, false);
    set("variable", code.variable, None, false);
    set("variable.special", code.variable, None, false);
    set("string", code.string, None, false);
    set("string.special", code.variable, None, false);
    set("comment", code.comment, None, true);
    set("comment.doc", code.comment, None, true);
    set("number", code.number, None, false);
    set("constant", code.number, None, false);
    set("operator", code.operator, None, false);
    set("property", code.variable, None, false);
    set("attribute", code.variable, None, false);
    set("label", code.reference, None, true);
    set("citation", code.citation, None, false);
    set("punctuation", code.bracket, None, false);
    set("punctuation.bracket", code.bracket, None, false);
    set("emphasis", code.ink, None, true);
    set("emphasis.strong", code.ink, Some(700), false);
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_family_holds_both_appearances_by_name() {
        let families = zed_theme_families(Tint::Graphite, Accent::Graphite);
        assert_eq!(families.len(), 2);
        let github: Value = serde_json::from_slice(&families[0]).unwrap();
        let names: Vec<&str> = github["themes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|theme| theme["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                CodeTheme::Github.zed_theme_name(Appearance::Light),
                CodeTheme::Github.zed_theme_name(Appearance::Dark)
            ]
        );
    }

    #[test]
    fn the_editor_stands_on_the_lattice_sheet() {
        let palette = Palette::new(Appearance::Light, Tint::Sage, Accent::Graphite);
        let theme = zed_theme(CodeTheme::Github, &palette);
        assert_eq!(theme["style"]["editor.background"], hex(palette.editor));
        assert_eq!(
            theme["style"]["syntax"]["keyword"]["color"],
            hex(COLOR_SYNTAX_GITHUB_KEYWORD.light.hsla())
        );
    }
}
