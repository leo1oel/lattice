//! The pointer and the keys on the pages: a drag selects text, a click on a
//! link follows it, a double-click asks for the source line (reverse
//! SyncTeX), ⌘-wheel and a pinch zoom around the pointer, and the keys
//! scroll, copy the selection and open Find.

use super::*;

/// Arrow keys scroll by this much.
pub(in crate::pdf) const LINE_SCROLL: f32 = 40.;

impl PdfView {
    /// The sheet point under a window position.
    pub(super) fn sheet_point(&self, position: Point<Pixels>) -> (f32, f32) {
        let (scroll_x, scroll_y) = self.scroll_offset();
        (
            f32::from(position.x - self.viewport.origin.x) + scroll_x,
            f32::from(position.y - self.viewport.origin.y) + scroll_y,
        )
    }

    /// The caret nearest a window position: on the page under it, or the
    /// nearest page in the column, whose text must have been read.
    pub(super) fn caret_at(&self, position: Point<Pixels>) -> Option<(usize, usize)> {
        let (x, y) = self.sheet_point(position);
        let page = self.layout.page_near(y);
        let rect = self.layout.page(page)?;
        let text = self.pages.get(page)?.text.as_ref()?;
        let scale = self.layout.scale;
        let caret = text.caret_at((x - rect.x) / scale, (y - rect.y) / scale)?;
        Some((page, caret))
    }

