#![cfg(target_os = "macos")]
//! The e2e checks of the citation card opened from the keyboard
//! (`editor_panel/citation_card.rs`, `LatticeEditor::open_card_at`), with
//! native keys on `main.tex`, as the Tauri app's ⌥⌘K
//! (`citationCardAtCursor`) behaves: on `\cite{knuth1984}` it opens the card
//! with the keyboard in it and the caret where it was; ⇧Tab walks round from
//! the first action to Copy key, whose Return copies the key and leaves the
//! card open, and on to Go to entry, whose Return opens the bibliography at
//! the entry; Escape gives the caret back; a click in the text closes the
//! card; and off a citation the key opens none.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Focusable as _, point, px};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

/// The card shown (provider ids), whether it was opened from the keyboard
/// and holds the keyboard, the caret, whether the text has the keyboard,
/// and whether anything does.
type CardState = (Vec<&'static str>, bool, usize, bool, bool);

impl Run {
    pub(super) async fn citation_card_keys(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        let panel = self.open(cx, &main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let native = self.native(cx)?;
        let text = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let key_at = text.find("knuth1984}").context("the \\cite")? + 3;

        // ⌥⌘K on the key: the card, the keyboard in it, the caret kept.
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        let (shown, keyboard, caret, in_text, focused) = self.card_state(cx, &panel)?;
        self.completion_shot(cx, "citation-card-keyboard").await;
        steps.check(
            "⌥⌘K on a citation key opens its card with the keyboard in the card and the caret where it was",
            shown == ["citation"] && keyboard && caret == key_at && !in_text && focused,
            json!({ "shown": shown, "keyboard": keyboard, "caret": caret, "wanted_caret": key_at, "text_focused": in_text, "focused": focused }),
        );

        // ⇧Tab from the first action goes round to the last, Copy key.
        cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(String::new())));
        native::send_chord(native, '\t', false, false, true)?;
        self.pause(cx, Duration::from_millis(150)).await;
        native::send_key(native, '\n', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        let (shown, _, _, in_text, _) = self.card_state(cx, &panel)?;
        steps.check(
            "in the ⌥⌘K card ⇧Tab goes round from the first action to Copy key, whose Return copies the key and leaves the card open",
            copied.as_deref() == Some("knuth1984") && shown == ["citation"] && !in_text,
            json!({ "copied": copied, "shown": shown, "text_focused": in_text }),
        );

        // ⇧Tab again: Go to entry, whose Return opens the bibliography.
        native::send_chord(native, '\t', false, false, true)?;
        self.pause(cx, Duration::from_millis(150)).await;
        native::send_key(native, '\n', false)?;
        let entry = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .active_editor()
                    .is_some_and(|editor| editor.read(cx).relative() == "references.bib")
            })
            .await;
        let line = cx.update(|cx| {
            self.shell
                .read(cx)
                .active_editor()
                .map(|editor| editor.read(cx).cursor().0)
        });
        let (shown, ..) = self.card_state(cx, &panel)?;
        steps.check(
            "in the ⌥⌘K card ⇧Tab then reaches Go to entry, whose Return opens the bibliography at the entry and closes the card",
            entry && line == Some(1) && shown.is_empty(),
            json!({ "opened_bib": entry, "line": line, "shown": shown }),
        );

        // Escape: the card goes and the caret is back in the text.
        let panel = self.open(cx, &main, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        let (opened, ..) = self.card_state(cx, &panel)?;
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (shown, _, caret, in_text, _) = self.card_state(cx, &panel)?;
        steps.check(
            "Escape in the ⌥⌘K card closes it and gives the caret back to the text where it was",
            opened == ["citation"] && shown.is_empty() && in_text && caret == key_at,
            json!({ "opened": opened, "shown": shown, "text_focused": in_text, "caret": caret }),
        );

        // A click in the text takes focus from the card, which closes.
        self.option_command_k(cx, native).await?;
        let (opened, ..) = self.card_state(cx, &panel)?;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let (_, rect) = self
            .text_point(cx, &panel, &lattice, "Some text", 1)
            .await?;
        native::send_click(native, point(rect.left() + px(3.), rect.center().y))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (shown, _, _, in_text, _) = self.card_state(cx, &panel)?;
        steps.check(
            "a click in the text closes the ⌥⌘K card, as focus leaving it does",
            opened == ["citation"] && shown.is_empty() && in_text,
            json!({ "opened": opened, "shown": shown, "text_focused": in_text }),
        );

        // Off a citation the key opens nothing and the text keeps the keyboard.
        let plain = text.find("Some text").context("the plain text")? + 2;
        self.select(cx, &panel, plain, plain)?;
        self.option_command_k(cx, native).await?;
        let (shown, _, caret, in_text, _) = self.card_state(cx, &panel)?;
        let after = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        steps.check(
            "⌥⌘K off a citation key opens no card and leaves the text as it was",
            shown.is_empty() && in_text && caret == plain && after == text,
            json!({ "shown": shown, "text_focused": in_text, "caret": caret, "text_unchanged": after == text }),
        );
        Ok(())
    }

    async fn option_command_k(&self, cx: &mut AsyncApp, native: native::Native) -> Result<()> {
        native::send_chord(native, 'k', true, true, false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    fn card_state(&self, cx: &mut AsyncApp, panel: &Entity<EditorPanel>) -> Result<CardState> {
        self.with_window(cx, |_, window, cx| {
            let panel = panel.read(cx);
            let lattice = panel.lattice_editor().read(cx);
            let shown = lattice
                .shown_hover(cx)
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            (
                shown,
                lattice.hover_from_keyboard() && lattice.hover_holds_focus(window, cx),
                panel.text_and_caret(cx).1,
                panel.editor().focus_handle(cx).is_focused(window),
                window.focused(cx).is_some(),
            )
        })
    }
}

/// This file's registration as the e2e module `citation_card_keys` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 115,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/hover.rs",
        "gpui/crates/lattice-editor/src/latex/cards.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/citation_card.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.citation_card_keys(cx, steps, &fixture.root)),
};
