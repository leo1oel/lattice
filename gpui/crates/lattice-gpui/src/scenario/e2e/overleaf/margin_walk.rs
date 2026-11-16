//! The e2e check of margin review's keyboard walk (`margin_review/walk.rs`),
//! with native keys on main.tex's comments in Markers: "Review here" from
//! the first line puts focus on the first item with its card open, J goes to
//! the next item in the text with its card following, K comes back, K again
//! goes round to the last, Escape closes the card and leaves focus on its
//! pip, and a second Escape gives the text the keyboard. The order expected
//! is the stand-in Overleaf's: its open threads' and suggestions' positions
//! in main.tex.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::super::Steps;
use crate::{
    editor_panel::MarginMode,
    native,
    scenario::{Run, overleaf_mock::MockOverleaf},
};

/// The item with focus, the open card, and whether the text has focus.
type WalkState = (Option<String>, Option<String>, bool);

impl Run {
    pub(super) async fn overleaf_margin_walk(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let editor = self
            .with_window(cx, {
                let main = main.clone();
                move |shell, window, cx| {
                    shell.update(cx, |shell, cx| {
                        shell.set_margin_mode(MarginMode::Markers, cx);
                        let editor = shell.open_path(main, Some(1), window, cx)?;
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
        let mut items: Vec<(i64, String)> = mock
            .comments("main.tex")
            .into_iter()
            .filter(|comment| mock.thread(&comment.thread_id).is_some_and(|(_, resolved)| !resolved))
            .map(|comment| (comment.position, format!("comment:{}", comment.thread_id)))
            .chain(
                mock.changes("main.tex")
                    .into_iter()
                    .map(|change| (change.position, format!("change:{}", change.id))),
            )
            .collect();
        items.sort();
        let keys: Vec<String> = items.into_iter().map(|(_, key)| key).collect();
        let (first, second, last) = (keys.first(), keys.get(1), keys.last());
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::ReviewHere), cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let here = state(self, cx)?;
        native::send_key(native, 'j', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let next = state(self, cx)?;
        native::send_key(native, 'k', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let back = state(self, cx)?;
        native::send_key(native, 'k', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before = state(self, cx)?;
        let walked = keys.len() >= 3
            && here.0.as_ref() == first
            && here.1.as_ref() == first
            && next.0.as_ref() == second
            && next.1.as_ref() == second
            && back.0.as_ref() == first
            && before.0.as_ref() == last
            && before.1.as_ref() == last
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
