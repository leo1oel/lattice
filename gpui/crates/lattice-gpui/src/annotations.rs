//! Local annotations: the writer's notes on passages of the project's
//! sources, kept with the project in `.research/annotations.json`, as the
//! Tauri app keeps them (`src/app/use-editor-comments.ts`,
//! `src/editor/comments/`).
//!
//! - [`model`]: the note, its anchor and its status, ported from
//!   `editor-comment-data.ts`;
//! - [`store`]: the project's notes, read and saved through lattice-core;
//! - [`card`] and [`colors`]: the pin, the quote and the comment card every
//!   surface shares, in the annotation roles' colours;
//! - [`panel`]: the Annotations panel.
//!
//! The source editor draws them (`editor_panel/annotations.rs`) and the
//! window wires the panel, the titlebar button and the status bar's counter
//! (`shell/annotations_flow.rs`).

pub mod card;
pub mod colors;
pub mod model;
pub mod panel;
pub mod rounds;
pub mod rounds_sheet;
pub mod store;

/// What an editor asks of the window about a note.
#[derive(Clone, Debug)]
pub enum AnnotationRequest {
    /// A note was just saved: it stands out in the panel.
    Created(String),
    /// Open the note in the Annotations panel (its gutter pin).
    Open(String),
    /// Resolve the note (its card's check).
    Resolve(String),
    /// Reply to the note: its reply box in the panel (its card's Reply…).
    Reply(String),
    /// Ask the agent about the note alone (the composer's Save and revise
    /// now).
    Revise(String),
}
