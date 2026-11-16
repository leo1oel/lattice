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

        // A pointer move over the text, away from the card, leaves a
        // keyboard-opened card open (a hover card would close).
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        let (_, far) = self
            .text_point(cx, &panel, &lattice, "\\documentclass", 1)
            .await?;
        for dx in [3., 30., 60.] {
            native::send_mouse(native, native::Mouse::Moved, point(far.left() + px(dx), far.center().y))?;
            self.pause(cx, Duration::from_millis(150)).await;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        let (shown, keyboard, ..) = self.card_state(cx, &panel)?;
        steps.check(
            "a pointer move over the text away from the ⌥⌘K card leaves it open with the keyboard",
            shown == ["citation"] && keyboard,
            json!({ "shown": shown, "keyboard": keyboard }),
        );
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;

        // Tab stays in the card: however often it is pressed, the card keeps
        // the keyboard (the window root's focus_next would move it out).
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        for _ in 0..6 {
            native::send_chord(native, '\t', false, false, false)?;
            self.pause(cx, Duration::from_millis(100)).await;
        }
        let (shown, keyboard, _, in_text, _) = self.card_state(cx, &panel)?;
        steps.check(
            "Tab pressed six times in the ⌥⌘K card keeps the keyboard in the card",
            shown == ["citation"] && keyboard && !in_text,
            json!({ "shown": shown, "keyboard": keyboard, "text_focused": in_text }),
        );
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;

        // Tab from the last action wraps to the first: ⇧Tab (Copy key), Tab
        // (back to the first), ⇧Tab (Copy key again), Return copies. Were Tab
        // a no-op, the second ⇧Tab would land on Go to entry instead.
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(String::new())));
        for shift in [true, false, true] {
            native::send_chord(native, '\t', false, false, shift)?;
            self.pause(cx, Duration::from_millis(150)).await;
        }
        native::send_key(native, '\n', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        let active_main = cx.update(|cx| {
            self.shell
                .read(cx)
                .active_editor()
                .is_some_and(|editor| editor.read(cx).relative() == "main.tex")
        });
        steps.check(
            "in the ⌥⌘K card Tab from the last action wraps round to the first",
            copied.as_deref() == Some("knuth1984") && active_main,
            json!({ "copied": copied, "still_in_main": active_main }),
        );
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(300)).await;

        // An edit to the text closes the card.
        self.select(cx, &panel, key_at, key_at)?;
        self.option_command_k(cx, native).await?;
        let (opened, ..) = self.card_state(cx, &panel)?;
        let end = text.len();
        self.with_window(cx, |_, window, cx| {
            let inner = panel.read(cx).editor().clone();
            inner.update(cx, |editor, cx| {
                editor.change_selections(editor::SelectionEffects::default(), window, cx, |s| {
                    s.select_ranges([editor::MultiBufferOffset(end)..editor::MultiBufferOffset(end)])
                });
                editor.insert("%", window, cx);
            })
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (shown, ..) = self.card_state(cx, &panel)?;
        self.with_window(cx, |_, window, cx| {
            let inner = panel.read(cx).editor().clone();
            inner.update(cx, |editor, cx| editor.undo(&editor::actions::Undo, window, cx));
        })?;
        steps.check(
            "an edit to the text closes the ⌥⌘K card",
            opened == ["citation"] && shown.is_empty(),
            json!({ "opened": opened, "shown": shown }),
        );

        // Outside a LaTeX file the key opens no card, even on a \cite.
        let md = root.join("citation-card-check.md");
        std::fs::write(&md, "See \\cite{knuth1984} here.\n")?;
        let md_panel = self.open(cx, &md, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let md_text = cx.update(|cx| md_panel.read(cx).text_and_caret(cx).0);
        let md_at = md_text.find("knuth1984").context("the md \\cite")? + 3;
        self.select(cx, &md_panel, md_at, md_at)?;
        self.option_command_k(cx, native).await?;
        let (shown, ..) = self.card_state(cx, &md_panel)?;
        let md_after = cx.update(|cx| md_panel.read(cx).text_and_caret(cx).0);
        steps.check(
            "⌥⌘K in a Markdown file opens no citation card, even on a \\cite key",
            shown.is_empty() && md_after == md_text,
            json!({ "shown": shown, "text_unchanged": md_after == md_text }),
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
