//! Font stacks and the type roles' sizes, weights, tracking and leading.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use gpui::{FontWeight, Rems};

use crate::token_types::FontStack;

// Font families

/// Interface font; release builds put Timeless Sans (Grotesk) first; Chinese sets in PingFang SC. Paper cannot draw Timeless and draws Inter, the closest face it has (glyph overlap 0.73, same width and x-height at the app's 1.04 size-adjust)
///
/// App: `--ui-font-fallback`.
pub const FONT_UI: FontStack = FontStack(&["Inter Variable", "Inter", "PingFang SC", "Avenir Next", "Segoe UI", "sans-serif"]);
/// The one serif voice: Display and Title only, regular weight. Release builds put Timeless Serif first; Chinese falls to Songti SC. Paper draws Lora, the closest face it has to Timeless Serif (same width, x-height 0.98); open builds draw Instrument Serif
///
/// App: `--display-font-fallback`.
pub const FONT_DISPLAY: FontStack = FontStack(&["Instrument Serif", "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Georgia", "serif"]);
/// Code, diffs, logs and every monospace surface. Ioskeley Mono (OFL, bundled with the app) is not installed for Paper, so Paper draws Roboto Mono, the closest face it has (same advance, x-height 1.02)
///
/// App: `--editor-font`.
pub const FONT_EDITOR: FontStack = FontStack(&["Ioskeley Mono", "Menlo", "SF Mono", "ui-monospace", "monospace"]);
/// Chinese interface face, the third family in --font-ui
pub const FONT_ZH: FontStack = FontStack(&["PingFang SC"]);
/// Chinese serif, the second family in --font-display
pub const FONT_ZH_SERIF: FontStack = FontStack(&["Songti SC"]);
/// Long-form prose: the visual Markdown surface and a paper's title in the reader. Release builds set it in Timeless Serif Text; Paper draws Libre Caslon Text, the closest serif it has (same width and x-height; regular and bold only); open builds use the interface stack
///
/// App: `--reading-font`.
pub const FONT_READING: FontStack = FontStack(&["Inter Variable", "Inter", "PingFang SC", "Avenir Next", "Segoe UI", "sans-serif"]);

// Font sizes

/// Type role micro: size
///
/// App: `--type-micro-size`.
pub const TEXT_MICRO: Rems = Rems(0.6875);
/// Type role caption: size
///
/// App: `--type-caption-size`.
pub const TEXT_CAPTION: Rems = Rems(0.75);
/// Type role body-compact: size
///
/// App: `--type-body-compact-size`.
pub const TEXT_BODY_COMPACT: Rems = Rems(0.75);
/// Type role body: size
///
/// App: `--type-body-size`.
pub const TEXT_BODY: Rems = Rems(0.8125);
/// Type role subtitle: size
///
/// App: `--type-subtitle-size`.
pub const TEXT_SUBTITLE: Rems = Rems(0.8125);
/// Type role typeset: size
///
/// App: `--type-typeset-size`.
pub const TEXT_TYPESET: Rems = Rems(0.875);
/// Type role title: size
///
/// App: `--type-title-size`.
pub const TEXT_TITLE: Rems = Rems(1.125);
/// Type role display: size
///
/// App: `--type-display-size`.
pub const TEXT_DISPLAY: Rems = Rems(1.875);
/// Settings step: caption
///
/// App: `.settings-modal --type-caption-size`.
pub const TEXT_SETTINGS_CAPTION: Rems = Rems(0.75);
/// Settings step: micro
///
/// App: `.settings-modal --type-micro-size`.
pub const TEXT_SETTINGS_MICRO: Rems = Rems(0.75);
/// Settings step: body compact
///
/// App: `.settings-modal --type-body-compact-size`.
pub const TEXT_SETTINGS_BODY_COMPACT: Rems = Rems(0.8125);
/// Settings step: subtitle
///
/// App: `.settings-modal --type-subtitle-size`.
pub const TEXT_SETTINGS_SUBTITLE: Rems = Rems(0.875);
/// Settings step: body
///
/// App: `.settings-modal --type-body-size`.
pub const TEXT_SETTINGS_BODY: Rems = Rems(0.875);
/// Settings step: typeset
///
/// App: `.settings-modal --type-typeset-size`.
pub const TEXT_SETTINGS_TYPESET: Rems = Rems(0.9375);
/// Settings step: title
///
/// App: `.settings-modal --type-title-size`.
pub const TEXT_SETTINGS_TITLE: Rems = Rems(1.5);

