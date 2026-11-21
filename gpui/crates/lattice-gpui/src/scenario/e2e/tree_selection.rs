//! The Project tree's selection and what it remembers
//! (`file_tree/selection.rs`, `file_tree/memory.rs`), driven by the
//! platform's own pointer and key events:
//!
//! - Opening a file selects its row alone, opening its folders down to it.
//! - ⌘-click adds a row without opening it, ⇧-click takes the range shown,
//!   ⌘C copies every selected path, and Delete asks about them together.
//! - Enter names the one selected row anew.
//! - A template's `.sty` stays out of the tree until Show hidden files.
//! - The open folders are kept for the project when it is shown again.
//! - A press on the empty space clears the selection, so + makes the next
//!   file at the project root; the open file stays open.
//! - What a Finder drop brings in is selected.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, MouseButton, PlatformInput, Pixels, Point};
use serde_json::json;

use super::{Steps, drops::PointerStep};
use crate::scenario::Run;

impl Run {
    async fn tree_selection(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        let rows = |cx: &mut AsyncApp| cx.update(|cx| tree.read(cx).row_paths(cx));
        let selection = |cx: &mut AsyncApp| cx.update(|cx| tree.read(cx).selection_state(cx));
        let intro = "chapters/intro.tex".to_string();

        // Opening a file inside a closed folder selects its row alone and
        // opens the folder down to it.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        if rows(cx).contains(&intro) {
            let chapters = self.tree_row_center(cx, "chapters")?;
            self.click_with(cx, chapters, Modifiers::default()).await?;
        }
        let closed = !rows(cx).contains(&intro);
        self.open(cx, &root.join(&intro), Some(1))?;
        let revealed = self
            .wait_for(cx, Duration::from_secs(4), |_, cx| {
                let (selected, _) = tree.read(cx).selection_state(cx);
                tree.read(cx).row_paths(cx).contains(&intro) && selected == [intro.clone()]
            })
            .await;
        let (selected, open) = selection(cx);
        steps.check(
            "opening a file in a closed folder selects its row alone and opens the folder to it",
            closed && revealed && open.contains(&"chapters".to_string()),
            json!({ "closed_first": closed, "selected": selected, "open": open }),
        );

        // Let the automatic build the openings started finish, and its
        // outputs' rescan reach the tree: landing mid-click it would redraw
        // the rows under the pointer, and its notice would be the newest one
        // when ⌘C's is looked for.
        self.wait_for(cx, Duration::from_secs(120), |shell, cx| {
            !shell.read(cx).building()
        })
        .await;
        self.pause(cx, Duration::from_millis(500)).await;

        // ⌘-click adds main.tex without opening it; ⇧-click takes the rows
        // shown from there to references.bib.
        let main = self.tree_row_center(cx, "main.tex")?;
        self.click_with(cx, main, Modifiers::command()).await?;
        let (added, _) = selection(cx);
        let front = cx.update(|cx| self.shell.read(cx).active_editor_path(cx));
        let bib = self.tree_row_center(cx, "references.bib")?;
        self.click_with(cx, bib, Modifiers::shift()).await?;
        let (ranged, _) = selection(cx);
        self.drop_shot(cx, "tree-multi-select").await;
        let shown = rows(cx);
        let range = |from: &str, to: &str| {
            let (a, b) = (
                shown.iter().position(|row| row == from),
                shown.iter().position(|row| row == to),
            );
            a.zip(b)
                .map(|(a, b)| shown[a.min(b)..=a.max(b)].to_vec())
                .unwrap_or_default()
        };
        steps.check(
            "⌘-click adds a row without opening it, and ⇧-click selects the rows shown between",
            added == [intro.clone(), "main.tex".to_string()]
                && front.as_deref() == Some(intro.as_str())
                && ranged == range("main.tex", "references.bib"),
            json!({ "added": added, "front": front, "ranged": ranged, "rows": shown }),
        );

        // ⌘C copies every selected path, one a line, and says how many.
        self.tree_key(cx, &tree, "cmd-c")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        let notice = self.last_notice(cx)?;
        let lines = copied.as_deref().map(|text| text.lines().count());
        steps.check(
            "⌘C with several rows selected copies each one's path and says how many",
            lines == Some(ranged.len())
                && notice
                    .as_deref()
                    .is_some_and(|notice| notice.starts_with(&format!("{} paths copied", ranged.len()))),
            json!({ "copied": copied, "notice": notice }),
        );

