//! Moving through the PDF, end to end: Next page and a page jump, a zoom
//! step and the two fits, and the scrollbar the pages draw while they move,
//! the app's one bar, the source editor's, which hides as soon after a
//! scroll as the editor's does.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::{Steps, status_bar::BAR_HIDES_WITHIN};
use crate::{pdf::FitMode, scenario::Run};

impl Run {
    /// The pages' scrollbar is the editor's: the same 4px thumb 5px off the
    /// edge of a 10px track, shown while the pages scroll and hidden within
    /// the same short moment after they rest, not Kit's wider bar that
    /// waited two seconds.
    pub(super) async fn pdf_scrollbar(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        // Rested first, so the trace starts from a hidden bar.
        self.wait_view(cx, 3, |view, _| view.scrollbar_opacity() == 0.)
            .await;
        let page = cx.update(|cx| self.live_view_of(cx).read(cx).current_page());
        let scrolled = std::time::Instant::now();
        self.with_view(cx, |view, _, cx| {
            view.go_to_page(if page >= 3 { 0 } else { 4 }, cx)
        })?;
        let view = cx.update(|cx| self.live_view_of(cx));
        let trace = self
            .bar_trace(
                cx,
                scrolled,
                |cx| view.read(cx).scrollbar_opacity(),
                |cx| view.read(cx).scrollbar_thumb(),
            )
            .await;
        steps.check(
            "PDF: the pages' scrollbar is the editor's (a 4px thumb 5px off the edge of a 10px \
             track) and hides within 0.8 s once the pages rest",
            trace.shown
                && trace.is_the_app_bar()
                && trace
                    .hidden_after
                    .is_some_and(|after| after < BAR_HIDES_WITHIN),
            json!({ "bar": trace.json() }),
        );
        Ok(())
    }

    pub(super) async fn navigation_and_zoom(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.go_to_page(0, cx))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_view(cx, |view, _, cx| view.step_page(1, cx))?;
        let next = self
            .wait_view(cx, 5, |view, _| view.current_page() == 1)
            .await;
        self.with_view(cx, |view, _, cx| view.go_to_page(6, cx))?;
        let jumped = self
            .wait_view(cx, 5, |view, _| view.current_page() == 6)
            .await;
        steps.check(
            "PDF: Next page and a page jump move the view",
            next && jumped,
            json!({ "page": cx.update(|cx| self.live_view_of(cx).read(cx).current_page()) }),
        );

        let (fit, fitted) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.step_zoom(1., cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (zoom_fit, zoomed) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.toggle_fit(FitMode::Height, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (height_fit, height_scale) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.toggle_fit(FitMode::Width, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (back_fit, back_scale) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        // A zoom step is a tenth from the scale rounded to one decimal.
        let step = ((fitted + 0.1) * 10.).round() / 10.;
        steps.check(
            "PDF: a zoom step leaves the fit, the height fit shows the whole page, and the width fit comes back",
            fit == Some(FitMode::Width)
                && zoom_fit.is_none()
                && (zoomed - step).abs() < 0.001
                && height_fit == Some(FitMode::Height)
                && height_scale <= fitted + 0.001
                && back_fit == Some(FitMode::Width)
                && (back_scale - fitted).abs() < 0.01,
            json!({ "fitted": fitted, "zoomed": zoomed, "height": height_scale, "back": back_scale }),
        );
        Ok(())
    }
}
