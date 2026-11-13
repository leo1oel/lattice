//! Lattice's editor: Zed's editor behind one adapter, [`LatticeEditor`], that
//! every later editor feature decorates through, and the LaTeX language with
//! Lattice's own extensions on it.
//!
//! The Tauri app builds its source editor out of CodeMirror extensions
//! (`src/editor/`, `src/editor/latex/`): decorations, gutter markers, block
//! widgets, hover tooltips, completion sources and other people's carets.
//! Zed's editor offers each of these in its own way, some only to Zed's
//! project and language servers; the adapter puts one Lattice-shaped API over
//! them, so a feature (TexLab's diagnostics, the citation card, Overleaf's
//! carets, later annotations and inline proofreading) says what to show in
//! buffer offsets and leaves how Zed draws it to the adapter:
//!
//! - [`decorations`]: marks over ranges (underlines, ink, strike) and
//!   highlights (a wash behind the text), in named layers;
//! - [`gutter`]: a mark beside a line, with an optional hover card;
//! - [`blocks`]: a widget between lines;
//! - [`hover`]: a card for what the pointer rests on;
//! - [`completion`]: sources for Zed's completion menu;
//! - [`remote_cursors`]: other people's carets, named as they move.
//!
//! Each but gutter marks (whose first use will be the annotation pins) is
//! proved by a real Lattice use in [`latex`]: TexLab's diagnostics as marks
//! and hover cards; the citation and reference cards; command and citation
//! completion. The project data they read (citation
//! keys, labels) is a [`ProjectIndex`], and TexLab runs as a
//! [`TexlabService`], both on `lattice-core`.

mod adapter;
pub mod blocks;
pub mod completion;
pub mod decorations;
mod geometry;
pub mod gutter;
pub mod hover;
pub mod index;
pub mod latex;
pub mod remote_cursors;
pub mod texlab;

pub use adapter::{LatticeEditor, LatticeEditorEvent, Painted, PaintedCursor};
pub use index::ProjectIndex;
pub use texlab::TexlabService;

/// Set up what every editor shares: the LaTeX language.
pub fn init(cx: &mut gpui::App) {
    latex::init(cx);
}
