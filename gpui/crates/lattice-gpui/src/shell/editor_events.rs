//! What the shell does when an editor reports: a save refreshes the word
//! counts and the outline, a save after a pause builds, a deleted file's tab
//! closes, a card or outline row opens its place, and the editor in front
//! marks its file in the tree and its section in the outline.

use gpui::{Context, Entity, Window};

use super::{Shell, build::BuildRequest};
use crate::editor_panel::{EditorPanel, EditorPanelEvent};

impl Shell {
    /// Follow a newly opened editor's reports, and give its outline rail the
    /// manuscript's outline.
    pub(super) fn adopt_editor(
        &mut self,
        editor: &Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.subscribe_in(editor, window, Self::on_editor_event)
            .detach();
        self.editors.push(editor.downgrade());
        self.show_outline(cx);
    }

    pub(super) fn on_editor_event(
        &mut self,
        editor: &Entity<EditorPanel>,
        event: &EditorPanelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorPanelEvent::Saved => {
                if let Some(project) = &self.project {
                    project.update(cx, |project, _| project.mark_inputs_changed());
                }
                self.refresh_words(cx);
                self.refresh_outline(window, cx);
            }
            // Settings › Editor & builds › Automatic build: "Manual only"
            // leaves every build to the Build button and ⌘B.
            EditorPanelEvent::SavedForBuild | EditorPanelEvent::DiskEdit => {
                if crate::settings::builds_automatically(cx) {
                    self.run_build(BuildRequest::automatic(), window, cx);
                }
            }
            EditorPanelEvent::Close => self.close_editor(editor, window, cx),
            EditorPanelEvent::OpenLocation { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            EditorPanelEvent::OutlineJump { path, line } => {
                self.jump_to_heading(path, *line, window, cx)
            }
            EditorPanelEvent::Focused => {
                self.active_editor = Some(editor.downgrade());
                let path = editor.read(cx).path().to_path_buf();
                self.file_tree
                    .update(cx, |tree, cx| tree.set_current(Some(path), cx));
                self.show_outline(cx);
            }
            EditorPanelEvent::CaretLine => {
                if self.active_editor().as_ref() == Some(editor) {
                    self.show_outline(cx);
                }
            }
        }
    }

    /// The Project tree marks the document in front, and Papers the paper
    /// it is, whichever tab brought it there.
    pub(super) fn follow_active_document(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(active) = self.active_document(cx) else {
            // A reader closed with no document behind it leaves no paper
            // open.
            self.mark_front_paper(None, cx);
            return;
        };
        let path = root.join(active);
        self.mark_front_paper(Some(&path), cx);
        self.file_tree
            .update(cx, |tree, cx| tree.set_current(Some(path), cx));
    }

    /// Close an editor's tab, wherever it is, without asking: its file is
    /// gone.
    pub(super) fn close_editor(
        &mut self,
        editor: &Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(view) = self.view_of_editor(editor) {
            self.engine_do(cx, |engine| engine.close(&view));
        }
        let _ = window;
        self.editors
            .retain(|open| open.upgrade().is_some_and(|open| open != *editor));
        if self
            .active_editor
            .as_ref()
            .is_some_and(|active| active.upgrade().as_ref() == Some(editor))
        {
            self.active_editor = None;
            self.show_outline(cx);
        }
        cx.notify();
    }
}
