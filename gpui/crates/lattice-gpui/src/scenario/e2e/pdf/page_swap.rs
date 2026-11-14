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
        Ok(())
    }
}
