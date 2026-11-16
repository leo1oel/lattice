//! What a `.tex` editor's citation cards know beyond the bibliography, and
//! the citation reasons filed on its cites (`citation-card-uses.ts`,
//! `citation-reason-editor.ts`, `use-document-surfaces.tsx`):
//!
//! - the library's facts about the cited paper (Open paper, its authors,
//!   Crossref's word), from the Papers panel;
//! - "Cited N× here": this file's uses read from the buffer as it is now,
//!   the other files' from the saved manuscript, read once per scan and
//!   annotation revision, each with the section it sits in, its page and
//!   its reason;
//! - "Why cited" (`why_cited.rs`), from the card or a right-click on the
//!   key;
//! - and each reason's anchor saved again once the text around its cite
//!   has changed and settled, so the context it is found by follows the
//!   writer's edits (`writeBack`).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ops::Range,
    path::PathBuf,
    rc::Rc,
    time::Duration,
};

use gpui::{App, AppContext as _, Context, Entity, Focusable as _, Task, WeakEntity, Window};
use language::BufferSnapshot;
use lattice_core::project::{EditorComment, citation_sites};
use lattice_editor::{
    index::ProjectIndex,
    latex::citation_library::{CitationLibrary, CitationUse, Health, PaperFacts},
};

use super::EditorPanel;
use crate::{
    annotations::{panel::sections_of, reasons, store},
    papers::{PapersPanel, model},
};

mod why_cited;
pub(super) use why_cited::ReasonDraft;

/// How long the text around a reason's cite sits unchanged before its new
/// anchor is saved (`SETTLE_MS`).
const SETTLE: Duration = Duration::from_millis(1200);

/// The other files' uses of each key, as last read.
#[derive(Default)]
struct OtherUses {
    /// What they were read for: the scan's and the annotations' revisions.
    revision: (u64, u64),
    by_key: HashMap<String, Vec<CitationUse>>,
    reading: HashMap<String, Task<()>>,
}

#[derive(Default)]
pub(super) struct CitationLayer {
    /// "Why cited" is open: the card stays away meanwhile.
    pub(super) editing: Rc<Cell<bool>>,
    pub(super) draft: Option<ReasonDraft>,
    others: Rc<RefCell<OtherUses>>,
    _settle: Option<Task<()>>,
}

/// One use's row, from its file's text.
fn rows_in(
    text: &str,
    path: &str,
    key: &str,
    all: &[EditorComment],
    with_ranges: bool,
) -> Vec<CitationUse> {
    let sections = sections_of(text, path);
    let (_, placed) = reasons::placed(text, path, all);
    let reason_at: HashMap<usize, &EditorComment> = all
        .iter()
        .filter_map(|reason| Some((placed.get(&reason.id)?.start, reason)))
        .collect();
    citation_sites(text)
        .into_iter()
        .filter(|site| site.key.eq_ignore_ascii_case(key))
        .map(|site| CitationUse {
            path: path.to_string(),
            line: site.line,
            range: with_ranges.then_some(site.from..site.to),
            section: sections
                .iter()
                .rfind(|(offset, _)| *offset <= site.from)
                .map(|(_, label)| label.clone()),
            page: site.page,
            reason: reason_at.get(&site.from).and_then(|reason| {
                let role = reason.citation.as_ref()?.role.clone();
                let label = crate::papers::role_label(&role)?;
                Some((role, label.into(), reason.body.trim().to_string()))
            }),
        })
        .collect()
}

/// The source the index's entry for `key` cites (its web page, DOI or
/// arXiv preprint), which Open paper opens when the library has no paper.
pub(super) fn citation_source(index: &ProjectIndex, key: &str) -> Option<String> {
    let citation = index.citation(key)?;
    model::citation_source_url(
        citation.url.as_deref(),
        citation.doi.as_deref(),
        citation.arxiv_id.as_deref(),
    )
}

/// The citation library of one editor.
struct PanelCitations {
    panel: WeakEntity<EditorPanel>,
    papers: WeakEntity<PapersPanel>,
    root: PathBuf,
    path: String,
    editing: Rc<Cell<bool>>,
    others: Rc<RefCell<OtherUses>>,
}

impl PanelCitations {
    fn reasons(&self, cx: &App) -> Vec<EditorComment> {
        store::try_store(cx)
            .and_then(|store| {
                store
                    .read(cx)
                    .notes(&self.root)
                    .map(|notes| notes.annotations.clone())
            })
            .unwrap_or_default()
    }