    pub(in crate::pdf) fn on_sheet_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        let (x, y) = self.sheet_point(event.position);
        let Some((page, page_x, page_y)) = self.layout.to_page(x, y) else {
            self.selection = None;
            cx.notify();
            return;
        };
        if event.click_count == 2 {
            // Reverse SyncTeX: the point, in PDF points from the page's
            // top-left corner.
            let round = |value: f32| (f64::from(value) * 1000.).round() / 1000.;
            cx.emit(PdfViewEvent::SourceAt {
                page: page as u32 + 1,
                x: round(page_x),
                y: round(page_y),
            });
            return;
        }
        // A link is followed when the press ends on it, as a click; a drag
        // that starts on one selects its text.
        self.pressed_link = self
            .link_at(page, page_x, page_y)
            .map(|target| (page, target));
        self.selection = self.caret_at(event.position).map(|caret| Selection {
            anchor: caret,
            focus: caret,
        });
        self.selecting = self.selection.is_some();
        cx.notify();
    }

    fn link_at(&self, page: usize, x: f32, y: f32) -> Option<LinkTarget> {
        let text = self.pages.get(page)?.text.as_ref()?;
        let link = text.links.iter().find(|link| link.contains(x, y))?;
        Some(link.target.clone())
    }

    pub(in crate::pdf) fn on_sheet_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let Some(caret) = self.caret_at(event.position)
            && let Some(selection) = &mut self.selection
            && selection.focus != caret
        {
            selection.focus = caret;
            cx.notify();
        }
    }

    pub(in crate::pdf) fn on_sheet_mouse_up(
        &mut self,
        event: &MouseUpEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selecting = false;
        let collapsed = self.selection.is_none_or(|selection| selection.is_empty());
        if collapsed {
            self.selection = None;
            cx.notify();
        }
        // Released on the link it was pressed on, without a selection made:
        // a click.
        if let Some((page, target)) = self.pressed_link.take()
            && collapsed
        {
            let (x, y) = self.sheet_point(event.position);
            let on_it = self.layout.to_page(x, y).is_some_and(|(at, x, y)| {
                at == page && self.link_at(at, x, y).as_ref() == Some(&target)
            });
            if on_it {
                self.follow(&target, cx);
            }
        }
    }

    /// ⌘-wheel and Ctrl-wheel zoom around the pointer (`use-pdf-zoom.ts`):
    /// a trackpad's pixel deltas keep their 1:1 rate, a mouse notch is one
    /// step of about 5%.
    pub(in crate::pdf) fn on_zoom_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let delta = match event.delta {
            ScrollDelta::Pixels(delta) => {
                let pixels = -f32::from(delta.y);
                if pixels.abs() < 50. {
                    pixels
                } else {
                    pixels.signum() * 5.
                }
            }
            ScrollDelta::Lines(lines) => -lines.y.signum() * 5.,
        };
        if delta == 0. {
            return;
        }
        let anchor = self.viewport_point(event.position);
        self.zoom_to(self.scale * (-delta * 0.01).exp(), Some(anchor), None, cx);
    }

    /// A trackpad pinch zooms around its centre.
    pub(in crate::pdf) fn on_pinch(&mut self, event: &PinchEvent, cx: &mut Context<Self>) {
        let anchor = self.viewport_point(event.position);
        self.zoom_to(self.scale * (1. + event.delta), Some(anchor), None, cx);
    }

    pub(super) fn viewport_point(&self, position: Point<Pixels>) -> (f32, f32) {
        (
            f32::from(position.x - self.viewport.origin.x),
            f32::from(position.y - self.viewport.origin.y),
        )
    }

    pub(in crate::pdf) fn on_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Keys typed into the toolbar's fields are theirs.
        if !self.focus_handle.is_focused(window) {
            return;
        }
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        let (_, height) = self.viewport_size();
        let page = (height - LINE_SCROLL).max(LINE_SCROLL);
        let (x, y) = self.scroll_offset();
        let to = match keystroke.key.as_str() {
            "f" if modifiers.secondary(cx) && !modifiers.shift && !modifiers.alt => {
                cx.stop_propagation();
                self.focus_find(window, cx);
                return;
            }
            "c" if modifiers.secondary(cx) && !modifiers.shift && !modifiers.alt => {
                if self.selection.is_some() {
                    cx.stop_propagation();
                    self.copy_selection(cx);
                }
                return;
            }
            "escape" if self.selection.is_some() => {
                self.selection = None;
                cx.notify();
                return;
            }
            _ if modifiers.secondary(cx) || modifiers.alt => return,
            "down" => (x, y + LINE_SCROLL),
            "up" => (x, y - LINE_SCROLL),
            "right" => (x + LINE_SCROLL, y),
            "left" => (x - LINE_SCROLL, y),
            "pagedown" => (x, y + page),
            "pageup" => (x, y - page),
            "space" if modifiers.shift => (x, y - page),
            "space" => (x, y + page),
            "home" => (x, 0.),
            "end" => (x, self.layout.height),
            _ => return,
        };
        cx.stop_propagation();
        self.set_scroll(to);
        cx.notify();
    }

    /// The selection's text, once every page it runs through has been read,
    /// put on the clipboard as the Tauri app copies it.
    pub fn copy_selection(&mut self, cx: &mut Context<Self>) {
        let Some(text) = self.selected_text_task(cx) else {
            return;
        };
        cx.spawn(async move |_, cx| {
            let text = text.await;
            if !text.is_empty() {
                cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string(text)));
            }
        })
        .detach();
    }

    /// The selection's text, read from each page it covers.
    pub fn selected_text_task(&mut self, cx: &mut Context<Self>) -> Option<Task<String>> {
        let selection = self.selection.filter(|selection| !selection.is_empty())?;
        let engine = self.engine.clone().ok()?;
        let doc = self.doc?;
        let generation = self.document.as_ref()?.info.generation;
        let ((from, _), (to, _)) = selection.ordered();
        let to = to.min(self.pages.len().checked_sub(1)?);
        let texts: Vec<_> = (from..=to)
            .map(|page| match &self.pages[page].text {
                Some(text) if self.pages[page].text_generation == generation => Ok(text.clone()),
                _ => Err(engine.text(doc, generation, page)),
            })
            .collect();
        Some(cx.background_spawn(async move {
            let mut raw = String::new();
            for (offset, text) in texts.into_iter().enumerate() {
                let text = match text {
                    Ok(text) => text,
                    Err(reading) => match reading.await {
                        Ok(Ok(text)) => text,
                        _ => continue,
                    },
                };
                let page = from + offset;
                if let Some(range) = selection.range_on(page, text.chars.len()) {
                    if !raw.is_empty() {
                        raw.push('\n');
                    }
                    raw.push_str(&text.raw_text(range));
                }
            }
            copied(&raw)
        }))
    }

    /// Select from caret `from` to caret `to` (page, caret), as a drag would.
    #[cfg(target_os = "macos")]
    pub fn select(&mut self, from: (usize, usize), to: (usize, usize), cx: &mut Context<Self>) {
        self.selection = Some(Selection {
            anchor: from,
            focus: to,
        });
        cx.notify();
    }

    pub fn has_selection(&self) -> bool {
        self.selection
            .is_some_and(|selection| !selection.is_empty())
    }
}
