//! The citation cards over the compiled PDF's citation links: the project
//! index's entries (`citations` in the Tauri app's
//! `use-document-surfaces.tsx`), and what a card's title opens, as the
//! source editor's citation card and the PDF's open the same thing
//! (`onOpenCitation`): the paper in its reader when Papers has its text or
//! overview, else its source on the web (the entry's own address, its DOI's
//! resolver, or arXiv's PDF).
//!
//! And the key cards over chemnum compound numbers: once a build writes a
//! PDF, what chemnum numbered in it (its `.aux` files) goes to the live PDF
//! (`compiledCompoundNumbers` in `compound-project.ts`).
//!
//! A cited paper Papers can fetch but has not is fetched first and opened
//! when it arrives, as a Papers row does (`fetchAndOpenPaper`); when the
//! download fails, its source opens after the error.

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Window};
use lattice_core::papers::PaperSummary;
use lattice_editor::index::Citation;

use super::Shell;
use crate::{
    papers::{PapersPanel, model as paper_model},
    pdf::{CitationLookup, PdfPanel},
};

/// A download Papers started has come back (`fetchAndOpenPaper`'s answer):
/// `key` is the paper's `paper_key`.
pub(crate) struct PaperFetched {
    pub(crate) key: String,
    pub(crate) failed: bool,
}

impl EventEmitter<PaperFetched> for PapersPanel {}

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
                    .is_some_and(|papers| paper_cited(&papers.read(cx).papers, key).is_some());
                readable || citation.as_ref().and_then(source_url).is_some()
            }),
        })
    }

    /// Give `panel` the project's citations.
    pub(super) fn give_citations(&self, panel: &Entity<PdfPanel>, cx: &mut Context<Self>) {
        let lookup = self.citation_lookup(cx);
        panel.update(cx, |panel, cx| panel.set_citations(lookup, cx));
    }

    /// A build of `root_document` wrote the live PDF: its compounds, read
    /// off the main thread, go to it.
    pub(super) fn read_compounds(
        &self,
        root_document: String,
        aux_folder: String,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let read = cx.background_spawn({
            let root = root.clone();
            async move {
                crate::pdf::compounds::read_compound_numbers(&root, &root_document, &aux_folder)
            }
        });
        cx.spawn(async move |this, cx| {
            let numbers = read.await;
            this.update(cx, |this, cx| {
                if this.root(cx).as_deref() != Some(root.as_path()) {
                    return;
                }
                let source = crate::pdf::CompoundSource {
                    root,
                    numbers: std::sync::Arc::new(numbers),
                };
                let pdf = this.pdf.clone();
                pdf.update(cx, |pdf, cx| pdf.set_compounds(Some(source), cx));
            })
            .ok();
        })
        .detach();
    }

    /// A citation card's title: the paper in its reader, fetched first when
    /// Papers can fetch it, else its source.
    pub(super) fn open_citation(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let paper = paper_cited(&self.papers.read(cx).papers, key).cloned();
        if let Some(paper) = paper {
            if paper.has_full_text || paper.has_blog {
                self.open_reader(paper, window, cx);
            } else {
                // Fetched, then opened in its reader (`activate`); a failed
                // download opens the source instead.
                let papers = self.papers.clone();
                let fetching = paper_model::paper_key(&paper);
                let source = self.citation_source(key, cx);
                self.citation_fetch = Some(cx.subscribe(
                    &papers,
                    move |this, _, fetched: &PaperFetched, cx| {
                        if fetched.key != fetching {
                            return;
                        }
                        this.citation_fetch = None;
                        if let Some(url) = source.as_deref().filter(|_| fetched.failed) {
                            cx.open_url(url);
                        }
                    },
                ));
                papers.update(cx, |papers, cx| papers.activate(&paper, None, window, cx));
            }
            return;
        }
        if let Some(url) = self.citation_source(key, cx) {
            cx.open_url(&url);
        }
    }

    /// The web source of the project's entry under `key`.
    fn citation_source(&self, key: &str, cx: &App) -> Option<String> {
        let project = self.project.as_ref()?.read(cx);
        source_url(project.index().read(cx).citation(key)?)
    }
}

/// The library's paper cited under `key` that opens (`paperCited`): its
/// text or overview is saved, or Papers can fetch it by its arXiv id or DOI.
fn paper_cited<'a>(papers: &'a [PaperSummary], key: &str) -> Option<&'a PaperSummary> {
    papers.iter().find(|paper| {
        let identified =
            !paper.arxiv_id.is_empty() || paper.doi.as_deref().is_some_and(|doi| !doi.is_empty());
        paper
            .citation_key
            .as_deref()
            .is_some_and(|cited| cited.eq_ignore_ascii_case(key))
            && (paper.has_full_text
                || paper.has_blog
                || (identified && paper_model::can_download(paper)))
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
    fn a_cited_paper_opens_when_papers_has_it_or_can_fetch_it() {
        use crate::papers::model::test_support::{paper, with};
        // `paperCited` in `use-document-surfaces.tsx`.
        let cited = |key: &str| with(paper(key), |p| p.citation_key = Some(key.into()));
        let papers = vec![
            with(cited("read"), |p| p.has_full_text = true),
            with(cited("arxiv"), |p| p.arxiv_id = "1706.03762".into()),
            with(cited("doi-only"), |p| p.doi = Some("10.1000/x".into())),
            cited("bare"),
        ];
        assert!(
            paper_cited(&papers, "READ").is_some(),
            "keys match without case"
        );
        assert!(
            paper_cited(&papers, "arxiv").is_some(),
            "Papers can fetch it"
        );
        // A DOI identifies a work, not a downloadable text (`canDownloadPaper`).
        assert!(paper_cited(&papers, "doi-only").is_none());
        assert!(paper_cited(&papers, "bare").is_none());
        assert!(paper_cited(&papers, "absent").is_none());
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