    /// The source the entry for `key` cites, for Open paper without a paper.
    fn source_of(&self, key: &str, cx: &App) -> Option<String> {
        let panel = self.panel.upgrade()?;
        let index = panel.read(cx).project.read(cx).index().clone();
        citation_source(index.read(cx), key)
    }

    /// The other files' uses of `key`; read in the background when the
    /// manuscript or the annotations changed since.
    fn others(&self, key: &str, cx: &mut App) -> Vec<CitationUse> {
        let Some(papers) = self.papers.upgrade() else {
            return Vec::new();
        };
        let revision = (
            papers.read(cx).usage_revision,
            crate::status_counters::annotations_revision(&self.root, cx),
        );
        let lower = key.to_lowercase();
        let mut others = self.others.borrow_mut();
        if others.revision != revision {
            *others = OtherUses {
                revision,
                ..OtherUses::default()
            };
        }
        if let Some(rows) = others.by_key.get(&lower) {
            return rows.clone();
        }
        if others.reading.contains_key(&lower) {
            return Vec::new();
        }
        let scanned: Vec<(String, u32)> = papers
            .read(cx)
            .facts
            .uses
            .as_ref()
            .and_then(|uses| uses.get(&lower))
            .map(|uses| {
                uses.iter()
                    .filter(|usage| usage.path != self.path)
                    .map(|usage| (usage.path.clone(), usage.line))
                    .collect()
            })
            .unwrap_or_default();
        if scanned.is_empty() {
            others.by_key.insert(lower, Vec::new());
            return Vec::new();
        }
        let (root, key, all) = (self.root.clone(), key.to_string(), self.reasons(cx));
        let (cell, panel) = (self.others.clone(), self.panel.clone());
        let task_key = lower.clone();
        let read = cx.spawn(async move |cx| {
            let rows = cx
                .background_spawn(async move {
                    let mut paths: Vec<&String> = scanned.iter().map(|(path, _)| path).collect();
                    paths.sort();
                    paths.dedup();
                    let mut rows = Vec::new();
                    for path in paths {
                        let open: Vec<EditorComment> = all
                            .iter()
                            .filter(|reason| reason.path == *path && !reason.resolved)
                            .cloned()
                            .collect();
                        match std::fs::read_to_string(root.join(path)) {
                            Ok(text) => rows.extend(rows_in(&text, path, &key, &open, false)),
                            // Unreadable: the scan's line still places the row.
                            Err(_) => rows.extend(scanned.iter().filter(|(at, _)| at == path).map(
                                |(path, line)| CitationUse {
                                    path: path.clone(),
                                    line: *line,
                                    range: None,
                                    section: None,
                                    page: None,
                                    reason: None,
                                },
                            )),
                        }
                    }
                    rows
                })
                .await;
            {
                let mut others = cell.borrow_mut();
                if others.revision == revision {
                    others.reading.remove(&task_key);
                    others.by_key.insert(task_key, rows);
                }
            }
            // The card shows them the next time it is drawn.
            panel
                .update(cx, |panel, cx| {
                    panel.lattice.update(cx, |_, cx| cx.notify())
                })
                .ok();
        });
        others.reading.insert(lower, read);
        Vec::new()
    }
}

impl CitationLibrary for PanelCitations {
    fn facts(&self, key: &str, cx: &App) -> PaperFacts {
        let Some(papers) = self.papers.upgrade() else {
            return PaperFacts::default();
        };
        let papers = papers.read(cx);
        let paper = papers.paper_for_key(key);
        let source = self.source_of(key, cx);
        let health = paper.and_then(|paper| {
            let health = paper.citation_health.as_ref()?;
            let fact = match model::health_parts(Some(health)) {
                Some((kind, _)) => Health::Warning(kind),
                None if health.kind == "unknown" => Health::Verified,
                None => return None,
            };
            Some((fact, model::health_title(Some(health))))
        });
        PaperFacts {
            can_open: papers.can_open_citation(key, source.as_deref()),
            authors: paper
                .map(|paper| paper.authors.clone())
                .filter(|authors| !authors.trim().is_empty()),
            health,
        }
    }

