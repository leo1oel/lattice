//! The current line, as the Tauri app draws it (`.cm-activeLine::before` in
//! `editor-workspace.css`): a rounded wash in the code theme's line colour
//! under the text, from the line box's start (CodeMirror's 6px of line
//! padding before the text) to 8px short of the line box's end, across
//! every row the line wraps to, with 4px corners. It shows only while the
//! caret is a caret, not a selection, and the gutter keeps no band.
//!
//! Zed's own band runs from edge to edge, so the theme leaves Zed's editor
//! and its active line clear, and the adapter paints the ground and this
//! wash under the editor, in the frame Zed lays it out.

use editor::ToPoint as _;
use gpui::{Bounds, Context, Pixels, Window, point, px};
use lattice_ui::{ActiveLattice as _, editor_theme};

use super::{LatticeEditor, gutter_column};
use crate::geometry::{self, Frame};

/// CodeMirror's padding before a line's text, where the band starts.
const LINE_PADDING: Pixels = px(6.);
/// The band's gap to the editor's right edge (`--space-4`).
const END_INSET: Pixels = px(8.);
/// `--radius-compact`.
const RADIUS: Pixels = px(4.);

impl LatticeEditor {
    pub(super) fn paint_current_line(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (empty, row) = {
            let editor = self.editor.read(cx);
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            let head = selection.head().to_point(&snapshot);
            (
                selection.start.to_point(&snapshot) == selection.end.to_point(&snapshot),
                head.row,
            )
        };
        if !empty {
            return;
        }
        let Some(editor_bounds) = self.editor_bounds(bounds) else {
            return;
        };
        let Some(frame) = Frame::read(&self.editor, editor_bounds, window, cx) else {
            return;
        };
        let text = self.buffer.read(cx).snapshot();
        if row > text.max_point().row {
            return;
        }
        let (top, bottom) = frame.row_span(row, text.line_len(row));
        if !frame.shows_row(top) && !frame.shows_row(bottom - frame.line_height) {
            return;
        }
        let start = text.point_to_offset(language::Point::new(row, 0));
        let Some(caret) =
            geometry::caret_rect(&self.editor, &text, start, editor_bounds, window, cx)
        else {
            return;
        };
        let left = caret.left() - LINE_PADDING;
        let right = bounds.right() - gutter_column::line_box_end(self.end_clearance) - END_INSET;
        if right <= left {
            return;
        }
        let lattice = cx.lattice();
        let color = editor_theme::current_line(lattice.code_theme, &lattice.palette);
        let band = Bounds::from_corners(point(left, top), point(right, bottom));
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            window.paint_quad(gpui::fill(band, color).corner_radii(RADIUS));
        });
    }
}
