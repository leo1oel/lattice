//! Links: a place in this PDF is a jump that back and forward undo and redo
//! (`usePdfLocationHistory`); a web address opens in the browser.

use super::*;

/// A place in the PDF, for back and forward over link jumps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(in crate::pdf) struct Location {
    pub(super) page: usize,
    pub(super) scale: f32,
    pub(super) fit: Option<FitMode>,
    pub(super) scroll: (f32, f32),
}

impl PdfView {
    pub(super) fn location(&self) -> Location {
        Location {
            page: self.current_page,
            scale: self.scale,
            fit: self.fit,
            scroll: self.scroll_offset(),
        }
    }

    /// Follow a link: a place in this PDF is a jump back and forward can
    /// undo; a web address opens in the browser.
    pub(in crate::pdf) fn follow(&mut self, target: &LinkTarget, cx: &mut Context<Self>) {
        match target {
            LinkTarget::Uri(uri) => cx.open_url(uri),
            LinkTarget::Page { page, x, y } => {
                if *page >= self.pages.len() {
                    return;
                }
                let from = self.location();
                self.pending_scroll = Some(PendingScroll::PagePoint {
                    page: *page,
                    x: *x,
                    y: y.unwrap_or(0.),
                    at_y: 0.,
                });
                self.current_page = *page;
                self.apply_pending_scroll();
                if self.location() != from {
                    self.back.push(from);
                    self.forward.clear();
                }
                cx.notify();
            }
        }
    }

    pub fn can_go_back(&self) -> bool {
        !self.back.is_empty()
    }

    pub fn can_go_forward(&self) -> bool {
        !self.forward.is_empty()
    }

    /// Back (`forward == false`) or forward over link jumps.
    pub fn navigate(&mut self, forward: bool, cx: &mut Context<Self>) {
        let (from, to) = if forward {
            (&mut self.forward, &mut self.back)
        } else {
            (&mut self.back, &mut self.forward)
        };
        let Some(target) = from.pop() else {
            return;
        };
        to.push(Location {
            page: self.current_page,
            scale: self.scale,
            fit: self.fit,
            scroll: {
                let offset = self.scroll.offset();
                (-f32::from(offset.x), -f32::from(offset.y))
            },
        });
        self.fit = target.fit;
        self.scale = target.scale;
        self.relayout();
        self.current_page = target.page;
        self.pending_scroll = Some(PendingScroll::Offset(target.scroll.0, target.scroll.1));
        self.apply_pending_scroll();
        self.settle(ZOOM_SETTLE, cx);
        cx.notify();
    }
}