    fn uses(&self, key: &str, text: &BufferSnapshot, cx: &mut App) -> Vec<CitationUse> {
        let all = self.reasons(cx);
        let mut rows = rows_in(&text.text(), &self.path, key, &all, true);
        rows.extend(self.others(key, cx));
        rows
    }

    fn path(&self) -> String {
        self.path.clone()
    }

    fn open_paper(&self, key: &str, page: Option<u32>, window: &mut Window, cx: &mut App) {
        let source = self.source_of(key, cx);
        if let Some(papers) = self.papers.upgrade() {
            papers.update(cx, |papers, cx| {
                papers.open_citation(key, page, source, window, cx)
            });
        }
    }

    fn jump(&self, at: &CitationUse, window: &mut Window, cx: &mut App) {
        let Some(panel) = self.panel.upgrade() else {
            return;
        };
        panel.update(cx, |panel, cx| match &at.range {
            Some(range) if at.path == panel.relative => {
                panel.select_bytes(range.clone(), window, cx);
                let editor = panel.editor.focus_handle(cx);
                window.focus(&editor, cx);
            }
            _ => cx.emit(super::EditorPanelEvent::OpenLocation {
                path: at.path.clone(),
                line: at.line,
            }),
        });
    }

    fn files_reasons(&self, cx: &App) -> bool {
        store::try_store(cx).is_some_and(|store| store.read(cx).loaded(&self.root))
    }

    fn why_cited(&self, key: &str, range: Range<usize>, window: &mut Window, cx: &mut App) {
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| panel.open_why_cited(key, range, window, cx));
        }
    }

    fn editing_reason(&self, _: &App) -> bool {
        self.editing.get()
    }
}

impl EditorPanel {
    /// Give this editor's citation cards the library, reasons and uses,
    /// with `papers` for the library; a `.tex` file's only.
    pub(super) fn attach_citations(
        &mut self,
        papers: &Entity<PapersPanel>,
        cx: &mut Context<Self>,
    ) {
        if !lattice_editor::latex::is_tex_source(&self.path) {
            return;
        }
        let library = PanelCitations {
            panel: cx.weak_entity(),
            papers: papers.downgrade(),
            root: self.project_root(cx),
            path: self.relative.clone(),
            editing: self.citations.editing.clone(),
            others: self.citations.others.clone(),
        };
        let slot = self.lattice.read(cx).citation_slot();
        slot.replace(Some(Rc::new(library)));
    }

