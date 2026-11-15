//! The Project panel's new entries and Find in project
//! (`file_tree/new_entries.rs`), as the Tauri app's + menu, ⋯ menu and
//! palette add them, each from its palette command:
//!
//! - New LaTeX file names an `untitled.tex` row beside the selection, and a
//!   name without an extension becomes a `.tex`, opened.
//! - New spreadsheet and New board name a bare `untitled` row at the
//!   project root and take their extension, opened in their editors.
//! - New presentation names its deck under `slides/` before the folder
//!   exists, and opens the deck lattice-core makes.
//! - The strip's Find in project closes the tree's filter and opens the
//!   project's find.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{Action, AsyncApp};
use serde_json::json;

use super::Steps;
use crate::{
    scenario::Run,
    shell::palette_commands::{
        NewBoardInProject, NewLatexFileInProject, NewPresentationInProject,
        NewSpreadsheetInProject,
    },
};

impl Run {
    async fn new_entries(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());

        // New LaTeX file beside the selected chapter: "untitled.tex", its
        // stem selected; "appendix" becomes appendix.tex and opens.
        let selected = cx.update(|cx| tree.read(cx).row_paths(cx).contains(&"chapters/intro.tex".to_string()));
        if selected {
            self.with_window(cx, {
                let tree = tree.clone();
                move |_, window, cx| {
                    tree.update(cx, |tree, cx| tree.select_row("chapters/intro.tex", window, cx));
                }
            })?;
        }
        let (row, named) = self.name_entry(cx, Box::new(NewLatexFileInProject), "appendix").await?;
        let opened = self.opened(cx, "chapters/appendix.tex").await;
        steps.check(
            "New LaTeX file names an untitled.tex row beside the selection, and a bare name becomes a .tex that opens",
            row.as_deref() == Some("chapters/untitled.tex")
                && named
                && root.join("chapters/appendix.tex").is_file()
                && opened,
            json!({ "row": row, "opened": opened }),
        );

        // New spreadsheet and New board: a bare "untitled" at the root,
        // taking their extension, opened in their editors.
        let (sheet_row, _) = self.name_entry(cx, Box::new(NewSpreadsheetInProject), "budget").await?;
        let sheet = self.opened(cx, "budget.lattice-sheet").await;
        let (board_row, _) = self.name_entry(cx, Box::new(NewBoardInProject), "map").await?;
        let board = self.opened(cx, "map.tldr").await;
        steps.check(
            "New spreadsheet and New board name a bare untitled row at the root, and open with their extension",
            sheet_row.as_deref() == Some("untitled")
                && board_row.as_deref() == Some("untitled")
                && sheet
                && board,
            json!({ "sheet_row": sheet_row, "sheet": sheet, "board_row": board_row, "board": board }),
        );

        // New presentation: its row under slides/ before the folder is
        // there, and the deck lattice-core makes opens.
        let had_slides = root.join("slides").exists();
        let (deck_row, _) = self.name_entry(cx, Box::new(NewPresentationInProject), "talk").await?;
        let deck = self.opened(cx, "slides/talk/index.tsx").await;
        steps.check(
            "New presentation names its deck under slides/, and the deck it makes opens",
            !had_slides
                && deck_row.as_deref() == Some("slides/untitled")
                && root.join("slides/talk/index.tsx").is_file()
                && deck,
            json!({ "had_slides": had_slides, "row": deck_row, "opened": deck }),
        );

        // Find in project from the strip: the tree's filter closes and the
        // project's find opens; pressed again it stays open.
        self.with_window(cx, {
            let tree = tree.clone();
            move |_, window, cx| tree.update(cx, |tree, cx| tree.open_search("i", window, cx))
        })?;
        for _ in 0..2 {
            self.with_window(cx, {
                let tree = tree.clone();
                move |_, window, cx| tree.update(cx, |tree, cx| tree.find_in_project(window, cx))
            })?;
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let (find, filtering) = self.with_window(cx, {
            let tree = tree.clone();
            move |shell, window, cx| {
                (
                    shell.read(cx).project_find().is_some(),
                    tree.read(cx).search_state(window, cx).is_some(),
                )
            }
        })?;
        steps.check(
            "Find in project closes the tree's filter and opens the project's find, which a second press leaves open",
            find && !filtering,
            json!({ "find": find, "filtering": filtering }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.toggle_find(window, cx))
        })?;
        // The steps after these find the project as they left it: what was
        // made closes and goes, and the keyboard is back in main.tex (a
        // board's, sheet's or deck's island would keep it).
        let made = [
            "chapters/appendix.tex",
            "budget.lattice-sheet",
            "map.tldr",
            "slides/talk/index.tsx",
        ];
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                let views: Vec<String> = made
                    .iter()
                    .filter_map(|key| shell.view_of_document(key, cx))
                    .collect();
                shell
                    .workspace()
                    .clone()
                    .update(cx, |workspace, cx| workspace.close(&views, cx));
            })
        });
        self.pause(cx, Duration::from_millis(300)).await;
        self.open(cx, &root.join("main.tex"), Some(1))?;
        for made in ["chapters/appendix.tex", "budget.lattice-sheet", "map.tldr"] {
            std::fs::remove_file(root.join(made)).ok();
        }
        std::fs::remove_dir_all(root.join("slides")).ok();
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.pause(cx, Duration::from_millis(500)).await;
        Ok(())
    }

    /// Run `action` from the palette's rows, read the row it names, and
    /// give it `name` as Enter does.
    async fn name_entry(
        &self,
        cx: &mut AsyncApp,
        action: Box<dyn Action>,
        name: &'static str,
    ) -> Result<(Option<String>, bool)> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        self.with_window(cx, move |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(action, cx)
        })?;
        self.pause(cx, Duration::from_millis(250)).await;
        let state = self.with_window(cx, {
            let tree = tree.clone();
            move |_, window, cx| tree.read(cx).naming_state(window, cx)
        })?;
        let row = state.as_ref().map(|(path, ..)| path.clone());
        self.with_window(cx, move |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name(name, window, cx))
        })?;
        Ok((row, state.is_some()))
    }

    /// Whether `key` comes to the front within a few seconds.
    async fn opened(&self, cx: &mut AsyncApp, key: &str) -> bool {
        let key = key.to_string();
        self.wait_for(cx, Duration::from_secs(8), move |shell, cx| {
            shell.read(cx).active_document(cx).as_deref() == Some(key.as_str())
        })
        .await
    }
}

/// This file's registration as the e2e module `new_entries` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 35,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/file_tree/new_entries.rs",
        "gpui/crates/lattice-gpui/src/file_tree/naming.rs",
        "gpui/crates/lattice-gpui/src/shell/palette_commands.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.new_entries(cx, steps, &fixture.root)),
};
