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
        self.show_deck_editable(cx);
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
                self.agent_host_saved(editor, cx);
                self.live_preview.update(cx, |live, _| live.note_saved());
                if let Some(project) = &self.project {
                    project.update(cx, |project, _| project.mark_inputs_changed());
                }
                self.refresh_words(cx);
                self.refresh_outline(window, cx);
            }
            // Settings › Editor & builds › Automatic build: "Manual only"
            // leaves every build to the Build button and ⌘S.
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
            // The paper's reader wrapping the editor names the paper itself.
            EditorPanelEvent::Masthead(_) | EditorPanelEvent::PaperSource(_) => {}
            EditorPanelEvent::Annotation(request) => {
                self.on_annotation_request(request, window, cx)
            }
            EditorPanelEvent::OverleafReview(action) => {
                self.overleaf_review_action(editor, action, window, cx)
            }
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
            EditorPanelEvent::AgentRequest(request) => self.deck_agent_request(request, window, cx),
            EditorPanelEvent::SurfaceContext => self.surface_context_changed(editor, cx),
            EditorPanelEvent::Focused => {
                self.active_editor = Some(editor.downgrade());
                self.live_preview
                    .update(cx, |live, cx| live.note_editor(editor, cx));
                let path = editor.read(cx).path().to_path_buf();
                self.mark_front_paper(Some(&path), cx);
                self.file_tree
                    .update(cx, |tree, cx| tree.set_current(Some(path), cx));
                self.show_outline(cx);
                self.push_agent_workspace(cx);
                self.tell_overleaf_caret(editor, cx);
                self.show_overleaf_carets(cx);
                self.overleaf
                    .update(cx, |bridge, cx| bridge.editor_shown(Some(editor), cx));
            }
            EditorPanelEvent::Typed => {
                // Typing happens in the editor the writer works in.
                self.overleaf.update(cx, |bridge, cx| {
                    bridge.editor_shown(Some(editor), cx);
                    bridge.editor_typed(editor, cx);
                });
            }
            EditorPanelEvent::CaretMoved => {
                self.tell_overleaf_caret(editor, cx);
                if self.active_editor().as_ref() == Some(editor) {
                    self.push_agent_workspace(cx);
                }
            }
            EditorPanelEvent::Symbol {
                kind,
                symbol,
                rename,
            } => {
                self.active_editor = Some(editor.downgrade());
                if *rename {
                    self.begin_rename(*kind, symbol.clone(), window, cx)
                } else {
                    self.show_references(*kind, symbol.clone(), window, cx)
                }
            }
            EditorPanelEvent::PasteImage => {
                self.active_editor = Some(editor.downgrade());
                self.paste_image_as_figure(true, window, cx)
            }
            EditorPanelEvent::InsertFigures(paths) => {
                // Into the editor it was dropped on, front or not.
                self.active_editor = Some(editor.downgrade());
                self.insert_figures(paths.clone(), window, cx)
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
        if super::papers::is_reader_key(&active) {
            // A reader is the document in front: its own paper is the open
            // one, whether or not the dock has drawn its tab yet.
            match self.reader_of(&active, cx) {
                Some(reader) => {
                    let path = root.join(reader.read(cx).path());
                    self.mark_paper(&path, cx);
                }
                None => self.mark_front_paper(None, cx),
            }
            return;
        }
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
        // A paper's text stands in its reader's tab: the file going takes
        // the reader with it.
        let holder = self.reader_holding(editor, cx);
        if let Some(view) = holder
            .and_then(|reader| self.view_of_panel(reader.entity_id()))
            .or_else(|| self.view_of_editor(editor))
        {
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
            self.overleaf
                .update(cx, |bridge, cx| bridge.editor_shown(None, cx));
        }
        cx.notify();
    }
}
