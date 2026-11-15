//! Export review PDF (`review-pdf-sheet.tsx`): a copy of the PDF on screen
//! that carries the annotations the writer ticks as standard PDF comments,
//! for a collaborator who reads in Preview, Acrobat or Zotero rather than in
//! Lattice. Opening the sheet finds each annotation on that PDF
//! (`review_place.rs`), off the main thread; unticked notes stay private,
//! and the plain PDF and the project are not touched. Page 1 also gets a
//! note saying when the PDF was built and exported, so a reply can be
//! matched to the version it was about. lattice-core's `review_pdf` writes
//! the copy, refusing a PDF rebuilt since the notes were placed.

use std::{collections::HashSet, path::PathBuf};

use chrono::{DateTime, Local};
use gpui::{
    AnyElement, AppContext as _, Context, EventEmitter, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Task, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::{
    project::EditorComment,
    review_pdf::{ReviewMark, ReviewNote, ReviewPdf},
};
use lattice_i18n::{Locale, fill_named, locale, t, tr};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, LayerPlacement, ModalLayer, Sheet},
    tokens::{RADIUS_SURFACE, SPACING_2, SPACING_3, SPACING_4, SPACING_5, SPACING_6},
};

use super::{
    ReviewSource,
    review_place::{ReviewPlacement, review_file_name, separate_notes, short_quote},
};
use crate::annotations::{
    card,
    model::{self, Intent, Status},
};

/// The cover note's id, in its `/NM`.
const COVER_ID: &str = "review-cover";

/// What the sheet asks of the window.
pub enum ReviewSheetEvent {
    Close,
}

pub struct ReviewSheet {
    /// The PDF on screen; `None` when there is none to annotate.
    source: Option<ReviewSource>,
    /// The project's numbered notes as they were when the sheet opened.
    notes: Vec<EditorComment>,
    author: String,
    placements: Option<Vec<ReviewPlacement>>,
    selected: HashSet<String>,
    with_replies: bool,
    busy: bool,
    error: Option<SharedString>,
    _placing: Option<Task<()>>,
}

impl EventEmitter<ReviewSheetEvent> for ReviewSheet {}

impl ReviewSheet {
    /// The sheet over `source`, for `annotations` (the local ones; an
    /// Overleaf thread has no number), signed by `author`.
    pub fn new(
        source: Option<ReviewSource>,
        annotations: Vec<EditorComment>,
        author: String,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut notes: Vec<_> = annotations
            .into_iter()
            .filter(|note| note.number > 0)
            .collect();
        notes.sort_by_key(|note| note.number);
        let placing = source.clone().filter(|_| !notes.is_empty()).map(|source| {
            let wanted = notes.clone();
            let placing = cx.background_spawn(async move { source.place(&wanted) });
            cx.spawn(async move |this, cx| {
                let placed = placing.await;
                this.update(cx, |this, cx| {
                    // What a collaborator should see: every open note on the PDF.
                    this.selected = this
                        .notes
                        .iter()
                        .zip(&placed)
                        .filter(|(note, place)| !note.resolved && place.page().is_some())
                        .map(|(note, _)| note.id.clone())
                        .collect();
                    this.placements = Some(placed);
                    cx.notify();
                })
                .ok();
            })
        });
        Self {
            source,
            notes,
            author,
            placements: None,
            selected: HashSet::new(),
            with_replies: true,
            busy: false,
            error: None,
            _placing: placing,
        }
    }

    fn placement(&self, ix: usize) -> Option<&ReviewPlacement> {
        self.placements.as_ref()?.get(ix)
    }

    /// The notes that can be ticked (on this PDF), and those ticked.
    fn placeable(&self) -> Vec<usize> {
        (0..self.notes.len())
            .filter(|ix| {
                self.placement(*ix)
                    .is_some_and(|place| place.page().is_some())
            })
            .collect()
    }

    fn chosen(&self) -> Vec<usize> {
        self.placeable()
            .into_iter()
            .filter(|ix| self.selected.contains(&self.notes[*ix].id))
            .collect()
    }

