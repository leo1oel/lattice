//! Lattice's look on GPUI.
//!
//! The Tauri app's design system lives in Paper and is exported to
//! `design-system/tokens.json`; this crate turns that file into Rust
//! ([`tokens`], generated, with a drift test) and builds everything the GPUI
//! app paints from it: the resolved [`Palette`] for an appearance, tint and
//! accent, the GPUI Kit theme, the Zed editor theme, type roles, motion,
//! elevation, icons and the components.
//!
//! The parity target is the running app, as drawn on Paper's App screens
//! page, not the token tables alone: where the app paints a value the tokens
//! do not hold (the 18.4px panel radius, the tab chip's 11px corners), the
//! component carries it with a note saying where it was measured.

pub mod palette;
pub mod token_types;
#[rustfmt::skip]
pub mod tokens;
#[cfg(test)]
mod tokens_codegen;

pub use palette::{Accent, GlyphKind, Palette, Tint};

/// Light or dark: which value of every two-valued token is painted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}
