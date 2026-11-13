//! The Papers panel's requests of the shell: open a reading file (at a
//! line), and the open document's paper marked in the list.

use std::path::Path;

use gpui::{Context, Entity, Window};

use super::Shell;
use crate::papers::{PapersEvent, PapersPanel};

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
            // Add papers and the literature search are drawn by the shell
            // once they are ported; until then the panel's own box adds one
            // reference at a time.
            PapersEvent::AddPapers(_) | PapersEvent::SearchLiterature(_) => {}
        }
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
