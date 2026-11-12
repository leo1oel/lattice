//! The SyncTeX mark: where a jump from the source landed, scrolled to the
//! middle of the view and marked with an accent box that fades after 1.44 s
//! (`.pdf-synctex-highlight`).

use super::*;

/// How long a jump's mark stays before it fades (`.pdf-synctex-highlight`).
pub(in crate::pdf) const SYNC_MARK_HOLD: Duration = Duration::from_millis(1440);

/// The box a jump from the source marks, in PDF points on its page.
#[derive(Clone, Copy)]
pub(in crate::pdf) struct SyncMark {
    /// 0-based.
    pub page: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub id: usize,
    /// Still to be scrolled into view, once the document holding it shows.
    pub scroll: bool,
    /// Drawn at least once, which starts its fade.
    pub drawn: bool,
}

impl PdfView {
    /// Mark `target` (a forward SyncTeX answer) and scroll it to the middle
    /// of the panel, now or once the document being loaded shows.
    pub fn show_sync_target(&mut self, target: &PdfSyncTarget, cx: &mut Context<Self>) {
        let id = self.next_mark;
        self.next_mark += 1;
        self.sync_mark = Some(SyncMark {
            page: (target.page.max(1) - 1) as usize,
            x: target.x as f32,
            y: target.y as f32,
            width: target.width as f32,
            height: target.height as f32,
            id,
            scroll: true,
            drawn: false,
        });
        self._mark_task = None;
        self.scroll_to_mark();
        cx.notify();
    }

    /// The mark was drawn for the first time: it leaves the tree once it has
    /// faded, as the app's highlight does from when it is inserted.
    pub(in crate::pdf) fn mark_drawn(&mut self, id: usize, cx: &mut Context<Self>) {
        self._mark_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(
                    SYNC_MARK_HOLD
                        + lattice_ui::Motion::SlowExit.duration()
                        + Duration::from_millis(100),
                )
                .await;
            this.update(cx, |this, cx| {
                if this.sync_mark.is_some_and(|mark| mark.id == id) {
                    this.sync_mark = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// Scroll the pending mark to the middle of the view, once the document
    /// holding its page is laid out at a known size.
    pub(super) fn scroll_to_mark(&mut self) {
        let Some(mark) = self.sync_mark.filter(|mark| mark.scroll) else {
            return;
        };
        if mark.page >= self.layout.len() || self.viewport.size.height <= px(0.) {
            return;
        }
        let min_height = 12. / self.scale.max(0.01);
        let center = mark.y + mark.height.max(min_height) / 2.;
        let viewport = self.viewport_size();
        self.pending_scroll = Some(PendingScroll::PagePoint {
            page: mark.page,
            x: None,
            y: center,
            at_y: viewport.1 / 2.,
        });
        self.current_page = mark.page;
        self.apply_pending_scroll();
        if let Some(mark) = &mut self.sync_mark {
            mark.scroll = false;
        }
    }

    pub fn sync_mark(&self) -> Option<(usize, bool)> {
        self.sync_mark.map(|mark| (mark.page, mark.scroll))
    }

    pub fn sync_mark_top(&self) -> Option<f32> {
        self.sync_mark.map(|mark| mark.y)
    }

    /// A point of a page (PDF points from its top-left corner) on screen, in
    /// window coordinates.
    pub fn window_point(&self, page: usize, x: f32, y: f32) -> Option<Point<Pixels>> {
        let (sheet_x, sheet_y) = self.layout.to_sheet(page, x, y)?;
        let (scroll_x, scroll_y) = self.scroll_offset();
        Some(point(
            self.viewport.origin.x + px(sheet_x - scroll_x),
            self.viewport.origin.y + px(sheet_y - scroll_y),
        ))
    }

    /// The middle of the last jump's mark on screen, in window coordinates.
    pub fn sync_mark_center(&self) -> Option<Point<Pixels>> {
        let mark = self.sync_mark?;
        self.window_point(
            mark.page,
            mark.x + mark.width / 2.,
            mark.y + mark.height / 2.,
        )
    }
}
