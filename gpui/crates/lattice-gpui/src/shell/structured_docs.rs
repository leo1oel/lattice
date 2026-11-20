//! What the window does with a structured document's news
//! (`use-document-surfaces.tsx`): an Open Slide deck's selection and pending
//! edits go to the Agent as its `presentation` context, and a deck with an
//! uncommitted edit is kept out of Overleaf uploads until it lands. A deck
//! is editable as its file is (`editorEditableForPath`): a read-only role
//! on a linked Overleaf project, or a running compile repair, shows it as it is.

use gpui::{Context, Entity};

use super::Shell;
use crate::editor_panel::EditorPanel;

impl Shell {
    /// Each open editor, its source and any deck or visual Markdown editor,
    /// is editable as its file is (`editorEditableForPath`): not while a
    /// compile repair runs, nor where the Overleaf link keeps it read-only.
    pub(super) fn show_editable(&mut self, cx: &mut Context<Self>) {
        let repairing = self.build_panel.read(cx).repair_busy();
        for editor in self.open_editors() {
            let panel = editor.read(cx);
            let editable = !repairing && self.overleaf.read(cx).may_edit(panel.relative());
            let zed = panel.editor().clone();
            let document = panel.structured().or(panel.markdown_document()).cloned();
            let changed = zed.update(cx, |zed, cx| {
                let changed = zed.read_only(cx) == editable;
                if changed {
                    zed.set_read_only(!editable);
                    cx.notify();
                }
                changed
            });
            // Conflict choices show only where the file can be edited.
            if changed {
                editor.update(cx, |panel, cx| panel.paint_conflicts(cx));
            }
            if let Some(document) = document {
                document.update(cx, |document, cx| document.set_editable(editable, cx));
            }
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
        // The paper in front's reading text reports its selection too.
        let paper_text = self
            .agent_paper(cx)
            .is_some_and(|reader| reader.read(cx).editor() == Some(editor));
        if self.active_editor().as_ref() == Some(editor) || paper_text {
            self.push_agent_workspace(cx);
        }
    }
}
