//! What Lattice's host does with an open board: open it from the file's
//! text, take its text back, merge in an outside change to the file, keep
//! the reader's camera, and follow the app's theme. Lattice's own (not
//! quiet.md's).

use super::history::CaptureUpdateAction;
use super::{BoardEvent, BoardView};
use crate::whiteboard::Board;
use gpui::*;
use serde_json::{Value, json};
use std::sync::Arc;

impl BoardView {
    /// The board in a `.excalidraw` file's text. A file that can't be read
    /// opens empty and read-only (`unreadable`), so nothing overwrites it.
    pub fn open(text: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (board, unreadable) = match Board::from_file(text) {
            Ok(b) => (b, None),
            Err(e) => (Board::default(), Some(e)),
        };
        let mut v = BoardView::new(Arc::new(board.clone()), window, cx);
        // Lattice's defaults (the Tauri board's too): clean strokes, the pen
        // with simulated pressure as Excalidraw 0.18 draws it, and a
        // non-handwritten face for new elements; the canvas is the editor
        // sheet, so the file always says white.
        v.app.current_item_roughness = lattice_board_core::board::consts::ROUGHNESS_ARCHITECT;
        v.app.current_item_stroke_variability =
            lattice_board_core::board::types::StrokeVariability::Variable;
        v.app.current_item_font_family = lattice_board_core::board::consts::font_family::NUNITO;
        v.app.view_background_color = "#ffffff".into();
        v.base = board;
        v.unreadable = unreadable;
        v
    }

    /// The Agent's canvas tool `action` on this board
    /// (`agent_canvas::execute`): a write is one undoable step, saved like
    /// an edit; a board that opened unreadable only lists.
    pub fn agent_canvas(
        &mut self,
        action: &str,
        args: &serde_json::Map<String, Value>,
        cx: &mut Context<Self>,
    ) -> Result<Value, super::agent_canvas::ToolError> {
        let writable = self.unreadable.is_none();
        let (result, next) =
            super::agent_canvas::execute(self.elements(), action, args, writable, &*self.m)?;
        if let Some(next) = next {
            self.apply(
                super::actions::ActionResult::new(
                    Some(next),
                    None,
                    CaptureUpdateAction::Immediately,
                ),
                cx,
            );
        }
        Ok(result)
    }

    /// Where Export image saves first: the board's folder, under its name.
    pub fn set_export_target(&mut self, file: &std::path::Path) {
        let dir = file.parent().map(Into::into).unwrap_or_default();
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.export_target = Some((dir, stem));
    }

    /// Where the board was last laid out, in window coordinates.
    pub fn bounds(&self) -> Bounds<Pixels> {
        self.bounds.get()
    }

    /// Why the file couldn't be read, if it couldn't.
    pub fn unreadable(&self) -> Option<&str> {
        self.unreadable.as_deref()
    }

    /// The file's text as the board is now; marks it as what the file holds.
    pub fn file_text(&mut self) -> String {
        let board = Arc::unwrap_or_clone(self.board());
        let text = board.file_json();
        self.base = board;
        text
    }

    /// The file changed outside (disk, git, Overleaf): its elements merged
    /// with what is open (`Board::reconcile`), not an undo step, as
    /// Excalidraw applies a remote scene (`CaptureUpdateAction.NEVER`).
    pub fn merge_file(&mut self, text: &str, cx: &mut Context<Self>) {
        let Ok(remote) = Board::from_file(text) else {
            return;
        };
        if self.unreadable.take().is_some() {
            // the file is readable again: it is what shows
            self.files = remote.files.clone();
            self.app.apply_exported(&remote.app);
            self.scene.replace_all_elements(remote.elements.clone());
            self.base = remote;
            self.sync_linear();
            self.commit(Some(CaptureUpdateAction::Never), cx);
            return;
        }
        let files = remote.files.clone();
        let app = remote.app.clone();
        let next = Board::reconcile(
            self.scene.elements_including_deleted(),
            &self.base,
            remote.clone(),
        );
        self.files.extend(files);
        self.app.apply_exported(&app);
        self.scene.replace_all_elements(next);
        self.base = remote;
        self.sync_linear();
        self.commit(Some(CaptureUpdateAction::Never), cx);
    }

    /// The reader's camera, kept out of the file: `{ scrollX, scrollY, zoom }`.
    pub fn view_state(&self) -> Value {
        let v = self.viewport();
        json!({ "scrollX": v.scroll_x, "scrollY": v.scroll_y, "zoom": v.zoom })
    }

    /// Puts the camera back where the reader left it.
    pub fn restore_view_state(&mut self, state: &Value, cx: &mut Context<Self>) {
        let num = |k: &str| state.get(k).and_then(Value::as_f64);
        let (Some(scroll_x), Some(scroll_y), Some(zoom)) =
            (num("scrollX"), num("scrollY"), num("zoom"))
        else {
            return;
        };
        if !(zoom.is_finite() && zoom > 0.) {
            return;
        }
        self.fitted = true;
        self.set_viewport(
            super::viewport::Viewport {
                scroll_x,
                scroll_y,
                zoom,
            },
            cx,
        );
        cx.emit(BoardEvent::ViewChanged);
    }
}
