//! The e2e checks of the submission checklist and the figure inventory
//! (`crate::submission::checklist`, `crate::submission::figures`): the
//! checklist opened by the palette's action into the documents' panel, its disk
//! checks read, a word budget typed and saved into the project's manifest;
//! then a figure drawn by a chapter listed by the inventory, opened from the
//! checklist's link, replaced by another project image and the replacement
//! undone, the chapter back as it was.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{
    scenario::Run,
    submission::{
        checklist::ChecklistEvent,
        figures::{FigureInventory, FiguresEvent},
    },
};

/// The figure the chapter draws, as `\includegraphics` names it.
const FIGURE: &str = "\n\\begin{figure}\n  \\includegraphics[width=2in]{figures/plot}\n  \\caption{A plot.}\n  \\label{fig:plot}\n\\end{figure}\nSee Figure~\\ref{fig:plot}.\n";

impl Run {
    pub(super) async fn submission_checklist(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.checklist_panel(cx, steps, root).await?;
        self.figure_inventory(cx, steps, root).await
    }

    async fn checklist_panel(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let manifest = root.join(".research/project.json");
        let original = std::fs::read(&manifest).ok();
        // The palette's "Submission checklist" dispatches this action.
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(crate::shell::OpenChecklist), cx)
        })?;
        let checklist = cx.update(|cx| self.shell.read(cx).checklist.clone());
        let read = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                checklist.read(cx).facts_read() && shell.read(cx).view_on_screen("checklist", cx)
            })
            .await;
        let (on_screen, beside_documents) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let panel = shell.panel_holding("checklist", cx);
            (
                shell.view_on_screen("checklist", cx),
                panel.is_some() && panel == shell.document_panel_of_layout(cx),
            )
        });
        steps.check(
            "Submission checklist opens in the documents' panel and reads its disk checks",
            read && on_screen && beside_documents,
            json!({ "read": read, "onScreen": on_screen, "besideDocuments": beside_documents }),
        );

        self.with_window(cx, |_, window, cx| {
            checklist.update(cx, |checklist, cx| {
                checklist.enter_word_budget("6000", window, cx)
            })
        })?;
        let saved = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .project()
                    .is_some_and(|project| project.read(cx).manifest().word_budget == Some(6000))
            })
            .await;
        steps.check(
            "a word budget typed into the checklist is saved in the project's manifest",
            saved,
            json!({ "saved": saved }),
        );
        self.with_window(cx, |_, window, cx| {
            checklist.update(cx, |checklist, cx| {
                checklist.enter_word_budget("", window, cx)
            })
        })?;
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            shell
                .read(cx)
                .project()
                .is_some_and(|project| project.read(cx).manifest().word_budget.is_none())
        })
        .await;
        if let Some(original) = original {
            std::fs::write(&manifest, original).ok();
        }
        Ok(())
    }

    async fn figure_inventory(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter).context("chapters/intro.tex")?;
        let figures = root.join("figures");
        std::fs::create_dir_all(&figures)?;
        image::RgbImage::from_pixel(1200, 600, image::Rgb([40, 90, 160]))
            .save(figures.join("plot.png"))?;
        image::RgbImage::from_pixel(1800, 900, image::Rgb([160, 90, 40]))
            .save(figures.join("plot-v2.png"))?;
        std::fs::write(&chapter, format!("{original}{FIGURE}"))?;
        let project = cx.update(|cx| self.shell.read(cx).project().cloned());
        if let Some(project) = &project {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        let scanned = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).project().is_some_and(|project| {
                    let mut paths = Vec::new();
                    collect(project.read(cx).files(), &mut paths);
                    paths.iter().any(|path| path == "figures/plot-v2.png")
                })
            })
            .await;
        // The chapter is open from the TODOs step: its editor takes the
        // change from disk before the inventory reads it in its place.
        let reloaded = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).active_editor().is_none_or(|editor| {
                    let editor = editor.read(cx);
                    editor.relative() != "chapters/intro.tex"
                        || editor.editor().read(cx).text(cx).contains("figures/plot")
                })
            })
            .await;

        // The checklist's link opens the inventory, as its row does.
        let checklist = cx.update(|cx| self.shell.read(cx).checklist.clone());
        cx.update(|cx| checklist.update(cx, |_, cx| cx.emit(ChecklistEvent::OpenFigures)));
        let sheet = self.figure_sheet(cx);
        let listed = match &sheet {
            Some(sheet) => {
                let sheet = sheet.clone();
                self.wait_for(cx, Duration::from_secs(10), move |_, cx| {
                    sheet.read(cx).settled()
                })
                .await
            }
            None => false,
        };
        let uses = sheet
            .as_ref()
            .map(|sheet| cx.update(|cx| sheet.read(cx).uses().to_vec()))
            .unwrap_or_default();
        let found = uses
            .iter()
            .find(|use_| use_.asset.as_deref() == Some("figures/plot.png"));
        steps.check(
            "the checklist's link opens the figure inventory, which lists a chapter's figure with its caption, label and reference",
            scanned
                && reloaded
                && listed
                && found.is_some_and(|use_| {
                    use_.source == "chapters/intro.tex"
                        && use_.caption == "A plot."
                        && use_.labels == ["fig:plot"]
                        && use_.references.len() == 1
                        && use_.width_inches == Some(2.)
                }),
            json!({
                "scanned": scanned,
                "reloaded": reloaded,
                "opened": listed,
                "uses": uses.iter().map(|use_| json!({
                    "source": use_.source, "line": use_.line, "asset": use_.asset,
                    "caption": use_.caption, "labels": use_.labels,
                    "references": use_.references.len(), "width": use_.width_inches,
                })).collect::<Vec<_>>(),
            }),
        );

        let Some(sheet) = sheet else {
            std::fs::write(&chapter, original)?;
            return Ok(());
        };
        cx.update(|cx| {
            sheet.update(cx, |sheet, cx| {
                sheet.replace("figures/plot.png", "figures/plot-v2.png", cx)
            })
        });
        let replaced = self
            .wait_for_sheet(cx, &sheet, |sheet, _| {
                sheet.settled()
                    && sheet
                        .uses()
                        .iter()
                        .any(|use_| use_.asset.as_deref() == Some("figures/plot-v2.png"))
            })
            .await;
        let written = std::fs::read_to_string(&chapter).unwrap_or_default();
        let error = cx.update(|cx| sheet.read(cx).last_error().map(str::to_string));
        steps.check(
            "Replace listed usages rewrites only the graphics argument, keeping its options, as the Tauri app writes it",
            replaced
                && written.contains("\\includegraphics[width=2in]{\\detokenize{figures/plot-v2.png}}")
                && !written.contains("{figures/plot}"),
            json!({ "replaced": replaced, "error": error }),
        );

        let undoable = cx.update(|cx| sheet.read(cx).can_undo());
        cx.update(|cx| sheet.update(cx, |sheet, cx| sheet.undo(cx)));
        let undone = self
            .wait_for_sheet(cx, &sheet, |sheet, _| {
                sheet.settled() && !sheet.can_undo()
            })
            .await;
        let restored = std::fs::read_to_string(&chapter).unwrap_or_default();
        steps.check(
            "Undo replacement puts the chapter back as it was",
            undoable && undone && restored == format!("{original}{FIGURE}"),
            json!({ "undoable": undoable, "undone": undone }),
        );

        // Closed as Escape closes it, the keyboard back on the checklist.
        cx.update(|cx| sheet.update(cx, |_, cx| cx.emit(FiguresEvent::Close)));
        let closed = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).sheets.figures.is_none()
            })
            .await;
        steps.check(
            "Closing the figure inventory leaves the checklist in front",
            closed && cx.update(|cx| self.shell.read(cx).view_on_screen("checklist", cx)),
            json!({ "closed": closed }),
        );
        std::fs::write(&chapter, original)?;
        std::fs::remove_dir_all(&figures).ok();
        if let Some(project) = &project {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        Ok(())
    }

    fn figure_sheet(&self, cx: &mut AsyncApp) -> Option<Entity<FigureInventory>> {
        cx.update(|cx| {
            self.shell
                .read(cx)
                .sheets
                .figures
                .as_ref()
                .map(|(sheet, _)| sheet.clone())
        })
    }

    async fn wait_for_sheet(
        &self,
        cx: &mut AsyncApp,
        sheet: &Entity<FigureInventory>,
        mut done: impl FnMut(&FigureInventory, &gpui::App) -> bool,
    ) -> bool {
        let sheet = sheet.clone();
        self.wait_for(cx, Duration::from_secs(15), move |_, cx| {
            done(sheet.read(cx), cx)
        })
        .await
    }
}

fn collect(nodes: &[lattice_core::models::FileNode], out: &mut Vec<String>) {
    for node in nodes {
        out.push(node.path.clone());
        collect(&node.children, out);
    }
}
