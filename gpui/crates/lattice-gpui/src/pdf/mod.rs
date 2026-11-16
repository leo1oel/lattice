//! The PDF: a native viewer on PDFium (`engine.rs`, a thread of its own),
//! laid out and drawn as the Tauri app's PDF.js viewer is (`view.rs`,
//! `layout.rs`, `sheet.rs`, `toolbar.rs`), with find (`find.rs`), text
//! selection (`text.rs`) and dark pages (`dark.rs`); the dock's PDF panels
//! (`panel.rs`) and the live PDF's separate window (`window.rs`).

pub(crate) mod annotation_place;
mod clicked_word;
/// chemnum's keys and numbers, read in lattice-editor, where the source's
/// compound completion reads them too.
pub(crate) use lattice_editor::latex::compounds;
mod comment_margin;
mod dark;
mod engine;
mod find;
mod layout;
mod loading;
mod named_links;
mod outline_menu;
mod overflow;
mod panel;
pub(crate) mod preferences;
mod review_marking;
pub(crate) mod review_place;
pub(crate) mod review_sheet;
mod sheet;
pub(crate) mod source_anchor;
mod text;
mod toolbar;
mod toolbar_hover;
mod view;
mod window;

pub(crate) use clicked_word::word_at as clicked_word_at;
pub(crate) use dark::{enabled as dark_pages, filter as dark_filter};
pub(crate) use engine::{DocId, PdfEngine, RenderRequest};
pub use find::FindOptions;
pub use layout::FitMode;
pub(crate) use named_links::citation_keys;
pub use outline_menu::OutlineState;
pub use panel::{PdfEvent, PdfPanel, PdfPanelKind, pdf_tab_label};
pub use text::LinkTarget;
pub use toolbar_hover::toolbar_section;
pub use view::{
    CitationLookup, CompoundSource, NoteDestination, OfferedSelection, OverleafNotes, PdfNotes,
    PdfView, PdfViewEvent, ReviewSource, ToolbarAction, ViewPlace, note_destination,
};
