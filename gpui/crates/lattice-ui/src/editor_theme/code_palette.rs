//! What one code theme paints a buffer with: the generated sources, and the
//! colours they resolve to for the app's appearance and palette.

use gpui::Hsla;

use super::CodeTheme;
use crate::{
    Appearance, Palette,
    token_types::{ColorToken, Srgb},
    tokens::*,
};

/// One code theme as `src/settings/code-themes.ts` paints it in a light app
/// and in a dark app. The values are generated into [`crate::tokens`]
/// (`CODE_THEME_GITHUB` and the rest) from `design-system/code-themes.json`,
/// the app's own `codeThemeProperties`, so every colour is already fitted to
/// 4.5:1 (3:1 for the caret and line numbers) on the ground it stands on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodeThemeSource {
    /// The theme's id in the app's settings: `github`, `tokyo-night`.
    pub id: &'static str,
    /// The theme's proper name, as Settings shows it.
    pub name: &'static str,
    pub light_app: CodeVariant,
    pub dark_app: CodeVariant,
}

impl CodeThemeSource {
    /// The variant the editor shows while the app is `app`.
    pub fn in_app(&self, app: Appearance) -> &CodeVariant {
        match app {
            Appearance::Light => &self.light_app,
            Appearance::Dark => &self.dark_app,
        }
    }
}

/// Where a variant draws: the window's editor ground (the palette's
/// `editor`), or a ground of its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CodeGround {
    Window,
    Own(Srgb),
}

/// One variant of a code theme, in one app appearance.
///
/// A variant in the app's own appearance stands on the window's editor
/// ground, so its current line and selections are a colour at an alpha:
/// CSS mixes them into `--editor-bg`, and Zed lays them over
/// `editor.background`, which comes to the same colour. A variant shown in
/// the other appearance (a dark-only theme in a light app) keeps its own
/// ground, and all of its colours are opaque.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodeVariant {
    /// Which of the theme's palettes this is: the app's appearance when the
    /// theme has it, else the one it has.
    pub kind: Appearance,
    pub ground: CodeGround,
    pub ink: Srgb,
    /// Gutter numbers at a UI mark's 3:1.
    pub line_number: Srgb,
    /// Gutter numbers at text's 4.5:1, for the More Contrast setting.
    pub line_number_contrast: Srgb,
    pub caret: Srgb,
    /// The current line: the theme's ink at 5%.
    pub line: Srgb,
    pub selection_focused: Srgb,
    /// The selection of an editor without focus, at 60% of the focused one.
    pub selection: Srgb,
    pub syntax: CodeSyntax,
}

/// A colour per token role, one `--syntax-*` property each in the app.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodeSyntax<C = Srgb> {
    pub keyword: C,
    pub operator: C,
    pub function: C,
    pub type_: C,
    pub variable: C,
    pub variable_special: C,
    pub property: C,
    pub attribute: C,
    pub string: C,
    pub comment: C,
    pub comment_doc: C,
    pub number: C,
    pub constant: C,
    pub bracket: C,
    pub citation: C,
    pub reference: C,
}

impl CodeSyntax {
    fn hsla(&self) -> CodeSyntax<Hsla> {
        CodeSyntax {
            keyword: self.keyword.hsla(),
            operator: self.operator.hsla(),
            function: self.function.hsla(),
            type_: self.type_.hsla(),
            variable: self.variable.hsla(),
            variable_special: self.variable_special.hsla(),
            property: self.property.hsla(),
            attribute: self.attribute.hsla(),
            string: self.string.hsla(),
            comment: self.comment.hsla(),
            comment_doc: self.comment_doc.hsla(),
            number: self.number.hsla(),
            constant: self.constant.hsla(),
            bracket: self.bracket.hsla(),
            citation: self.citation.hsla(),
            reference: self.reference.hsla(),
        }
    }
}

/// The colours one code theme paints a buffer with in the app's palette.
pub(super) struct CodePalette {
    /// Which appearance the ground is: the app's on the window, the
    /// variant's own otherwise.
    pub kind: Appearance,
    pub ground: Hsla,
    pub ink: Hsla,
    pub line_number: Hsla,
    /// The fold markers' and fold placeholders' ink, a step above the
    /// numbers.
    pub line_number_contrast: Hsla,
    pub caret: Hsla,
    pub line: Hsla,
    pub selection: Hsla,
    pub syntax: CodeSyntax<Hsla>,
}

impl CodePalette {
    pub fn new(theme: CodeTheme, palette: &Palette) -> Self {
        let Some(source) = theme.source() else {
            return Self::weft_and_warp(palette);
        };
        let variant = source.in_app(palette.appearance);
        Self {
            kind: variant.kind,
            ground: match variant.ground {
                CodeGround::Window => palette.editor,
                CodeGround::Own(ground) => ground.hsla(),
            },
            ink: variant.ink.hsla(),
            line_number: variant.line_number.hsla(),
            line_number_contrast: variant.line_number_contrast.hsla(),
            caret: variant.caret.hsla(),
            line: variant.line.hsla(),
            selection: variant.selection_focused.hsla(),
            syntax: variant.syntax.hsla(),
        }
    }

    /// Lattice's own palette, always on the window: its ink, gutter, current
    /// line and selection are the palette's, its syntax the `COLOR_SYNTAX_*`
    /// tokens. The export carries ten of the app's sixteen roles; the rest
    /// take the nearest one carried.
    fn weft_and_warp(palette: &Palette) -> Self {
        let get = |token: ColorToken| palette.token(token);
        let variable = get(COLOR_SYNTAX_VARIABLE);
        let number = get(COLOR_SYNTAX_NUMBER);
        let comment = get(COLOR_SYNTAX_COMMENT);
        Self {
            kind: palette.appearance,
            ground: palette.editor,
            ink: palette.text,
            line_number: palette.line_number,
            // `--lattice-code-line-number-contrast`: tertiary text, which is
            // the secondary.
            line_number_contrast: palette.text_secondary,
            caret: palette.text,
            line: palette.current_line,
            selection: palette.selection,
            syntax: CodeSyntax {
                keyword: get(COLOR_SYNTAX_KEYWORD),
                operator: get(COLOR_SYNTAX_OPERATOR),
                function: get(COLOR_SYNTAX_FUNCTION),
                type_: get(COLOR_SYNTAX_TYPE),
                variable,
                variable_special: variable,
                property: variable,
                attribute: variable,
                string: get(COLOR_SYNTAX_STRING),
                comment,
                comment_doc: comment,
                number,
                constant: number,
                bracket: palette.text_secondary,
                citation: get(COLOR_SYNTAX_CITATION),
                reference: get(COLOR_SYNTAX_REFERENCE),
            },
        }
    }
}
