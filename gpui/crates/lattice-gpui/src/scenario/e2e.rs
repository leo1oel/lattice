//! The end-to-end check of the writing flow, driven with native input on
//! macOS and Windows.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::{Value, json};

use super::Run;
use crate::{editor_panel::EditorPanel, native};

mod bib;
mod build_flow;
mod documents;
mod editor_adapter;
mod fluid;
#[cfg(target_os = "macos")]
mod islands;
mod papers;
mod pdf;
mod saves;
mod settings;
mod source_chrome;
mod status_bar;

/// Each step's name, whether it passed, and what it saw.
struct Steps(Vec<Value>);

impl Steps {
    fn check(&mut self, name: &str, passed: bool, detail: Value) -> bool {
        self.0
            .push(json!({ "step": name, "passed": passed, "detail": detail }));
        passed
    }
}

impl Run {
    /// The writing flow, end to end, on a scratch copy of a small project:
    /// open it through lattice-core, build, jump from the source to the PDF
    /// and back (SyncTeX), and from a .bib entry to the PDF, autosave, take
    /// an outside edit into a clean buffer and merge one into an edited
    /// buffer, break the document by typing, save with the shortcut, build,
    /// follow the error to its line, search, Vim, repair, build; glide the
    /// Project tree's hover between rows (`fluid.rs`); hover a
    /// citation and a reference, draw remote carets and a block widget, show
    /// TexLab's diagnostics and complete a citation and a command; then create,
    /// rename, move and delete files in the tree, check the PDF viewer on a
    /// second root document and in a second window (`pdf.rs`), drag a tab
    /// into a dock, open Settings and change it (the interface language
    /// included), close a dirty tab, a vanished file's tab and a window,
    /// and type before the quit that ends the run, which the result's `after_quit`
    /// names for the CI workflow to check on disk.
    pub(super) async fn e2e(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Steps(Vec::new());
        let root = self.root(cx).await?;
        // No step may reach a real TeX install.
        let stub = self.stub_tex_setup(cx, &root);
        // The look-review shots find the Build button by its probe.
        if std::env::var_os("LATTICE_E2E_SHOTS").is_some() {
            lattice_ui::parity::enable();
        }
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)
            .context("the e2e project needs chapters/intro.tex")?;
        self.pause(cx, Duration::from_millis(800)).await;

