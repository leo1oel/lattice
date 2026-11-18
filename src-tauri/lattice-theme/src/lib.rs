//! Lattice themes.
//!
//! A theme is data, not code: a `lattice-theme.json` that gives literal
//! colours to the design system's base roles (`docs/themes.md`). This crate
//! is the single place both shells read one:
//!
//! - [`ThemeFile::parse`] validates the file (schema 1, known roles only,
//!   literal `#RRGGBB`/`#RRGGBBAA` values);
//! - [`resolve`] picks the variant for an appearance, applies the writer's
//!   accent choice (an accent of their own wins over the theme's, decision
//!   L13), and fits every role that colours text to its contrast floor;
//! - [`Resolved::css_variables`] is what the Tauri app sets on `<html>`; the
//!   GPUI app lays [`Resolved`] over its palette (`lattice-ui` `palette.rs`).
//!
//! Derived colours (hover washes, the soft accent, the titlebar veil) are not
//! themeable: each shell derives them from the base roles the way it already
//! does, and `theme_parity` tests keep the two derivations equal.

mod bundled;
pub mod color;
mod format;
mod resolve;
pub mod roles;
pub mod schema;

pub use bundled::{bundled, BUNDLED};
pub use format::{
    valid_id as valid_theme_id, Color, ThemeError, ThemeFile, Variant, MAX_THEME_BYTES,
};
pub use resolve::{resolve, AccentChoice, Resolved};

use serde::{Deserialize, Serialize};

/// Light or dark: the app's appearance, and the one a theme variant is for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}
