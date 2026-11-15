//! The `latex_visual` module's checks of what the Visual page runs beside
//! its drawing (`editor_panel/latex_visual_events.rs`,
//! `structured/latex_services.rs`):
//!
//! - the outline rail stands over the page's right edge, with a mark for
//!   each of the document's sections (a file outside the manuscript has its
//!   own outline, and a rail needs two marks), as over the source;
//! - a misspelt word in the page is marked by the spell check (Harper,
//!   answered by the owner's `harper_lint`), as in the source.

#![cfg(target_os = "macos")]

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};

/// The rail, its marks, and the spell check's marks over the misspelt
/// `word`, as one JSON object.
fn companions(word: &str) -> String {
    format!(
        "JSON.stringify({{ \
         rail: !!document.querySelector('.source-editor > .latex-outline-rail'), \
         marks: document.querySelectorAll('.latex-outline-rail-marks > *').length, \
         lints: [...document.querySelectorAll('.cm-latex-visual .cm-lintRange')].map((node) => node.textContent), \
         flagged: [...document.querySelectorAll('.cm-latex-visual .cm-lintRange')].some((node) => node.textContent.includes({word:?})) }})"
    )
}

impl Run {
    /// The rail over the page, and the misspelt `word` marked.
    pub(super) async fn latex_visual_companions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
        word: &str,
    ) -> Result<()> {
        // The outline comes from the shell's read of the manuscript, and the
        // spell check runs after typing pauses: both arrive a moment late.
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            facts = self.evaluate(cx, island, &companions(word)).await;
            if facts["rail"] == true
                && facts["marks"].as_u64().is_some_and(|marks| marks > 0)
                && facts["flagged"] == true
            {
                break;
            }
            self.pause(cx, Duration::from_millis(250)).await;
        }
        steps.check(
            "the outline rail stands over the Visual page with its sections' marks, as over the source",
            facts["rail"] == true && facts["marks"].as_u64().is_some_and(|marks| marks > 0),
            json!({ "rail": facts["rail"], "marks": facts["marks"] }),
        );
        steps.check(
            "a misspelt word in the Visual page is marked by the spell check, as in the source",
            facts["flagged"] == true,
            json!({ "word": word, "lints": facts["lints"] }),
        );
        Ok(())
    }
}
