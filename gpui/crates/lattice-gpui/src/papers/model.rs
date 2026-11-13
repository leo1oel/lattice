//! What the Papers panel knows of a paper beyond lattice-core's
//! `PaperSummary`, ported from the Tauri app's helpers so both apps list,
//! name, rank and narrow the library alike:
//!
//! - `identity`: its key, reading state, authors, source, links and
//!   citation-health notice;
//! - `narrowing`: the filters, sorts and groups the toolbar offers, and how a
//!   query ranks the library;
//! - `adding`: what the search box would add, and whether the library
//!   already holds it;
//! - `reading`: what the inspector reads out of a saved paper.

mod adding;
mod identity;
mod narrowing;
mod reading;

pub use adding::*;
pub use identity::*;
pub use narrowing::*;
pub use reading::*;

#[cfg(test)]
pub(crate) mod test_support {
    use lattice_core::papers::PaperSummary;

    pub fn paper(title: &str) -> PaperSummary {
        PaperSummary {
            arxiv_id: String::new(),
            doi: None,
            url: None,
            title: title.into(),
            authors: String::new(),
            year: None,
            citation_key: None,
            has_full_text: false,
            has_blog: false,
            has_local_pdf: false,
            asset_paths: Vec::new(),
            citation_health: None,
        }
    }

    pub fn with(mut paper: PaperSummary, edit: impl FnOnce(&mut PaperSummary)) -> PaperSummary {
        edit(&mut paper);
        paper
    }
}
