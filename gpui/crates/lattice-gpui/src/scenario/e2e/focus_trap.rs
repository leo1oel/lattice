//! Every modal surface keeps the keyboard, as the Tauri app's
//! `ModalDialog` (`FocusScope trapped loop`) does: with one open, Tab and
//! ⇧Tab cycle through its own controls and never reach the window behind it
//! (lattice-ui `components/focus_trap.rs`); Escape closes it, and the
//! keyboard goes back to the document it was opened from.
//!
//! Each surface is opened from the document, then walked with Tab and ⇧Tab
//! past more stops than it has, checking after every key that focus is still
//! inside the same trap.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _, Keystroke};
use lattice_ui::components::focus_trap_holding;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{
    confirm::{self, Confirm},
    scenario::Run,
    shell::Shell,
};

/// More presses than any surface here has stops, so each walk wraps.
const PRESSES: usize = 24;

type Open = fn(&mut Shell, &mut gpui::Window, &mut gpui::Context<Shell>);

impl Run {
    fn trap_key(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }

    /// Open one surface from the document, walk it both ways, close it with
    /// Escape, and check where the keyboard ended up.
    async fn walk_surface(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        name: &str,
        document: &gpui::FocusHandle,
        open: Open,
    ) -> Result<()> {
        let back = document.clone();
        self.with_window(cx, move |_, window, cx| window.focus(&back, cx))?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| open(shell, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        let holder = self.with_window(cx, |_, window, cx| focus_trap_holding(window, cx))?;
        let mut escaped = Vec::new();
        let mut stops = Vec::new();
        for (index, key) in std::iter::repeat_n("tab", PRESSES)
            .chain(std::iter::repeat_n("shift-tab", PRESSES))
            .enumerate()
        {
            self.trap_key(cx, key)?;
            self.pause(cx, Duration::from_millis(30)).await;
            let (now, focused) = self.with_window(cx, |_, window, cx| {
                (focus_trap_holding(window, cx), window.focused(cx))
            })?;
            if now.is_none() || now != holder {
                escaped.push(json!({ "press": index + 1, "key": key, "in_a_trap": now.is_some() }));
            }
            if let Some(focused) = focused
                && !stops.contains(&focused)
            {
                stops.push(focused);
            }
            // `LATTICE_FOCUS_SHOTS=DIR`: the surface three Tabs in, its
            // focus ring on the third stop, for a look review.
            if index == 2
                && let Some(dir) = std::env::var_os("LATTICE_FOCUS_SHOTS")
            {
                let slug: String = name
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
                    .collect();
                let out = std::path::Path::new(&dir).join(format!("{slug}.png"));
                self.capture(cx, &out.to_string_lossy()).await?;
            }
        }
        steps.check(
            &format!("Tab and ⇧Tab stay inside {name}"),
            holder.is_some() && escaped.is_empty(),
            json!({
                "trapped_on_open": holder.is_some(),
                "stops_visited": stops.len(),
                "escaped": escaped,
            }),
        );
        self.trap_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(600)).await;
        let check = document.clone();
        let (open_after, returned) = self.with_window(cx, move |shell, window, cx| {
            (shell.read(cx).dialog_open(cx), check.contains_focused(window, cx))
        })?;
        steps.check(
            &format!("Escape closes {name} and the keyboard goes back to the document"),
            !open_after && returned,
            json!({ "still_open": open_after, "document_focused": returned }),
        );
        Ok(())
    }

