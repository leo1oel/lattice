//! The constants of a panel's 40px strip that the Trellis skin lays its
//! header out with (`shell/skin.rs`), as the Trellis patch's `planHeader`
//! sizes the Tauri app's tabs.

use gpui::{Pixels, px};

/// The ⋯ menu button.
pub const MENU_WIDTH: Pixels = px(24.);
/// The most a document's tab shrinks to while anything else can give way:
/// the selected tab keeps room for two letters and an ellipsis beside its
/// close square.
pub const DOCUMENT_TAB_MIN: Pixels = px(100.);
/// A document's tab at its smallest: icon and close square, no label.
pub const DOCUMENT_TAB_FLOOR: Pixels = px(66.);
/// Between the spare tools and the panel's tools (`.trellis-latex-tools`).
pub const SPARE_GAP: Pixels = px(4.);
