//! What the panel does as its editor's caret, focus and scroll change: the
//! status bar's line and column and Overleaf's caret follow the caret, the
//! `.bib` list follows it, diagnostics know whether the text has the
//! keyboard, a Markdown file's Split and a `.tex` file's highlights follow
//! the scroll, both are kept as the file's place (`place_memory.rs`), and
//! leaving the editor saves at once, as the Tauri app does.

use editor::{Editor, EditorEvent, ToPoint as _};
use gpui::{Context, Entity};
use language::Point;

use super::{EditorPanel, EditorPanelEvent, overleaf_carets};
use crate::editor_status;

impl EditorPanel {
    pub(super) fn on_editor_event(
        &mut self,
        editor: Entity<Editor>,
        event: &EditorEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorEvent::SelectionsChanged { .. } => {
                let editor = editor.read(cx);
                let snapshot = editor.buffer().read(cx).snapshot(cx);
                let head = editor.selections.newest_anchor().head().to_point(&snapshot);
                let line_start = Point::new(head.row, 0);
                let column = editor_status::caret_column(snapshot.text_for_range(line_start..head));
                let line = head.row + 1;
                let moved = self.cursor.0 != line;
                self.cursor = (line, column);
                self.overleaf_caret = (
                    head.row,
                    overleaf_carets::utf16_units(snapshot.text_for_range(line_start..head)),
                );
                self.bib_follow_caret(cx);
                if moved {
                    cx.emit(EditorPanelEvent::CaretLine);
                }
                cx.emit(EditorPanelEvent::CaretMoved);
                self.place_changed(cx);
                cx.notify();
            }
            EditorEvent::Focused => {
                self.bib_source_focused(true);
                if let Some(diagnostics) = &self.diagnostics {
                    diagnostics.update(cx, |diagnostics, cx| diagnostics.set_focused(true, cx));
                }
                cx.emit(EditorPanelEvent::Focused);
            }
            // A Markdown file's Split: the visual editor follows; a
            // `.tex` file's highlights are painted where it shows.
            EditorEvent::ScrollPositionChanged { .. } => {
                self.markdown_source_scrolled(cx);
                self.highlights_shown(cx);
                self.place_changed(cx);
            }
            // Leaving the editor saves at once, as the Tauri app does.
            EditorEvent::Blurred => {
                self.bib_source_focused(false);
                if let Some(diagnostics) = &self.diagnostics {
                    diagnostics.update(cx, |diagnostics, cx| diagnostics.set_focused(false, cx));
                }
                self.leave(cx)
            }
            _ => {}
        }
    }
}
