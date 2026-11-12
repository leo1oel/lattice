//! Block widgets: an element between lines, which the text makes room for.
//!
//! CodeMirror's block widget decorations (the Tauri app's accepted-edit
//! pictures, the inline proofreading card, a comment's thread) put an
//! element of its own height between two lines. Zed's editor has the same
//! thing in its block map; a [`BlockWidget`] is one of those in Lattice's
//! terms: the line it sits above or below, how many lines tall it is, and
//! what it draws. The adapter anchors it, so it follows its line through
//! edits, and replaces a layer's blocks a whole layer at a time.

use std::sync::Arc;

use editor::display_map::BlockContext;
use gpui::AnyElement;

/// Which side of its line a block sits on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BlockSide {
    Above,
    #[default]
    Below,
}

/// Draws a block, given its place in the editor (the gutter's width, the
/// line height, the room to the right edge).
pub type RenderBlockWidget = Arc<dyn Send + Sync + Fn(&mut BlockContext) -> AnyElement>;

/// A widget between lines.
#[derive(Clone)]
pub struct BlockWidget {
    /// The buffer row, 0-based, the block sits beside.
    pub line: u32,
    pub side: BlockSide,
    /// Its height in lines of the editor's text; Zed lays blocks out in rows.
    pub lines: u32,
    pub render: RenderBlockWidget,
}
