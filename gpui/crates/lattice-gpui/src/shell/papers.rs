//! The Papers panel's requests of the shell: open a reading file (at a
//! line), and the open document's paper marked in the list.

use std::path::Path;

use gpui::{AppContext as _, Context, Entity, Window};

use super::Shell;
use crate::papers::{
    PapersEvent, PapersPanel,
    add_sheet::{AddPapers, AddPapersEvent},
    audit::{Audit, AuditEvent},
    literature::{Literature, LiteratureEvent},
};

impl Shell {
    pub(super) fn on_papers_event(
        &mut self,
        _: &Entity<PapersPanel>,
        event: &PapersEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PapersEvent::Open { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), *line, window, cx);
                }
            }
            PapersEvent::AddPapers(seed) => self.open_add_papers(seed.clone(), window, cx),
            PapersEvent::SearchLiterature(query) => self.open_literature(query.clone(), window, cx),
            PapersEvent::CheckReferences => self.open_audit(window, cx),
        }
    }

    /// Add papers, over the window like the project's other sheets.
    fn open_add_papers(&mut self, seed: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() {
            return;
        }
        self.dismiss_overlays_for_documents(cx);
        let papers = self.papers.clone();
        let view = cx.new(|cx| AddPapers::new(papers, seed, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AddPapersEvent::Dismiss => this.close_document_overlays(window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.add_papers = Some(view);
        cx.notify();
    }

    /// Discover literature, a drawer at the window's right edge.
    fn open_literature(&mut self, query: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() {
            return;
        }
        self.dismiss_overlays_for_documents(cx);
        let papers = self.papers.clone();
        let view = cx.new(|cx| Literature::new(papers, query, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            LiteratureEvent::Dismiss => this.close_document_overlays(window, cx),
            LiteratureEvent::AddCitation(seed) => this.open_add_papers(seed.clone(), window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.literature = Some(view);
        cx.notify();
    }

    /// Check references, over the window like the project's other sheets.
    fn open_audit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.dismiss_overlays_for_documents(cx);
        // The check reads the files on disk: what the editors hold is saved
        // first, in the background, as the Tauri app's `onPrepare` does.
        self.save_in_background(cx);
        let view = cx.new(|cx| Audit::new(root, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            AuditEvent::Dismiss => this.close_document_overlays(window, cx),
            AuditEvent::OpenSource { path, line } => {
                if let Some(root) = this.root(cx) {
                    this.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            AuditEvent::Applied => {
                for editor in this.open_editors() {
                    editor.update(cx, |editor, cx| editor.check_disk(cx));
                }
                this.papers.update(cx, |papers, cx| papers.reload(cx));
            }
        })
        .detach();
        self.documents.audit = Some(view);
        cx.notify();
    }

    /// Check references, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn audit(&self) -> Option<&Entity<Audit>> {
        self.documents.audit.as_ref()
    }

    /// Add papers, while it is up, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn add_papers(&self) -> Option<&Entity<AddPapers>> {
        self.documents.add_papers.as_ref()
    }

    /// The paper whose reading file `path` is, marked as the open one.
    pub(super) fn mark_paper(&mut self, path: &Path, cx: &mut Context<Self>) {
        let relative = self
            .root(cx)
            .and_then(|root| path.strip_prefix(&root).ok().map(Path::to_path_buf));
        let relative = relative.map(|path| path.to_string_lossy().replace('\\', "/"));
        self.papers.update(cx, |papers, cx| {
            papers.set_active_path(relative.as_deref(), cx)
        });
    }
}
