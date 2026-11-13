//! The project's history, ported from the Tauri app's `src/history/`: the
//! History tool panel (Lattice's own activity and the project's git versions
//! on one timeline), a version or an entry opened to read its changes as
//! prose or as a source diff, the comparison of any two versions, the PDF
//! with those changes marked (latexdiff), and the resolver for a file a
//! merge left with conflict markers. lattice-core does the work, as it does
//! for the Tauri app (`git`, `project::history`, `latex::changes`).

mod art;
mod body;
mod compare;
pub mod conflict_resolver;
pub mod conflicts;
mod diff_view;
mod export_changes;
mod inline_edits;
mod messages;
pub mod panel;
mod prose;
mod row;
mod time;
mod timeline;
mod view;
mod widgets;
mod words;

/// A handler that opens a file at a line, as the passages and diffs call it.
type OnLine = std::rc::Rc<dyn Fn(usize, &mut gpui::Window, &mut gpui::App)>;

pub use conflict_resolver::{ConflictEvent, ConflictResolver};
pub use panel::{HistoryEvent, HistoryPanel};
