//! The Papers panel's requests of the shell: open a reading file (at a
//! line), and the open document's paper marked in the list.

use std::path::Path;

use gpui::{AppContext as _, Context, Entity, Window};

use super::Shell;
use crate::papers::{
    PapersEvent, PapersPanel,
    add_sheet::{AddPapers, AddPapersEvent},
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
            // The literature search is drawn by the shell once it is
            // ported; until then a title the library lacks is looked up
            // through Add papers.
            PapersEvent::SearchLiterature(query) => self.open_add_papers(query.clone(), window, cx),
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
