//! What the window does with a structured document's news
//! (`use-document-surfaces.tsx`): an Open Slide deck's selection and pending
//! edits go to the Agent as its `presentation` context, and a deck with an
//! uncommitted edit is kept out of Overleaf uploads until it lands. A deck
//! is editable as its file is (`editorEditableForPath`): a read-only role
//! on a linked Overleaf project shows it as it is.

use gpui::{Context, Entity};

use super::Shell;
use crate::editor_panel::EditorPanel;

impl Shell {
    /// Each open deck and visual Markdown editor is editable, or not, as the
    /// Overleaf link allows.
    pub(super) fn show_deck_editable(&mut self, cx: &mut Context<Self>) {
        for editor in self.open_editors() {
            let panel = editor.read(cx);
            let Some(document) = panel.structured().or(panel.markdown_document()).cloned() else {
                continue;
            };
            let path = editor.read(cx).relative().to_string();
            let editable = self.overleaf.read(cx).may_edit(&path);
            document.update(cx, |document, cx| document.set_editable(editable, cx));
        }
    }

    /// `editor`'s deck or visual Markdown editor reported a new context.
    pub(super) fn surface_context_changed(
        &mut self,
        editor: &Entity<EditorPanel>,
        cx: &mut Context<Self>,
    ) {
        let (path, pending) = {
            let panel = editor.read(cx);
            let pending = panel
                .structured()
                .is_some_and(|document| document.read(cx).deck_pending_edits());
            (panel.relative().to_string(), pending)
        };
        self.overleaf
            .update(cx, |bridge, _| bridge.set_whole_file_draft(&path, pending));
        if self.active_editor().as_ref() == Some(editor) {
            self.push_agent_workspace(cx);
        }
    }
}
