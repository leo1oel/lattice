//! The seven GPUI design calls, driven with native input:
//!
//! - a right-click on a Project tree row opens Lattice's menu
//!   (`lattice_ui::components::ContextMenu`) on that row and moves focus
//!   into it; a press outside closes it and gives focus back (call 4);
//! - the menu occludes what lies under it: a click on its Copy path, over
//!   another tree row, copies the path and opens nothing, and the tree's
//!   hover does not track the pointer under it;
//! - in the project switcher's menu, → puts the keys on a row's
//!   open-in-this-window glyph, and the pointer leaving that row ends it, so
//!   coming back and pressing Enter runs the row, not the glyph;
//! - the PDF toolbar's buttons share one hover fill that glides from one
//!   button to the next instead of each fading its own (call 2).
//!
//! With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window with the tree's
//! menu open, and with the toolbar's fill on a button, for a look review.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, point, px};
use serde_json::json;

use lattice_i18n::t;
use lattice_ui::components::{menu_snapshot, record_menus};

use super::Steps;
use crate::{native, scenario::Run};

/// The pop tier's entrance and the fast tier's glide, with a frame spare.
const SETTLE: Duration = Duration::from_millis(250);

impl Run {
    pub(super) async fn design_calls(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        cx.update(record_menus);
        self.tree_context_menu(cx, steps).await?;
        self.menu_item_over_row(cx, steps).await?;
        self.switcher_glyph_keys(cx, steps).await?;
        self.pdf_toolbar_glide(cx, steps).await
    }

    async fn tree_context_menu(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        let rows = cx.update(|cx| tree.read(cx).hover_snapshot(cx).unwrap_or_default().rows);
        let Some((_, row, _)) = rows.iter().find(|(_, _, target)| *target).copied() else {
            steps.check(
                "a right-click on a tree row opens Lattice's menu on it",
                false,
                json!({ "rows": rows.len() }),
            );
            return Ok(());
        };
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, row.center())?;
        native::send_right_click(native, row.center())?;
        self.pause(cx, SETTLE).await;
        let (target, focused_in_menu) = self.with_window(cx, |shell, window, cx| {
            let tree = shell.read(cx).file_tree().clone();
            let tree = tree.read(cx);
            (tree.row_menu_target(cx), tree.row_menu_focused(window, cx))
        })?;
        steps.check(
            "a right-click on a tree row opens Lattice's menu on it, and the menu takes focus",
            target.is_some() && focused_in_menu,
            json!({ "target": target, "focus_in_menu": focused_in_menu }),
        );
        self.design_shot(cx, "tree-context-menu").await;

