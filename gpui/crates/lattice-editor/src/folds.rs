//! Folding: what a line folds, as a language says it.
//!
//! The Tauri app's fold gutter asks the language's fold service about each
//! line it shows (`foldService`); a language here gives the adapter a
//! [`FoldSource`] the same way, and the source gutter shows a marker on
//! every line it answers for (`adapter/gutter_column.rs`).

use std::rc::Rc;

use language::BufferSnapshot;

/// A range a fold hides: from `start` to `end`, each a (row, byte column).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FoldRange {
    pub start: (u32, u32),
    pub end: (u32, u32),
}

/// What a line (by its 0-based row) folds, if anything.
pub type FoldSource = Rc<dyn Fn(&BufferSnapshot, u32) -> Option<FoldRange>>;
