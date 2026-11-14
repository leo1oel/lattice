//! The e2e checks for the Project tree's own operations: new file, rename,
//! move, delete and ⌘C / ⌘V, as its menu and keys run them.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::{super::Run, Steps};

impl Run {
    /// New file, rename, move and delete in the tree, as its menu runs them.
    pub(super) async fn tree_operations(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());

        // New file in chapters/: an "untitled" row named in place, ".tex"
        // added, opened.
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| {
                tree.begin_create("chapters", false, window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let placeholder = self.naming_state(cx, &tree)?;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name("methods", window, cx))
        })?;
        let created = root.join("chapters/methods.tex");
        let opened = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                created.is_file()
                    && shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_some_and(|path| path == "chapters/methods.tex")
            })
            .await;
        steps.check(
            "New file names an untitled row in place, creates chapters/methods.tex and opens it",
            opened
                && placeholder.as_ref().is_some_and(|(path, name, _)| {
                    path == "chapters/untitled" && name == "untitled"
                }),
            json!({ "placeholder": placeholder }),
        );

        // Rename: the name before the extension is what is typed; the open
        // tab follows.
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| {
                tree.begin_rename("chapters/methods.tex".into(), window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let renaming = self.naming_state(cx, &tree)?;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name("results.tex", window, cx))
        })?;
        let renamed = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                root.join("chapters/results.tex").is_file()
                    && !created.exists()
                    && shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_some_and(|path| path == "chapters/results.tex")
            })
            .await;
        steps.check(
            "Rename renames the file in place and its tab follows",
            renamed
                && renaming
                    .as_ref()
                    .is_some_and(|(_, name, _)| name == "methods.tex"),
            json!({ "renaming": renaming }),
        );

        // Move to the top level: the tab follows again.
        cx.update(|cx| {
            tree.update(cx, |tree, cx| {
                tree.drop_on("chapters/results.tex".into(), String::new(), cx)
            })
        });
        let moved = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                root.join("results.tex").is_file()
                    && shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_some_and(|path| path == "results.tex")
            })
            .await;
        steps.check(
            "a row dropped on the top level moves there and its tab follows",
            moved,
            json!({}),
        );

        // Renamed off .tex while the writer is in it: TexLab, which only
        // ever holds a LaTeX document, is never handed the plain-text file.
        let editor = cx
            .update(|cx| {
                self.shell
                    .read(cx)
                    .active_editor()
                    .map(|panel| panel.read(cx).editor().clone())
            })
            .context("results.tex is open")?;
        self.writer_in(cx, &editor).await?;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| {
                tree.begin_rename("results.tex".into(), window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name("results.txt", window, cx))
        })?;
        let to_text = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                root.join("results.txt").is_file()
                    && shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_some_and(|path| path == "results.txt")
            })
            .await;
        // Past the sync delay that a rename schedules.
        self.pause(
            cx,
            lattice_editor::latex::diagnostics::SYNC_DELAY + Duration::from_millis(600),
        )
        .await;
        let document = cx.update(|cx| {
            self.shell.read(cx).project().and_then(|project| {
                project
                    .read(cx)
                    .texlab()
                    .read(cx)
                    .document()
                    .map(str::to_string)
            })
        });
        steps.check(
            "a .tex file renamed to .txt is never synced to TexLab under its new name",
            to_text && document.as_deref() != Some("results.txt"),
            json!({ "renamed": to_text, "texlab_document": document }),
        );
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| {
                tree.begin_rename("results.txt".into(), window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |_, window, cx| {
            tree.update(cx, |tree, cx| tree.confirm_name("results.tex", window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(8), |_, _| {
            root.join("results.tex").is_file()
        })
        .await;

        // Delete: asked first; the tab closes with the file.
        cx.update(|cx| tree.update(cx, |tree, cx| tree.ask_delete("results.tex".into(), cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        let question = cx.update(|cx| self.shell.read(cx).confirm().read(cx).question());
        let confirm = cx.update(|cx| self.shell.read(cx).confirm().clone());
        self.with_window(cx, |_, window, cx| {
            confirm.update(cx, |confirm, cx| confirm.accept(window, cx))
        })?;
        let deleted = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                !root.join("results.tex").exists()
                    && shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_none_or(|path| path != "results.tex")
            })
            .await;
        steps.check(
            "Delete asks first, then deletes the file and closes its tab",
            question.as_deref() == Some("Delete “results.tex” from this project?") && deleted,
            json!({ "question": question }),
        );
        Ok(())
    }

    /// The tree's naming state, for a step's detail.
    fn naming_state(
        &self,
        cx: &mut AsyncApp,
        tree: &Entity<crate::file_tree::FileTreePanel>,
    ) -> Result<Option<(String, String, bool)>> {
        let tree = tree.clone();
        self.with_window(cx, move |_, window, cx| {
            tree.read(cx).naming_state(window, cx)
        })
    }
}