// Font weights

/// Weight role
///
/// App: `--weight-regular`.
pub const FONT_WEIGHT_REGULAR: FontWeight = FontWeight(400.0);
/// Weight role
///
/// App: `--weight-medium`.
pub const FONT_WEIGHT_MEDIUM: FontWeight = FontWeight(500.0);
/// Weight role
///
/// App: `--weight-semibold`.
pub const FONT_WEIGHT_SEMIBOLD: FontWeight = FontWeight(600.0);
/// Weight role
///
/// App: `--weight-bold`.
pub const FONT_WEIGHT_BOLD: FontWeight = FontWeight(700.0);

// Letter spacing

/// Every interface role
/// In em.
pub const TRACKING_NORMAL: f32 = 0.0;
/// An uppercase micro label (venue kind, colour picker hex)
/// In em.
pub const TRACKING_CAPS: f32 = 0.04;

// Line heights

/// Type role micro: line height
///
/// App: `--type-micro-line-height`.
pub const LEADING_MICRO: Rems = Rems(0.875);
/// Type role caption: line height
///
/// App: `--type-caption-line-height`.
pub const LEADING_CAPTION: Rems = Rems(1.0);
/// Type role body-compact: line height
///
/// App: `--type-body-compact-line-height`.
pub const LEADING_BODY_COMPACT: Rems = Rems(1.0);
/// Type role subtitle: line height
///
/// App: `--type-subtitle-line-height`.
pub const LEADING_SUBTITLE: Rems = Rems(1.125);
/// Type role body: line height
///
/// App: `--type-body-line-height`.
pub const LEADING_BODY: Rems = Rems(1.25);
/// Type role typeset: line height
///
/// App: `--type-typeset-line-height`.
pub const LEADING_TYPESET: Rems = Rems(1.375);
/// Type role title: line height
///
/// App: `--type-title-line-height`.
pub const LEADING_TITLE: Rems = Rems(1.5);
/// Type role display: line height
///
/// App: `--type-display-line-height`.
pub const LEADING_DISPLAY: Rems = Rems(2.25);
/// Settings step: micro
///
/// App: `.settings-modal --type-micro-line-height`.
pub const LEADING_SETTINGS_MICRO: Rems = Rems(1.0);
/// Diff code, editor font at caption size
///
/// App: `--type-diff-code-line-height`.
pub const LEADING_DIFF_CODE: Rems = Rems(1.125);
/// Settings step: caption
///
/// App: `.settings-modal --type-caption-line-height`.
pub const LEADING_SETTINGS_CAPTION: Rems = Rems(1.125);
/// Settings step: body compact
///
/// App: `.settings-modal --type-body-compact-line-height`.
pub const LEADING_SETTINGS_BODY_COMPACT: Rems = Rems(1.125);
/// Settings step: subtitle
///
/// App: `.settings-modal --type-subtitle-line-height`.
pub const LEADING_SETTINGS_SUBTITLE: Rems = Rems(1.25);
/// Settings step: body
///
/// App: `.settings-modal --type-body-line-height`.
pub const LEADING_SETTINGS_BODY: Rems = Rems(1.375);
/// Settings step: typeset
///
/// App: `.settings-modal --type-typeset-line-height`.
pub const LEADING_SETTINGS_TYPESET: Rems = Rems(1.5);
/// Settings step: title
///
/// App: `.settings-modal --type-title-line-height`.
pub const LEADING_SETTINGS_TITLE: Rems = Rems(1.875);
