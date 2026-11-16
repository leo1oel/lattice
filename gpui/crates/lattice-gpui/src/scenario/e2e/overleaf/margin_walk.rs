//! The e2e check of margin review's keyboard walk (`margin_review/walk.rs`),
//! with native keys on main.tex's comments in Markers: "Review here" puts
//! focus on the item by the caret with its card open, J goes to the next
//! item in the text with its card following, K comes back, K again goes
//! round to the last, Escape closes the card and leaves focus on its pip,
//! and a second Escape gives the text the keyboard.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::super::Steps;
use crate::{editor_panel::MarginMode, native, scenario::Run};

/// The item with focus, the open card, and whether the text has focus.
type WalkState = (Option<String>, Option<String>, bool);

impl Run {
    pub(super) async fn overleaf_margin_walk(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let editor = self
            .with_window(cx, {
                let main = main.clone();
                move |shell, window, cx| {
                    shell.update(cx, |shell, cx| {
                        shell.set_margin_mode(MarginMode::Markers, cx);
                        let editor = shell.open_editor(&main, cx)?;
                        window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
                        Some(editor)
                    })
                }
            })?
            .context("main.tex is open")?;
        self.pause(cx, Duration::from_millis(300)).await;
        let _front = self.focused(cx, "margin review walk").await?;
        let native = self.native(cx)?;
        let state = |run: &Run, cx: &mut AsyncApp| -> Result<WalkState> {
            let editor = editor.clone();
            run.with_window(cx, move |_, window, cx| {
                let panel = editor.read(cx);
                (
                    panel.margin_focused(window, cx),
                    panel.margin_open().map(str::to_string),
                    panel.editor().focus_handle(cx).is_focused(window),
                )
            })
        };
        let keys = cx.update(|cx| editor.read(cx).margin_keys());
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::ReviewHere), cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let here = state(self, cx)?;
        let start = here.0.clone().unwrap_or_default();
        let at = keys.iter().position(|key| *key == start);
        let step = |by: isize| {
            at.map(|at| keys[(at as isize + by).rem_euclid(keys.len() as isize) as usize].clone())
        };
        native::send_key(native, 'j', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let next = state(self, cx)?;
        native::send_key(native, 'k', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let back = state(self, cx)?;
        native::send_key(native, 'k', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before = state(self, cx)?;
        let walked = keys.len() >= 2
            && at.is_some()
            && here.1.as_deref() == Some(start.as_str())
            && next.0 == step(1)
            && next.1 == step(1)
            && back.0.as_deref() == Some(start.as_str())
            && before.0 == step(-1)
            && !next.2
            && !before.2;
        steps.check(
            "in margin review J walks to the next comment or suggestion with its card following, K back, and K again round to the last",
            walked,
            json!({ "keys": keys, "here": here, "next": next, "back": back, "round": before }),
        );
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let closed = state(self, cx)?;
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let out = state(self, cx)?;
        steps.check(
            "in margin review Escape closes the open card leaving its pip focused, and Escape again gives the text the keyboard",
            closed.1.is_none() && closed.0 == before.0 && !closed.2 && out.2 && out.0.is_none(),
            json!({ "closed": closed, "out": out }),
        );
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.set_margin_mode(MarginMode::Auto, cx))
        })?;
        Ok(())
    }
}
