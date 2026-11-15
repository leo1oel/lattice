//! A drawing dropped from Finder onto a LaTeX editor (`shell/drawing_drop.rs`),
//! with the platform's own file-drop events. Inkscape and draw.io are not on
//! this machine, so the drop runs as it does for a writer without them: the
//! drawing is copied into `figures/` and lattice-core's words say which
//! program to install, with nothing put into the source. The insertion
//! itself is `insert/editable_figure.rs`'s unit tests.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn drawing_drop(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let finder = std::env::temp_dir().join(format!("lattice-e2e-drawing-{}", std::process::id()));
        std::fs::create_dir_all(&finder)?;
        let drawing = finder.join("flow.drawio");
        std::fs::write(
            &drawing,
            "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel></diagram></mxfile>\n",
        )?;
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let at = self
            .with_window(cx, |_, window, cx| {
                editor.update(cx, |editor, cx| editor.point_before(1, window, cx))
            })?
            .context("main.tex's first line is on screen")?;
        self.file_drag(cx, at, std::slice::from_ref(&drawing)).await?;
        self.file_drop(cx, at).await?;
        let copied = self
            .wait_for(cx, Duration::from_secs(8), |_, _| {
                root.join("figures/flow.drawio").is_file()
            })
            .await;
        let said = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                notices
                    .read(cx)
                    .titles()
                    .iter()
                    .any(|title| title.as_ref() == "Could not update the figure")
            })
            .await;
        let details: Vec<String> = cx.update(|cx| {
            notices
                .read(cx)
                .details()
                .into_iter()
                .map(|detail| detail.to_string())
                .collect()
        });
        let after = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        steps.check(
            "a .drawio dropped on a LaTeX editor is copied into figures/ to become an editable figure, and without draw.io says to install it, the source untouched",
            copied
                && said
                && details.iter().any(|detail| detail == "Install draw.io to update this figure.")
                && after == before,
            json!({ "copied": copied, "said": said, "details": details, "unchanged": after == before }),
        );

        // The steps after these find the project as it was.
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        std::fs::remove_file(root.join("figures/flow.drawio")).ok();
        std::fs::remove_dir_all(&finder).ok();
        if let Some(project) = cx.update(|cx| self.shell.read(cx).project().cloned()) {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        Ok(())
    }
}

/// This file's registration as the e2e module `drawing_drop` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 37,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/drawing_drop.rs",
        "gpui/crates/lattice-gpui/src/insert/editable_figure.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.drawing_drop(cx, steps, &fixture.root)),
};
