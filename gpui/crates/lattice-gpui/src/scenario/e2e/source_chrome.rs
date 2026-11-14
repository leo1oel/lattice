//! The e2e checks of the chrome around the source editor (`source_chrome.rs`
//! in the editor panel, `gutter_column.rs` in the adapter): the gutter puts
//! the text where CodeMirror does, its fold markers show over the gutter and
//! fold and unfold the preamble under native clicks; a .tex file's strip
//! offers the Source / Visual switch and a Markdown file's does not; the
//! outline rail marks main.tex's sections, the text gives up its width, a
//! pointer resting on it opens the outline, and a row puts the caret on its
//! heading and keeps it current.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Bounds, Pixels, point, px};
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run};

impl Run {
    pub(super) async fn source_chrome(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let drawn = lattice.clone();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            !drawn.read(cx).painted_gutter().lines.is_empty()
        })
        .await;
        self.pause(cx, Duration::from_millis(200)).await;

        // The text starts after 10px, four digits, 2px, the 16px fold column
        // and CodeMirror's 6px: where the caret before its first character is.
        let gutter = cx.update(|cx| lattice.read(cx).painted_gutter());
        let caret = {
            let lattice = lattice.clone();
            self.with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| lattice.offset_bounds(0, window, cx))
            })?
        };
        let first = gutter.lines.first().cloned().context("the gutter drew")?;
        let view = gutter.bounds.context("the gutter drew its column")?;
        let text_left = gutter.text_left.context("the gutter placed the text")?;
        let digits = first.number.size.width - px(12.);
        let fold = first.fold.unwrap_or_default();
        steps.check(
            "the gutter keeps four digits, a fold column and CodeMirror's 6px before the text",
            first.row == 0
                && (f32::from(digits) / 4. - 8.4).abs() < 0.6
                && fold.size.width == px(16.)
                && fold.left() == first.number.right()
                && (text_left - (fold.right() + px(6.))).abs() < px(0.5)
                && caret.is_some_and(|caret| (caret.left() - text_left).abs() < px(1.)),
            json!({
                "view_left": f32::from(view.left()),
                "number_cell": f32::from(first.number.size.width),
                "text_left": f32::from(text_left),
                "caret_left": caret.map(|caret| f32::from(caret.left())),
            }),
        );

        // `\documentclass` folds the preamble: its marker is quiet until the
        // pointer is over the gutter, and a click folds and unfolds.
        self.park_pointer(cx)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let quiet = cx.update(|cx| marker_opacity(&lattice.read(cx).painted_gutter(), 0));
        let center = fold.center();
        self.move_pointer(cx, center).await?;
        let shown = lattice.clone();
        let revealed = self
            .wait_for(cx, Duration::from_secs(2), move |_, cx| {
                marker_opacity(&shown.read(cx).painted_gutter(), 0) >= 1.
            })
            .await;
        native::send_click(self.native(cx)?, center)?;
        let folded = self.wait_folded(cx, &lattice, true).await?;
        // The next line numbered once the gutter has drawn the fold.
        let painted = lattice.clone();
        let row_after = move |cx: &gpui::App| {
            painted
                .read(cx)
                .painted_gutter()
                .lines
                .get(1)
                .map(|line| line.row)
        };
        let after = row_after.clone();
        self.wait_for(cx, Duration::from_secs(2), move |_, cx| {
            after(cx).is_some_and(|row| row > 2)
        })
        .await;
        let next_row = cx.update(|cx| row_after(cx));
        native::send_click(self.native(cx)?, center)?;
        let unfolded = self.wait_folded(cx, &lattice, false).await?;
        steps.check(
            "a fold marker shows over the gutter, and a click folds and unfolds the preamble",
            quiet == 0. && revealed && folded && unfolded && next_row.is_some_and(|row| row > 2),
            json!({
                "quiet": quiet,
                "revealed": revealed,
                "folded": folded,
                "row_after_fold": next_row,
                "unfolded": unfolded,
            }),
        );

        // The Source / Visual switch is a .tex file's alone.
        let note = root.join("switch-check.md");
        std::fs::write(&note, "Notes\n")?;
        let markdown = self.open(cx, &note, Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (tex_offers, md_offers) = cx.update(|cx| {
            let panel = |entity_id| gpui_kit::component::dock::PanelId::from(entity_id);
            (
                lattice_ui::dock::offers_spare_tools(panel(editor.entity_id()), cx),
                lattice_ui::dock::offers_spare_tools(panel(markdown.entity_id()), cx),
            )
        });
        steps.check(
            "a .tex file's strip offers the Source / Visual switch, a Markdown file's does not",
            tex_offers && !md_offers,
            json!({ "tex": tex_offers, "markdown": md_offers }),
        );
        std::fs::remove_file(&note).ok();
        self.open(cx, &root.join("main.tex"), Some(1))?;

        self.outline_rail(cx, steps, &editor, &lattice, root).await
    }

    async fn outline_rail(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &gpui::Entity<crate::editor_panel::EditorPanel>,
        lattice: &gpui::Entity<lattice_editor::LatticeEditor>,
        root: &Path,
    ) -> Result<()> {
        let rail = cx
            .update(|cx| editor.read(cx).outline_rail().cloned())
            .context("main.tex has an outline rail")?;
        let shown = rail.clone();
        let marked = self
            .wait_for(cx, Duration::from_secs(10), move |_, cx| {
                shown.read(cx).shown() && shown.read(cx).marks_bounds().is_some()
            })
            .await;
        let (marks, clearance, bounds) = cx.update(|cx| {
            let rail = rail.read(cx);
            (
                rail.outline().marks.len(),
                lattice.read(cx).end_clearance(),
                rail.marks_bounds(),
            )
        });
        steps.check(
            "the outline rail marks main.tex's sections and the text gives up its 36px",
            marked && marks >= 2 && clearance == px(36.),
            json!({ "marks": marks, "clearance": f32::from(clearance) }),
        );
        let bounds: Bounds<Pixels> = bounds.context("the rail drew its marks")?;

        // A pointer resting on the marks opens the outline after 120 ms.
        self.move_pointer(cx, bounds.center()).await?;
        let open = rail.clone();
        let opened = self
            .wait_for(cx, Duration::from_secs(2), move |_, cx| {
                open.read(cx).is_open()
            })
            .await;
        let method = cx.update(|cx| {
            rail.read(cx)
                .outline()
                .entries
                .iter()
                .position(|entry| entry.heading.title == "Method")
        });
        let line = method.and_then(|index| {
            cx.update(|cx| {
                rail.read(cx)
                    .outline()
                    .entries
                    .get(index)
                    .map(|entry| entry.heading.line)
            })
        });
        if let Some(index) = method {
            cx.update(|cx| rail.update(cx, |rail, cx| rail.choose(index, cx)));
        }
        let caret_editor = editor.clone();
        let jumped = self
            .wait_for(cx, Duration::from_secs(5), move |_, cx| {
                line.is_some_and(|line| caret_editor.read(cx).cursor().0 == line)
            })
            .await;
        let current = {
            let rail = rail.clone();
            self.with_window(cx, move |_, window, cx| {
                rail.update(cx, |rail, cx| rail.current(window, cx))
            })?
        };
        self.park_pointer(cx)?;
        let closed_rail = rail.clone();
        let closed = self
            .wait_for(cx, Duration::from_secs(2), move |_, cx| {
                !closed_rail.read(cx).is_open()
            })
            .await;
        steps.check(
            "resting on the rail opens the outline; a row puts the caret on its heading and keeps it current",
            opened && jumped && current == method && closed,
            json!({
                "opened": opened,
                "method": method,
                "line": line,
                "jumped": jumped,
                "current": current,
                "closed": closed,
            }),
        );

        // A native click on the left edge of the marks, where they lie over
        // the editor's text, toggles the outline and leaves the caret where
        // it was: the rail occludes the text under it.
        let before = cx.update(|cx| editor.read(cx).cursor());
        let edge = point(bounds.left() + px(2.), bounds.center().y);
        self.move_pointer(cx, edge).await?;
        native::send_click(self.native(cx)?, edge)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let after = cx.update(|cx| editor.read(cx).cursor());
        self.park_pointer(cx)?;
        let settled = rail.clone();
        self.wait_for(cx, Duration::from_secs(2), move |_, cx| {
            !settled.read(cx).is_open()
        })
        .await;
        steps.check(
            "a click on the outline rail's marks leaves the caret where it was",
            before == after,
            json!({ "before": before, "after": after, "at": [f32::from(edge.x), f32::from(edge.y)] }),
        );

        // Reinstalling the layout (Reset Layout, focus mode on and off) keeps
        // the .tex editor's Source / Visual switch.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.reset_layout(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(true, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(false, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let still = cx.update(|cx| {
            lattice_ui::dock::offers_spare_tools(
                gpui_kit::component::dock::PanelId::from(editor.entity_id()),
                cx,
            )
        });
        steps.check(
            "the .tex editor keeps its Source / Visual switch after the layout is reinstalled",
            still,
            json!({ "offers": still }),
        );
        self.long_outline(cx, steps, root).await
    }

    /// A standalone file with more sections than the opened outline can
    /// show: the outline opens with the current row in its middle, and a
    /// wheel over the text ends a jump's hold on the current section.
    async fn long_outline(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let path = root.join("outline-check.tex");
        let mut text = String::new();
        for section in 1..=120 {
            text.push_str(&format!("\\section{{Part {section}}}\n"));
            for line in 1..=20 {
                text.push_str(&format!("Text {section}.{line}\n"));
            }
        }
        std::fs::write(&path, text)?;
        let editor = self.open(cx, &path, Some(1))?;
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let rail = {
            let editor = editor.clone();
            let mut found = None;
            for _ in 0..50 {
                found = cx.update(|cx| editor.read(cx).outline_rail().cloned());
                if found.is_some() {
                    break;
                }
                self.pause(cx, Duration::from_millis(100)).await;
            }
            found.context("the long file has an outline rail")?
        };
        let shown = rail.clone();
        self.wait_for(cx, Duration::from_secs(10), move |_, cx| {
            shown.read(cx).shown()
                && shown.read(cx).marks_bounds().is_some()
                && shown.read(cx).outline().entries.len() == 120
        })
        .await;
        // Read late in the file, around Part 100.
        self.with_window(cx, |_, window, cx| {
            let zed = editor.read(cx).editor().clone();
            zed.update(cx, |zed, cx| {
                zed.set_scroll_position(point(0., 2090.), window, cx)
            });
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let bounds = cx
            .update(|cx| rail.read(cx).marks_bounds())
            .context("the long file's rail drew its marks")?;
        self.move_pointer(cx, bounds.center()).await?;
        let open = rail.clone();
        let opened = self
            .wait_for(cx, Duration::from_secs(2), move |_, cx| {
                open.read(cx).is_open()
            })
            .await;
        self.pause(cx, Duration::from_millis(500)).await;
        let current = {
            let rail = rail.clone();
            self.with_window(cx, move |_, window, cx| {
                rail.update(cx, |rail, cx| rail.current(window, cx))
            })?
        };
        let (offset, viewport, max) = cx.update(|cx| rail.read(cx).list_scroll());
        // Rows share one height, so the content height over 120 places the
        // current row; centred means its middle sits at the viewport's.
        let content = viewport.size.height + max.y;
        let row = content / 120.;
        let middle = current.map(|index| row * (index as f32 + 0.5) + offset.y);
        let centred = middle.is_some_and(|middle| {
            let want = viewport.size.height / 2.;
            (middle - want).abs() <= row
        });
        steps.check(
            "the outline of a long file opens with the current row in the middle of its list",
            opened && max.y > px(0.) && current.is_some_and(|index| index >= 90) && centred,
            json!({
                "opened": opened,
                "current": current,
                "offset": f32::from(offset.y),
                "viewport": f32::from(viewport.size.height),
                "max": f32::from(max.y),
                "row_middle": middle.map(f32::from),
            }),
        );

        // Jump to Part 5, then wheel the text down: the hold ends.
        cx.update(|cx| rail.update(cx, |rail, cx| rail.choose(4, cx)));
        self.park_pointer(cx)?;
        let closed = rail.clone();
        self.wait_for(cx, Duration::from_secs(2), move |_, cx| {
            !closed.read(cx).is_open()
        })
        .await;
        let pinned = cx.update(|cx| rail.read(cx).is_pinned());
        let view = cx
            .update(|cx| lattice.read(cx).painted_gutter().bounds)
            .context("the long file's gutter drew")?;
        let over_text = point(view.left() + view.size.width / 3., view.center().y);
        self.move_pointer(cx, over_text).await?;
        let top = |cx: &mut gpui::App| {
            let zed = editor.read(cx).editor().clone();
            zed.update(cx, |zed, cx| zed.scroll_position(cx).y)
        };
        let before = cx.update(|cx| top(cx));
        native::send_wheel(self.native(cx)?, over_text, -200)?;
        let moved = {
            let editor = editor.clone();
            self.wait_for(cx, Duration::from_secs(2), move |_, cx| {
                let zed = editor.read(cx).editor().clone();
                zed.update(cx, |zed, cx| zed.scroll_position(cx).y) > before
            })
            .await
        };
        self.pause(cx, Duration::from_millis(200)).await;
        let released = !cx.update(|cx| rail.read(cx).is_pinned());
        self.park_pointer(cx)?;
        // Close the tab before the file goes: a tab whose file vanished
        // closes itself a disk check and a second later, in a later step.
        self.close_tab(cx, editor)?;
        std::fs::remove_file(&path).ok();
        steps.check(
            "after an outline jump, the wheel scrolling the text ends the jump's hold on the current section",
            pinned && moved && released,
            json!({ "pinned": pinned, "moved": moved, "released": released }),
        );
        Ok(())
    }

    async fn wait_folded(
        &self,
        cx: &mut AsyncApp,
        lattice: &gpui::Entity<lattice_editor::LatticeEditor>,
        folded: bool,
    ) -> Result<bool> {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            let lattice = lattice.clone();
            let now = self.with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| lattice.is_folded(0, window, cx))
            })?;
            if now == folded {
                return Ok(true);
            }
            self.pause(cx, Duration::from_millis(50)).await;
        }
        Ok(false)
    }

    async fn move_pointer(&self, cx: &mut AsyncApp, at: gpui::Point<Pixels>) -> Result<()> {
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, point(at.x - px(4.), at.y))?;
        self.pause(cx, Duration::from_millis(30)).await;
        native::send_mouse(native, native::Mouse::Moved, at)
    }
}

/// The opacity row `row`'s fold marker was drawn at.
fn marker_opacity(gutter: &lattice_editor::PaintedGutter, row: u32) -> f32 {
    gutter
        .lines
        .iter()
        .find(|line| line.row == row)
        .map_or(-1., |line| line.marker_opacity)
}

/// This file's registration as the e2e module `source_chrome` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 20,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/editor_panel/source_chrome.rs"],
    run: |run, cx, steps, fixture| Box::pin(run.source_chrome(cx, steps, &fixture.root)),
};