        // A press in the tree's empty area below its rows, outside the
        // menu (the titlebar's middle is the window's native drag area).
        let last = rows
            .iter()
            .map(|(_, bounds, _)| bounds.bottom())
            .fold(px(0.), |a, b| a.max(b));
        let away = point(row.left() + px(4.), last + px(160.));
        native::send_click(native, away)?;
        self.pause(cx, SETTLE).await;
        let closed = cx.update(|cx| tree.read(cx).row_menu_target(cx).is_none());
        steps.check(
            "a press outside the tree's menu closes it",
            closed,
            json!({ "closed": closed }),
        );
        Ok(())
    }

    /// A click on the tree menu's Copy path, where another file's row lies
    /// under the item, runs the item alone: the menu occludes the rows.
    async fn menu_item_over_row(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        const NAME: &str = "a click on a menu item over another tree row runs the item alone: \
                            the path is copied, the menu closes, and no file opens";
        let root = self.root(cx).await?;
        // Enough rows that a row's menu drops over the rows below it.
        let extra: Vec<String> = (1..=8).map(|n| format!("menu-check-{n}.tex")).collect();
        for name in &extra {
            std::fs::write(root.join(name), "Menu check.\n")?;
        }
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                if let Some(project) = shell.project() {
                    project.update(cx, |project, cx| project.rescan(cx));
                }
            })
        });
        let listed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let rows = tree.read(cx).row_paths(cx);
                extra.iter().all(|name| rows.contains(name))
            })
            .await;
        self.pause(cx, SETTLE).await;
        let (paths, rows) = cx.update(|cx| {
            let tree = tree.read(cx);
            (
                tree.row_paths(cx),
                tree.hover_snapshot(cx).unwrap_or_default().rows,
            )
        });
        let path_of = |ix: usize| paths.get(ix).cloned().unwrap_or_default();
        let is_file = |ix: usize| root.join(path_of(ix)).is_file();
        // The topmost file row the menu can open on.
        let opened_on = rows
            .iter()
            .filter(|(ix, _, target)| *target && is_file(*ix))
            .min_by(|a, b| f32::from(a.1.top()).total_cmp(&f32::from(b.1.top())))
            .copied();
        let Some((on_ix, on_row, _)) = opened_on.filter(|_| listed) else {
            steps.check(NAME, false, json!({ "listed": listed, "rows": paths }));
            return self.remove_menu_checks(cx, &root, &extra, &tree).await;
        };
        let native = self.native(cx)?;
        let press = point(on_row.left() + px(8.), on_row.center().y);
        native::send_mouse(native, native::Mouse::Moved, press)?;
        native::send_right_click(native, press)?;
        self.pause(cx, SETTLE).await;
        let copy_label = t!("Copy path").to_string();
        let item = cx.update(|cx| {
            menu_snapshot(&copy_label, cx).and_then(|menu| {
                menu.rows
                    .into_iter()
                    .find(|(_, label, _)| *label == copy_label)
                    .map(|(_, _, bounds)| bounds.center())
            })
        });
        // The file row under the item, which a click through would open.
        let under = item.and_then(|item| {
            rows.iter()
                .find(|(ix, bounds, _)| *ix != on_ix && is_file(*ix) && bounds.contains(&item))
                .map(|(ix, _, _)| path_of(*ix))
        });
        let (Some(item), Some(under)) = (item, under) else {
            steps.check(
                NAME,
                false,
                json!({ "item": item.map(|at| (f32::from(at.x), f32::from(at.y))), "rows": paths }),
            );
            native::send_key(native, '\u{1b}', false)?;
            self.pause(cx, SETTLE).await;
            return self.remove_menu_checks(cx, &root, &extra, &tree).await;
        };
        let documents = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let shell = self.shell.read(cx);
                (
                    crate::shell::views::documents_of(&shell.document(cx)),
                    shell.active_editor_path(cx),
                )
            })
        };
        let before = documents(cx);
        cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string("before".into())));
        native::send_mouse(native, native::Mouse::Moved, item)?;
        self.pause(cx, SETTLE).await;
        // The tree under the menu does not light the row beneath the pointer.
        let tree_lit = cx.update(|cx| tree.read(cx).hover_snapshot(cx).unwrap_or_default().lit);
        native::send_click(native, item)?;
        self.pause(cx, SETTLE).await;
        let after = documents(cx);
        let clipboard = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        let closed = cx.update(|cx| tree.read(cx).row_menu_target(cx).is_none());
        let copied = root.join(path_of(on_ix));
        steps.check(
            NAME,
            clipboard.as_deref() == Some(copied.to_string_lossy().as_ref())
                && closed
                && after == before
                && tree_lit.is_none(),
            json!({
                "menu_on": path_of(on_ix),
                "row_under_item": under,
                "clipboard": clipboard,
                "closed": closed,
                "documents": [before, after],
                "tree_lit_under_menu": tree_lit,
            }),
        );
        self.remove_menu_checks(cx, &root, &extra, &tree).await
    }

    async fn remove_menu_checks(
        &self,
        cx: &mut AsyncApp,
        root: &std::path::Path,
        extra: &[String],
        tree: &gpui::Entity<crate::file_tree::FileTreePanel>,
    ) -> Result<()> {
        for name in extra {
            std::fs::remove_file(root.join(name)).ok();
        }
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                if let Some(project) = shell.project() {
                    project.update(cx, |project, cx| project.rescan(cx));
                }
            })
        });
        self.wait_for(cx, Duration::from_secs(5), |_, cx| {
            let rows = tree.read(cx).row_paths(cx);
            !extra.iter().any(|name| rows.contains(name))
        })
        .await;
        Ok(())
    }

    /// The project switcher's menu: → from Open another folder puts the
    /// keys on its open-in-this-window glyph; the pointer moving to another
    /// row and back ends that, so Enter there would run the row itself.
    async fn switcher_glyph_keys(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        const NAME: &str = "in the project switcher's menu, → puts the keys on a row's \
                            open-here glyph, and the pointer leaving the row and coming back ends it";
        let start = cx.update(|cx| self.shell.read(cx).titlebar_drag().left_start());
        let Some(start) = start else {
            steps.check(NAME, false, json!({ "left_start": null }));
            return Ok(());
        };
        let native = self.native(cx)?;
        // The switcher: 28px tall, 4px under the titlebar's top.
        native::send_titlebar_click(native, point(px(start + 16.), px(18.)))?;
        self.pause(cx, SETTLE).await;
        self.design_shot(cx, "project-switcher-menu").await;
        let label = t!("Open another folder").to_string();
        let snapshot = |cx: &mut AsyncApp| cx.update(|cx| menu_snapshot(&label, cx));
        let opened = snapshot(cx);
        let drawn = opened.is_some();
        let rows = opened.map(|menu| menu.rows).unwrap_or_default();
        let row = rows.iter().find(|(_, text, _)| *text == label).cloned();
        let other = rows.iter().find(|(_, text, _)| *text != label).cloned();
        let (Some((row, _, row_bounds)), Some((_, _, other_bounds))) = (row, other) else {
            steps.check(
                NAME,
                false,
                json!({
                    "switcher_at": start,
                    "menu_drawn": drawn,
                    "rows": rows.iter().map(|(_, text, _)| text.to_string()).collect::<Vec<_>>(),
                }),
            );
            native::send_key(native, '\u{1b}', false)?;
            self.pause(cx, SETTLE).await;
            return Ok(());
        };
        native::send_mouse(native, native::Mouse::Moved, row_bounds.center())?;
        self.pause(cx, SETTLE).await;
        self.press(cx, native::RIGHT_ARROW, false).await?;
        self.pause(cx, SETTLE).await;
        let keyed = snapshot(cx).unwrap_or_default();
        native::send_mouse(native, native::Mouse::Moved, other_bounds.center())?;
        self.pause(cx, SETTLE).await;
        native::send_mouse(native, native::Mouse::Moved, row_bounds.center())?;
        self.pause(cx, SETTLE).await;
        let back = snapshot(cx).unwrap_or_default();
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, SETTLE).await;
        steps.check(
            NAME,
            keyed.on_secondary == Some(row) && back.lit == Some(row) && back.on_secondary.is_none(),
            json!({
                "row": row,
                "keys_on_glyph": keyed.on_secondary,
                "back": { "lit": back.lit, "keys_on_glyph": back.on_secondary },
            }),
        );
        Ok(())
    }

    async fn pdf_toolbar_glide(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        // Off the last page, so Previous and Next are both enabled, and with
        // no fit in use, so a narrow toolbar's Fit width is a button the fill
        // lands on beside ⋯: two buttons of one section, no divider between.
        let fit = cx.update(|cx| {
            view.update(cx, |view, cx| {
                if view.current_page() + 1 >= view.page_count() {
                    view.step_page(-1, cx)
                }
                let fit = view.fit();
                if let Some(mode) = fit {
                    view.toggle_fit(mode, cx);
                }
                fit
            })
        });
        self.pause(cx, SETTLE).await;
        let snapshot = |cx: &mut AsyncApp| {
            cx.update(|cx| view.read(cx).toolbar_hover_snapshot(cx).unwrap_or_default())
        };
        // Two buttons the fill may land on, in one section (a divider
        // between two starts a new fade, as it should).
        let rows = snapshot(cx).rows;
        let targets: Vec<_> = rows
            .iter()
            .filter(|(_, _, target)| *target)
            .copied()
            .collect();
        let pair = targets.iter().enumerate().find_map(|(at, first)| {
            targets[at + 1..]
                .iter()
                .find(|second| {
                    crate::pdf::toolbar_section(first.0) == crate::pdf::toolbar_section(second.0)
                })
                .map(|second| (*first, *second))
        });
        let Some(((first, first_bounds, _), (second, second_bounds, _))) = pair else {
            steps.check(
                "the PDF toolbar's buttons register with its one hover fill",
                false,
                json!({ "rows": rows.iter().map(|(ix, _, target)| (*ix, *target)).collect::<Vec<_>>() }),
            );
            if let Some(mode) = fit {
                cx.update(|cx| view.update(cx, |view, cx| view.toggle_fit(mode, cx)));
            }
            return Ok(());
        };
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, first_bounds.center())?;
        self.pause(cx, SETTLE).await;
        let on_first = snapshot(cx);
        native::send_mouse(native, native::Mouse::Moved, second_bounds.center())?;
        self.pause(cx, SETTLE).await;
        self.design_shot(cx, "pdf-toolbar-glide").await;
        let on_second = snapshot(cx);
        steps.check(
            "the PDF toolbar lights the button under the pointer with its one fill, and glides it to the next",
            on_first.lit == Some(first)
                && on_second.lit == Some(second)
                && on_second.fill.is_some_and(|fill| (fill.origin.x - second_bounds.origin.x).abs() < px(0.5))
                && on_second.sessions == on_first.sessions,
            json!({
                "lit": [on_first.lit, on_second.lit],
                "buttons": [first, second],
                "sessions": [on_first.sessions, on_second.sessions],
            }),
        );
        let away = self.with_window(cx, |_, window, _| {
            point(window.viewport_size().width / 2., px(20.))
        })?;
        native::send_mouse(native, native::Mouse::Moved, away)?;
        self.pause(cx, SETTLE).await;
        let cleared = snapshot(cx).lit.is_none();
        if let Some(mode) = fit {
            cx.update(|cx| view.update(cx, |view, cx| view.toggle_fit(mode, cx)));
        }
        steps.check(
            "leaving the PDF toolbar fades its fill out",
            cleared,
            json!({ "cleared": cleared }),
        );
        Ok(())
    }

    /// Save the window as `name` under `LATTICE_E2E_SHOTS`.
    async fn design_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            let path = std::path::Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }
}
