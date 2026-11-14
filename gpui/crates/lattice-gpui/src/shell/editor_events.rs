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
                self.live_preview.update(cx, |live, _| live.note_saved());
                if let Some(project) = &self.project {
                    project.update(cx, |project, _| project.mark_inputs_changed());
                }
                self.refresh_words(cx);
                self.refresh_outline(window, cx);
            }
            // Settings › Editor & builds › Automatic build: "Manual only"
            // leaves every build to the Build button and ⌘B.
            EditorPanelEvent::SavedForBuild | EditorPanelEvent::DiskEdit => {
                if crate::settings::builds_automatically(cx)
                    && !self.defer_automatic_build(window, cx)
                {
                    self.run_build(BuildRequest::automatic(), window, cx);
                }
            }
            // The live preview follows the editor in front, as the Tauri
            // app's follows its open file.
            EditorPanelEvent::Edited => {
                if self.active_editor().as_ref() == Some(editor) {
                    self.live_preview
                        .update(cx, |live, cx| live.note_editor(editor, cx));
                }
            }
            EditorPanelEvent::Close => self.close_editor(editor, window, cx),
            EditorPanelEvent::OpenLocation { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            EditorPanelEvent::OpenFile { path } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), None, window, cx);
                }
            }
            EditorPanelEvent::OutlineJump { path, line } => {
                self.jump_to_heading(path, *line, window, cx)
            }
            EditorPanelEvent::Focused => {
                self.active_editor = Some(editor.downgrade());
                self.live_preview
                    .update(cx, |live, cx| live.note_editor(editor, cx));
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
