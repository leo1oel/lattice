//! Files dragged in from Finder and Project tree rows dragged out
//! (`shell/drops.rs`, `editor_panel/drops.rs`, the tree's drop handlers):
//! the window gets the platform's own file-drop events (entered, moved,
//! dropped) and pointer events, as AppKit hands them over.
//!
//! - Finder files dropped on a folder's row land in that folder, the folder
//!   lit while it is aimed at; off the rows, the project root is aimed at.
//! - Another kind of drag after a Finder drag left (a split's divider)
//!   lights no folder of the tree and no editor.
//! - A Finder figure dropped on a LaTeX editor goes into `figures/` and in
//!   as a figure at the line under the pointer, the editor lit meanwhile.
//! - A Finder source dropped on an editor is imported and opens; a mix of
//!   sources and figures says to drop them separately.
//! - A figure's row dragged from the tree over the editor draws the drop
//!   caret, and goes in as a figure.
//! - A file's row dragged out of the Project panel is carried on by
//!   Trellis and lands in the documents' panel; one let go before Trellis
//!   takes it is let go at the next move, its tab closed again.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result};
use gpui::{
    AsyncApp, ExternalPaths, FileDropEvent, Modifiers, MouseButton, PlatformInput, Pixels, Point,
};
use serde_json::json;

use super::Steps;
use crate::{
    editor_panel::{DocumentView, drops::DropLit},
    scenario::Run,
};

