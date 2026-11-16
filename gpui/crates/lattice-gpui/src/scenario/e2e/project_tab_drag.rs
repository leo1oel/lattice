#![cfg(target_os = "macos")]
//! Dragging project tabs (`shell/project_tab_drag.rs`), with the
//! platform's own pointer and key events:
//!
//! - A press moved under 5px is still a click; past it the tab is lifted,
//!   the line marks where it would go, and the order changes only when it
//!   is let go there, switching nothing.
//! - Escape puts a lifted tab back.
//! - A tab let go over no window of the app gets a window of its own.
//! - That window's lone project, let go over this window's strip, moves
//!   here in front with its editor's caret, and the window it left closes.

use std::{path::PathBuf, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Pixels, Point, point, px};
use serde_json::json;

use super::{Steps, drops::PointerStep};
use crate::scenario::Run;

impl Run {
    /// With `LATTICE_E2E_SHOTS=DIR` (and the `offscreen-shots` feature) the
    /// window is saved as `DIR/<name>.png`.
    async fn tab_shot(&self, cx: &mut AsyncApp, name: &str) {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return;
        };
        self.pause(cx, Duration::from_millis(200)).await;
        let path = std::path::Path::new(&dir).join(format!("{name}.png"));
        if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
            log::warn!("no shot {name}: {error:#}");
        }
    }

    /// This window's project order.
    fn project_order(&self, cx: &mut AsyncApp) -> Vec<PathBuf> {
        cx.update(|cx| self.shell.read(cx).projects.iter().map(|p| p.root.clone()).collect())
    }

    /// The middle of `root`'s tab, in its window's coordinates.
    fn tab_middle(&self, cx: &mut AsyncApp, root: &PathBuf) -> Option<Point<Pixels>> {
        cx.update(|cx| {
            let bounds = self.shell.read(cx).project_strip_bounds();
            let bounds = bounds.borrow();
            bounds
                .tabs
                .iter()
                .find(|(tab, _)| tab == root)
                .map(|(_, rect)| rect.center())
        })
    }

    async fn project_tab_drag(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let first = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .context("the run's project is open")?;
        let other = std::env::temp_dir().join(format!("lattice-gpui-tab-drag-{}", std::process::id()));
        std::fs::create_dir_all(&other)?;
        std::fs::write(other.join("main.tex"), "\\documentclass{article}\n\\begin{document}\nOther.\n\\end{document}\n")?;
        let other = other.canonicalize()?;
        self.with_window(cx, {
            let other = other.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.open_project(other, window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(8), |shell, cx| shell.read(cx).projects.len() == 2)
            .await;
        self.pause(cx, Duration::from_millis(600)).await;

        // A click on the active tab opens the project menu (the press held
        // from it is given back); Escape closes it.
        let label = lattice_i18n::t!("Open another folder").to_string();
        let menu_open = |cx: &mut AsyncApp| {
            cx.update(|cx| lattice_ui::components::menu_snapshot(&label, cx).is_some())
        };
        cx.update(lattice_ui::components::record_menus);
        let title = self.tab_middle(cx, &other).context("the active tab is drawn")?;
        self.pointer(cx, PointerStep::Down, title).await?;
        self.pointer(cx, PointerStep::Up, title).await?;
        self.pause(cx, Duration::from_millis(400)).await;
        let clicked = menu_open(cx);
        let escape = |run: &Run, cx: &mut AsyncApp| -> Result<()> {
            let key = gpui::Keystroke::parse("escape")?;
            run.with_window(cx, move |_, window, cx| {
                window.dispatch_event(
                    gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                        keystroke: key,
                        is_held: false,
                        prefer_character_input: false,
                    }),
                    cx,
                );
            })
        };
        escape(self, cx)?;
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "a click on the active project tab opens its menu, the press held from it given back",
            clicked && self.project_order(cx).len() == 2,
            json!({ "clicked": clicked }),
        );

        // A press moved 3px is a click's; 6px more lifts the tab. Over the
        // other tab's far half the line goes to the end; the order holds
        // until the release, which switches nothing.
        let before = self.project_order(cx);
        let from = self.tab_middle(cx, &first).context("the first tab is drawn")?;
        let past = self.tab_middle(cx, &other).context("the second tab is drawn")? + point(px(20.), px(0.));
        self.pointer(cx, PointerStep::Down, from).await?;
        self.pointer(cx, PointerStep::Move, from + point(px(3.), px(0.))).await?;
        let small = cx.update(|cx| self.shell.read(cx).project_drag_view().0);
        self.pointer(cx, PointerStep::Move, from + point(px(9.), px(0.))).await?;
        let lifted = cx.update(|cx| self.shell.read(cx).project_drag_view().0);
        self.pointer(cx, PointerStep::Move, past).await?;
        let (_, line, _) = cx.update(|cx| self.shell.read(cx).project_drag_view());
        let held = self.project_order(cx);
        self.tab_shot(cx, "project-tab-dragging").await;
        self.pointer(cx, PointerStep::Up, past).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let after = self.project_order(cx);
        let shown = cx.update(|cx| self.shell.read(cx).root(cx));
        self.tab_shot(cx, "project-tabs-reordered").await;
        steps.check(
            "a project tab lifts past 5px, its line marks the end, and the order changes only when it is let go, switching nothing",
            small.is_none()
                && lifted.as_ref() == Some(&first)
                && line.as_ref().is_some_and(|slot| slot.before.is_none())
                && held == before
                && after == vec![other.clone(), first.clone()]
                && shown.as_ref() == Some(&other),
            json!({ "small": small, "lifted": lifted, "line": line.map(|slot| slot.before), "held": held, "after": after, "shown": shown }),
        );

        // Escape puts a lifted tab back.
        let from = self.tab_middle(cx, &first).context("the first tab is drawn")?;
        let left = self.tab_middle(cx, &other).context("the second tab is drawn")? - point(px(30.), px(0.));
        self.pointer(cx, PointerStep::Down, from).await?;
        self.pointer(cx, PointerStep::Move, left).await?;
        escape(self, cx)?;
        let dropped = cx.update(|cx| self.shell.read(cx).project_drag_view().0);
        self.pointer(cx, PointerStep::Up, left).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        steps.check(
            "Escape puts a lifted project tab back",
            dropped.is_none() && self.project_order(cx) == vec![other.clone(), first.clone()],
            json!({ "dragging": dropped, "order": self.project_order(cx) }),
        );

        // Let go over no window: the tab gets a window of its own.
        let windows_before = cx.update(|cx| cx.windows().len());
        let from = self.tab_middle(cx, &first).context("the first tab is drawn")?;
        let away = point(px(-4000.), px(-4000.));
        self.pointer(cx, PointerStep::Down, from).await?;
        self.pointer(cx, PointerStep::Move, from + point(px(0.), px(12.))).await?;
        self.pointer(cx, PointerStep::Move, away).await?;
        self.pointer(cx, PointerStep::Up, away).await?;
        let opened = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                crate::shell::windows::window_showing_except(&first, None, cx).is_some()
            })
            .await;
        self.pause(cx, Duration::from_millis(800)).await;
        let torn = cx.update(|cx| {
            crate::shell::windows::window_showing_except(&first, None, cx)
                .and_then(|handle| crate::shell::windows::shell_of(handle, cx).map(|shell| (handle, shell)))
        });
        steps.check(
            "a project tab let go over no window gets a window of its own, and leaves this one",
            opened
                && torn.is_some()
                && cx.update(|cx| cx.windows().len()) == windows_before + 1
                && self.project_order(cx) == vec![other.clone()],
            json!({ "opened": opened, "windows": [windows_before, cx.update(|cx| cx.windows().len())], "order": self.project_order(cx) }),
        );
        let (handle, torn) = torn.context("the torn-off window")?;
        let second = self.for_window(torn, handle);

        // In that window, the caret in its main file.
        let main = first.join("main.tex");
        let editor = second.open(cx, &main, Some(3))?;
        second.pause(cx, Duration::from_millis(500)).await;
        let caret = cx.update(|cx| editor.read(cx).text_and_caret(cx).1);

        // Its lone project let go over this window's strip moves here, in
        // front, before the tab under it; the window it left closes.
        let target = self.tab_middle(cx, &other).context("this window's tab")? - point(px(20.), px(0.));
        let (here, there) = cx.update(|cx| {
            let origin = |handle: gpui::AnyWindowHandle, cx: &mut gpui::App| {
                handle.update(cx, |_, window, _| window.bounds().origin).unwrap_or_default()
            };
            (origin(self.window, cx), origin(handle, cx))
        });
        let at = here + target - there;
        let lone = cx
            .update(|cx| {
                let bounds = second.shell.read(cx).project_strip_bounds();
                let tabs = bounds.borrow();
                tabs.tabs.first().map(|(_, rect)| rect.center())
            })
            .context("the lone project's title is drawn")?;
        second.pointer(cx, PointerStep::Down, lone).await?;
        second.pointer(cx, PointerStep::Move, lone + point(px(0.), px(12.))).await?;
        second.pointer(cx, PointerStep::Move, at).await?;
        let incoming = cx.update(|cx| self.shell.read(cx).project_drag_view().1);
        second.pointer(cx, PointerStep::Up, at).await?;
        let moved = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| shell.read(cx).root(cx).as_ref() == Some(&first))
            .await;
        self.pause(cx, Duration::from_millis(800)).await;
        let closed = cx.update(|cx| !cx.windows().iter().any(|open| open.window_id() == handle.window_id()));
        let order = self.project_order(cx);
        let canonical = main.canonicalize().unwrap_or(main.clone());
        let here_editor = cx.update(|cx| self.shell.update(cx, |shell, cx| shell.open_editor(&canonical, cx)));
        let caret_here = here_editor.map(|editor| cx.update(|cx| editor.read(cx).text_and_caret(cx).1));
        steps.check(
            "a lone project let go over another window's strip moves there in front, before the tab under it, its caret kept, and its window closes",
            incoming.as_ref().is_some_and(|slot| slot.before.as_ref() == Some(&other))
                && moved
                && closed
                && order == vec![first.clone(), other.clone()]
                && (caret_here.is_none() || caret_here == Some(caret)),
            json!({ "incoming": incoming.map(|slot| slot.before), "moved": moved, "closed": closed, "order": order, "caret": [caret, caret_here] }),
        );

        // The steps after these find the project alone in its window.
        self.with_window(cx, {
            let other = other.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.close_project(&other, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        std::fs::remove_dir_all(&other).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `project_tab_drag`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 103,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/project_tab_drag.rs",
        "gpui/crates/lattice-gpui/src/titlebar/project_group.rs",
    ],
    run: |run, cx, steps, _| Box::pin(run.project_tab_drag(cx, steps)),
};
