//! Lattice's look on GPUI.
//!
//! The Tauri app's design system lives in Paper and is exported to
//! `design-system/tokens.json`; this crate turns that file into Rust
//! ([`tokens`], generated, with a drift test) and builds everything the GPUI
//! app paints from it: the resolved [`Palette`] for an appearance, tint and
//! accent, the GPUI Kit theme ([`kit`]), the Zed editor theme
//! ([`editor_theme`]), type roles, motion, elevation, icons and the
//! components.
//!
//! The parity target is the running app, as drawn on Paper's App screens
//! page, not the token tables alone: where the app paints a value the tokens
//! do not hold (the 18.4px panel radius, the tab chip's 11px corners), the
//! component carries it with a note saying where it was measured.

// The Kit and Zed theme files are written as `json!` literals of a hundred
// keys each, deeper than the macro's default expansion limit.
#![recursion_limit = "512"]

pub mod components;
pub mod dock;
pub mod editor_theme;
pub mod elevation;
pub mod fonts;
pub mod icons;
pub mod kit;
pub mod motion;
pub mod palette;
pub mod theme;
pub mod token_types;
#[rustfmt::skip]
pub mod tokens;
#[cfg(test)]
mod tokens_codegen;
pub mod typography;

pub use editor_theme::CodeTheme;
pub use elevation::Elevation;
pub use icons::{Icon, UiAssets};
pub use motion::Motion;
pub use palette::{Accent, GlyphKind, Palette, Tint};
pub use theme::{ActiveLattice, LatticeTheme};
pub use typography::{TextRole, TextRoleStyle, TypeScale};

/// Light or dark: which value of every two-valued token is painted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}
