//! What a `.tex` file's Visual page's citation cards know beyond the
//! bibliography, and what they ask (`gpui/islands/latex/citations.ts`), as
//! the Tauri app's canvas gives its editor in Visual mode the same as in
//! Source (`use-document-surfaces.tsx`'s `bibliography`), and as the
//! source's own cards have it here (`citations.rs`):
//!
//! - the library: its papers by citation key (their authors and Crossref's
//!   word), the keys Open paper is offered for, as the Papers panel decides
//!   it (`papers/citation_open.rs`), and the revision of the manuscript's
//!   citation scan, after which a card counts its uses again; sent when the
//!   library is listed again, the scan runs again or the index is read
//!   again (an entry's DOI or URL is what Open paper falls back to);
//! - the project's citation reasons, on every file, and who files one,
//!   sent whenever the annotations change;
//! - a card's Open paper, opened through the source cards' own library,
//!   which hands it to the Papers panel (`PapersPanel::open_citation`);
//! - Why cited's Save and Remove, written to the project's annotations
//!   (`annotations::store`) as the source's popover writes them; only a
//!   citation reason on this file is taken, never another annotation.

use gpui::{Context, Window};
use lattice_core::project::EditorComment;
use lattice_editor::index::ProjectIndex;
use serde_json::{Value, json};

use super::{EditorPanel, citations::citation_source};
use crate::{annotations::store, papers::PapersPanel};

/// The library as the page's citation cards read it (`CitationLibrary`):
/// the papers that carry a citation key, with the fields of `PaperSummary`
/// a card reads, the index's keys Open paper opens, and the scan's revision.
fn library_payload(papers: &PapersPanel, index: &ProjectIndex) -> Value {
    let listed: Vec<Value> = papers
        .papers
        .iter()
        .filter(|paper| paper.citation_key.is_some())
        .map(|paper| {
            let mut entry = json!({
                "arxivId": paper.arxiv_id,
                "title": paper.title,
                "authors": paper.authors,
                "citationKey": paper.citation_key,
                "hasFullText": paper.has_full_text,
                "hasBlog": paper.has_blog,
            });
            if let Some(health) = &paper.citation_health {
                entry["citationHealth"] = json!(health);
            }
            entry
        })
        .collect();
    let openable: Vec<&str> = index
        .citations()
        .iter()
        .filter(|citation| {
            let source = citation_source(index, &citation.key);
            papers.can_open_citation(&citation.key, source.as_deref())
        })
        .map(|citation| citation.key.as_str())
        .collect();
    json!({ "papers": listed, "openable": openable, "revision": papers.usage_revision })
}

/// The project's citation reasons among its annotations, as the page's
/// `EditorComment`s.
fn reasons_payload(annotations: &[EditorComment], author: Value) -> Value {
    let reasons: Vec<&EditorComment> = annotations
        .iter()
        .filter(|comment| comment.citation.is_some())
        .collect();
    json!({ "reasons": reasons, "author": author })
}

impl EditorPanel {
    /// Send the Visual page the library, when its list or citation scan
    /// changed since it was last sent (the Papers panel notifies for much
    /// else), or `force`d after the index was read again.
    pub(super) fn forward_latex_library(&mut self, force: bool, cx: &mut Context<Self>) {
        let (Some(document), Some(papers)) = (
            self.latex_visual_document().cloned(),
            self.bib.papers.clone(),
        ) else {
            return;
        };
        let revision = {
            let papers = papers.read(cx);
            (papers.list_revision, papers.usage_revision)
        };
        if !force && self.latex.library_sent == Some(revision) {
            return;
        }
        self.latex.library_sent = Some(revision);
        let index = self.project.read(cx).index().clone();
        let payload = library_payload(papers.read(cx), index.read(cx));
        document.update(cx, |document, cx| {
            document.set_citation_library(payload, cx)
        });
    }

    /// Send the Visual page the project's citation reasons and who files one.
    pub(super) fn forward_latex_reasons(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex_visual_document().cloned() else {
            return;
        };
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let author = store::author(&root, cx);
        let author = json!({ "id": author.id, "name": author.name });
        let payload = match store.read(cx).notes(&root) {
            Some(notes) => reasons_payload(&notes.annotations, author),
            None => reasons_payload(&[], author),
        };
        document.update(cx, |document, cx| {
            document.set_citation_reasons(payload, cx)
        });
    }

    /// A Visual card's Open paper: what the source's card opens for `key`,
    /// the library's paper, else the source its entry cites. Not through
    /// the source cards' library, which reads this panel, being updated here.
    pub(super) fn open_visual_citation(
        &mut self,
        key: &str,
        page: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(papers) = self.bib.papers.clone() else {
            return;
        };
        let index = self.project.read(cx).index().clone();
        let source = citation_source(index.read(cx), key);
        papers.update(cx, |papers, cx| {
            papers.open_citation(key, page, source, window, cx)
        });
    }

    /// Why cited's Save in the Visual page: `reason` filed, or the reason
    /// with its id replaced (`saveCitationReason`), its change time now.
    pub(super) fn save_visual_reason(&mut self, reason: EditorComment, cx: &mut Context<Self>) {
        if reason.citation.is_none() || reason.path != self.relative {
            return;
        }
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        store.update(cx, |store, cx| {
            match store
                .get(&root, &reason.id)
                .map(|existing| existing.citation.is_some())
            {
                // Only a reason replaces a reason: an id the page got wrong
                // never overwrites a note.
                Some(false) => {}
                Some(true) => {
                    let id = reason.id.clone();
                    store.update(&root, &id, move |item| *item = reason, cx);
                }
                None => {
                    store.commit(
                        &root,
                        |notes| {
                            notes.annotations.push(reason);
                            true
                        },
                        cx,
                    );
                }
            }
        });
    }

    /// Why cited's Remove in the Visual page, with the store's Undo.
    pub(super) fn delete_visual_reason(&mut self, id: &str, cx: &mut Context<Self>) {
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let reason = store
            .read(cx)
            .get(&root, id)
            .is_some_and(|comment| comment.citation.is_some());
        if reason {
            store.update(cx, |store, cx| store.delete(&root, id, cx));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_core::project::CitationReason;

    fn comment(id: &str, citation: Option<&str>) -> EditorComment {
        serde_json::from_value(json!({
            "id": id, "path": "main.tex", "from": 0, "to": 4, "quote": "knuth", "body": "",
            "authorId": "a", "authorName": "A", "createdAt": "", "updatedAt": "",
        }))
        .map(|mut comment: EditorComment| {
            comment.citation = citation.map(|key| CitationReason {
                key: key.into(),
                role: "method".into(),
            });
            comment
        })
        .expect("a comment")
    }

    /// `citation-card-uses.ts` reads the reasons of every file, and the
    /// popover finds a reason by its id among them; a note is no reason.
    #[test]
    fn the_page_gets_every_citation_reason_and_no_note() {
        let payload = reasons_payload(
            &[comment("note", None), comment("why", Some("knuth1984"))],
            json!({ "id": "a", "name": "A" }),
        );
        let ids: Vec<&str> = payload["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reason| reason["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["why"]);
        // As the Tauri app's `EditorComment` names its fields.
        assert_eq!(payload["reasons"][0]["citation"]["key"], "knuth1984");
        assert_eq!(payload["reasons"][0]["authorName"], "A");
        assert_eq!(payload["author"]["name"], "A");
    }
}
