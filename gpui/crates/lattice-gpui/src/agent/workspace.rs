//! The source editor's part of what the Agent is told of the writer's
//! workspace (the inputs the Tauri app's `useAgentContext` builds its host
//! context from): the file in front, the caret, and its selection with its
//! lines, read from the window. The rest of the window's part (the shared
//! selection, the PDF, a document page's own report) is `host_context.rs`.

use editor::{ToOffset as _, ToPoint as _};
use gpui::App;
use language::Point;
use serde_json::{Value, json};

use super::host_context::Selected;
use crate::editor_panel::EditorPanel;

/// More than the host context keeps (12,000 characters); what is past it is
/// only counted, so a longer selection is cut here and its full length sent
/// as `selectionLength`.
const SELECTION_LIMIT: usize = 24_000;

/// A source editor's file, caret and selection.
pub struct EditorState {
    pub relative: String,
    /// `EditorPosition`.
    pub position: Value,
    pub selected: Selected,
}

/// What the source editor `panel` shows.
pub fn of_editor(panel: &EditorPanel, cx: &App) -> EditorState {
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
    let mut selected = Selected::default();
    if start != end {
        let (text, length) = cut_selection(buffer.text_for_range(start..end));
        let first = start_point.row + 1;
        let mut last: Point = end_point;
        // A selection ending at a line's start does not take that line.
        if last.column == 0 && last.row + 1 > first {
            last.row -= 1;
        }
        selected = Selected {
            text,
            length: Some(length),
            lines: Some((first, last.row + 1)),
            pdf_document: None,
        };
    }
    EditorState {
        position: editor_position(&relative, line, column),
        relative,
        selected,
    }
}

/// The trimmed selection cut to `SELECTION_LIMIT` characters, and the
/// trimmed whole's length in UTF-16 units, as the page's `String.length`
/// counts it, read in one pass over the chunks without copying the whole.
fn cut_selection<'a>(chunks: impl IntoIterator<Item = &'a str>) -> (String, usize) {
    let mut text = String::new();
    let (mut kept, mut chars, mut trailing_chars) = (0, 0, 0);
    let (mut length, mut trailing) = (0, 0);
    for c in chunks.into_iter().flat_map(str::chars) {
        if chars == 0 && c.is_whitespace() {
            continue;
        }
        chars += 1;
        length += c.len_utf16();
        if c.is_whitespace() {
            trailing += c.len_utf16();
            trailing_chars += 1;
        } else {
            (trailing, trailing_chars) = (0, 0);
        }
        if kept < SELECTION_LIMIT {
            text.push(c);
            kept += 1;
        }
    }
    if kept > chars - trailing_chars {
        text.truncate(text.trim_end().len());
    }
    (text, length - trailing)
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
        let x = "x".repeat(50_000);
        let (text, length) = cut_selection(["  ", x.as_str(), x.as_str(), "\n "]);
        assert_eq!(length, 100_000);
        assert_eq!(text, "x".repeat(SELECTION_LIMIT));
        // "𝑥" is one character but two UTF-16 units.
        let (_, wide) = cut_selection(["𝑥a"]);
        assert_eq!(wide, 3);
        // A short selection is sent whole, trimmed as `String.trim` would.
        let (short, count) = cut_selection([" \tsee \\cite{a}", " \n\n"]);
        assert_eq!(short, "see \\cite{a}");
        assert_eq!(count, 12);
    }
}
