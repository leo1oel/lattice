//! What a row says about itself beyond its text: the tip naming what a
//! click does.

use lattice_core::papers::PaperSummary;
use lattice_i18n::t;

use super::model;

/// The row's tip: its title when it opens to read, else what a click
/// fetches or opens instead (`paper-row.tsx`, `.paper-open`'s title).
pub(super) fn open_tip(paper: &PaperSummary) -> String {
    if model::readable(paper) {
        return paper.title.clone();
    }
    let url = paper.url.as_deref().map_or("", str::trim);
    if model::reading_state(paper) == model::ReadingState::Citation && !url.is_empty() {
        t!("Open source page — no downloadable full text found").to_string()
    } else if !paper.arxiv_id.is_empty() {
        t!("Download arXiv {id}", id = paper.arxiv_id)
    } else if !url.is_empty() {
        t!("Download {url}", url = url)
    } else {
        t!("{title} — no local reading available", title = paper.title)
    }
}