    /// The comment a reader shows: its pin and intent, the note, what it is
    /// about, and its replies.
    fn contents_of(&self, note: &EditorComment, placement: &ReviewPlacement) -> String {
        let heading = match note.intent.as_deref().and_then(Intent::parse) {
            Some(intent) => format!("#{} {}", note.number, intent.label()),
            None => format!("#{}", note.number),
        };
        let mut parts = vec![heading, note.body.trim().to_string()];
        // A highlight shows its words; a margin note says which they are.
        if matches!(placement, ReviewPlacement::Note { .. }) {
            parts.push(t!("On “{0}”", short_quote(&note.quote)));
        }
        if self.with_replies && !note.replies.is_empty() {
            parts.push(
                note.replies
                    .iter()
                    .map(|reply| {
                        format!(
                            "{}: {}",
                            model::author_display(&reply.author_name),
                            reply.body.trim()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        parts.retain(|part| !part.is_empty());
        parts.join("\n\n")
    }

    /// The copy's notes: the cover on page 1, then each ticked note.
    fn review(&self, exported: DateTime<Local>) -> Option<(ReviewPdf, PathBuf)> {
        let source = self.source.as_ref()?;
        let placements = self.placements.as_ref()?;
        let chosen = self.chosen();
        if chosen.is_empty() {
            return None;
        }
        let count = if chosen.len() == 1 {
            t!("1 note").to_string()
        } else {
            t!("{0} notes", chosen.len())
        };
        let when = format_date(exported, locale());
        let mut cover = vec![fill_named(
            tr("Review copy exported from Lattice on {0}, with {count}."),
            &[("0", &when), ("count", &count)],
        )];
        if let Some(built) = source.built {
            cover.push(t!(
                "The PDF was built on {0}.",
                format_date(built.into(), locale())
            ));
        }
        cover.push(
            t!("Each note is a comment on the passage it is about; reply in your PDF reader and send the file back.")
                .to_string(),
        );
        let (width, height) = source.sizes.first().copied().unwrap_or((612., 792.));
        // The cover stands in page 1's top right corner; notes in that
        // margin make way for it.
        let spaced = separate_notes(
            std::iter::once(ReviewPlacement::Note {
                page: 0,
                x: f64::from(width) - 26.,
                y: f64::from(height) - 8.,
            })
            .chain(chosen.iter().map(|ix| placements[*ix].clone()))
            .collect(),
        );
        let stamp = exported.to_rfc3339();
        let mark = |placement: &ReviewPlacement| match placement {
            ReviewPlacement::Highlight { page, quads } => Some((
                *page as u32 + 1,
                ReviewMark::Highlight {
                    quads: quads.clone(),
                },
            )),
            ReviewPlacement::Note { page, x, y } => {
                Some((*page as u32 + 1, ReviewMark::Note { x: *x, y: *y }))
            }
            ReviewPlacement::Unplaced => None,
        };
        let mut notes = Vec::new();
        let (page, cover_mark) = mark(&spaced[0])?;
        notes.push(ReviewNote {
            id: COVER_ID.into(),
            page,
            mark: cover_mark,
            contents: cover.join("\n"),
            author: model::author_display(&self.author),
            created: stamp.clone(),
            modified: stamp,
        });
        for (ix, placement) in chosen.iter().zip(&spaced[1..]) {
            let note = &self.notes[*ix];
            let (page, mark) = mark(placement)?;
            notes.push(ReviewNote {
                id: note.id.clone(),
                page,
                mark,
                contents: self.contents_of(note, placement),
                author: model::author_display(&note.author_name),
                created: note.created_at.clone(),
                modified: note.updated_at.clone(),
            });
        }
        Some((
            ReviewPdf {
                digest: source.digest.clone(),
                notes,
            },
            source.path.clone(),
        ))
    }

    /// Ask where to save the copy, then write it.
    fn export(&mut self, cx: &mut Context<Self>) {
        let Some(source) = self.source.as_ref().filter(|_| !self.busy) else {
            return;
        };
        let directory = source
            .path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| source.root.clone());
        let name = review_file_name(&source.file_name());
        let chosen = cx.prompt_for_new_path(&directory, Some(&name));
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(destination))) = chosen.await {
                this.update(cx, |this, cx| this.export_to(destination, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// Write the copy to `destination`; the sheet closes once it is saved,
    /// and stays, saying why, when it is not.
    pub fn export_to(&mut self, destination: PathBuf, cx: &mut Context<Self>) {
        let Some((review, shown)) = self.review(Local::now()).filter(|_| !self.busy) else {
            return;
        };
        self.busy = true;
        self.error = None;
        cx.notify();
        let writing = cx.background_spawn(async move {
            let bytes = std::fs::read(&shown).map_err(|error| error.to_string())?;
            let annotated = lattice_core::review_pdf::annotate(bytes, &review)?;
            lattice_core::export::save(&destination, &annotated, &lattice_core::export::PDF)
        });
        cx.spawn(async move |this, cx| {
            let written = writing.await;
            this.update(cx, |this, cx| match written {
                Ok(path) => {
                    crate::notices::show(
                        crate::notices::Notice::new(
                            lattice_ui::components::ToastLevel::Success,
                            t!("Export review PDF"),
                        )
                        .source("PDF")
                        .detail(fill_named(tr("Saved to {path}"), &[("path", &path)])),
                        cx,
                    );
                    cx.emit(ReviewSheetEvent::Close);
                }
                Err(error) => {
                    this.busy = false;
                    this.error = Some(error.into());
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Where each note lands, for a scenario: its id and placement kind
    /// (`highlight`, `note`, `unplaced`), once placed.
    pub fn placed(&self) -> Option<Vec<(String, &'static str)>> {
        let placements = self.placements.as_ref()?;
        Some(
            self.notes
                .iter()
                .zip(placements)
                .map(|(note, place)| {
                    let kind = match place {
                        ReviewPlacement::Highlight { .. } => "highlight",
                        ReviewPlacement::Note { .. } => "note",
                        ReviewPlacement::Unplaced => "unplaced",
                    };
                    (note.id.clone(), kind)
                })
                .collect(),
        )
    }

    /// The ticked notes' ids, for a scenario.
    pub fn ticked(&self) -> Vec<String> {
        self.chosen()
            .into_iter()
            .map(|ix| self.notes[ix].id.clone())
            .collect()
    }

    /// Why the last export failed, for a scenario.
    pub fn failure(&self) -> Option<&str> {
        self.error.as_deref()
    }

    fn close(cx: &mut Context<Self>) {
        cx.emit(ReviewSheetEvent::Close);
    }
}

/// A date and time as `Intl.DateTimeFormat` with `dateStyle: "medium",
/// timeStyle: "short"` writes it.
fn format_date(when: DateTime<Local>, locale: Locale) -> String {
    if locale.is_chinese() {
        when.format("%Y年%-m月%-d日 %H:%M").to_string()
    } else {
        when.format("%b %-d, %Y, %-I:%M\u{202f}%p").to_string()
    }
}

mod view;
