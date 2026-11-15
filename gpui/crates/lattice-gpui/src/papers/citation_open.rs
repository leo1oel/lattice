//! Open paper from a citation card (`canOpenCitation` and `onOpenCitation`
//! in the Tauri app's `use-document-surfaces.tsx`): a citation opens its
//! paper when the library has its text or can download a preprint or a
//! published paper first (a cited web page stays in the browser), else the
//! source its entry cites, as it does when that download fails. A
//! `\cite[p.~5]{key}` opens the paper's PDF at page 5.

use gpui::{Context, Window};
use lattice_core::papers::PaperSummary;

use super::{PapersEvent, PapersPanel, model};

/// Whether Open paper opens `paper` in Lattice (`paperCited`): its text is
/// here, or a preprint or a published paper can be downloaded.
pub fn opens_in_lattice(paper: &PaperSummary) -> bool {
    paper.has_full_text
        || paper.has_blog
        || ((!paper.arxiv_id.is_empty() || paper.doi.is_some()) && model::can_download(paper))
}

impl PapersPanel {
    /// The library's paper `key` cites, whatever it can open.
    pub fn paper_for_key(&self, key: &str) -> Option<&PaperSummary> {
        self.papers.iter().find(|paper| {
            paper
                .citation_key
                .as_deref()
                .is_some_and(|cited| cited.eq_ignore_ascii_case(key))
        })
    }

    /// The paper Open paper opens in Lattice for `key`.
    fn paper_cited(&self, key: &str) -> Option<&PaperSummary> {
        self.paper_for_key(key)
            .filter(|paper| opens_in_lattice(paper))
    }

    /// Whether Open paper is offered for `key`, whose entry cites `source`.
    pub fn can_open_citation(&self, key: &str, source: Option<&str>) -> bool {
        self.paper_cited(key).is_some() || source.is_some()
    }

    /// Open the paper `key` cites (at `page`), downloading it first when
    /// it has no text yet, else `source` in the browser.
    pub fn open_citation(
        &mut self,
        key: &str,
        page: Option<u32>,
        source: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(paper) = self.paper_cited(key).cloned() else {
            if let Some(url) = source {
                cx.open_url(&url);
            }
            return;
        };
        let readable = model::readable(&paper);
        match page {
            Some(page) if readable => {
                self.navigations += 1;
                cx.emit(PapersEvent::ReadAt {
                    paper: Box::new(paper),
                    page,
                });
            }
            _ if readable => self.activate(&paper, None, window, cx),
            _ => {
                if let Some(url) = source {
                    self.fetching
                        .fallbacks
                        .insert(model::paper_key(&paper), url);
                }
                self.activate(&paper, None, window, cx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paper() -> PaperSummary {
        crate::papers::model::test_support::paper("T")
    }

    /// `paperCited`: text here or a downloadable preprint opens in Lattice;
    /// a cited web page with no arXiv id or DOI stays in the browser.
    #[test]
    fn a_paper_opens_in_lattice_when_its_text_is_here_or_downloads() {
        let mut item = paper();
        assert!(!opens_in_lattice(&item));
        item.has_full_text = true;
        assert!(opens_in_lattice(&item));
        let mut preprint = paper();
        preprint.arxiv_id = "1706.03762".into();
        assert!(opens_in_lattice(&preprint));
        let mut page = paper();
        page.url = Some("https://example.org/post".into());
        assert!(!opens_in_lattice(&page));
    }
}
