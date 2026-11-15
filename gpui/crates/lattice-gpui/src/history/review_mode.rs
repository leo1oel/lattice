//! Track changes: the project's local review mode (`src/history/review-mode-*.ts`).
//!
//! Turned on from the titlebar's Track changes, every `.tex` and `.bib` of
//! the project is copied as its base (lattice-core's `project::review_mode`),
//! and from then on every difference between a file's base and its text is
//! one of the writer's tracked changes, marked in the source as Overleaf's
//! suggestions are, with a bar over the editor to step through them and
//! accept or reject them, and the PDF with them marked (latexdiff) in the
//! PDF panel. Turned off, the bases go and the files stay as they are.
//!
//! - [`diff`]: the changes, worked out from the base and the text.
//! - [`store`]: each project's review mode and bases, and their saves.
//! - [`marked_pdf`]: the PDF with the changes marked, built after each
//!   build of the paper and each accept.
//!
//! The editor's side is `editor_panel/review_marks.rs` (its marks, hover
//! card and accepts as undo steps) and `editor_panel/review_bar.rs`; the
//! window's is `shell/review_mode_flow.rs` (the titlebar's toggle and the
//! PDF panel).

pub mod diff;
pub mod marked_pdf;
pub mod store;

/// The writer's own colour for their tracked changes: Word's blue-violet
/// (`REVIEW_HUE`).
pub const REVIEW_HUE: f32 = 250.;
