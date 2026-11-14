//! What inserting a figure or a table asks of an editor
//! (`crate::insert`, `shell/insert_flow.rs`): its text and caret, as byte
//! offsets, and one edit with the caret placed after it, undone with ⌘Z as
//! typing is, the keyboard back in the text.

use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _, scroll::Autoscroll};
use gpui::{App, Context, Focusable as _, Window};

use super::EditorPanel;

impl EditorPanel {
    /// Whether figures go into this file: LaTeX or Markdown.
    pub fn inserts_figures(&self) -> bool {
        let relative = self.relative().to_ascii_lowercase();
        relative.ends_with(".tex") || relative.ends_with(".md")
    }

    /// Whether ⌘V here pastes an image as a figure: a LaTeX or Markdown
    /// file, and an image on the clipboard with no text beside it (a copied
    /// passage that carries a picture pastes as text).
    pub fn pastes_image(&self, cx: &App) -> bool {
        if !self.inserts_figures() {
            return false;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let entries = item.entries();
        entries
            .iter()
            .any(|entry| matches!(entry, gpui::ClipboardEntry::Image(_)))
            && !entries
                .iter()
                .any(|entry| matches!(entry, gpui::ClipboardEntry::String(_)))
    }

    /// The buffer's text and the caret's offset in it.
    pub fn text_and_caret(&self, cx: &App) -> (String, usize) {
        let editor = self.editor().read(cx);
        let buffer = editor.buffer().read(cx).snapshot(cx);
        let caret = editor.selections.newest_anchor().head().to_offset(&buffer);
        (buffer.text(), caret.0)
    }

    /// Write `insert` over `from..to` and put the caret at `caret` in the
    /// new text, scrolled into view.
    pub fn replace_range(
        &mut self,
        from: usize,
        to: usize,
        insert: &str,
        caret: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editor = self.editor().clone();
        editor.update(cx, |editor, cx| {
            editor.buffer().update(cx, |buffer, cx| {
                buffer.edit(
                    [(MultiBufferOffset(from)..MultiBufferOffset(to), insert)],
                    None,
                    cx,
                );
            });
            let at = MultiBufferOffset(caret);
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([at..at]),
            );
        });
        window.focus(&editor.focus_handle(cx), cx);
    }
}
