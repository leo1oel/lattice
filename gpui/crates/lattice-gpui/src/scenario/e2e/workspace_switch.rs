//! The titlebar's layout switch as the Tauri app drives it
//! (`titlebar/workspace_track.rs`, `workspace_rename.rs`), with the
//! platform's own pointer and key events:
//!
//! - A tab pressed and drawn past its neighbour's middle takes its place,
//!   saved, and the press switches nothing; Enter on it after is its click.
//! - The project's workspace is the one tab stop; → and ← (round the ends),
//!   Home and End switch and take the keyboard along.
//! - F2 renames; a name already used stays in editing, marked, until the
//!   next keystroke; Escape gives the keyboard back to the tab.
//! - ⇧F10 opens the workspace's menu.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, PlatformInput, point, px};
use serde_json::json;

use super::{Steps, drops::PointerStep};
use crate::{scenario::Run, shell::workspaces::Workspaces};

impl Run {
    async fn workspace_switch(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        // Three workspaces: the project's, then two more.
        let first = cx
            .update(|cx| self.shell.read(cx).layout.workspace.clone())
            .context("the project is in a workspace")?;
        let mut made = Vec::new();
        for _ in 0..2 {
            let id = self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    let id = shell.new_workspace(window, cx);
                    shell.finish_rename(window, cx);
                    id
                })
            })?;
            made.push(id);
        }
        let order = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                Workspaces::global(cx)
                    .list()
                    .iter()
                    .map(|entry| entry.id.clone())
                    .collect::<Vec<_>>()
            })
        };
        self.with_window(cx, {
            let first = first.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.switch_workspace(&first, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;

        // Drag the workspace after the project's back past its middle: the
        // project's stays current, though the press was on the other tab.
        let before = order(cx);
        let bounds = |cx: &mut AsyncApp, id: &str| {
            let id = id.to_string();
            cx.update(|cx| self.shell.read(cx).workspace_tab_bounds(&id))
        };
        let next = before
            .iter()
            .skip_while(|id| **id != first)
            .nth(1)
            .cloned()
            .context("a workspace after the first")?;
        let grabbed = bounds(cx, &next).context("the next tab is drawn")?;
        let past = bounds(cx, &first).context("the first tab is drawn")?;
        let from = grabbed.center();
        let to = point(past.left() + px(2.), from.y);
        self.pointer(cx, PointerStep::Down, from).await?;
        self.pointer(cx, PointerStep::Move, from - point(px(6.), px(0.))).await?;
        let lifted = cx.update(|cx| self.shell.read(cx).layout.track.dragging.clone());
        self.pointer(cx, PointerStep::Move, to).await?;
        self.pointer(cx, PointerStep::Up, to).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let after = order(cx);
        let current = cx.update(|cx| self.shell.read(cx).layout.workspace.clone());
        let moved = after.iter().position(|id| *id == next)
            == before.iter().position(|id| *id == first);
        steps.check(
            "a workspace tab dragged past its neighbour's middle takes its place, and the drag switches nothing",
            lifted.as_deref() == Some(next.as_str()) && moved && current.as_deref() == Some(first.as_str()),
            json!({ "lifted": lifted, "before": before, "after": after, "current": current }),
        );

        // After the drag, Enter on the dragged tab is still its click.
        self.with_window(cx, {
            let next = next.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.focus_workspace_tab(&next, window, cx))
        })?;
        self.key(cx, "enter")?;
        self.key_up(cx, "enter")?;
        self.pause(cx, Duration::from_millis(300)).await;
        let entered = cx.update(|cx| self.shell.read(cx).layout.workspace.clone());
        steps.check(
            "after a drag, Enter on a workspace's tab switches to it",
            entered.as_deref() == Some(next.as_str()),
            json!({ "entered": entered, "tab": next }),
        );
        self.with_window(cx, {
            let first = first.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.switch_workspace(&first, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;

        // The keyboard: → switches to the next workspace and goes with it;
        // End and Home reach the ends; ← from the first goes round.
        self.with_window(cx, {
            let first = first.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.focus_workspace_tab(&first, window, cx))
        })?;
        let mut visits = Vec::new();
        for key in ["right", "end", "home", "left"] {
            self.key(cx, key)?;
            self.pause(cx, Duration::from_millis(200)).await;
            let (current, focused) = self.with_window(cx, |shell, window, cx| {
                let shell = shell.read(cx);
                let current = shell.layout.workspace.clone().unwrap_or_default();
                let focused = shell.workspace_tab_focused(&current, window);
                (current, focused)
            })?;
            visits.push((key, current, focused));
        }
        let ids = order(cx);
        let at = |id: &str| ids.iter().position(|entry| entry == id);
        let first_at = at(&first).unwrap_or(0);
        let expected = [
            (first_at + 1) % ids.len(),
            ids.len() - 1,
            0,
            ids.len() - 1,
        ];
        steps.check(
            "→ ← Home End switch the workspace and take the keyboard along, ← going round from the first",
            visits
                .iter()
                .zip(expected)
                .all(|((_, current, focused), want)| at(current) == Some(want) && *focused),
            json!({ "visits": visits, "order": ids }),
        );

        // F2 renames; a name already used stays in editing, marked;
        // Escape gives the keyboard back to the tab.
        let current = cx.update(|cx| self.shell.read(cx).layout.workspace.clone().unwrap_or_default());
        let taken_name = cx.update(|cx| {
            Workspaces::global(cx)
                .list()
                .iter()
                .find(|entry| entry.id != current)
                .map(|entry| entry.name.clone())
                .unwrap_or_default()
        });
        self.key(cx, "f2")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let opened = cx.update(|cx| self.shell.read(cx).workspace_renaming());
        self.with_window(cx, move |shell, window, cx| {
            if let Some(input) = shell.read(cx).rename_input() {
                input.update(cx, |input, cx| input.set_value(taken_name.clone(), window, cx));
            }
        })?;
        self.key(cx, "enter")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let taken = cx.update(|cx| self.shell.read(cx).workspace_renaming());
        self.key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (closed, back) = self.with_window(cx, {
            let current = current.clone();
            move |shell, window, cx| {
                let shell = shell.read(cx);
                (shell.workspace_renaming().0.is_none(), shell.workspace_tab_focused(&current, window))
            }
        })?;
        steps.check(
            "F2 renames the workspace; a name already used stays in editing, marked, and Escape gives the keyboard back to its tab",
            opened.0.as_deref() == Some(current.as_str())
                && taken.0.as_deref() == Some(current.as_str())
                && taken.1
                && closed
                && back,
            json!({ "opened": opened, "taken": taken, "closed": closed, "back": back }),
        );

        // ⇧F10 opens the workspace's menu.
        self.key(cx, "shift-f10")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let menu = cx.update(|cx| self.shell.read(cx).workspace_menu_open(cx));
        steps.check(
            "⇧F10 on the workspace's tab opens its menu",
            menu.as_deref() == Some(current.as_str()),
            json!({ "menu": menu }),
        );
        self.key(cx, "escape")?;

        // The steps after these find the workspaces as they were.
        self.with_window(cx, {
            let first = first.clone();
            move |shell, window, cx| shell.update(cx, |shell, cx| shell.switch_workspace(&first, window, cx))
        })?;
        cx.update(|cx| {
            Workspaces::update(cx, |library| {
                for id in &made {
                    library.remove(id);
                }
                library.move_to(&first, 0);
            })
        });
        self.pause(cx, Duration::from_millis(300)).await;
        // And the keyboard in the document, where the steps after expect it.
        if let Some(root) = cx.update(|cx| self.shell.read(cx).root(cx)) {
            self.open(cx, &root.join("main.tex"), Some(1))?;
        }
        Ok(())
    }

    /// One key let go where the keyboard is, as the platform sends it.
    fn key_up(&self, cx: &mut AsyncApp, key: &'static str) -> Result<()> {
        let keystroke = gpui::Keystroke::parse(key)?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_event(PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }), cx);
        })
    }

    /// One key pressed where the keyboard is, as the platform sends it.
    fn key(&self, cx: &mut AsyncApp, key: &'static str) -> Result<()> {
        let keystroke = gpui::Keystroke::parse(key)?;
        self.with_window(cx, move |_, window, cx| {
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
}

/// This file's registration as the e2e module `workspace_switch`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 36,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/titlebar/workspace_track.rs",
        "gpui/crates/lattice-gpui/src/titlebar/workspace_rename.rs",
        "gpui/crates/lattice-gpui/src/titlebar/workspace_switch.rs",
    ],
    run: |run, cx, steps, _| Box::pin(run.workspace_switch(cx, steps)),
};
