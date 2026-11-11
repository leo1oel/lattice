//! The tints and accent presets of Settings › Appearance.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use crate::token_types::{ColorToken, hex};

// Colour

/// Accent preset blue; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="blue"] --accent`.
pub const COLOR_ACCENT_BLUE: ColorToken = ColorToken::new(hex(0x096ACB), hex(0x4D8FE0));
/// Accent preset purple; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="purple"] --accent`.
pub const COLOR_ACCENT_PURPLE: ColorToken = ColorToken::new(hex(0x884FBE), hex(0xA679D5));
/// Accent preset pink; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="pink"] --accent`.
pub const COLOR_ACCENT_PINK: ColorToken = ColorToken::new(hex(0xB83B76), hex(0xD56B97));
/// Accent preset orange; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="orange"] --accent`.
pub const COLOR_ACCENT_ORANGE: ColorToken = ColorToken::new(hex(0xB04D00), hex(0xD37438));
/// Accent preset green; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="green"] --accent`.
pub const COLOR_ACCENT_GREEN: ColorToken = ColorToken::new(hex(0x007C34), hex(0x3DA05A));
/// Accent preset teal; its wash is 10% and it is also the focus ring
///
/// App: `[data-accent="teal"] --accent`.
pub const COLOR_ACCENT_TEAL: ColorToken = ColorToken::new(hex(0x007777), hex(0x139D9E));
/// Tint paper: window
///
/// App: `[data-tint="paper"] --bg`.
pub const COLOR_TINT_PAPER_WINDOW: ColorToken = ColorToken::new(hex(0xFBF6EF), hex(0x191713));
/// Tint paper: chrome
///
/// App: `[data-tint="paper"] --chrome-surface`.
pub const COLOR_TINT_PAPER_CHROME: ColorToken = ColorToken::new(hex(0xF3EEE7), hex(0x171410));
/// Tint paper: panel
///
/// App: `[data-tint="paper"] --panel`.
pub const COLOR_TINT_PAPER_PANEL: ColorToken = ColorToken::new(hex(0xFEFAF5), hex(0x1D1B18));
/// Tint paper: raised
///
/// App: `[data-tint="paper"] --panel-strong`.
pub const COLOR_TINT_PAPER_RAISED: ColorToken = ColorToken::new(hex(0xFCF9F4), hex(0x22201D));
/// Tint sage: window
///
/// App: `[data-tint="sage"] --bg`.
pub const COLOR_TINT_SAGE_WINDOW: ColorToken = ColorToken::new(hex(0xF2F9F3), hex(0x141915));
/// Tint sage: chrome
///
/// App: `[data-tint="sage"] --chrome-surface`.
pub const COLOR_TINT_SAGE_CHROME: ColorToken = ColorToken::new(hex(0xEAF1EB), hex(0x111612));
/// Tint sage: panel
///
/// App: `[data-tint="sage"] --panel`.
pub const COLOR_TINT_SAGE_PANEL: ColorToken = ColorToken::new(hex(0xF8FDF8), hex(0x191C1A));
/// Tint sage: raised
///
/// App: `[data-tint="sage"] --panel-strong`.
pub const COLOR_TINT_SAGE_RAISED: ColorToken = ColorToken::new(hex(0xF6FBF6), hex(0x1E211F));
/// Tint mist: window
///
/// App: `[data-tint="mist"] --bg`.
pub const COLOR_TINT_MIST_WINDOW: ColorToken = ColorToken::new(hex(0xF0F8FF), hex(0x12181D));
/// Tint mist: chrome
///
/// App: `[data-tint="mist"] --chrome-surface`.
pub const COLOR_TINT_MIST_CHROME: ColorToken = ColorToken::new(hex(0xE8F0F8), hex(0x0F151A));
/// Tint mist: panel
///
/// App: `[data-tint="mist"] --panel`.
pub const COLOR_TINT_MIST_PANEL: ColorToken = ColorToken::new(hex(0xF6FCFF), hex(0x181C1F));
/// Tint mist: raised
///
/// App: `[data-tint="mist"] --panel-strong`.
pub const COLOR_TINT_MIST_RAISED: ColorToken = ColorToken::new(hex(0xF4FAFF), hex(0x1D2125));
/// Tint dusk: window
///
/// App: `[data-tint="dusk"] --bg`.
pub const COLOR_TINT_DUSK_WINDOW: ColorToken = ColorToken::new(hex(0xF8F5FF), hex(0x18161D));
/// Tint dusk: chrome
///
/// App: `[data-tint="dusk"] --chrome-surface`.
pub const COLOR_TINT_DUSK_CHROME: ColorToken = ColorToken::new(hex(0xF0EDF7), hex(0x15131A));
/// Tint dusk: panel
///
/// App: `[data-tint="dusk"] --panel`.
pub const COLOR_TINT_DUSK_PANEL: ColorToken = ColorToken::new(hex(0xFCFAFF), hex(0x1C1A1F));
/// Tint dusk: raised
///
/// App: `[data-tint="dusk"] --panel-strong`.
pub const COLOR_TINT_DUSK_RAISED: ColorToken = ColorToken::new(hex(0xFAF8FF), hex(0x211F24));
