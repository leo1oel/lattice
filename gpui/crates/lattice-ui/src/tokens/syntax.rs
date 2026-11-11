//! The code themes' syntax colours: Weft & Warp and GitHub.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use crate::token_types::{ColorToken, hex};

// Colour

/// Weft & Warp syntax: keyword
///
/// App: `--lattice-syntax-keyword`.
pub const COLOR_SYNTAX_KEYWORD: ColorToken = ColorToken::new(hex(0x3349C4), hex(0x93A6FF));
/// Weft & Warp syntax: function
///
/// App: `--lattice-syntax-function`.
pub const COLOR_SYNTAX_FUNCTION: ColorToken = ColorToken::new(hex(0x4553AD), hex(0xAAB3EE));
/// Weft & Warp syntax: type
///
/// App: `--lattice-syntax-type`.
pub const COLOR_SYNTAX_TYPE: ColorToken = ColorToken::new(hex(0x006A6E), hex(0x5CD0C8));
/// Weft & Warp syntax: variable
///
/// App: `--lattice-syntax-variable`.
pub const COLOR_SYNTAX_VARIABLE: ColorToken = ColorToken::new(hex(0x006A6E), hex(0x5CD0C8));
/// Weft & Warp syntax: string
///
/// App: `--lattice-syntax-string`.
pub const COLOR_SYNTAX_STRING: ColorToken = ColorToken::new(hex(0x45454B), hex(0xD2D2D6));
/// Weft & Warp syntax: comment
///
/// App: `--lattice-syntax-comment`.
pub const COLOR_SYNTAX_COMMENT: ColorToken = ColorToken::new(hex(0x626268), hex(0x9E9EA5));
/// Weft & Warp syntax: number
///
/// App: `--lattice-syntax-number`.
pub const COLOR_SYNTAX_NUMBER: ColorToken = ColorToken::new(hex(0x7D5100), hex(0xE8B25C));
/// Weft & Warp syntax: operator
///
/// App: `--lattice-syntax-operator`.
pub const COLOR_SYNTAX_OPERATOR: ColorToken = ColorToken::new(hex(0x7D5100), hex(0xE8B25C));
/// Weft & Warp syntax: citation
///
/// App: `--lattice-syntax-citation`.
pub const COLOR_SYNTAX_CITATION: ColorToken = ColorToken::new(hex(0x8D472F), hex(0xDFA27D));
/// Weft & Warp syntax: reference
///
/// App: `--lattice-syntax-reference`.
pub const COLOR_SYNTAX_REFERENCE: ColorToken = ColorToken::new(hex(0x7A3FA8), hex(0xD59BF0));
/// GitHub code theme (the default): ink: plain code and brackets
///
/// App: `code-theme github --code-ink`.
pub const COLOR_SYNTAX_GITHUB_INK: ColorToken = ColorToken::new(hex(0x1F2328), hex(0xE6EDF3));
/// GitHub code theme (the default): line numbers in the gutter
///
/// App: `code-theme github --code-line-number`.
pub const COLOR_SYNTAX_GITHUB_LINE_NUMBER: ColorToken = ColorToken::new(hex(0x89929C), hex(0x6E7681));
/// GitHub code theme (the default): the caret
///
/// App: `code-theme github --code-caret`.
pub const COLOR_SYNTAX_GITHUB_CARET: ColorToken = ColorToken::new(hex(0x0969DA), hex(0x2F81F7));
/// GitHub code theme (the default): LaTeX commands, keywords
///
/// App: `code-theme github --syntax-keyword`.
pub const COLOR_SYNTAX_GITHUB_KEYWORD: ColorToken = ColorToken::new(hex(0xCF222E), hex(0xFF7B72));
/// GitHub code theme (the default): operators
///
/// App: `code-theme github --syntax-operator`.
pub const COLOR_SYNTAX_GITHUB_OPERATOR: ColorToken = ColorToken::new(hex(0xCF222E), hex(0xFF7B72));
/// GitHub code theme (the default): sectioning, functions
///
/// App: `code-theme github --syntax-function`.
pub const COLOR_SYNTAX_GITHUB_FUNCTION: ColorToken = ColorToken::new(hex(0x804DDC), hex(0xD2A8FF));
/// GitHub code theme (the default): environment names, types
///
/// App: `code-theme github --syntax-type`.
pub const COLOR_SYNTAX_GITHUB_TYPE: ColorToken = ColorToken::new(hex(0x116329), hex(0x7EE787));
/// GitHub code theme (the default): math, variables
///
/// App: `code-theme github --syntax-variable`.
pub const COLOR_SYNTAX_GITHUB_VARIABLE: ColorToken = ColorToken::new(hex(0x0550AE), hex(0x79C0FF));
/// GitHub code theme (the default): strings, arguments
///
/// App: `code-theme github --syntax-string`.
pub const COLOR_SYNTAX_GITHUB_STRING: ColorToken = ColorToken::new(hex(0x0A3069), hex(0xA5D6FF));
/// GitHub code theme (the default): comments
///
/// App: `code-theme github --syntax-comment`.
pub const COLOR_SYNTAX_GITHUB_COMMENT: ColorToken = ColorToken::new(hex(0x59636E), hex(0x8B949E));
/// GitHub code theme (the default): numbers, constants
///
/// App: `code-theme github --syntax-number`.
pub const COLOR_SYNTAX_GITHUB_NUMBER: ColorToken = ColorToken::new(hex(0x0550AE), hex(0x79C0FF));
/// GitHub code theme (the default): citation keys
///
/// App: `code-theme github --syntax-citation`.
pub const COLOR_SYNTAX_GITHUB_CITATION: ColorToken = ColorToken::new(hex(0x0A3069), hex(0xA5D6FF));
/// GitHub code theme (the default): cross-references
///
/// App: `code-theme github --syntax-reference`.
pub const COLOR_SYNTAX_GITHUB_REFERENCE: ColorToken = ColorToken::new(hex(0x953800), hex(0xFFA657));
