//! The end-to-end check of the writing flow, driven with native input on
//! macOS and Windows.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::{Value, json};

use super::{Run, sleep};
use crate::native;

impl Run {
    /// The writing flow, end to end, on a scratch copy of a small project:
    /// open, build, break the document by typing, save with the shortcut,
    /// build, follow the error to its line, search, Vim, repair, build.
    pub(super) async fn e2e(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Vec::<Value>::new();
        let mut check = |name: &str, passed: bool, detail: Value| {
            steps.push(json!({ "step": name, "passed": passed, "detail": detail }));
            passed
        };
        let root = self.root(cx)?;
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)
            .context("the e2e project needs chapters/intro.tex")?;
        sleep(cx, Duration::from_millis(800)).await;

        let main_open = cx.update(|cx| self.shell.read(cx).root().is_some());
        check("project opens", main_open, json!({ "root": root }));

        let (built, took) = self.build(cx).await?;
        sleep(cx, Duration::from_millis(800)).await;
        let pages = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count());
        check(
            "build succeeds and the PDF shows",
            built && pages > 0,
            json!({ "seconds": took.as_secs_f32(), "pages": pages }),
        );

        let editor = self.open(cx, &chapter, Some(3))?;
        sleep(cx, Duration::from_millis(300)).await;
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
        check(
            "a .tex file opens with LaTeX highlighting",
            language.as_deref() == Some("LaTeX"),
            json!({ "language": language }),
        );

        self.type_text(cx, "\\undefinedmacro ").await?;
        let typed = self.editor_text(cx, &editor).contains("\\undefinedmacro ");
        let dirty = cx.update(|cx| editor.read(cx).is_dirty(cx));
        check(
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
        check(
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
                .find(|diagnostic| diagnostic.level == tex::Level::Error)
                .map(|diagnostic| (diagnostic.clone(), panel.location(diagnostic)))
        });
        let located = error.as_ref().is_some_and(|(diagnostic, _)| {
            diagnostic
                .file
                .as_deref()
                .is_some_and(|file| file.ends_with("intro.tex"))
                && diagnostic.line == Some(3)
        });
        check(
            "a broken build reports the error at its file and line",
            !built && located,
            json!({ "seconds": took.as_secs_f32(), "error": error.as_ref().map(|(d, _)| format!("{:?}:{:?} {}", d.file, d.line, d.message)) }),
        );

        if let Some((_, Some(location))) = error {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.open_path(location.path.clone(), location.line, window, cx)
                });
            })?;
            sleep(cx, Duration::from_millis(200)).await;
            let row = self.cursor_row(cx, &editor);
            check(
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
            sleep(cx, Duration::from_millis(200)).await;
            cx.update(|cx| bar.read(cx).has_active_match())
        };
        check("buffer search finds the text", found, json!({}));

        // Vim: Normal mode's `x` deletes the character under the cursor.
        cx.update(|cx| crate::app::set_vim_mode(true, cx));
        let scratch = root.join("vim-check.txt");
        std::fs::write(&scratch, "abc\n")?;
        let vim_editor = self.open(cx, &scratch, Some(1))?;
        sleep(cx, Duration::from_millis(300)).await;
        self.type_text(cx, "x").await?;
        sleep(cx, Duration::from_millis(100)).await;
        let vim_text = self.editor_text(cx, &vim_editor);
        check(
            "Vim mode: x deletes the character under the cursor",
            vim_text == "bc\n",
            json!({ "text": vim_text }),
        );
        // Its tab closed with the edit unsaved, the file on disk has the edit.
        let vim_panel = gpui_kit::component::dock::PanelId::from(vim_editor.entity_id());
        drop(vim_editor);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_panel(vim_panel, window, cx))
        })?;
        let written = self
            .wait_for(cx, Duration::from_secs(2), |_, _| {
                std::fs::read_to_string(&scratch).is_ok_and(|text| text == "bc\n")
            })
            .await;
        check(
            "closing a tab with unsaved edits writes them to the file",
            written,
            json!({ "on_disk": std::fs::read_to_string(&scratch).ok() }),
        );
        cx.update(|cx| crate::app::set_vim_mode(false, cx));
        std::fs::remove_file(&scratch).ok();

        std::fs::write(&chapter, &original)?;
        let (built, _) = self.build(cx).await?;
        check("repairing the file builds cleanly again", built, json!({}));

        // Docking: drag an editor tab out of the center into the right dock,
        // beside the PDF, with native mouse events. (The shell steps after
        // it drag the PDF out of its dock alone.)
        let (moved, layout) = self.drag_editor_tab_to_right_dock(cx).await?;
        check(
            "an editor tab drags from the center into the right dock",
            moved,
            layout,
        );

        for (name, passed, detail) in self.shell_steps(cx).await? {
            check(name, passed, detail);
        }

        let passed = steps.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "e2e", "passed": passed, "steps": steps }))
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
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Down, from)?;
        sleep(cx, Duration::from_millis(50)).await;
        for step in 1..=24 {
            let t = step as f32 / 24.;
            let point = gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            native::send_mouse(native, native::Mouse::Dragged, point)?;
            sleep(cx, Duration::from_millis(20)).await;
        }
        native::send_mouse(native, native::Mouse::Up, to)?;
        sleep(cx, Duration::from_millis(400)).await;
        let state = cx.update(|cx| {
            let area = self.shell.read(cx).dock_area().read(cx);
            serde_json::to_value(area.dump(cx)).unwrap_or_default()
        });
        let right = state["right_dock"].to_string();
        let moved = right.contains("EditorPanel") && right.contains("PdfPanel");
        Ok((
            moved,
            json!({ "from": [f32::from(from.x), f32::from(from.y)], "to": [f32::from(to.x), f32::from(to.y)], "right_dock": state["right_dock"] }),
        ))
    }
}