    /// The byte offset of the character under `position` (window
    /// coordinates), from Zed's editor as the input method asks it.
    pub(super) fn citation_offset_under(
        &self,
        position: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<usize> {
        use gpui::EntityInputHandler as _;
        let editor = self.editor.clone();
        let utf16 = editor.update(cx, |editor, cx| {
            editor.character_index_for_point(position, window, cx)
        })?;
        let snapshot = self.buffer.read(cx).snapshot();
        Some(snapshot.offset_utf16_to_offset(language::OffsetUtf16(utf16)))
    }

    /// Whether a right-click at `offset` lands on a citation key, which
    /// opens "Why cited" there rather than the system menu.
    pub(super) fn why_cited_at(
        &mut self,
        offset: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !lattice_editor::latex::is_tex_source(&self.path) {
            return false;
        }
        let slot = self.lattice.read(cx).citation_slot();
        let Some(library) = slot.borrow().clone() else {
            return false;
        };
        if !library.files_reasons(cx) {
            return false;
        }
        let text = self.buffer.read(cx).text();
        let (start, end) = (offset.saturating_sub(800), (offset + 800).min(text.len()));
        let start = (0..=start)
            .rev()
            .find(|at| text.is_char_boundary(*at))
            .unwrap_or(0);
        let end = (end..=text.len())
            .find(|at| text.is_char_boundary(*at))
            .unwrap_or(text.len());
        let Some(target) =
            lattice_editor::latex::syntax::citation_target(&text[start..end], offset - start)
        else {
            return false;
        };
        let range = target.range.start + start..target.range.end + start;
        self.open_why_cited(&target.key, range, window, cx);
        true
    }

    /// After an edit, save each reason's anchor again once the text around
    /// it settles (`writeBack`).
    pub(super) fn citations_edited(&mut self, cx: &mut Context<Self>) {
        if !lattice_editor::latex::is_tex_source(&self.path) {
            return;
        }
        let root = self.project_root(cx);
        let any = store::try_store(cx).is_some_and(|store| {
            store.read(cx).notes(&root).is_some_and(|notes| {
                !reasons::open_on(&notes.annotations, &self.relative).is_empty()
            })
        });
        if !any {
            return;
        }
        self.citations._settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            this.update(cx, |this, cx| this.write_back_reasons(cx)).ok();
        }));
    }

    fn write_back_reasons(&mut self, cx: &mut Context<Self>) {
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let Some(all) = store
            .read(cx)
            .notes(&root)
            .map(|notes| notes.annotations.clone())
        else {
            return;
        };
        let text = self.buffer.read(cx).text();
        // The Annotations panel tells an orphaned reason by this text.
        crate::annotations::orphans::set_live(&root, &self.relative, Some(text.clone()), cx);
        let (_, placed) = reasons::placed(&text, &self.relative, &all);
        let moves: Vec<(String, reasons::Anchor)> = reasons::open_on(&all, &self.relative)
            .into_iter()
            .filter_map(|reason| {
                let site = placed.get(&reason.id)?.clone();
                let next = reasons::reanchored(&text, reason, site)?;
                // A shift in offsets alone is not saved: the context still
                // finds the cite.
                (next.prefix != reason.prefix
                    || next.suffix != reason.suffix
                    || next.quote != reason.quote)
                    .then(|| (reason.id.clone(), next))
            })
            .collect();
        if moves.is_empty() {
            return;
        }
        // The reason itself did not change, so neither does its updatedAt.
        store.update(cx, |store, cx| {
            store.commit(
                &root,
                |notes| {
                    for (id, next) in &moves {
                        if let Some(item) = notes.annotations.iter_mut().find(|item| &item.id == id)
                        {
                            item.from = next.from;
                            item.to = next.to;
                            item.quote = next.quote.clone();
                            item.prefix = next.prefix.clone();
                            item.suffix = next.suffix.clone();
                        }
                    }
                    true
                },
                cx,
            )
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `latex-hover-cards.test.ts`: the card over `\citep[p.~5]{vaswani2017}`
    /// opens the paper at page 5 (`onOpenCitation("vaswani2017", 5)`); the
    /// card over the same key's bare cite opens it at its start.
    #[test]
    fn the_card_opens_the_paper_at_the_page_its_cite_names() {
        let text = "See \\citep[p.~5]{vaswani2017} and \\cite{vaswani2017}.";
        let rows = rows_in(text, "main.tex", "vaswani2017", &[], true);
        let first = text.find("vaswani2017").unwrap();
        let second = text.rfind("vaswani2017").unwrap();
        let page = |at: usize| {
            lattice_editor::latex::card_uses::hovered_page(&rows, "main.tex", &(at..at + 11))
        };
        assert_eq!(page(first), Some(5));
        assert_eq!(page(second), None);
        let other = lattice_editor::latex::card_uses::hovered_page(
            &rows,
            "other.tex",
            &(first..first + 11),
        );
        assert_eq!(other, None);
    }

    /// `citation-card-uses.ts` `usesIn`: each cite of the key is a row, in
    /// the section it sits in, with its note's page and its reason.
    #[test]
    fn each_cite_is_a_row_in_its_section_with_its_page_and_reason() {
        let text = "\\section{Introduction}\nAs shown~\\cite[p.~5]{Key}.\n\
            \\section{Method}\nWe follow~\\cite{other,key}.\n";
        let at = text.rfind("key").unwrap();
        let author = crate::annotations::model::Author {
            id: "me".into(),
            name: "Me".into(),
        };
        let reason = reasons::new_reason(
            "main.tex",
            text,
            at..at + 3,
            "key",
            "method",
            "Its loss",
            &author,
        )
        .expect("a key is a quote");
        let rows = rows_in(text, "main.tex", "key", &[reason], true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].section.as_deref(), Some("§1 Introduction"));
        assert_eq!(rows[0].page, Some(5));
        assert_eq!(rows[0].line, 2);
        assert!(rows[0].reason.is_none());
        assert_eq!(rows[1].section.as_deref(), Some("§2 Method"));
        assert_eq!(rows[1].range, Some(at..at + 3));
        let (role, _, note) = rows[1].reason.clone().expect("the second cite's reason");
        assert_eq!((role.as_str(), note.as_str()), ("method", "Its loss"));
    }
}
