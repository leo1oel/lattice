//! The builds no editor's save starts, as the Tauri app's pipeline starts
//! them: a write to a closed file (the Agent's, a terminal's) builds once
//! the writes pause, a file only a build writes builds nothing, and the
//! diagnostics card's docked or floating choice is kept for the next run.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{build::watched, scenario::Run};

impl Run {
    /// Whether a build starts within `within`, and how long after now.
    async fn build_starts(&self, cx: &mut AsyncApp, before: usize, within: Duration) -> Option<Duration> {
        let started = Instant::now();
        self.wait_for(cx, within, |shell, cx| {
            let shell = shell.read(cx);
            shell.building() || shell.build_panel().read(cx).builds() > before
        })
        .await
        .then(|| started.elapsed())
    }

    async fn watched_builds(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        // Settle whatever the repair left running.
        self.wait_for(cx, Duration::from_secs(60), |shell, cx| !shell.read(cx).building())
            .await;
        let appendix = root.join("chapters/appendix.tex");
        let before = self.builds(cx);
        std::fs::write(&appendix, "% An appendix written outside Lattice.\n")?;
        let started = self.build_starts(cx, before, Duration::from_secs(15)).await;
        let built = self.built_after(cx, before).await;
        steps.check(
            "a write to a file no editor has open builds once the writes pause",
            built && started.is_some_and(|after| after >= watched::IDLE - Duration::from_millis(300)),
            json!({ "started_after_ms": started.map(|after| after.as_millis()) }),
        );

        let output = root.join("notes.log");
        let before = self.builds(cx);
        std::fs::write(&output, "This is pdfTeX\n")?;
        let started = self.build_starts(cx, before, Duration::from_secs(4)).await;
        steps.check(
            "a file only a build writes starts no build",
            started.is_none(),
            json!({ "started_after_ms": started.map(|after| after.as_millis()) }),
        );
        std::fs::remove_file(&output).ok();
        let before = self.builds(cx);
        std::fs::remove_file(&appendix).ok();
        if self.build_starts(cx, before, Duration::from_secs(10)).await.is_some() {
            self.built_after(cx, before).await;
        }

        let docked = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().clone();
            let was = panel.read(cx).docked();
            panel.update(cx, |panel, cx| panel.set_docked(!was, cx));
            let kept = crate::settings::get(cx).build_output_docked;
            panel.update(cx, |panel, cx| panel.forget_docked_choice(cx));
            (was, kept)
        });
        steps.check(
            "the card's docked or floating choice is kept in the settings, for every project",
            docked.1 == Some(!docked.0),
            json!({ "was_docked": docked.0, "kept": docked.1 }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `watched_builds`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 5,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/build_watch.rs",
        "gpui/crates/lattice-gpui/src/build/watched.rs",
        "gpui/crates/lattice-gpui/src/build/inputs.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.watched_builds(cx, steps, &fixture.root)),
};
