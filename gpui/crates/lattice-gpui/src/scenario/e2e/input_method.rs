#![cfg(target_os = "macos")]
//! The e2e checks of typing with Pinyin selected (gpui's
//! `fast::ime_bindings`, `patches/gpui-fast-ime-bindings.diff`), as the
//! Tauri app's editor takes it: the keys Lattice binds on their own reach
//! their bindings rather than Pinyin's full-width punctuation, so `$` pairs
//! in a LaTeX file and Vim's `:` opens its command line. The run types on an
//! ASCII layout (`native::use_ascii_keyboard`); this module selects Pinyin
//! (enabling it first where the user has not) and puts the keyboard back
//! after. The chapter is put back too.
//!
//! Composing is not checked here: Pinyin composes only keys the window
//! server delivers, and a key a run posts there goes to whichever app holds
//! the keyboard, which on a shared Mac can be another run's. The scenario's
//! keys, sent to its own window, reach Pinyin already interpreted, and it
//! inserts them as typed. Composing (marked text, Space and Enter) is checked
//! by hand; see the PR.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

/// Apple's Pinyin – Simplified, in its own (Chinese) mode.
const PINYIN: &str = "com.apple.inputmethod.SCIM.ITABC";

impl Run {
    pub(super) async fn input_method(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        let start = original.len() + 1;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let end = original.len();
                editor.replace_range(end, end, "\n", end + 1, window, cx)
            })
        })?;
        self.select(cx, &editor, start, start)?;
        let tail = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let (text, caret) = editor.read(cx).text_and_caret(cx);
                format!("{}|{}", &text[..caret], &text[caret..])
                    .get(start..)
                    .unwrap_or_default()
                    .to_string()
            })
        };

        // The input method serves only the key window of the active app.
        let front = self.foreground(cx, "input method").await?;
        let method = match native::select_input_method(self.native(cx)?, PINYIN) {
            Ok(method) => method,
            Err(error) => {
                steps.check(
                    "with Pinyin selected, $ in a LaTeX file writes a pair with the caret between, not Pinyin's ￥",
                    false,
                    json!({ "pinyin": format!("{error:#}") }),
                );
                drop(front);
                return self.put_back(cx, &editor, &original);
            }
        };
        let selected = native::current_input_source();
        self.pause(cx, Duration::from_millis(200)).await;

        let before = tail(cx);
        self.type_text(cx, "$").await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let paired = tail(cx);
        let typed = before.trim_end_matches('|');
        steps.check(
            "with Pinyin selected, $ in a LaTeX file writes a pair with the caret between, not Pinyin's ￥",
            paired == format!("{typed}$|$"),
            json!({ "source": selected, "paired": paired }),
        );

        self.put_back(cx, &editor, &original)?;
        cx.update(|cx| crate::app::set_vim_mode(true, cx));
        self.pause(cx, Duration::from_millis(200)).await;
        self.select(cx, &editor, 0, 0)?;
        self.press(cx, '\u{1b}', false).await?;
        self.press(cx, ':', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let opened = cx.update(|cx| editor.read(cx).vim_ex_open());
        self.press(cx, '\u{1b}', false).await?;
        cx.update(|cx| crate::app::set_vim_mode(false, cx));
        self.pause(cx, Duration::from_millis(200)).await;
        let unchanged = self.editor_text(cx, &editor) == original;
        steps.check(
            "with Pinyin selected and Vim on, : in Normal mode opens Lattice's command line",
            opened && unchanged,
            json!({ "opened": opened, "text_unchanged": unchanged }),
        );
        drop(method);
        drop(front);
        Ok(())
    }

    /// The chapter as it was, for the modules after.
    fn put_back(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, original: &str) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, original, 0, window, cx)
            })
        })
    }
}

/// This file's registration as the e2e module `input_method` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 113,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/patches/gpui-fast/crates/gpui/src/fast/ime_bindings.rs",
        "gpui/patches/gpui-fast/crates/gpui_macos/src/window.rs",
        "gpui/crates/lattice-gpui/src/native/input_source.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.input_method(cx, steps, &fixture.root)),
};
