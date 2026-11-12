//! The toolbar's two editable values, the page and the zoom: each reads as
//! text until clicked, then edits a draft that Enter or leaving the field
//! commits and Escape drops (`useDraftInput` in `pdf-viewer.tsx`).

use super::*;

/// One of the toolbar's two editable values: the page and the zoom. Each
/// reads as text until clicked, then edits a draft that Enter or leaving
/// the field commits and Escape drops (`useDraftInput`).
pub(in crate::pdf) struct DraftField {
    pub input: Entity<InputState>,
    pub editing: bool,
}

impl PdfView {
    /// Start editing the page (`zoom == false`) or zoom value.
    pub(in crate::pdf) fn edit_draft(
        &mut self,
        zoom: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = if zoom {
            format!("{}", (self.scale * 100.).round() as i64)
        } else {
            format!("{}", self.current_page + 1)
        };
        let field = if zoom {
            &mut self.zoom_field
        } else {
            &mut self.page_field
        };
        field.editing = true;
        let input = field.input.clone();
        input.update(cx, |input, cx| input.set_value(value, window, cx));
        // The field takes focus once it is drawn: focused before, it is not
        // in the frame yet, and GPUI would take the focus back.
        window.on_next_frame(move |window, cx| {
            input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
        });
        cx.notify();
    }

    pub(super) fn on_draft_event(
        &mut self,
        zoom: bool,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // Enter commits and hands focus back to the pages, so the reader
            // goes on with Page Down or Space.
            InputEvent::PressEnter { .. } => {
                self.commit_draft(zoom, cx);
                window.focus(&self.focus_handle, cx);
            }
            // Leaving the field another way commits it too.
            InputEvent::Blur => self.commit_draft(zoom, cx),
            _ => {}
        }
    }

    fn commit_draft(&mut self, zoom: bool, cx: &mut Context<Self>) {
        let field = if zoom {
            &mut self.zoom_field
        } else {
            &mut self.page_field
        };
        if !field.editing {
            return;
        }
        field.editing = false;
        let draft = field.input.read(cx).value().to_string();
        if zoom {
            self.zoom_entry = false;
            if let Some(scale) = layout::parse_zoom_percent(&draft) {
                self.zoom_to(scale, None, None, cx);
            }
        } else if let Ok(page) = draft.trim().parse::<usize>() {
            let page = page.clamp(1, self.pages.len().max(1));
            self.go_to_page(page - 1, cx);
        }
        cx.notify();
    }

    /// Escape in a draft field: drop the draft and go back to reading.
    pub(in crate::pdf) fn cancel_draft(
        &mut self,
        zoom: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = if zoom {
            &mut self.zoom_field
        } else {
            &mut self.page_field
        };
        field.editing = false;
        if zoom {
            self.zoom_entry = false;
        }
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    /// The overflow menu's percentage: the toolbar's own zoom field, shown
    /// over the end of Find until it is left.
    pub(in crate::pdf) fn enter_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom_entry = true;
        self.edit_draft(true, window, cx);
    }

    /// Start editing a value with `draft` typed in, as a scenario types it.
    pub fn edit_draft_to(
        &mut self,
        zoom: bool,
        draft: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_draft(zoom, window, cx);
        let field = if zoom {
            &self.zoom_field
        } else {
            &self.page_field
        };
        let draft = draft.to_string();
        field
            .input
            .update(cx, |input, cx| input.set_value(draft, window, cx));
    }
}
