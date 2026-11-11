//! File glyph hues, one per kind of file.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use crate::token_types::{ColorToken, hex};

// Colour

/// File glyph hue: tex
///
/// App: `--glyph-tex`.
pub const COLOR_GLYPH_TEX: ColorToken = ColorToken::new(hex(0x3B5BD6), hex(0x8FA5FF));
/// File glyph hue: style
///
/// App: `--glyph-style`.
pub const COLOR_GLYPH_STYLE: ColorToken = ColorToken::new(hex(0x7A52C4), hex(0xBBA3F2));
/// File glyph hue: bib
///
/// App: `--glyph-bib`.
pub const COLOR_GLYPH_BIB: ColorToken = ColorToken::new(hex(0xB06A00), hex(0xF2B65E));
/// File glyph hue: markdown
///
/// App: `--glyph-markdown`.
pub const COLOR_GLYPH_MARKDOWN: ColorToken = ColorToken::new(hex(0x4D6A8A), hex(0xA7BAD3));
/// File glyph hue: pdf
///
/// App: `--glyph-pdf`.
pub const COLOR_GLYPH_PDF: ColorToken = ColorToken::new(hex(0xC4473C), hex(0xF39087));
/// File glyph hue: image
///
/// App: `--glyph-image`.
pub const COLOR_GLYPH_IMAGE: ColorToken = ColorToken::new(hex(0x2E8A55), hex(0x72CF98));
/// File glyph hue: board
///
/// App: `--glyph-board`.
pub const COLOR_GLYPH_BOARD: ColorToken = ColorToken::new(hex(0x13878A), hex(0x62D1CD));
/// File glyph hue: sheet
///
/// App: `--glyph-sheet`.
pub const COLOR_GLYPH_SHEET: ColorToken = ColorToken::new(hex(0x3A7F2E), hex(0x93D07F));
/// File glyph hue: slides
///
/// App: `--glyph-slides`.
pub const COLOR_GLYPH_SLIDES: ColorToken = ColorToken::new(hex(0xC2571C), hex(0xF4A06A));
/// File glyph hue: code
///
/// App: `--glyph-code`.
pub const COLOR_GLYPH_CODE: ColorToken = ColorToken::new(hex(0xA85A12), hex(0xEAA565));
/// File glyph hue: config
///
/// App: `--glyph-config`.
pub const COLOR_GLYPH_CONFIG: ColorToken = ColorToken::new(hex(0x6A6A70), hex(0x9D9DA5));
/// File glyph hue: folder
///
/// App: `--glyph-folder`.
pub const COLOR_GLYPH_FOLDER: ColorToken = ColorToken::new(hex(0x8A6A3E), hex(0xD9BC8C));
