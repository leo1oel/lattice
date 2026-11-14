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
/// only counted, so a longer selection is cut here and its length kept.
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
        "editorPosition": { "path": relative, "line": line, "column": column },
        "activeSurface": "editor",
    });
    if start != end {
        let text: String = buffer
            .text_for_range(start..end)
            .flat_map(str::chars)
            .take(SELECTION_LIMIT)
            .collect();
        let first = start_point.row + 1;
        let mut last: Point = end_point;
        // A selection ending at a line's start does not take that line.
        if last.column == 0 && last.row + 1 > first {
            last.row -= 1;
        }
        workspace["selection"] = json!(text);
        workspace["selectionSource"] = json!("editor");
        workspace["selectionLines"] = json!({ "start": first, "end": last.row + 1 });
    }
    workspace
}