    async fn focus_trap_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        fixture: &Fixture,
    ) -> Result<()> {
        let editor = self.open(cx, &fixture.root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let document = cx.update(|cx| editor.read(cx).editor().focus_handle(cx));
        let surfaces: [(&str, Open); 13] = [
            ("Settings", |shell, window, cx| shell.open_settings(None, window, cx)),
            ("the command palette", |shell, window, cx| shell.open_palette(window, cx)),
            ("the shortcut sheet", |shell, window, cx| shell.open_shortcuts(window, cx)),
            ("quick open", |shell, window, cx| shell.toggle_quick_open(window, cx)),
            ("Find in project", |shell, window, cx| shell.open_find(window, cx)),
            ("Go to line", |shell, window, cx| shell.open_goto_line(window, cx)),
            ("the table generator", |shell, window, cx| {
                shell.open_table_generator(window, cx)
            }),
            ("Open from Overleaf", |shell, window, cx| {
                shell.open_overleaf_picker(window, cx)
            }),
            ("the arXiv export", |shell, window, cx| shell.open_arxiv_export(window, cx)),
            // The wizard opens only when something is missing; the doctor's
            // sheet, where the administrator prompt for an update is asked
            // from, stands on the same layer.
            ("the TeX doctor", |shell, _, cx| {
                shell.tex_setup().clone().update(cx, |center, cx| center.open_doctor(cx))
            }),
            ("New project", |shell, window, cx| shell.open_new_project(window, cx)),
            ("Clone repository", |shell, window, cx| shell.open_clone(window, cx)),
            ("a plugin's confirmation", |_, _, cx| {
                confirm::ask(
                    Confirm::new("Turn on Example?")
                        .body("Example asks to:")
                        .list(["Read the open project", "Run commands"])
                        .confirm_label("Turn on"),
                    cx,
                )
            }),
        ];
        for (name, open) in surfaces {
            self.walk_surface(cx, steps, name, &document, open).await?;
        }

        // A question asked over Settings fences Settings out too: the
        // innermost trap holds, and closing the question returns the
        // keyboard to Settings, not the document.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_settings(None, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        let settings = self.with_window(cx, |_, window, cx| focus_trap_holding(window, cx))?;
        cx.update(|cx| confirm::ask(Confirm::new("Remove Example?").destructive(), cx));
        self.pause(cx, Duration::from_millis(500)).await;
        let question = self.with_window(cx, |_, window, cx| focus_trap_holding(window, cx))?;
        let mut held = true;
        for index in 0..PRESSES {
            self.trap_key(cx, "tab")?;
            self.pause(cx, Duration::from_millis(30)).await;
            held &= self.with_window(cx, |_, window, cx| focus_trap_holding(window, cx))? == question;
            if index == 0
                && let Some(dir) = std::env::var_os("LATTICE_FOCUS_SHOTS")
            {
                let out = std::path::Path::new(&dir).join("confirm-over-settings.png");
                self.capture(cx, &out.to_string_lossy()).await?;
            }
        }
        self.trap_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(600)).await;
        let after = self.with_window(cx, |_, window, cx| focus_trap_holding(window, cx))?;
        steps.check(
            "a question asked over Settings holds Tab, and Escape hands the keyboard back to Settings",
            settings.is_some() && question.is_some() && question != settings && held && after == settings,
            json!({
                "settings_trapped": settings.is_some(),
                "question_trapped": question.is_some(),
                "held": held,
                "back_in_settings": after.is_some() && after == settings,
            }),
        );
        self.trap_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(600)).await;
        Ok(())
    }
}

/// This file's registration as the e2e module `focus_trap` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 96,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-ui/src/components/focus_trap.rs",
        "gpui/crates/lattice-ui/src/components/sheet.rs",
        "gpui/patches/gpui-base/src/focus_trap.rs",
        "gpui/patches/gpui-base/src/root.rs",
        "gpui/crates/lattice-gpui/src/search/sheet.rs",
        "gpui/crates/lattice-gpui/src/shell/palette.rs",
        "gpui/crates/lattice-gpui/src/shell/shortcut_sheet.rs",
        "gpui/crates/lattice-gpui/src/search/quick_open.rs",
        "gpui/crates/lattice-gpui/src/welcome/",
        "gpui/crates/lattice-gpui/src/confirm.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.focus_trap_checks(cx, steps, fixture)),
};
