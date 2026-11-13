//! The seven GPUI design calls, driven with native input:
//!
//! - a right-click on a Project tree row opens Lattice's menu
//!   (`lattice_ui::components::ContextMenu`) on that row and moves focus
//!   into it; a press outside closes it and gives focus back (call 4);
//! - the PDF toolbar's buttons share one hover fill that glides from one
//!   button to the next instead of each fading its own (call 2).
//!
//! With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window with the tree's
//! menu open, and with the toolbar's fill on a button, for a look review.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, point, px};
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run};

/// The pop tier's entrance and the fast tier's glide, with a frame spare.
const SETTLE: Duration = Duration::from_millis(250);

impl Run {
    pub(super) async fn design_calls(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.tree_context_menu(cx, steps).await?;
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
