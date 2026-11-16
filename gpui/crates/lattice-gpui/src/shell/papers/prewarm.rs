//! Papers' hover prewarm (`prewarmLikelyPaper` in `use-preview-prewarm.ts`):
//! the pointer resting on a readable paper's row, or the keyboard landing
//! on it, readies the text that paper would open with, so the click that
//! usually follows finds it made.
//!
//! The Tauri app readies the visual editor's code for it, since its editor
//! keeps nothing across mounts. Here the cost of opening is the text's
//! editor itself (the file read, its buffer and its parse), and that can be
//! kept: the shell makes it ahead, outside the dock and the open editors (no
//! tab, nothing the Agent or a save sees), and hands it to the reader when
//! the paper opens, reading the file again first should it have changed.
//!
//! The scheduling is the Tauri app's: the pointer must settle on a row
//! (120 ms) before anything is made, a new target replaces a pending one, a
//! document opening cancels what is pending, the paper already in front is
//! left alone, and at most four are kept, the oldest let go first.

use std::{path::PathBuf, time::Duration};

use gpui::{Context, Entity, Task, Window};
use lattice_core::papers::PaperSummary;

use super::{Shell, preferred_view, reader_key};
use crate::{editor_panel::EditorPanel, papers::model, papers::reader::reading_path};

/// How long the pointer rests on a row before its paper is readied.
const SETTLE: Duration = Duration::from_millis(120);
/// How many readied texts are kept.
const KEPT: usize = 4;

/// What is pending and what has been readied.
#[derive(Default)]
pub(in crate::shell) struct PaperPrewarm {
    /// The text a pending readying is for, and that readying.
    pending: Option<(PathBuf, Task<()>)>,
    /// Editors made ahead, oldest first.
    warmed: Vec<Entity<EditorPanel>>,
}

impl Shell {
    /// The writer is likely to open `paper`: ready its text once the
    /// pointer settles.
    pub(super) fn prewarm_paper(
        &mut self,
        paper: &PaperSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if !model::readable(paper) || self.reader_of(&reader_key(&paper.arxiv_id), cx).is_some() {
            return;
        }
        let remembered = self.documents.paper_views.get(&paper.arxiv_id).copied();
        let view = preferred_view(remembered, paper);
        let path = root.join(reading_path(&paper.arxiv_id, view));
        let prewarm = &self.documents.prewarm;
        let readied = prewarm
            .warmed
            .iter()
            .any(|editor| editor.read(cx).path() == path)
            || prewarm
                .pending
                .as_ref()
                .is_some_and(|(pending, _)| *pending == path);
        if readied || self.open_editor(&path, cx).is_some() {
            return;
        }
        let target = path.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            this.update_in(cx, |this, window, cx| this.ready_text(target, window, cx))
                .ok();
        });
        self.documents.prewarm.pending = Some((path, task));
    }

    /// Make the editor of `path` ahead, kept outside the dock.
    fn ready_text(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let prewarm = &mut self.documents.prewarm;
        if prewarm
            .pending
            .as_ref()
            .is_none_or(|(pending, _)| *pending != path)
        {
            return;
        }
        // Dropping the task that runs this only stops it after this step,
        // its last.
        prewarm.pending = None;
        let Some(project) = self.project.clone() else {
            return;
        };
        if self.open_editor(&path, cx).is_none()
            && let Ok(editor) =
                EditorPanel::open(path, project, self.build_panel.clone(), window, cx)
        {
            let warmed = &mut self.documents.prewarm.warmed;
            warmed.push(editor);
            if warmed.len() > KEPT {
                warmed.remove(0);
            }
        }
    }

    /// A document is opening: what is pending gives way to it.
    pub(in crate::shell) fn cancel_prewarm(&mut self) {
        self.documents.prewarm.pending = None;
    }

    /// The editor readied for `path`, handed over: it is no longer kept here.
    pub(in crate::shell) fn take_prewarmed(
        &mut self,
        path: &std::path::Path,
        cx: &gpui::App,
    ) -> Option<Entity<EditorPanel>> {
        let warmed = &mut self.documents.prewarm.warmed;
        let at = warmed
            .iter()
            .position(|editor| editor.read(cx).path() == path)?;
        Some(warmed.remove(at))
    }

    /// The texts readied ahead, oldest first (for scenarios).
    pub fn prewarmed(&self) -> &[Entity<EditorPanel>] {
        &self.documents.prewarm.warmed
    }
}
