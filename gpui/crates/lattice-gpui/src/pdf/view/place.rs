//! Where a viewer is in its document, and telling its host once it has
//! settled somewhere, as the Tauri app's viewer reports `onViewState` for
//! the file view states to keep (`use-pdf-view.ts`).

use super::*;

/// A place is reported once the view has rested this long.
const REPORT_AFTER: Duration = Duration::from_millis(250);

/// One reported place, compared with the next to report only a change.
type ReportedPlace = ((f32, f32), f32, Option<FitMode>, usize);

/// What was last reported, and the report waiting out [`REPORT_AFTER`].
#[derive(Default)]
pub(in crate::pdf) struct PlaceReport {
    last: Option<ReportedPlace>,
    task: Option<Task<()>>,
}

/// Where a viewer is in its document, carried from the panel to the
/// separate window and back, and kept for back and forward over link jumps.
/// The top-left corner of the view is held as a point of the page under it,
/// in PDF points, so a viewer at another width (and so another fit scale)
/// shows the same place.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ViewPlace {
    pub(crate) page: usize,
    pub(crate) scale: f32,
    pub(crate) fit: Option<FitMode>,
    pub(crate) top: (usize, f32, f32),
}

impl ViewPlace {
    pub(super) fn scroll(&self) -> PendingScroll {
        let (page, x, y) = self.top;
        PendingScroll::PagePoint {
            page,
            x: Some(x),
            y,
            at_y: 0.,
        }
    }
}

impl PdfView {
    /// Each frame: once a shown document's view has moved (scrolled,
    /// zoomed, refitted) and rested, its place goes to the host.
    pub(in crate::pdf) fn report_place(&mut self, cx: &mut Context<Self>) {
        if self.document.is_none() || self.loading || self.pending_scroll.is_some() {
            return;
        }
        let now = Some((
            self.scroll_offset(),
            self.scale,
            self.fit,
            self.current_page,
        ));
        if self.place_report.last == now {
            return;
        }
        self.place_report.last = now;
        // Only for the file it was taken in: a document shown meanwhile has
        // a place of its own.
        let source = self.source.clone();
        self.place_report.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REPORT_AFTER).await;
            this.update(cx, |this, cx| {
                if this.document.is_some() && !this.loading && this.source == source {
                    cx.emit(PdfViewEvent::PlaceChanged(this.view_place()));
                }
            })
            .ok();
        }));
    }
}