        // Enter with several selected does nothing; with one, it names that
        // row anew, and Escape leaves the name as it was.
        self.tree_key(cx, &tree, "enter")?;
        self.pause(cx, Duration::from_millis(150)).await;
        let several = self.naming_of(cx, &tree)?;
        let main = self.tree_row_center(cx, "main.tex")?;
        self.click_with(cx, main, Modifiers::default()).await?;
        self.tree_key(cx, &tree, "enter")?;
        self.pause(cx, Duration::from_millis(150)).await;
        let one = self.naming_of(cx, &tree)?;
        self.tree_key(cx, &tree, "escape")?;
        self.pause(cx, Duration::from_millis(150)).await;
        let after = self.naming_of(cx, &tree)?;
        steps.check(
            "Enter names the one selected row anew, and does nothing with several selected",
            several.is_none() && one.as_deref() == Some("main.tex") && after.is_none(),
            json!({ "several": several, "one": one, "after_escape": after }),
        );

        // Delete on a row of the selection asks about them all at once.
        for name in ["scratch-a.tex", "scratch-b.tex"] {
            std::fs::write(root.join(name), "% scratch\n")?;
        }
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.wait_for(cx, Duration::from_secs(4), |_, cx| {
            tree.read(cx).row_paths(cx).contains(&"scratch-b.tex".to_string())
        })
        .await;
        let a = self.tree_row_center(cx, "scratch-a.tex")?;
        self.click_with(cx, a, Modifiers::default()).await?;
        let b = self.tree_row_center(cx, "scratch-b.tex")?;
        self.click_with(cx, b, Modifiers::command()).await?;
        cx.update(|cx| tree.update(cx, |tree, cx| tree.delete_from_menu("scratch-b.tex", cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        let question = cx.update(|cx| self.shell.read(cx).confirm().read(cx).question());
        let confirm = cx.update(|cx| self.shell.read(cx).confirm().clone());
        self.with_window(cx, |_, window, cx| {
            confirm.update(cx, |confirm, cx| confirm.accept(window, cx))
        })?;
        let deleted = self
            .wait_for(cx, Duration::from_secs(8), |_, _| {
                !root.join("scratch-a.tex").exists() && !root.join("scratch-b.tex").exists()
            })
            .await;
        steps.check(
            "Delete on a row of the selection asks about them together and deletes both",
            deleted
                && question.as_deref() == Some("Delete 2 selected items from this project?"),
            json!({ "question": question }),
        );

        // A template's .sty stays out until Show hidden files.
        std::fs::write(root.join("acl.sty"), "% style\n")?;
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.pause(cx, Duration::from_millis(800)).await;
        let hidden = !rows(cx).contains(&"acl.sty".to_string());
        let project = cx.update(|cx| self.shell.read(cx).project().cloned());
        if let Some(project) = &project {
            project.update(cx, |project, cx| project.set_show_hidden(true, cx));
        }
        let shown = self
            .wait_for(cx, Duration::from_secs(4), |_, cx| {
                tree.read(cx).row_paths(cx).contains(&"acl.sty".to_string())
            })
            .await;
        if let Some(project) = &project {
            project.update(cx, |project, cx| project.set_show_hidden(false, cx));
        }
        std::fs::remove_file(root.join("acl.sty")).ok();
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        steps.check(
            "a template's .sty stays out of the tree until Show hidden files",
            hidden && shown,
            json!({ "hidden": hidden, "shown": shown }),
        );

        // The project shown again keeps its open folders.
        if let Some(project) = project {
            cx.update(|cx| tree.update(cx, |tree, cx| tree.set_project(project, cx)));
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let (_, open) = selection(cx);
        steps.check(
            "the project shown again keeps the folders that were open",
            open.contains(&"chapters".to_string()) && rows(cx).contains(&intro),
            json!({ "open": open }),
        );

        // A row reached with an arrow key is the selection: a rescan keeps
        // it, and a ⌘-click adds to it rather than to the clicked rows. A
        // folder's row is clicked, as a file's would hand the keyboard to the
        // editor it opens.
        let folder = self.tree_row_center(cx, "chapters")?;
        self.click_with(cx, folder, Modifiers::default()).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.tree_key(cx, &tree, "down")?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (arrowed, _) = selection(cx);
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.pause(cx, Duration::from_millis(800)).await;
        let (rescanned, _) = selection(cx);
        let bib = self.tree_row_center(cx, "references.bib")?;
        self.click_with(cx, bib, Modifiers::command()).await?;
        let (toggled, _) = selection(cx);
        let mut below_chapters = |list: &[String]| {
            let shown = rows(cx);
            let next = shown
                .iter()
                .position(|row| row == "chapters")
                .and_then(|ix| shown.get(ix + 1).cloned());
            (next.clone(), next.is_some_and(|next| list == [next]))
        };
        let (next, arrow_ok) = below_chapters(&arrowed);
        steps.check(
            "a row reached with ↓ stays the selection after a rescan, and ⌘-click adds to it",
            arrow_ok
                && rescanned == arrowed
                && toggled.len() == 2
                && toggled.first() == next.as_ref()
                && toggled.get(1).map(String::as_str) == Some("references.bib"),
            json!({ "arrowed": arrowed, "rescanned": rescanned, "toggled": toggled }),
        );

        // Switching to another project and back keeps each one's open
        // folders: B's open figures/ survives a visit to A with it closed.
        let other = std::env::temp_dir().join(format!("lattice-e2e-other-{}", std::process::id()));
        std::fs::create_dir_all(other.join("figures"))?;
        std::fs::write(other.join("main.tex"), "\\documentclass{article}\n")?;
        std::fs::write(other.join("figures/fig.txt"), "figure\n")?;
        let original = cx.update(|cx| self.shell.read(cx).project().cloned());
        let opened = crate::project::open(other.clone(), cx).await;
        let switched = match (original, opened) {
            (Some(a), Ok(b)) => {
                if rows(cx).iter().any(|row| row.starts_with("figures/")) {
                    let folder = self.tree_row_center(cx, "figures")?;
                    self.click_with(cx, folder, Modifiers::default()).await?;
                    self.pause(cx, Duration::from_millis(200)).await;
                }
                let a_closed = !rows(cx).iter().any(|row| row.starts_with("figures/"));
                cx.update(|cx| tree.update(cx, |tree, cx| tree.set_project(b.clone(), cx)));
                self.wait_for(cx, Duration::from_secs(4), |_, cx| {
                    tree.read(cx).row_paths(cx).contains(&"figures".to_string())
                })
                .await;
                if !rows(cx).contains(&"figures/fig.txt".to_string()) {
                    let folder = self.tree_row_center(cx, "figures")?;
                    self.click_with(cx, folder, Modifiers::default()).await?;
                }
                let b_open = self
                    .wait_for(cx, Duration::from_secs(4), |_, cx| {
                        tree.read(cx).row_paths(cx).contains(&"figures/fig.txt".to_string())
                    })
                    .await;
                cx.update(|cx| tree.update(cx, |tree, cx| tree.set_project(a.clone(), cx)));
                self.pause(cx, Duration::from_millis(300)).await;
                let a_still_closed = !rows(cx).iter().any(|row| row.starts_with("figures/"));
                cx.update(|cx| tree.update(cx, |tree, cx| tree.set_project(b.clone(), cx)));
                self.pause(cx, Duration::from_millis(300)).await;
                let (_, b_kept) = selection(cx);
                let b_rows = rows(cx);
                cx.update(|cx| tree.update(cx, |tree, cx| tree.set_project(a, cx)));
                self.pause(cx, Duration::from_millis(300)).await;
                Ok((a_closed, b_open, a_still_closed, b_kept, b_rows))
            }
            (_, Err(error)) => Err(error),
            (None, _) => Err("no project".to_string()),
        };
        steps.check(
            "switching projects keeps each project's open folders: B's figures/ stays open after A with it closed",
            matches!(&switched, Ok((true, true, true, kept, shown))
                if kept.contains(&"figures".to_string()) && shown.contains(&"figures/fig.txt".to_string())),
            json!({ "switched": format!("{switched:?}") }),
        );
        std::fs::remove_dir_all(&other).ok();

        // A batch move that fails part-way: what moved first still has its
        // tab follow it.
        std::fs::create_dir_all(root.join("dest"))?;
        for name in ["mv-a.tex", "mv-b.tex", "dest/mv-b.tex"] {
            std::fs::write(root.join(name), "% move\n")?;
        }
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.wait_for(cx, Duration::from_secs(4), |_, cx| {
            tree.read(cx).row_paths(cx).contains(&"mv-b.tex".to_string())
        })
        .await;
        self.open(cx, &root.join("mv-a.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        cx.update(|cx| {
            tree.update(cx, |_, cx| {
                cx.emit(crate::file_tree::FileTreeEvent::Move {
                    paths: vec!["mv-a.tex".into(), "mv-b.tex".into()],
                    target: "dest".into(),
                })
            })
        });
        let moved = self
            .wait_for(cx, Duration::from_secs(8), |_, _| root.join("dest/mv-a.tex").is_file())
            .await;
        self.pause(cx, Duration::from_millis(500)).await;
        let front = cx.update(|cx| self.shell.read(cx).active_editor_path(cx));
        let notice = self.last_notice(cx)?;
        steps.check(
            "a batch move that fails part-way still moves the open tab of what went first",
            moved
                && front.as_deref() == Some("dest/mv-a.tex")
                && root.join("mv-b.tex").is_file()
                && notice.as_deref().is_some_and(|notice| notice.starts_with("Could not move it")),
            json!({ "moved": moved, "front": front, "notice": notice }),
        );
        if let Some(view) = cx.update(|cx| self.shell.read(cx).view_of_document("dest/mv-a.tex", cx)) {
            cx.update(|cx| {
                self.shell
                    .read(cx)
                    .workspace()
                    .clone()
                    .update(cx, |workspace, cx| workspace.close(&[view], cx))
            });
        }
        std::fs::remove_file(root.join("mv-b.tex")).ok();
        std::fs::remove_dir_all(root.join("dest")).ok();
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.pause(cx, Duration::from_millis(300)).await;

        // A press on the tree's empty space clears the selection, as in
        // Finder, so + makes the next file at the project root; the open
        // file stays open.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let chapters = self.tree_row_center(cx, "chapters")?;
        self.click_with(cx, chapters, Modifiers::default()).await?;
        let (picked, _) = selection(cx);
        let folder_before = cx.update(|cx| tree.read(cx).new_entry_folder(cx));
        let below = self.tree_below_rows(cx)?;
        self.click_with(cx, below, Modifiers::default()).await?;
        let (cleared, _) = selection(cx);
        let folder_after = cx.update(|cx| tree.read(cx).new_entry_folder(cx));
        let front = cx.update(|cx| self.shell.read(cx).active_editor_path(cx));
        steps.check(
            "a press on the tree's empty space clears the selection, so + makes the next file at the root, and the open file stays",
            picked == ["chapters".to_string()]
                && folder_before == "chapters"
                && cleared.is_empty()
                && folder_after.is_empty()
                && front.as_deref() == Some("main.tex"),
            json!({
                "picked": picked,
                "folder_before": folder_before,
                "cleared": cleared,
                "folder_after": folder_after,
                "front": front,
            }),
        );

        // What a Finder drop brings in is selected.
        let finder =
            std::env::temp_dir().join(format!("lattice-e2e-select-{}", std::process::id()));
        std::fs::create_dir_all(&finder)?;
        let notes = finder.join("dropped-notes.md");
        std::fs::write(&notes, "Dropped.\n")?;
        let below = self.tree_below_rows(cx)?;
        self.file_drag(cx, below, &[notes]).await?;
        self.file_drop(cx, below).await?;
        let picked = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                let (selected, _) = tree.read(cx).selection_state(cx);
                selected == ["dropped-notes.md".to_string()]
            })
            .await;
        let (selected, _) = selection(cx);
        steps.check(
            "what a Finder drop on the tree brings in is selected",
            picked,
            json!({ "selected": selected }),
        );
        std::fs::remove_file(root.join("dropped-notes.md")).ok();
        std::fs::remove_dir_all(&finder).ok();
        Ok(())
    }

    /// A click at `at` with `modifiers` held, pressed and released there.
    pub(super) async fn click_with(
        &self,
        cx: &mut AsyncApp,
        at: Point<Pixels>,
        modifiers: Modifiers,
    ) -> Result<()> {
        if modifiers == Modifiers::default() {
            self.pointer(cx, PointerStep::Down, at).await?;
            return self.pointer(cx, PointerStep::Up, at).await;
        }
        for event in [
            PlatformInput::MouseDown(gpui::MouseDownEvent {
                button: MouseButton::Left,
                position: at,
                modifiers,
                click_count: 1,
                first_mouse: false,
            }),
            PlatformInput::MouseUp(gpui::MouseUpEvent {
                button: MouseButton::Left,
                position: at,
                modifiers,
                click_count: 1,
            }),
        ] {
            self.with_window(cx, |_, window, cx| {
                window.dispatch_event(event, cx);
            })?;
            self.frame_after_input(cx).await?;
        }
        Ok(())
    }

    /// `keys` pressed with the tree holding the keyboard.
    fn tree_key(
        &self,
        cx: &mut AsyncApp,
        tree: &gpui::Entity<crate::file_tree::FileTreePanel>,
        keys: &'static str,
    ) -> Result<()> {
        let tree = tree.clone();
        let keystroke = gpui::Keystroke::parse(keys)?;
        self.with_window(cx, move |_, window, cx| {
            let focus = gpui::Focusable::focus_handle(tree.read(cx), cx);
            if !focus.contains_focused(window, cx) {
                window.focus(&focus, cx);
            }
            window.dispatch_event(
                PlatformInput::KeyDown(gpui::KeyDownEvent {
                    keystroke,
                    is_held: false,
                    prefer_character_input: false,
                }),
                cx,
            );
        })
    }

    /// The row being named, if any.
    fn naming_of(
        &self,
        cx: &mut AsyncApp,
        tree: &gpui::Entity<crate::file_tree::FileTreePanel>,
    ) -> Result<Option<String>> {
        let tree = tree.clone();
        self.with_window(cx, move |_, window, cx| {
            tree.read(cx)
                .naming_state(window, cx)
                .map(|(path, ..)| path)
        })
    }
}

/// This file's registration as the e2e module `tree_selection`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 32,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/file_tree/selection.rs",
        "gpui/crates/lattice-gpui/src/file_tree/memory.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.tree_selection(cx, steps, &fixture.root)),
};
