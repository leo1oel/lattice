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
    pub(in crate::pdf) cancelled: bool,
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
        field.cancelled = false;
        let input = field.input.clone();
        input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.focus(window, cx);
            input.select_all(window, cx);
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
            // Enter hands focus back to the pages, which commits on blur.
            InputEvent::PressEnter { .. } => window.focus(&self.focus_handle, cx),
            InputEvent::Blur => {
                let field = if zoom {
                    &mut self.zoom_field
                } else {
                    &mut self.page_field
                };
                if !field.editing {
                    return;
                }
                field.editing = false;
                let cancelled = std::mem::take(&mut field.cancelled);
                let draft = field.input.read(cx).value().to_string();
                if zoom {
                    self.zoom_entry = false;
                }
                if !cancelled {
                    if zoom {
                        if let Some(scale) = layout::parse_zoom_percent(&draft) {
                            self.zoom_to(scale, None, None, cx);
                        }
                    } else if let Ok(page) = draft.trim().parse::<usize>() {
                        let page = page.clamp(1, self.pages.len().max(1));
                        self.go_to_page(page - 1, cx);
                    }
                }
                cx.notify();
            }
            _ => {}
        }
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
        field.cancelled = true;
        window.focus(&self.focus_handle, cx);
    }

    /// The overflow menu's percentage: the toolbar's own zoom field, shown
    /// over the end of Find until it is left.
    pub(in crate::pdf) fn enter_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom_entry = true;
        self.edit_draft(true, window, cx);
    }
}
