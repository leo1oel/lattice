//! The e2e checks of the command palette's groups, as the Tauri palette
//! lists them (`src/app/command-palette.tsx`, `command-palette-leading.ts`):
//! with a LaTeX source in front, an empty query leads with "In this
//! document" (Build project, Jump to PDF) and the files opened recently,
//! the one in front left out; a command run from the palette leads the next
//! opening under "Recent", and one that opts out (Clean aux files) never
//! does; What's new carries the running version as its detail; a typed
//! query finds a Settings row, which opens Settings at it; and a query that
//! finds nothing offers Find in project on it, which opens with the query.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

type Rows = Vec<(String, String, Option<String>)>;

impl Run {
    fn open_palette_now(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                if shell.palette_view().is_some() {
                    shell.close_overlays(window, cx);
                }
                shell.open_palette(window, cx)
            })
        })
    }

    fn palette_rows_now(&self, cx: &mut AsyncApp) -> Rows {
        cx.update(|cx| {
            self.shell
                .read(cx)
                .palette_view()
                .map(|palette| palette.read(cx).rows())
                .unwrap_or_default()
        })
    }

    fn palette_type(&self, cx: &mut AsyncApp, text: &str) -> Result<()> {
        let text = text.to_string();
        self.with_window(cx, move |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| palette.type_query(&text, window, cx));
            }
        })
    }

    fn palette_run(&self, cx: &mut AsyncApp, label: &str) -> Result<bool> {
        let label = label.to_string();
        self.with_window(cx, move |shell, window, cx| {
            shell.read(cx).palette_view().is_some_and(|palette| {
                palette.update(cx, |palette, cx| palette.run_labelled(&label, window, cx))
            })
        })
    }

    async fn keyboard_in_document(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        after: &str,
    ) -> Result<()> {
        // The keyboard is back in the document: a key typed lands there.
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before = self.editor_text(cx, &editor).matches('%').count();
        self.type_text(cx, "%").await?;
        let typed = self.editor_text(cx, &editor).matches('%').count() == before + 1;
        let overlays = cx.update(|cx| {
            let shell = self.shell.read(cx);
            json!({
                "palette": shell.palette_view().is_some(),
                "settings": shell.settings.is_some(),
                "find": shell.project_find().is_some(),
            })
        });
        steps.check(
            &format!("after {after} the keyboard is back in the document"),
            typed,
            json!({ "typed": typed, "overlays": overlays }),
        );
        Ok(())
    }

    async fn palette_groups(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.open(cx, &root.join("references.bib"), Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        self.open_palette_now(cx)?;
        let rows = self.palette_rows_now(cx);
        let in_group = |rows: &Rows, group: &str| -> Vec<String> {
            rows.iter()
                .filter(|(shown, _, _)| shown == group)
                .map(|(_, label, _)| label.clone())
                .collect()
        };
        let here = in_group(&rows, "In this document");
        let recent_files = in_group(&rows, "Recent files");
        steps.check(
            "an empty palette leads with the document's own commands, then the recent files",
            here.first().is_some_and(|label| label == "Build project")
                && here.contains(&"Jump to PDF".to_string())
                && recent_files.contains(&"references.bib".to_string())
                && !recent_files.contains(&"main.tex".to_string())
                && rows
                    .first()
                    .is_some_and(|(group, _, _)| group == "In this document"),
            json!({ "in_this_document": here, "recent_files": recent_files }),
        );
        let version = rows
            .iter()
            .find(|(_, label, _)| label == "What’s new in Lattice")
            .and_then(|(_, _, detail)| detail.clone());
        steps.check(
            "What's new shows the running version as its detail",
            version.as_deref() == Some(crate::help::whats_new::RUNNING_VERSION),
            json!({ "detail": version }),
        );

        // One that may be recent, then one that opts out.
        let ran = self.palette_run(cx, "Keyboard shortcuts")?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        self.open_palette_now(cx)?;
        let ran_clean = self.palette_run(cx, "Clean aux files")?;
        self.pause(cx, Duration::from_millis(500)).await;
        self.open_palette_now(cx)?;
        let recent = in_group(&self.palette_rows_now(cx), "Recent");
        steps.check(
            "a command run from the palette leads the next opening, and Clean aux files never does",
            ran && ran_clean
                && recent
                    .first()
                    .is_some_and(|label| label == "Keyboard shortcuts")
                && !recent.contains(&"Clean aux files".to_string()),
            json!({ "recent": recent }),
        );

        self.palette_type(cx, "interface size")?;
        let rows = self.palette_rows_now(cx);
        let setting = rows
            .iter()
            .find(|(group, label, _)| group == "Settings" && label == "Interface size")
            .cloned();
        let opened = setting.is_some() && self.palette_run(cx, "Interface size")?;
        let shown = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).settings.as_ref().is_some_and(|settings| {
                    settings.read(cx).revealed_row() == Some("interface-size")
                })
            })
            .await;
        steps.check(
            "a typed query finds a Settings row, which opens Settings at it",
            opened && shown,
            json!({ "row": setting, "revealed": shown }),
        );
        // Settings takes the keyboard on its next frame; then it closes as
        // its own close does, the keyboard going back to the document.
        self.pause(cx, Duration::from_millis(300)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.close_settings(cx);
                shell.focus_front(window, cx);
            })
        })?;

        self.open_palette_now(cx)?;
        let nothing = "zqxjvwk";
        self.palette_type(cx, nothing)?;
        let rows = self.palette_rows_now(cx);
        let fallback = format!("Search the project for “{nothing}”");
        let offered = rows.len() == 1 && rows[0].1 == fallback;
        let ran = offered && self.palette_run(cx, &fallback)?;
        let found = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .project_find()
                    .is_some_and(|find| find.read(cx).memory(cx).query == nothing)
            })
            .await;
        steps.check(
            "a query that finds nothing offers Find in project on it",
            ran && found,
            json!({ "rows": rows, "find_opened_with_query": found }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        self.keyboard_in_document(cx, steps, root, "the palette")
            .await?;
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 97,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/palette.rs",
        "gpui/crates/lattice-gpui/src/shell/palette_groups.rs",
        "gpui/crates/lattice-gpui/src/shell/palette_commands.rs",
        "gpui/crates/lattice-gpui/src/shell/commands",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.palette_groups(cx, steps, &fixture.root)),
};
