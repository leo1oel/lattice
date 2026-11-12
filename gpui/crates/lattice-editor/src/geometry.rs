//! Where buffer positions are on screen, and what is under the pointer, in
//! Zed's editor, from outside it.
//!
//! Zed keeps its layout (the position map) private, but its editor answers
//! the input method's two questions for anyone: the bounds of a UTF-16
//! range (`bounds_for_range`, with the editor element's bounds) and the
//! character under a point (`character_index_for_point`). Everything the
//! adapter paints over the editor or opens from it is placed with those two
//! and the display snapshot (for display rows, which count wrapped lines
//! and block rows), in the same frame as the editor's own paint.

use std::ops::Range;

use editor::{Editor, display_map::ToDisplayPoint as _};
use gpui::{App, Bounds, Entity, EntityInputHandler as _, Pixels, Point, Window, point, size};
use language::{BufferSnapshot, OffsetUtf16, ToOffsetUtf16 as _};

/// One frame's view of an editor's layout.
pub(crate) struct Frame {
    /// The editor element's bounds, in window coordinates.
    pub bounds: Bounds<Pixels>,
    pub line_height: Pixels,
    /// The top of display row 0, which may be far above the bounds.
    row_zero_top: Pixels,
    display: editor::EditorSnapshot,
}

impl Frame {
    /// The layout of `editor`, drawn within `bounds` this frame.
    pub fn read(
        editor: &Entity<Editor>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Self> {
        editor.update(cx, |editor, cx| {
            let probe = editor.bounds_for_range(0..0, bounds, window, cx)?;
            let display = editor.snapshot(window, cx);
            let scroll_top = display.scroll_position().y as f32;
            let line_height = probe.size.height;
            Some(Frame {
                bounds,
                line_height,
                row_zero_top: bounds.origin.y - line_height * scroll_top,
                display,
            })
        })
    }

    /// The top of the display row a buffer `row` starts on.
    pub fn row_top(&self, row: u32) -> Pixels {
        let display_row = language::Point::new(row, 0)
            .to_display_point(&self.display.display_snapshot)
            .row()
            .0;
        self.row_zero_top + self.line_height * display_row as f32
    }

    /// Whether a row starting at `top` shows in the editor.
    pub fn shows_row(&self, top: Pixels) -> bool {
        top + self.line_height > self.bounds.top() && top < self.bounds.bottom()
    }
}

/// The caret rectangle before `offset` (an em wide, a line tall), in window
/// coordinates.
pub(crate) fn caret_rect(
    editor: &Entity<Editor>,
    text: &BufferSnapshot,
    offset: usize,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Bounds<Pixels>> {
    let utf16 = offset.min(text.len()).to_offset_utf16(text).0;
    editor.update(cx, |editor, cx| {
        editor.bounds_for_range(utf16..utf16, bounds, window, cx)
    })
}

/// The rectangle a range covers on its first display row: from its start's
/// caret to its end's when both are on that row, else to the row's end.
pub(crate) fn first_row_rect(
    editor: &Entity<Editor>,
    text: &BufferSnapshot,
    range: Range<usize>,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Bounds<Pixels>> {
    let start = caret_rect(editor, text, range.start, bounds, window, cx)?;
    let end = caret_rect(editor, text, range.end, bounds, window, cx)?;
    let right = if end.top() == start.top() && end.left() >= start.left() {
        end.left().max(start.left() + start.size.width / 2.)
    } else {
        bounds.right()
    };
    Some(Bounds {
        origin: start.origin,
        size: size(right - start.left(), start.size.height),
    })
}

/// The byte offset of the character under `position`, if it is over the
/// editor's text.
pub(crate) fn offset_at(
    editor: &Entity<Editor>,
    text: &BufferSnapshot,
    position: Point<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<usize> {
    let utf16 = editor.update(cx, |editor, cx| {
        editor.character_index_for_point(position, window, cx)
    })?;
    let utf16 = OffsetUtf16(utf16.min(text.len().to_offset_utf16(text).0));
    Some(text.offset_utf16_to_offset(utf16))
}

/// Whether `position` is inside `bounds` grown by `margin` on every side.
pub(crate) fn near(bounds: Bounds<Pixels>, position: Point<Pixels>, margin: Pixels) -> bool {
    let grown = Bounds {
        origin: point(bounds.origin.x - margin, bounds.origin.y - margin),
        size: size(
            bounds.size.width + margin * 2.,
            bounds.size.height + margin * 2.,
        ),
    };
    grown.contains(&position)
}