        // Opened as the Tauri app opens a folder it did not create: adopted,
        // with its manifest naming the main document.
        let (main_document, rows) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let main = shell
                .project()
                .and_then(|project| project.read(cx).main_document().map(str::to_string));
            (main, shell.file_tree().read(cx).row_paths(cx))
        });
        steps.check(
            "the project opens through lattice-core, adopted with main.tex as its main document",
            main_document.as_deref() == Some("main.tex")
                && root.join(".research/project.json").is_file()
                && rows.iter().any(|row| row == "main.tex")
                && rows.iter().any(|row| row == "chapters"),
            json!({ "root": root, "main": main_document, "rows": rows }),
        );

        let (built, took) = self.build(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        let pages = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count(cx));
        let rows = cx.update(|cx| self.shell.read(cx).file_tree().read(cx).row_paths(cx));
        steps.check(
            "build succeeds and the PDF shows",
            built && pages > 0,
            json!({ "seconds": took.as_secs_f32(), "pages": pages }),
        );
        steps.check(
            "the tree hides the build's output, as the Tauri app's does",
            !rows
                .iter()
                .any(|row| row.ends_with(".aux") || row.ends_with(".log") || row == "main.pdf"),
            json!({ "rows": rows }),
        );
        self.sequence_and_words(cx, &mut steps).await?;
        self.fluid_hover(cx, &mut steps).await?;
        self.source_chrome(cx, &mut steps, &root).await?;

        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let language = cx.update(|cx| {
            editor
                .read(cx)
                .editor()
                .read(cx)
                .buffer()
                .read(cx)
                .as_singleton()
                .and_then(|buffer| {
                    buffer
                        .read(cx)
                        .language()
                        .map(|language| language.name().to_string())
                })
        });
        steps.check(
            "a .tex file opens with LaTeX highlighting",
            language.as_deref() == Some("LaTeX"),
            json!({ "language": language }),
        );

        let intro_top = self.synctex(cx, &mut steps, &root, &editor).await?;
        self.bib_sync(cx, &mut steps, &root, intro_top).await?;
        self.autosave_and_outside_edits(cx, &mut steps, &chapter, &editor)
            .await?;
        // The chapter as the merge left it, for the repair below.
        let merged = std::fs::read_to_string(&chapter).unwrap_or_else(|_| original.clone());

        // The broken macro goes on its own line 3.
        self.open(cx, &chapter, Some(3))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.type_text(cx, "\\undefinedmacro ").await?;
        let typed = self.editor_text(cx, &editor).contains("\\undefinedmacro ");
        let dirty = cx.update(|cx| editor.read(cx).is_dirty(cx));
        steps.check(
            "typing with native key events edits the buffer",
            typed && dirty,
            json!({ "dirty": dirty }),
        );

        self.press(cx, 's', true).await?;
        let saved = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                std::fs::read_to_string(&chapter)
                    .is_ok_and(|text| text.contains("\\undefinedmacro"))
            })
            .await;
        steps.check(
            "the save shortcut (⌘S / Ctrl+S) saves the file",
            saved,
            json!({}),
        );

        let (built, took) = self.build(cx).await?;
        let error = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            panel
                .diagnostics()
                .iter()
                .find(|diagnostic| diagnostic.level == "error")
                .map(|diagnostic| (diagnostic.clone(), panel.location(diagnostic)))
        });
        let located = error.as_ref().is_some_and(|(diagnostic, _)| {
            diagnostic
                .file
                .as_deref()
                .is_some_and(|file| file.ends_with("intro.tex"))
                && diagnostic.line == Some(3)
        });
        steps.check(
            "a broken build reports the error at its file and line",
            !built && located,
            json!({ "seconds": took.as_secs_f32(), "error": error.as_ref().map(|(d, _)| format!("{:?}:{:?} {}", d.file, d.line, d.message)) }),
        );
        self.explained_failure(cx, &mut steps).await?;

        if let Some((_, Some(location))) = error {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.open_path(location.path.clone(), location.line, window, cx)
                });
            })?;
            self.pause(cx, Duration::from_millis(200)).await;
            let row = self.cursor_row(cx, &editor);
            steps.check(
                "following the error puts the cursor on its line",
                row == 2,
                json!({ "row": row + 1 }),
            );
        }

        let found = {
            let bar = cx.update(|cx| editor.read(cx).search_bar().clone());
            let searched = self.with_window(cx, |_, window, cx| {
                bar.update(cx, |bar, cx| {
                    bar.search("undefinedmacro", None, false, window, cx)
                })
            })?;
            searched.await.ok();
            self.pause(cx, Duration::from_millis(200)).await;
            cx.update(|cx| bar.read(cx).has_active_match())
        };
        steps.check("buffer search finds the text", found, json!({}));

        // Vim: Normal mode's `x` deletes the character under the cursor.
        cx.update(|cx| crate::app::set_vim_mode(true, cx));
        let scratch = root.join("vim-check.txt");
        std::fs::write(&scratch, "abc\n")?;
        let vim_editor = self.open(cx, &scratch, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.type_text(cx, "x").await?;
        self.pause(cx, Duration::from_millis(100)).await;
        let vim_text = self.editor_text(cx, &vim_editor);
        steps.check(
            "Vim mode: x deletes the character under the cursor",
            vim_text == "bc\n",
            json!({ "text": vim_text }),
        );
        cx.update(|cx| crate::app::set_vim_mode(false, cx));
        // Once the edit is saved, its tab closes by itself when the file goes.
        self.wait_for(cx, Duration::from_secs(6), |_, cx| {
            !vim_editor.read(cx).is_dirty(cx)
        })
        .await;
        std::fs::remove_file(&scratch).ok();
        self.status_bar_and_scrollbar(cx, &mut steps, &root).await?;

        // Repairing the file outside Lattice reloads the clean buffer.
        std::fs::write(&chapter, &merged)?;
        let reloaded = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                !editor
                    .read(cx)
                    .editor()
                    .read(cx)
                    .text(cx)
                    .contains("undefinedmacro")
            })
            .await;
        let (built, _) = self.build(cx).await?;
        steps.check(
            "repairing the file outside Lattice reloads it and builds cleanly again",
            reloaded && built,
            json!({ "reloaded": reloaded }),
        );
        self.build_fixes(cx, &mut steps, &root, &stub).await?;
        self.doctor_and_setup(cx, &mut steps, &stub).await?;

        // The editor adapter's extension points, through their LaTeX uses.
        self.editor_adapter(cx, &mut steps, &root).await?;

        self.tree_operations(cx, &mut steps, &root).await?;
        self.documents_and_project(cx, &mut steps, &root).await?;
        // Overlays above a page need gpui-fast's window composition, which
        // WebView2 does not join yet (gpui-webview 0.9.1), so the island
        // checks run on macOS.
        #[cfg(target_os = "macos")]
        self.webview_islands(cx, &mut steps, &root).await?;
        self.pdf_viewer(cx, &mut steps, &root).await?;
        self.second_window_pdf(cx, &mut steps, &root).await?;

        // Docking: drag an editor tab out of the center into the right dock,
        // beside the PDF, with native mouse events. (The shell steps after
        // it drag the PDF out of its dock alone.)
        //
        // A known flake, so it runs only when LATTICE_E2E_DRAG is set and
        // cannot block a release's gpui.yml run. On the 1024px macOS runner
        // the center is ~180px wide with three tabs open, and the drag
        // starts at a fixed point that assumes the first tab sits at the
        // strip's left edge; it misses a draggable tab there (failed every
        // macOS run of fm/lattice-main-ci-green once Stop stopped stalling,
        // with notices closed). Taking the point from the tab's recorded
        // parity region would fix it.
        if std::env::var_os("LATTICE_E2E_DRAG").is_some() {
            let (moved, layout) = self.drag_editor_tab_to_right_dock(cx).await?;
            steps.check(
                "an editor tab drags from the center into the right dock",
                moved,
                layout,
            );
        }

        for (name, passed, detail) in self.shell_steps(cx).await? {
            steps.check(name, passed, detail);
        }

        self.papers_panel(cx, &mut steps, &root).await?;
        self.bib_visual_editor(cx, &mut steps, &root).await?;
        self.settings_and_language(cx, &mut steps).await?;
        self.closing_saves(cx, &mut steps, &root).await?;
        // Last: `scenario::start` quits once the result is written.
        let quit = self.type_before_quit(cx, &mut steps, &root).await?;

        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "e2e", "passed": passed, "steps": steps.0, "after_quit": quit }))
    }

    /// The webview island checks alone (`islands.rs`), for work on the
    /// islands: the e2e scenario runs them too.
    #[cfg(target_os = "macos")]
    pub(super) async fn islands(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Steps(Vec::new());
        let root = self.root(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        self.webview_islands(cx, &mut steps, &root).await?;
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "islands", "passed": passed, "steps": steps.0 }))
    }

    /// SyncTeX both ways: from the caret on the chapter's second line to its
    /// box in the PDF, then a double-click on that box back to the line.
    /// Returns the top of the box on its page.
    async fn synctex(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        editor: &Entity<EditorPanel>,
    ) -> Result<Option<f32>> {
        self.open(cx, &root.join("chapters/intro.tex"), Some(2))?;
        self.pause(cx, Duration::from_millis(200)).await;
        // What ⌘⇧J and the PDF toolbar's locate button run.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.forward_sync(&crate::shell::ForwardSync, window, cx)
            })
        })?;
        let marked = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                shell
                    .read(cx)
                    .pdf()
                    .read(cx)
                    .sync_mark(cx)
                    .is_some_and(|(_, scroll)| !scroll)
            })
            .await;
        let (mark, top) = cx.update(|cx| {
            let pdf = self.shell.read(cx).pdf().read(cx);
            (pdf.sync_mark(cx), pdf.sync_mark_top(cx))
        });
        steps.check(
            "SyncTeX: the caret's line is found and marked in the PDF",
            marked && mark.is_some_and(|(page, _)| page == 0),
            json!({ "mark": mark.map(|(page, _)| page + 1) }),
        );

        // Somewhere else first, so the jump back is seen to land.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let center = cx.update(|cx| self.shell.read(cx).pdf().read(cx).sync_mark_center(cx));
        let landed = match center {
            Some(center) => {
                native::send_double_click(self.native(cx)?, center)?;
                self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
                    shell
                        .read(cx)
                        .active_editor_path(cx)
                        .is_some_and(|path| path.ends_with("intro.tex"))
                })
                .await
            }
            None => false,
        };
        // Lines 2–4 are one paragraph, typeset as one; SyncTeX may name any
        // of them for a point inside it.
        let row = self.cursor_row(cx, editor);
        steps.check(
            "SyncTeX: a double-click in the PDF opens its source line",
            landed && (1..=3).contains(&row),
            json!({ "at": center.map(|c| [f32::from(c.x), f32::from(c.y)]), "row": row + 1 }),
        );
        Ok(top)
    }

    /// Autosave after a pause in typing; an outside edit reloads a clean
    /// buffer; one made while the buffer holds edits is merged by the save.
    async fn autosave_and_outside_edits(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        chapter: &Path,
        editor: &Entity<EditorPanel>,
    ) -> Result<()> {
        self.open(cx, chapter, Some(4))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let builds = cx.update(|cx| self.shell.read(cx).build_panel().read(cx).builds());
        self.type_text(cx, "Autosaved. ").await?;
        let autosaved = self
            .wait_for(cx, Duration::from_secs(6), |_, cx| {
                !editor.read(cx).is_dirty(cx)
                    && std::fs::read_to_string(chapter)
                        .is_ok_and(|text| text.contains("Autosaved. "))
            })
            .await;
        // Automatic builds are on, as the Tauri app's are by default: one
        // follows the save.
        let built = self
            .wait_for(cx, Duration::from_secs(120), |shell, cx| {
                let shell = shell.read(cx);
                let panel = shell.build_panel().read(cx);
                !shell.building() && panel.builds() > builds && panel.succeeded() == Some(true)
            })
            .await;
        steps.check(
            "a pause in typing saves the file and builds",
            autosaved && built,
            json!({ "saved": autosaved, "built": built }),
        );

        // Clean buffer: an outside edit reloads it.
        let on_disk = std::fs::read_to_string(chapter)?;
        let outside = on_disk.replace("The last line.", "The last line, edited outside.");
        std::fs::write(chapter, &outside)?;
        let reloaded = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                let text = editor.read(cx).editor().read(cx).text(cx);
                text.contains("edited outside") && !editor.read(cx).is_dirty(cx)
            })
            .await;
        steps.check(
            "an edit made outside Lattice reloads a clean buffer",
            reloaded,
            json!({}),
        );
        // Let the automatic build that reload starts finish.
        self.wait_for(cx, Duration::from_secs(120), |shell, cx| {
            !shell.read(cx).building()
        })
        .await;

        // Edited buffer: the outside edit waits for the save, which merges.
        self.open(cx, chapter, Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.type_text(cx, "Typed here.\n").await?;
        let outside = std::fs::read_to_string(chapter)?.replace(
            "A second line of the introduction.",
            "A second line, changed outside.",
        );
        std::fs::write(chapter, &outside)?;
        // The poll sees the outside edit and leaves the edited buffer alone.
        self.pause(cx, Duration::from_millis(400)).await;
        self.press(cx, 's', true).await?;
        let merged = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                let disk = std::fs::read_to_string(chapter).unwrap_or_default();
                let buffer = editor.read(cx).editor().read(cx).text(cx);
                let both =
                    |text: &str| text.contains("Typed here.") && text.contains("changed outside");
                both(&disk) && both(&buffer) && !editor.read(cx).is_dirty(cx)
            })
            .await;
        steps.check(
            "an outside edit made while the buffer holds edits is merged by the save, not lost",
            merged,
            json!({ "disk": std::fs::read_to_string(chapter).unwrap_or_default() }),
        );
        self.wait_for(cx, Duration::from_secs(120), |shell, cx| {
            !shell.read(cx).building()
        })
        .await;
        Ok(())
    }

    /// New file, rename, move and delete in the tree, as its menu runs them.
    async fn tree_operations(
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

    async fn drag_editor_tab_to_right_dock(&self, cx: &mut AsyncApp) -> Result<(bool, Value)> {
        use gpui_kit::component::dock::DockPlacement;
        let (area_bounds, left_width, right_width) = cx.update(|cx| {
            let area = self.shell.read(cx).dock_area().read(cx);
            (
                area.bounds(),
                area.dock_size(DockPlacement::Left),
                area.dock_size(DockPlacement::Right),
            )
        });
        let left_width = left_width.unwrap_or_default();
        let right_width = right_width.context("there is no right dock")?;
        // The icon of the center's first tab: past the group's inset, the
        // strip's 6px padding and the tab's 14px. The icon is where the tab
        // begins, so it stays under the pointer when a narrow center (a
        // 1024px CI screen leaves it ~160px) gives the strip's trailing
        // build chip and menu most of the width and clips the tabs.
        let from = gpui::point(
            area_bounds.left()
                + left_width
                + lattice_ui::dock::GROUP_INSET
                + gpui::px(6. + 14.)
                + lattice_ui::icons::ICON / 2.,
            area_bounds.top() + gpui::px(18.),
        );
        // The middle of the PDF panel.
        let to = gpui::point(
            area_bounds.right() - right_width / 2.,
            area_bounds.top() + area_bounds.size.height / 2.,
        );
        // The notices stack at the bottom right, over the right dock: with
        // the Clean, package and TeX installs just before, their cards can
        // cover the PDF's middle on a 768px CI screen and take the drop.
        // Close them first, as the writer would.
        let notices = cx.update(|cx| {
            let stack = crate::notices::install(cx);
            let titles = stack.read(cx).titles();
            stack.update(cx, |stack, cx| stack.clear(cx));
            titles
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let mut detail = self.native_drag(cx, from, to).await?;
        let state = cx.update(|cx| {
            let area = self.shell.read(cx).dock_area().read(cx);
            serde_json::to_value(area.dump(cx)).unwrap_or_default()
        });
        let right = state["right_dock"].to_string();
        let moved = right.contains("EditorPanel") && right.contains("PdfPanel");
        detail["notices_closed"] = json!(notices);
        detail["right_dock"] = state["right_dock"].clone();
        Ok((moved, detail))
    }
}
