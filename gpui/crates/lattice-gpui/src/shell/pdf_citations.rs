//! The citation cards over the compiled PDF's citation links: the project
//! index's entries (`citations` in the Tauri app's
//! `use-document-surfaces.tsx`), and what a card's title opens, as the
//! source editor's citation card and the PDF's open the same thing
//! (`onOpenCitation`): the paper in its reader when Papers has its text or
//! overview, else its source on the web (the entry's own address, its DOI's
//! resolver, or arXiv's PDF).
//!
//! Not yet: a cited paper Papers can fetch but has not is opened at its
//! source rather than downloaded first (`fetchAndOpenPaper`).

use gpui::{App, Context, Entity, Window};
use lattice_core::papers::PaperSummary;
use lattice_editor::index::Citation;

use super::Shell;
use crate::{
    papers::model as paper_model,
    pdf::{CitationLookup, PdfPanel},
};

impl Shell {
    /// How a PDF of this project reads its citations; `None` without a
    /// project.
    fn citation_lookup(&self, cx: &App) -> Option<CitationLookup> {
        let index = self.project.as_ref()?.read(cx).index().downgrade();
        let papers = self.papers.downgrade();
        let find_index = index.clone();
        Some(CitationLookup {
            find: std::rc::Rc::new(move |key, cx| {
                find_index.upgrade()?.read(cx).citation(key).cloned()
            }),
            can_open: std::rc::Rc::new(move |key, cx| {
                let citation = index
                    .upgrade()
                    .and_then(|index| index.read(cx).citation(key).cloned());
                let readable = papers
                    .upgrade()
                    .is_some_and(|papers| paper_to_read(&papers.read(cx).papers, key).is_some());
                readable || citation.as_ref().and_then(source_url).is_some()
            }),
        })
    }

    /// Give `panel` the project's citations.
    pub(super) fn give_citations(&self, panel: &Entity<PdfPanel>, cx: &mut Context<Self>) {
        let lookup = self.citation_lookup(cx);
        panel.update(cx, |panel, cx| panel.set_citations(lookup, cx));
    }

    /// A citation card's title: the paper in its reader, else its source.
    pub(super) fn open_citation(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let paper = paper_to_read(&self.papers.read(cx).papers, key).cloned();
        if let Some(paper) = paper {
            self.open_reader(paper, window, cx);
            return;
        }
        let citation = self
            .project
            .as_ref()
            .and_then(|project| project.read(cx).index().read(cx).citation(key).cloned());
        if let Some(url) = citation.as_ref().and_then(source_url) {
            cx.open_url(&url);
        }
    }
}

/// The library's paper cited under `key` that the reader can show: its
/// text or its overview is saved (`paperCited`).
fn paper_to_read<'a>(papers: &'a [PaperSummary], key: &str) -> Option<&'a PaperSummary> {
    papers.iter().find(|paper| {
        paper
            .citation_key
            .as_deref()
            .is_some_and(|cited| cited.eq_ignore_ascii_case(key))
            && (paper.has_full_text || paper.has_blog)
    })
}

/// Where the entry lives on the web (`citationSourceUrl`): its own http(s)
/// address without credentials, else its DOI's resolver, else arXiv's PDF.
/// Bibliography fields are untrusted, so nothing else opens.
fn source_url(citation: &Citation) -> Option<String> {
    paper_model::web_link(citation.url.as_deref())
        .or_else(|| paper_model::doi_url(citation.doi.as_deref()))
        .or_else(|| {
            let id = citation.arxiv_id.as_deref()?.trim();
            paper_model::is_arxiv_id(id).then(|| format!("https://arxiv.org/pdf/{id}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn citation(url: Option<&str>, doi: Option<&str>, arxiv: Option<&str>) -> Citation {
        Citation {
            key: "k".into(),
            url: url.map(str::to_string),
            doi: doi.map(str::to_string),
            arxiv_id: arxiv.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn a_citation_opens_its_own_address_then_its_doi_then_arxiv() {
        // `citationSourceUrl` in `src/papers/paper-source.ts`.
        assert_eq!(
            source_url(&citation(
                Some("https://example.org/a"),
                Some("10.1000/x"),
                None
            ))
            .as_deref(),
            Some("https://example.org/a")
        );
        assert_eq!(
            source_url(&citation(
                Some("https://user:pw@example.org/a"),
                Some("10.1000/x#1"),
                None
            ))
            .as_deref(),
            Some("https://doi.org/10.1000/x%231")
        );
        assert_eq!(
            source_url(&citation(
                Some("file:///etc/passwd"),
                None,
                Some("1706.03762")
            ))
            .as_deref(),
            Some("https://arxiv.org/pdf/1706.03762")
        );
        assert_eq!(
            source_url(&citation(None, Some("not a doi"), Some("nonsense"))),
            None
        );
    }
}
