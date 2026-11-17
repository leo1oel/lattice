//! Add reference: a reference entered by hand, reviewed after a lookup, or
//! an entry edited, for the project's bibliography, in the sheet that takes
//! Add papers' place, and what its Save writes.

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_core::papers::PaperSummary;
use lattice_i18n::t;

use super::{Shell, offer_paper_tools};
use crate::notices;
use crate::papers::bib_editor::add::{AddReference, AddReferenceEvent, AddTarget, ProjectSave};

impl Shell {
    /// A reference entered by hand for the project's bibliography, in place
    /// of Add papers.
    pub(super) fn open_add_reference(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() {
            return;
        }
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        let target = AddTarget::Project {
            papers: self.papers.downgrade(),
            save: ProjectSave::Append,
        };
        let view = cx.new(|cx| AddReference::new(target, window, cx));
        view.update(cx, |view, cx| view.focus_lookup(window, cx));
        self.show_add_reference(view, window, cx);
    }

    /// A title the Papers box looked up, in Add reference for review
    /// (`showBibEntry("add", resolved, query)`).
    pub(super) fn review_reference(
        &mut self,
        query: String,
        resolved: lattice_core::models::ResolvedCitation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root(cx).is_none() {
            return;
        }
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        let target = AddTarget::Project {
            papers: self.papers.downgrade(),
            save: ProjectSave::Import,
        };
        let view = cx.new(|cx| AddReference::review(target, query, resolved, window, cx));
        self.show_add_reference(view, window, cx);
    }

    /// Edit bibliography entry (`editBibEntry`): the entry as the file holds
    /// it, in Add reference's form, saved back under its key.
    pub(super) fn edit_entry(
        &mut self,
        paper: PaperSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(root), Some(key)) = (self.root(cx), paper.citation_key) else {
            return;
        };
        self.documents.overlays_opened += 1;
        let opened = self.documents.overlays_opened;
        let (read_root, read_key) = (root.clone(), key.clone());
        let read = cx.background_spawn(async move {
            lattice_core::project::read_bib_entry(&read_root, &read_key)
        });
        cx.spawn_in(window, async move |this, cx| {
            let read = read.await;
            this.update_in(cx, |this, window, cx| {
                if this.root(cx).as_ref() != Some(&root) || this.documents.overlays_opened != opened
                {
                    return;
                }
                let record = match read {
                    Ok(Some(record)) => record,
                    Ok(None) => {
                        let detail = t!(
                            "Couldn't find a bibliography entry for {citationCommand}.",
                            citationCommand = format!("\\cite{{{key}}}")
                        );
                        notices::error(t!("Edit bibliography entry"), detail, cx);
                        return;
                    }
                    Err(error) => {
                        notices::error(t!("Edit bibliography entry"), error, cx);
                        return;
                    }
                };
                if !this.dismiss_overlays_for_documents(cx) {
                    return;
                }
                let papers = this.papers.downgrade();
                let view = cx.new(|cx| AddReference::edit(papers, record, window, cx));
                this.show_add_reference(view, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn show_add_reference(
        &mut self,
        view: Entity<AddReference>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.subscribe_in(&view, window, |this, view, event, window, cx| match event {
            AddReferenceEvent::Dismiss => this.close_document_overlays(window, cx),
            AddReferenceEvent::MissingPaperTools(failure) => offer_paper_tools(failure, cx),
            AddReferenceEvent::Save {
                key,
                entry,
                label,
                how,
                cite,
            } => this.save_reference(
                view.clone(),
                (key.clone(), entry.clone(), label.clone()),
                (*how, *cite),
                window,
                cx,
            ),
        })
        .detach();
        self.documents.add_reference = Some(view);
        cx.notify();
    }

    /// Save Add reference's entry into the project's bibliography
    /// (`saveBibEntry`): what the editors hold is saved first, then a title
    /// the box looked up imports as the box's adds do, and anything else is
    /// written to the file, which the open editors read again.
    fn save_reference(
        &mut self,
        view: Entity<AddReference>,
        (key, entry, label): (String, String, String),
        (how, cite): (ProjectSave, bool),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let saved = self.save_editors(cx);
        cx.spawn_in(window, async move |this, cx| {
            let failed = |error: String, cx: &mut gpui::AsyncWindowContext| {
                view.update(cx, |view, cx| view.save_failed(error, cx));
            };
            if !saved.await {
                failed(t!("Save the open file first.").to_string(), cx);
                return;
            }
            if how == ProjectSave::Import {
                let started = this
                    .update(cx, |this, cx| {
                        this.papers
                            .update(cx, |papers, cx| papers.import_entry(entry, label, cite, cx))
                    })
                    .unwrap_or(false);
                if started {
                    this.update_in(cx, |this, window, cx| {
                        this.close_reference(&view, window, cx)
                    })
                    .ok();
                } else {
                    failed(t!("Another paper is being added").to_string(), cx);
                }
                return;
            }
            let saved_key = key.clone();
            let written = cx
                .background_spawn(async move {
                    lattice_core::project::save_bib_entry(&root, &saved_key, &entry)
                })
                .await;
            match written {
                Ok(()) => {
                    this.update_in(cx, |this, window, cx| {
                        for editor in this.open_editors() {
                            editor.update(cx, |editor, cx| editor.check_disk(cx));
                        }
                        this.papers.update(cx, |papers, cx| papers.reload(cx));
                        this.close_reference(&view, window, cx);
                        if cite && this.latex_source_in_front(cx) {
                            this.insert_at_caret("cite", &key, window, cx);
                        }
                    })
                    .ok();
                }
                Err(error) => failed(error, cx),
            }
        })
        .detach();
    }

    /// Close Add reference once its entry is saved, when it is still the
    /// sheet up.
    fn close_reference(
        &mut self,
        view: &Entity<AddReference>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.documents.add_reference.as_ref() == Some(view) {
            view.update(cx, |view, _| view.saved());
            self.close_document_overlays(window, cx);
        }
    }
}