impl Run {
    async fn drops(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let finder = std::env::temp_dir().join(format!("lattice-e2e-finder-{}", std::process::id()));
        std::fs::create_dir_all(&finder)?;
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(4, 3, image::Rgba([30, 160, 90, 255]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let plot = finder.join("finder-plot.png");
        std::fs::write(&plot, png.into_inner())?;
        let notes = finder.join("finder-notes.txt");
        std::fs::write(&notes, "Notes from Finder.\n")?;

        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());

        // Finder → a folder's row: it lands there, the folder lit meanwhile,
        // even right after typing (AppKit sends no mouse moves meanwhile).
        let chapters = self.tree_row_center(cx, "chapters")?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::KeyDown(gpui::KeyDownEvent {
                    keystroke: gpui::Keystroke::parse("shift").expect("shift parses"),
                    is_held: false,
                    prefer_character_input: false,
                }),
                cx,
            );
        })?;
        self.file_drag(cx, chapters, std::slice::from_ref(&notes)).await?;
        let aimed = cx.update(|cx| tree.read(cx).drop_folder(cx));
        self.drop_shot(cx, "drop-tree-folder").await;
        self.file_drop(cx, chapters).await?;
        let landed = self
            .wait_for(cx, Duration::from_secs(8), |_, _| {
                root.join("chapters/finder-notes.txt").is_file()
            })
            .await;
        steps.check(
            "a Finder drop on a folder's row, right after typing, lands in that folder, lit while aimed at",
            landed && aimed.as_deref() == Some("chapters"),
            json!({ "aimed": aimed }),
        );

        // Off the rows, the project root is aimed at; leaving puts it out.
        let below = self.tree_below_rows(cx)?;
        self.file_drag(cx, below, std::slice::from_ref(&notes)).await?;
        let root_aimed = cx.update(|cx| tree.read(cx).drop_folder(cx));
        self.drop_shot(cx, "drop-tree-root").await;
        self.file_event(cx, FileDropEvent::Exited).await?;
        let after = cx.update(|cx| tree.read(cx).drop_folder(cx));
        steps.check(
            "a Finder drag off the tree's rows aims at the project root, and leaving clears it",
            root_aimed.as_deref() == Some("") && after.is_none(),
            json!({ "aimed": root_aimed, "after": after }),
        );

        // Another kind of drag after a Finder drag left (a Markdown split's
        // divider): no folder of the tree, nor the editor it left, lit.
        let marks = self.divider_drag_marks(cx, root, &notes).await?;
        steps.check(
            "a drag of a split's divider after a Finder drag left lights no folder of the tree and no editor",
            marks.tree_dragging
                && marks.tree_aimed.is_none()
                && marks.editor_lit_before == Some(DropLit::Open)
                && marks.editor_dragging
                && marks.editor_lit.is_none(),
            json!({
                "tree_dragging": marks.tree_dragging,
                "tree_aimed": marks.tree_aimed,
                "editor_lit_before": format!("{:?}", marks.editor_lit_before),
                "editor_dragging": marks.editor_dragging,
                "editor_lit": format!("{:?}", marks.editor_lit),
            }),
        );
        self.open(cx, &chapter, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        // Finder figure → the LaTeX editor's second line: a figure there.
        let (text, _) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        let second = text.find('\n').map(|at| at + 1).context("a second line")?;
        let second_line = text[second..].lines().next().unwrap_or_default().to_string();
        let at = self
            .with_window(cx, |_, window, cx| editor.update(cx, |editor, cx| editor.point_before(second, window, cx)))?
            .context("the second line is on screen")?;
        self.file_drag(cx, at, std::slice::from_ref(&plot)).await?;
        let lit = cx.update(|cx| editor.read(cx).drop_lit(cx));
        self.drop_shot(cx, "drop-editor-figure").await;
        self.file_drop(cx, at).await?;
        let shown = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).inserts.figure.is_some()
            })
            .await;
        let dialog = cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .figure
                .as_ref()
                .map(|open| open.dialog.clone())
        });
        if let Some(dialog) = &dialog {
            dialog.update(cx, |dialog, cx| dialog.insert(cx));
        }
        self.pause(cx, Duration::from_millis(200)).await;
        let inserted = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let figure_at = inserted.find("\\begin{figure}");
        let line_at = inserted.find(&second_line);
        steps.check(
            "a Finder figure dropped on a LaTeX editor goes into figures/ and in at the line under the pointer",
            shown
                && lit == (Some(DropLit::Insert), false)
                && root.join("figures/finder-plot.png").is_file()
                && inserted.contains("figures/finder-plot.png")
                // At the line's start: only the edit's own blank line before it.
                && figure_at.is_some_and(|at| at >= second && inserted[second..at].trim().is_empty())
                && line_at.is_some_and(|line| line > second),
            json!({ "lit": format!("{lit:?}"), "figure_at": figure_at, "second": second }),
        );
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, &text, 0, window, cx)
            })
        })?;

        // A figure's row from the tree over the editor: the drop caret. The
        // import's rescan shows figures/ with the figure revealed in it.
        let rows = |cx: &mut gpui::App, path: &str| {
            self.shell.read(cx).file_tree().read(cx).row_paths(cx).contains(&path.to_string())
        };
        self.wait_for(cx, Duration::from_secs(8), |_, cx| rows(cx, "figures")).await;
        let tree_drag = self.tree_figure_drag(cx, &editor, second).await;
        steps.check(
            "a figure's row dragged from the tree over the editor draws the drop caret and goes in as a figure",
            tree_drag.as_ref().is_ok_and(|(caret, offered)| *caret == (Some(DropLit::Insert), true) && *offered),
            match &tree_drag {
                Ok((caret, offered)) => json!({ "lit": format!("{caret:?}"), "offered": offered }),
                Err(error) => json!({
                    "error": error.to_string(),
                    "rows": cx.update(|cx| self.shell.read(cx).file_tree().read(cx).row_paths(cx)),
                }),
            },
        );
        self.close_figure_dialog(cx);

        // Finder source → the editor: imported into the root and opened.
        self.file_drag(cx, at, std::slice::from_ref(&notes)).await?;
        let open_lit = cx.update(|cx| editor.read(cx).drop_lit(cx));
        self.drop_shot(cx, "drop-editor-open").await;
        self.file_drop(cx, at).await?;
        let opened = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell
                    .read(cx)
                    .active_editor_path(cx)
                    .is_some_and(|path| path == "finder-notes.txt")
            })
            .await;
        steps.check(
            "a Finder source dropped on an editor is imported into the project and opens",
            opened && open_lit.0 == Some(DropLit::Open) && root.join("finder-notes.txt").is_file(),
            json!({ "lit": format!("{open_lit:?}") }),
        );

        // A mix of sources and figures: drop them separately.
        let editor = self.open(cx, &chapter, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let at = self
            .with_window(cx, |_, window, cx| editor.update(cx, |editor, cx| editor.point_before(second, window, cx)))?
            .context("the second line is on screen")?;
        self.file_drag(cx, at, &[notes.clone(), plot.clone()]).await?;
        self.file_drop(cx, at).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let notice = self.last_notice(cx)?;
        steps.check(
            "a mix of sources and figures dropped on an editor says to drop them separately",
            notice
                .as_deref()
                .is_some_and(|notice| notice.starts_with("Drop source files and figures separately")),
            json!({ "notice": notice }),
        );

        // A file's row dragged out of the Project panel: Trellis lands it
        // in the documents' panel.
        let bib = self.tree_row_center(cx, "references.bib")?;
        let target = self
            .with_window(cx, |_, window, cx| editor.update(cx, |editor, cx| editor.point_before(second, window, cx)))?
            .context("the editor is on screen")?;
        self.pointer(cx, PointerStep::Down, bib).await?;
        self.pointer(cx, PointerStep::Move, bib + gpui::point(gpui::px(12.), gpui::px(0.)))
            .await?;
        let mid = gpui::point((bib.x + target.x) / 2., (bib.y + target.y) / 2.);
        self.pointer(cx, PointerStep::Move, mid).await?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.pointer(cx, PointerStep::Move, target).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.pointer(cx, PointerStep::Up, target).await?;
        self.pause(cx, Duration::from_millis(500)).await;
        let placed = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let view = shell.view_of_document("references.bib", cx)?;
            let panel = shell.placement(&view, cx)?.1;
            let project = shell.placement("project", cx)?.1;
            Some((view, panel != project))
        });
        steps.check(
            "a file's row dragged out of the Project panel is carried by Trellis into the documents",
            placed.as_ref().is_some_and(|(_, away)| *away),
            json!({ "placed": placed }),
        );
        if let Some((view, _)) = placed {
            cx.update(|cx| {
                self.shell
                    .read(cx)
                    .workspace()
                    .clone()
                    .update(cx, |workspace, cx| workspace.close(&[view], cx))
            });
        }

        // A row flicked out and let go before the frame Trellis takes it on:
        // the next move without the button lets go of it, the tab it opened
        // closed again, rather than the tab following the bare pointer.
        self.pause(cx, Duration::from_millis(300)).await;
        let bib = self.tree_row_center(cx, "references.bib")?;
        self.pointer(cx, PointerStep::Down, bib).await?;
        self.pointer(cx, PointerStep::Move, bib + gpui::point(gpui::px(12.), gpui::px(0.)))
            .await?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: target,
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Modifiers::default(),
                }),
                cx,
            );
            window.dispatch_event(
                PlatformInput::MouseUp(gpui::MouseUpEvent {
                    button: MouseButton::Left,
                    position: target,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        self.frame_after_input(cx).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let lifted = cx.update(|cx| self.shell.read(cx).view_of_document("references.bib", cx));
        let past = target + gpui::point(gpui::px(24.), gpui::px(0.));
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: past,
                    pressed_button: None,
                    modifiers: Modifiers::default(),
                }),
                cx,
            );
        })?;
        self.frame_after_input(cx).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let left = cx.update(|cx| self.shell.read(cx).view_of_document("references.bib", cx));
        steps.check(
            "a row released before Trellis carries it is let go at the next move, its tab closed again",
            lifted.is_some() && left.is_none(),
            json!({ "lifted": lifted, "left": left }),
        );
        if let Some(view) = left {
            cx.update(|cx| {
                self.shell
                    .read(cx)
                    .workspace()
                    .clone()
                    .update(cx, |workspace, cx| workspace.close(&[view], cx))
            });
        }

        for path in [
            root.join("chapters/finder-notes.txt"),
            root.join("finder-notes.txt"),
            root.join("figures/finder-plot.png"),
        ] {
            std::fs::remove_file(path).ok();
        }
        std::fs::remove_dir_all(&finder).ok();
        Ok(())
    }

    /// A Markdown file opened in Split, its divider dragged after the
    /// Finder drag that last left the tree, then again after one that left
    /// the file's editor: what each drag showed.
    async fn divider_drag_marks(
        &self,
        cx: &mut AsyncApp,
        root: &Path,
        notes: &Path,
    ) -> Result<DividerMarks> {
        let path = root.join("e2e-drop-split.md");
        std::fs::write(&path, "# Split\n\nA paragraph to drop beside.\n")?;
        let panel = self.open(cx, &path, None)?;
        self.with_window(cx, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.set_document_view(DocumentView::Split, window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        let ratio = cx.update(|cx| crate::editor_panel::views::split_ratio(cx));
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        let grip = cx
            .update(|cx| panel.read(cx).split_divider_center(cx))
            .context("the split is laid out")?;
        let aside = grip - gpui::point(gpui::px(30.), gpui::px(0.));

        self.pointer(cx, PointerStep::Down, grip).await?;
        self.pointer(cx, PointerStep::Move, aside).await?;
        let (tree_dragging, tree_aimed) =
            cx.update(|cx| (cx.has_active_drag(), tree.read(cx).drop_folder(cx)));
        self.pointer(cx, PointerStep::Up, aside).await?;
        cx.update(|cx| crate::editor_panel::views::set_split_ratio(ratio, cx));
        self.pause(cx, Duration::from_millis(200)).await;

        let source = grip - gpui::point(gpui::px(120.), gpui::px(0.));
        self.file_drag(cx, source, &[notes.to_path_buf()]).await?;
        let editor_lit_before = cx.update(|cx| panel.read(cx).drop_lit(cx).0);
        self.file_event(cx, FileDropEvent::Exited).await?;
        self.pointer(cx, PointerStep::Down, grip).await?;
        self.pointer(cx, PointerStep::Move, aside).await?;
        let (editor_dragging, editor_lit) =
            cx.update(|cx| (cx.has_active_drag(), panel.read(cx).drop_lit(cx).0));
        self.pointer(cx, PointerStep::Up, aside).await?;
        cx.update(|cx| crate::editor_panel::views::set_split_ratio(ratio, cx));

        self.close_tab(cx, panel)?;
        std::fs::remove_file(&path).ok();
        Ok(DividerMarks {
            tree_dragging,
            tree_aimed,
            editor_lit_before,
            editor_dragging,
            editor_lit,
        })
    }

    /// Open figures/ and drag finder-plot.png's row onto the editor's line
    /// at `second`: how the editor was lit, and whether the figure dialog
    /// came up.
    async fn tree_figure_drag(
        &self,
        cx: &mut AsyncApp,
        editor: &gpui::Entity<crate::editor_panel::EditorPanel>,
        second: usize,
    ) -> Result<((Option<DropLit>, bool), bool)> {
        let rows = |cx: &mut gpui::App, path: &str| {
            self.shell.read(cx).file_tree().read(cx).row_paths(cx).contains(&path.to_string())
        };
        // The import revealed its figure, opening figures/ (revealRequest);
        // a click opens the folder only when it was closed since.
        if !cx.update(|cx| rows(cx, "figures/finder-plot.png")) {
            let folder = self.tree_row_center(cx, "figures")?;
            self.pointer(cx, PointerStep::Down, folder).await?;
            self.pointer(cx, PointerStep::Up, folder).await?;
        }
        self.wait_for(cx, Duration::from_secs(4), |_, cx| rows(cx, "figures/finder-plot.png"))
            .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let row = self.tree_row_center(cx, "figures/finder-plot.png")?;
        let at = self
            .with_window(cx, |_, window, cx| editor.update(cx, |editor, cx| editor.point_before(second, window, cx)))?
            .context("the second line is on screen")?;
        self.pointer(cx, PointerStep::Down, row).await?;
        self.pointer(cx, PointerStep::Move, row + gpui::point(gpui::px(12.), gpui::px(0.)))
            .await?;
        self.pointer(cx, PointerStep::Move, at).await?;
        let caret = cx.update(|cx| editor.read(cx).drop_lit(cx));
        self.drop_shot(cx, "drop-editor-caret").await;
        self.pointer(cx, PointerStep::Up, at).await?;
        let offered = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).inserts.figure.is_some()
            })
            .await;
        Ok((caret, offered))
    }

    /// Save the window as `<name>-light.png` and `<name>-dark.png` into
    /// `LATTICE_E2E_SHOTS`, when set; the drag stays on meanwhile.
    pub(super) async fn drop_shot(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        use lattice_ui::{Appearance, LatticeTheme};
        for (appearance, suffix) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            self.insert_shot(cx, &format!("{name}-{suffix}")).await;
        }
    }

    /// The middle of the tree's row for `path`, as last drawn.
    pub(super) fn tree_row_center(&self, cx: &mut AsyncApp, path: &str) -> Result<Point<Pixels>> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        cx.update(|cx| {
            let tree = tree.read(cx);
            let ix = tree
                .row_paths(cx)
                .iter()
                .position(|row| row == path)
                .with_context(|| format!("{path} is a row of the tree"))?;
            let snapshot = tree.hover_snapshot(cx).context("the tree was drawn")?;
            let (_, bounds, _) = snapshot
                .rows
                .iter()
                .find(|(row, ..)| *row == ix)
                .with_context(|| format!("{path}'s row is laid out"))?;
            Ok(bounds.center())
        })
    }

    /// A point in the tree below its last row.
    pub(super) fn tree_below_rows(&self, cx: &mut AsyncApp) -> Result<Point<Pixels>> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        cx.update(|cx| {
            let snapshot = tree.read(cx).hover_snapshot(cx).context("the tree was drawn")?;
            let last = snapshot
                .rows
                .iter()
                .map(|(_, bounds, _)| *bounds)
                .max_by(|a, b| a.bottom().partial_cmp(&b.bottom()).unwrap())
                .context("the tree has rows")?;
            Ok(gpui::point(last.center().x, last.bottom() + gpui::px(40.)))
        })
    }

    /// Finder's drag of `paths` entering the window, then moving, at `at`.
    pub(super) async fn file_drag(&self, cx: &mut AsyncApp, at: Point<Pixels>, paths: &[PathBuf]) -> Result<()> {
        let paths = ExternalPaths(paths.iter().cloned().collect());
        self.file_event(cx, FileDropEvent::Entered { position: at, paths })
            .await?;
        self.file_event(cx, FileDropEvent::Pending { position: at }).await
    }

    /// Finder's drop at `at`.
    pub(super) async fn file_drop(&self, cx: &mut AsyncApp, at: Point<Pixels>) -> Result<()> {
        self.file_event(cx, FileDropEvent::Submit { position: at }).await
    }

    async fn file_event(&self, cx: &mut AsyncApp, event: FileDropEvent) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(PlatformInput::FileDrop(event), cx);
        })?;
        self.frame_after_input(cx).await?;
        Ok(())
    }

    /// One pointer event at `at`, with a frame drawn after it.
    pub(super) async fn pointer(&self, cx: &mut AsyncApp, step: PointerStep, at: Point<Pixels>) -> Result<()> {
        let event = match step {
            PointerStep::Down => PlatformInput::MouseDown(gpui::MouseDownEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
            PointerStep::Move => PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position: at,
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::default(),
            }),
            PointerStep::Up => PlatformInput::MouseUp(gpui::MouseUpEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
        };
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(event, cx);
        })?;
        self.frame_after_input(cx).await?;
        Ok(())
    }

    fn close_figure_dialog(&self, cx: &mut AsyncApp) {
        let dialog = cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .figure
                .as_ref()
                .map(|open| open.dialog.clone())
        });
        if let Some(dialog) = dialog {
            dialog.update(cx, |_, cx| {
                cx.emit(crate::insert::figure_dialog::FigureDialogEvent::Close)
            });
        }
    }

    /// The app log's newest entry, "title: detail".
    pub(super) fn last_notice(&self, cx: &mut AsyncApp) -> Result<Option<String>> {
        self.with_window(cx, |_, _, cx| {
            crate::app_log::global(cx)
                .read(cx)
                .entries()
                .first()
                .map(|entry| format!("{}: {}", entry.title, entry.detail))
        })
    }
}

/// What the drags of [`Run::divider_drag_marks`] showed.
struct DividerMarks {
    tree_dragging: bool,
    tree_aimed: Option<String>,
    editor_lit_before: Option<DropLit>,
    editor_dragging: bool,
    editor_lit: Option<DropLit>,
}

#[derive(Clone, Copy)]
pub(super) enum PointerStep {
    Down,
    Move,
    Up,
}

/// This file's registration as the e2e module `drops` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 35,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/drops.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/drops.rs",
        "gpui/crates/trellis/src/view/input.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.drops(cx, steps, &fixture.root)),
};
