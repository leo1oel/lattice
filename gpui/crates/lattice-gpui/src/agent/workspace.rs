//! What the Agent is told of the writer's workspace: the inputs the Tauri
//! app's `useAgentContext` builds its host context from (the file in front,
//! the caret, the one shared selection and the surface that owns it), read
//! from the window. The page builds the snapshot itself with the Tauri app's
//! `buildAgentHostContext`, so its shape and bounds stay that module's.
//!
//! The selection the Agent sees is the front editor's, with its lines; a PDF
//! or Papers selection is not reported yet (the PDF viewer's text selection
//! is copied, not shared, and the papers library is not in the GPUI app).

use editor::{ToOffset as _, ToPoint as _};
use gpui::App;
use language::Point;
use serde_json::{Value, json};

use crate::editor_panel::EditorPanel;

/// More than the host context keeps (12,000 characters); what is past it is
/// only counted, so a longer selection is cut here and its full length sent
/// as `selectionLength`.
const SELECTION_LIMIT: usize = 24_000;

/// The workspace with `panel` in front, or with no editor at all.
pub fn of_editor(panel: Option<&EditorPanel>, cx: &App) -> Value {
    let Some(panel) = panel else {
        return json!({ "activeFile": "", "editorPosition": null, "activeSurface": "editor" });
    };
    let relative = panel.relative().to_string();
    let (line, column) = panel.cursor();
    let editor = panel.editor().read(cx);
    let buffer = editor.buffer().read(cx).snapshot(cx);
    let selection = editor.selections.newest_anchor();
    let (start, end) = (
        selection.start.to_offset(&buffer),
        selection.end.to_offset(&buffer),
    );
    let (start_point, end_point) = (
        selection.start.to_point(&buffer),
        selection.end.to_point(&buffer),
    );
    let (start, end) = (start.min(end), start.max(end));
    let (start_point, end_point) = (start_point.min(end_point), start_point.max(end_point));
    let mut workspace = json!({
        "activeFile": relative,
        "editorPosition": editor_position(&relative, line, column),
        "activeSurface": "editor",
    });
    if start != end {
        let full: String = buffer.text_for_range(start..end).collect();
        let (text, length) = cut_selection(&full);
        let first = start_point.row + 1;
        let mut last: Point = end_point;
        // A selection ending at a line's start does not take that line.
        if last.column == 0 && last.row + 1 > first {
            last.row -= 1;
        }
        workspace["selection"] = json!(text);
        workspace["selectionLength"] = json!(length);
        workspace["selectionSource"] = json!("editor");
        workspace["selectionLines"] = json!({ "start": first, "end": last.row + 1 });
    }
    workspace
}

/// The trimmed selection cut to `SELECTION_LIMIT` characters, and the
/// trimmed whole's length in UTF-16 units, as the page's `String.length`
/// counts it.
fn cut_selection(full: &str) -> (String, usize) {
    let trimmed = full.trim();
    (
        trimmed.chars().take(SELECTION_LIMIT).collect(),
        trimmed.encode_utf16().count(),
    )
}

/// The caret as the Tauri app's `EditorPosition` holds it: the line 1-based,
/// the column 0-based from the line's start (the status bar's column, from
/// `editor_status::caret_column`, counts from one).
fn editor_position(path: &str, line: u32, column: u32) -> Value {
    json!({ "path": path, "line": line, "column": column.saturating_sub(1) })
}

#[cfg(test)]
mod tests {
    use super::{SELECTION_LIMIT, cut_selection, editor_position};
    use crate::editor_status::caret_column;

    // The Tauri app's document-canvas.test.tsx: the caret five characters
    // into line 1 is `{ line: 1, column: 5 }`; at a line's start, column 0.
    #[test]
    fn the_caret_column_counts_from_the_line_start() {
        let start = editor_position("main.tex", 3, caret_column([]));
        assert_eq!(start["line"], 3);
        assert_eq!(start["column"], 0);
        let five = editor_position("main.tex", 1, caret_column(["hello"]));
        assert_eq!(five["line"], 1);
        assert_eq!(five["column"], 5);
    }

    // The Tauri app counts the trimmed selection with `String.length`: a
    // 100,000-character selection is that long however much of it is sent.
    #[test]
    fn a_long_selection_is_cut_but_counted_whole() {
        let full = format!("  {}\n", "x".repeat(100_000));
        let (text, length) = cut_selection(&full);
        assert_eq!(length, 100_000);
        assert_eq!(text, "x".repeat(SELECTION_LIMIT));
        // "𝑥" is one character but two UTF-16 units.
        let (_, wide) = cut_selection("𝑥a");
        assert_eq!(wide, 3);
    }
}
