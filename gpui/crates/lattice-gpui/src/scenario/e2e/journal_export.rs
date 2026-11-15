//! Export figures for a journal… (`shell/journal_export.rs`), with the TeX
//! installation the run has:
//!
//! - The palette lists it in a project, after Export for arXiv….
//! - A paper with no figure made from a drawing in it ends in an error
//!   notice with lattice-core's words, and writes nothing.
//! - A figure made from a drawing that only the editor's unsaved text puts
//!   in the paper is exported: the export saves first, writes the figure's
//!   PDF in a folder of its own, and says so with Show in Finder.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

/// The figure's entry file, as an editable figure writes one: its first line
/// names the drawing, the rest is what the paper sets.
const ENTRY: &str = "% editable-figure source: journal-check.drawio\n\\fbox{\\rule{0pt}{2cm}\\rule{3cm}{0pt}}\n";

/// The float the editor puts in the paper, unsaved.
const FLOAT: &str =
    "\\begin{figure}[h]\n\\centering\n\\input{figures/journal-check}\n\\caption{A scheme.}\n\\end{figure}\n";

/// What lattice-core says when the paper sets no figure made from a drawing.
const NO_FIGURE: [&str; 2] = [
    "This paper has no figure made from a drawing to export.",
    "No figure made from a drawing was found in the typeset paper.",
];

impl Run {
    async fn journal_export(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let ids: Vec<String> = cx.update(|cx| {
            let context = self.shell.read(cx).command_context(cx);
            crate::shell::commands::commands(&context)
                .into_iter()
                .filter(|command| command.palette)
                .map(|command| command.id.to_string())
                .collect()
        });
        let at = |id: &str| ids.iter().position(|entry| entry == id);
        steps.check(
            "the palette lists Export figures for a journal… in a project, after Export for arXiv…",
            matches!((at("export-arxiv"), at("export-journal")), (Some(arxiv), Some(journal)) if arxiv < journal),
            json!({ "arxiv": at("export-arxiv"), "journal": at("export-journal") }),
        );

        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let titles = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                notices
                    .read(cx)
                    .titles()
                    .into_iter()
                    .map(|title| title.to_string())
                    .collect::<Vec<_>>()
            })
        };

        // No figure from a drawing in the paper: lattice-core's error.
        let empty = tempfile::tempdir()?;
        self.export_into(cx, empty.path()).await?;
        let said = titles(cx);
        let written = std::fs::read_dir(empty.path())?.count();
        steps.check(
            "a paper with no figure made from a drawing ends in lattice-core's error notice and writes nothing",
            said.iter().any(|title| NO_FIGURE.contains(&title.as_str())) && written == 0,
            json!({ "notices": said, "written": written }),
        );
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));

        // A figure the unsaved editor puts in the paper.
        let entry = root.join("figures/journal-check.tex");
        std::fs::create_dir_all(root.join("figures"))?;
        std::fs::write(&entry, ENTRY)?;
        let main = root.join("main.tex");
        let on_disk = std::fs::read_to_string(&main)?;
        let editor = self.open(cx, &main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (before, _) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        let end = before
            .rfind("\\end{document}")
            .context("main.tex ends its document")?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.replace_range(end, end, FLOAT, end + FLOAT.len(), window, cx)
            })
        })?;
        let parent = tempfile::tempdir()?;
        self.export_into(cx, parent.path()).await?;
        let said = titles(cx);
        let saved = std::fs::read_to_string(&main)?.contains(FLOAT);
        let folders: Vec<_> = std::fs::read_dir(parent.path())?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.is_dir())
            .collect();
        let figures: Vec<String> = folders
            .first()
            .and_then(|folder| std::fs::read_dir(folder).ok())
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".pdf") || name.ends_with(".tiff"))
            .collect();
        let exported = said.iter().any(|title| {
            title.starts_with("Exported ") && title.ends_with(" and the paper that includes them")
        });
        steps.check(
            "Export figures for a journal saves the editor first, then writes the drawing's figure as a PDF in a folder of its own and says so",
            saved && exported && folders.len() == 1 && figures.iter().any(|name| name.ends_with(".pdf")),
            json!({ "saved": saved, "notices": said, "folders": folders, "figures": figures }),
        );

        // The steps after these find the project as it was.
        let (text, _) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        if let Some(at) = text.find(FLOAT) {
            self.with_window(cx, |_, window, cx| {
                editor.update(cx, |editor, cx| {
                    editor.replace_range(at, at + FLOAT.len(), "", at, window, cx)
                })
            })?;
        }
        let save = cx.update(|cx| editor.update(cx, |editor, cx| editor.save(cx)));
        save.await.ok();
        if std::fs::read_to_string(&main).ok().as_deref() != Some(on_disk.as_str()) {
            std::fs::write(&main, &on_disk)?;
        }
        std::fs::remove_file(&entry).ok();
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        if let Some(project) = cx.update(|cx| self.shell.read(cx).project().cloned()) {
            cx.update(|cx| project.update(cx, |project, cx| project.rescan(cx)));
        }
        Ok(())
    }

    /// Run the export into `parent`, as the folder dialog would, and wait
    /// for it to end.
    async fn export_into(&self, cx: &mut AsyncApp, parent: &Path) -> Result<()> {
        let parent = parent.to_path_buf();
        self.with_window(cx, move |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.export_for_journal_into(parent, cx))
        })?;
        // It starts on the next turn; then the typesetting runs.
        self.pause(cx, Duration::from_millis(300)).await;
        self.wait_for(cx, Duration::from_secs(120), |shell, cx| {
            !shell.read(cx).exporting_for_journal()
        })
        .await;
        Ok(())
    }
}

/// This file's registration as the e2e module `journal_export`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 100,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/shell/journal_export.rs"],
    run: |run, cx, steps, fixture| Box::pin(run.journal_export(cx, steps, &fixture.root)),
};
