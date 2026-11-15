//! The e2e checks of the palette rows the Tauri command table has for
//! features the window already has (`use-command-table.ts`,
//! `project-panel-commands.ts`): a Markdown file's Edit and Preview under
//! their switch's names, the view shown left out, and one run switching
//! the file; Dark PDF pages and Light PDF pages flipping the PDF's pages;
//! the PDF's own window and the Project panel's New folder, Import files…
//! and Refresh file tree listed; and the theme in use not offered.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_settings::ThemePreference;
use serde_json::json;

use super::Steps;
use crate::{editor_panel::views::DocumentView, scenario::Run};

impl Run {
    async fn palette_rows_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &std::path::Path,
    ) -> Result<()> {
        let file = root.join("palette-views-check.md");
        std::fs::write(&file, "# Views\n\nA note.\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let shown = cx.update(|cx| editor.read(cx).document_view());

        self.open_palette_now(cx)?;
        let labels: Vec<String> = self
            .palette_rows_now(cx)
            .into_iter()
            .map(|(_, label, _)| label)
            .collect();
        let has = |label: &str| labels.iter().any(|shown| shown == label);
        let views = [
            (DocumentView::Source, "Edit Markdown"),
            (DocumentView::Split, "Edit and preview Markdown"),
            (DocumentView::Preview, "Preview Markdown"),
        ];
        let listed = shown.is_some_and(|shown| {
            views
                .iter()
                .all(|(view, label)| has(label) == (*view != shown))
        });
        let theme = cx.update(|cx| crate::settings::get(cx).theme_preference);
        let in_use = match theme {
            ThemePreference::Light => "Use the light theme",
            ThemePreference::Dark => "Use the dark theme",
            ThemePreference::System => "Match the system theme",
        };
        steps.check(
            "the palette lists a Markdown file's other views, the PDF's window and pages, the Project panel's rows, and no theme already in use",
            listed
                && has("Open the PDF in a separate window")
                && (has("Dark PDF pages") || has("Light PDF pages"))
                && has("New folder")
                && has("Import files…")
                && has("Refresh file tree")
                && !has(in_use),
            json!({ "shown": format!("{shown:?}"), "theme": format!("{theme:?}"), "labels": labels }),
        );

        let target = if shown == Some(DocumentView::Preview) {
            (DocumentView::Source, "Edit Markdown")
        } else {
            (DocumentView::Preview, "Preview Markdown")
        };
        let ran = self.palette_run(cx, target.1)?;
        let switched = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).document_view() == Some(target.0)
            })
            .await;

        let dark_before = crate::pdf::dark_pages();
        self.open_palette_now(cx)?;
        let flip = if dark_before {
            "Light PDF pages"
        } else {
            "Dark PDF pages"
        };
        let flipped_run = self.palette_run(cx, flip)?;
        let flipped = self
            .wait_for(cx, Duration::from_secs(2), |_, _| {
                crate::pdf::dark_pages() != dark_before
            })
            .await;
        steps.check(
            "a view row switches the file, and Dark or Light PDF pages flips the PDF's pages",
            ran && switched && flipped_run && flipped,
            json!({ "ran": ran, "switched": switched, "flip": flip, "flipped": flipped }),
        );
        // The pages back as they were, for the modules after this one.
        if flipped {
            let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
            cx.update(|cx| view.update(cx, |view, cx| view.toggle_dark_pages(cx)));
        }
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.close_tab(cx, editor)?;
        std::fs::remove_file(&file).ok();
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 97,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/palette_commands.rs",
        "gpui/crates/lattice-gpui/src/shell/commands/appearance.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.palette_rows_checks(cx, steps, &fixture.root)),
};
