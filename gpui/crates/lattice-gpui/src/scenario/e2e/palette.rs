//! The e2e checks of the command palette's groups, as the Tauri palette
//! lists them (`src/app/command-palette.tsx`, `command-palette-leading.ts`):
//! with a LaTeX source in front, an empty query leads with "In this
//! document" (Build project, Jump to PDF) and the files opened recently,
//! the one in front left out; a command run from the palette leads the next
//! opening under "Recent", and one that opts out (Clean aux files) never
//! does; What's new carries the running version as its detail; a typed
//! query finds a Settings row, which opens Settings at it, and a paper by
//! its year or a run inside its title, never one that is only cited; and a query that finds nothing offers Find in project on it, which opens with the query.

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

    /// With `LATTICE_E2E_SHOTS=DIR` (and the `offscreen-shots` feature)
    /// the window is saved as `DIR/<name>.png`, for a review of the look.
    async fn palette_shot(&self, cx: &mut AsyncApp, name: &str) {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return;
        };
        self.pause(cx, Duration::from_millis(300)).await;
        let path = Path::new(&dir).join(format!("{name}.png"));
        if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
            log::warn!("no shot {name}: {error:#}");
        }
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
        self.palette_shot(cx, "palette-empty").await;
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
        self.palette_shot(cx, "palette-recent").await;
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
        self.palette_shot(cx, "palette-settings-row").await;
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

        // Papers, as the Tauri palette lists them (`command-palette.tsx`,
        // `picker-ranking.ts` `scoreItem`): the fixture's one paper, The
        // TeXbook (1984), is only cited, so it is never a row; a paper with a
        // page to open is found by the year its row shows and by a run
        // starting inside a word of its title ("bert" in "RoBERTa").
        const ROBERTA: &str = "RoBERTa: A Robustly Optimized BERT Pretraining Approach";
        let added = cx.update(|cx| {
            let papers = self.shell.read(cx).papers().clone();
            papers.update(cx, |panel, _| {
                let mut paper = panel.papers.first()?.clone();
                paper.title = ROBERTA.into();
                paper.authors = "Liu, Yinhan and Ott, Myle".into();
                paper.year = Some("2019".into());
                paper.citation_key = Some("liu2019roberta".into());
                paper.url = Some("https://example.org/roberta".into());
                panel.papers.push(paper);
                Some(())
            })
        });
        let mut papers = Vec::new();
        for (query, title, listed) in [
            ("1984", "The TeXbook", false),
            ("2019", ROBERTA, true),
            ("bert", ROBERTA, true),
        ] {
            self.open_palette_now(cx)?;
            self.palette_type(cx, query)?;
            if query == "bert" {
                self.palette_shot(cx, "palette-papers-row").await;
            }
            let rows = self.palette_rows_now(cx);
            let found = rows
                .iter()
                .any(|(group, label, _)| group == "Papers" && label == title);
            papers.push(json!({ "query": query, "title": title, "listed": found, "expected": listed, "rows": rows }));
        }
        cx.update(|cx| {
            let papers = self.shell.read(cx).papers().clone();
            papers.update(cx, |panel, _| {
                panel.papers.retain(|paper| paper.title != ROBERTA)
            });
        });
        steps.check(
            "a typed query finds a paper by its year or a run inside its title, never one only cited",
            added.is_some() && papers.iter().all(|paper| paper["listed"] == paper["expected"]),
            json!({ "papers": papers }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;

        self.open_palette_now(cx)?;
        let nothing = "zqxjvwk";
        self.palette_type(cx, nothing)?;
        self.palette_shot(cx, "palette-fallback").await;
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
