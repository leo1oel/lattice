//! The shell's editors: the one open on a path, opening one, the ones still
//! open, and the one the writer was last in.

use std::path::Path;

use gpui::{App, Context, Entity, Focusable as _, WeakEntity, Window};

use super::Shell;
use crate::editor_panel::EditorPanel;

impl Shell {
    /// The editor already open on `path`, if any.
    pub(crate) fn open_editor(&mut self, path: &Path, cx: &App) -> Option<Entity<EditorPanel>> {
        self.open_editors()
            .into_iter()
            .find(|editor| editor.read(cx).path() == path)
    }

    /// The editor on `path`, opened if it is not yet; it is not placed in
    /// the dock.
    pub(crate) fn editor_for(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<EditorPanel>> {
        if let Some(editor) = self.open_editor(path, cx) {
            return Some(editor);
        }
        let project = self.project.clone()?;
        match EditorPanel::open(
            path.to_path_buf(),
            project,
            self.build_panel.clone(),
            window,
            cx,
        ) {
            Ok(editor) => {
                let papers = self.papers.clone();
                editor.update(cx, |editor, cx| {
                    editor.set_papers(papers, cx);
                    // Where the file was left, in this run or an earlier
                    // one; an open at a line of its own moves on from it.
                    editor.restore_place(window, cx);
                });
                self.adopt_editor(&editor, window, cx);
                let weak = editor.downgrade();
                cx.on_focus_in(&editor.focus_handle(cx), window, move |this, _, _| {
                    this.active_editor = Some(weak.clone());
                })
                .detach();
                Some(editor)
            }
            Err(error) => {
                let root = self.project.as_ref().map(|project| project.read(cx).root().to_path_buf());
                super::open_failure::show(&error, root.as_deref(), path, cx);
                None
            }
        }
    }

    pub(crate) fn open_editors(&mut self) -> Vec<Entity<EditorPanel>> {
        self.editors.retain(|editor| editor.upgrade().is_some());
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .collect()
    }

    /// Proofread, polish or (with no ask) rewrite the selection of the
    /// editor in front, focused again first.
    pub(crate) fn proofread_in_front(
        &mut self,
        ask: Option<lattice_editor::proofread::Ask>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        let source = editor.read(cx).editor().focus_handle(cx);
        window.focus(&source, cx);
        editor.update(cx, |editor, cx| editor.proofread_action(ask, window, cx));
    }

    /// The editor the writer was last in, if it is still open.
    pub(crate) fn active_editor(&self) -> Option<Entity<EditorPanel>> {
        self.active_editor.as_ref().and_then(WeakEntity::upgrade)
    }
}
