//! The input method's view of the terminal: text it commits is typed into
//! the shell, its composition is drawn at the caret, and its candidates
//! open beside the caret.

use gpui::{App, Bounds, Entity, InputHandler, Pixels, Point as GpuiPoint, UTF16Selection, Window};

use crate::terminal::screen::TerminalScreen;

/// The input method's view of the terminal: text it commits is typed into
/// the shell, and its candidates open at the caret.
pub(super) struct TerminalInputHandler {
    pub(super) screen: Entity<TerminalScreen>,
    pub(super) cursor_bounds: Option<Bounds<Pixels>>,
    pub(super) cell_width: Pixels,
}

impl InputHandler for TerminalInputHandler {
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut App,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(
        &mut self,
        _: &mut Window,
        cx: &mut App,
    ) -> Option<std::ops::Range<usize>> {
        self.screen
            .read(cx)
            .marked_text()
            .map(|text| 0..text.encode_utf16().count())
    }

    fn text_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<String> {
        None
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.screen.update(cx, |screen, cx| {
            screen.set_marked_text(None, cx);
            screen.type_text(text, cx);
        });
        window.invalidate_character_coordinates();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        text: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        cx: &mut App,
    ) {
        self.screen.update(cx, |screen, cx| {
            screen.set_marked_text(Some(text.to_owned()), cx)
        });
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut App) {
        self.screen
            .update(cx, |screen, cx| screen.set_marked_text(None, cx));
    }

    fn bounds_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let mut bounds = self.cursor_bounds?;
        bounds.origin.x += self.cell_width * range.start as f32;
        Some(bounds)
    }

    fn apple_press_and_hold_enabled(&mut self) -> bool {
        false
    }

    fn character_index_for_point(
        &mut self,
        _: GpuiPoint<Pixels>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<usize> {
        None
    }
}
