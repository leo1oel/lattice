//! The PDF: a native viewer on PDFium (`engine.rs`, a thread of its own),
//! laid out and drawn as the Tauri app's PDF.js viewer is (`view.rs`,
//! `layout.rs`, `sheet.rs`, `toolbar.rs`), with find (`find.rs`), text
//! selection (`text.rs`) and dark pages (`dark.rs`); the dock's PDF panels
//! (`panel.rs`) and the live PDF's separate window (`window.rs`).

mod dark;
mod engine;
mod find;
mod layout;
mod outline_menu;
mod overflow;
mod panel;
pub(crate) mod preferences;
mod sheet;
mod text;
mod toolbar;
mod view;
mod window;

pub(crate) use engine::{PdfEngine, RenderRequest};
pub use find::FindOptions;
pub use layout::FitMode;
pub use outline_menu::OutlineState;
pub use panel::{PdfEvent, PdfPanel, PdfPanelKind, pdf_tab_label};
pub use text::LinkTarget;
pub use view::{PdfView, PdfViewEvent};
