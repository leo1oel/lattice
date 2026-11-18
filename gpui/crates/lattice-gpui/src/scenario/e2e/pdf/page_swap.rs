//! A rebuild that changes one page of the PDF, end to end: only that page is
//! drawn again.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{pdf::PdfView, scenario::Run};

impl Run {
    /// A rebuild that changes one page redraws only that page: its signature
    /// (lattice-core's `pdf_pages`) is the only one that differs.
    pub(super) async fn page_swap(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        supplement: &Path,
    ) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.go_to_page(9, cx))?;
        let swaps = cx.update(|cx| self.live_view_of(cx).read(cx).stats().swaps.len());
        // The same letters, so no font's subset changes with them.
        let text =
            std::fs::read_to_string(supplement)?.replace("Swap target ten.", "Target swap ten.");
        std::fs::write(supplement, text)?;
        // The outside edit reloads the editor and builds; this build runs
        // after that one (and finds nothing more to typeset).
        self.pause(cx, Duration::from_millis(500)).await;
        let (built, _) = self.build(cx).await?;
        let swapped = |view: &PdfView| {
            view.stats().swaps[swaps..]
                .iter()
                .any(|redrawn| redrawn.as_slice() == [9])
        };
        let reloaded = self.wait_view(cx, 20, |view, _| swapped(view)).await;
        let stats = cx.update(|cx| self.live_view_of(cx).read(cx).stats().clone());
        steps.check(
            "PDF: a rebuild that changed one page redraws only that page and keeps the others",
            built && reloaded,
            json!({ "reloads": stats.swaps.get(swaps..) }),
        );
        let page = cx.update(|cx| self.live_view_of(cx).read(cx).current_page());
        steps.check(
            "PDF: a rebuild leaves the reader on the page they were reading",
            page == 9,
            json!({ "page": page }),
        );
        self.rebuild_with_fewer_pages(cx, steps, supplement).await
    }

    /// A rebuild with fewer pages than the one being read shows its last
    /// page, not its first, and one that gives them back keeps that page.
    async fn rebuild_with_fewer_pages(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        supplement: &Path,
    ) -> Result<()> {
        const TAIL: &str = "\\newpage\n\\section{Eleven} Plain text.\n\\newpage\n\\section{Twelve} The end.\n";
        self.with_view(cx, |view, _, cx| view.go_to_page(11, cx))?;
        let full = std::fs::read_to_string(supplement)?;
        std::fs::write(supplement, full.replace(TAIL, ""))?;
        self.pause(cx, Duration::from_millis(500)).await;
        let (built, _) = self.build(cx).await?;
        let shrunk = self.wait_view(cx, 20, |view, _| view.page_count() == 10).await;
        let page = cx.update(|cx| self.live_view_of(cx).read(cx).current_page());
        steps.check(
            "PDF: a rebuild with fewer pages than the one read shows its last page",
            built && shrunk && page == 9,
            json!({ "built": built, "pages": shrunk, "page": page }),
        );
        std::fs::write(supplement, full)?;
        self.pause(cx, Duration::from_millis(500)).await;
        let (built, _) = self.build(cx).await?;
        let grown = self.wait_view(cx, 20, |view, _| view.page_count() == 12).await;
        let page = cx.update(|cx| self.live_view_of(cx).read(cx).current_page());
        steps.check(
            "PDF: a rebuild that adds pages keeps the page being read",
            built && grown && page == 9,
            json!({ "built": built, "pages": grown, "page": page }),
        );
        Ok(())
    }
}
