//! Links: a place in this PDF is a jump that back and forward undo and redo
//! (`usePdfLocationHistory`); a web address opens in the browser.

use super::*;

impl PdfView {
    /// Follow a link: a place in this PDF is a jump back and forward can
    /// undo; a web address opens in the browser.
    pub(in crate::pdf) fn follow(&mut self, target: &LinkTarget, cx: &mut Context<Self>) {
        match target {
            LinkTarget::Uri(uri) => cx.open_url(uri),
            LinkTarget::Page { page, x, y } => {
                if *page >= self.pages.len() {
                    return;
                }
                let from = self.view_place();
                self.pending_scroll = Some(PendingScroll::PagePoint {
                    page: *page,
                    x: *x,
                    y: y.unwrap_or(0.),
                    at_y: 0.,
                });
                self.current_page = *page;
                self.apply_pending_scroll(cx);
                if self.view_place() != from {
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
        let here = self.view_place();
        let (from, to) = if forward {
            (&mut self.forward, &mut self.back)
        } else {
            (&mut self.back, &mut self.forward)
        };
        let Some(target) = from.pop() else {
            return;
        };
        to.push(here);
        self.fit = target.fit;
        self.scale = target.scale;
        self.relayout();
        self.current_page = target.page;
        self.pending_scroll = Some(target.scroll());
        self.apply_pending_scroll(cx);
        self.settle(ZOOM_SETTLE, cx);
        cx.notify();
    }
}
