//! The Visual view's Wrap in environment… (⌘⇧E) and Rename the environment
//! (⌘⌥R), run by the `latex_visual` module: the keys reach the page's own
//! editor first, which asks the window for its dialog
//! (`tex:wrap-environment`, `tex:rename-environment`); the name typed there
//! goes back to the page (`tex:environment`), which wraps its own selection,
//! or renames both delimiters of the environment at its caret, as the Tauri
//! app's canvas does.

#![cfg(target_os = "macos")]

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_webview::Island;
use serde_json::json;

use super::{Run, Steps};
use crate::{editor_panel::EditorPanel, native};

/// A ⌘-chord typed into the page's editor, as WebKit reports one on macOS:
/// `key` with its key code, which CodeMirror reads its name from there.
fn page_chord(key: &str, key_code: u32, shift: bool, alt: bool) -> String {
    format!(
        "(() => {{ const target = document.querySelector('.cm-content'); \
         if (!target) return 'null'; \
         const event = new KeyboardEvent('keydown', {{ key: '{key}', metaKey: true, \
         shiftKey: {shift}, altKey: {alt}, bubbles: true, cancelable: true }}); \
         Object.defineProperty(event, 'keyCode', {{ get: () => {key_code} }}); \
         target.dispatchEvent(event); return JSON.stringify(event.defaultPrevented); }})()"
    )
}

impl Run {
    pub(super) async fn latex_visual_environment(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        let native = self.native(cx)?;
        // The search panel the find step left open closes first.
        native::send_key(native, '\u{1b}', false)?;
        self.pause(cx, Duration::from_millis(150)).await;
        // The page's caret at the start of the prose line.
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| panel.update(cx, |panel, cx| panel.go_to_line(7, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        // A native click at the line's first character gives the page the
        // keyboard there, as a writer's would.
        let rect = self
            .evaluate(
                cx,
                island,
                "JSON.stringify((() => { const r = document.querySelector('.cm-activeLine')?.getBoundingClientRect(); \
                 return r ? { x: r.left + 1, y: r.top + r.height / 2 } : null; })())",
            )
            .await;
        if let (Some(bounds), Some(x), Some(y)) = (
            cx.update(|cx| island.read(cx).bounds(cx)),
            rect["x"].as_f64(),
            rect["y"].as_f64(),
        ) {
            let at = bounds.origin + gpui::point(gpui::px(x as f32), gpui::px(y as f32));
            native::send_click(native, at)?;
            self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                island.read(cx).page_focused()
            })
            .await;
            self.pause(cx, Duration::from_millis(150)).await;
        }
        let original = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);

        let asked = self
            .evaluate(cx, island, &page_chord("E", 69, true, false))
            .await;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).references.rename.is_some()
            })
            .await;
        // The dialog starts at `equation`: Enter takes it.
        self.press(cx, '\n', false).await?;
        // The empty environment the wrap writes at the caret, which the
        // fixture has nowhere else; what follows it is left to the steps
        // before (an undo step that fails leaves its word there).
        let wrapped_text = "\\begin{equation}\n  \n\\end{equation}";
        let wrapped = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                panel.read(cx).text_and_caret(cx).0.contains(wrapped_text)
            })
            .await;
        let closed = cx.update(|cx| self.shell.read(cx).references.rename.is_none());
        let line = cx.update(|cx| {
            let text = panel.read(cx).text_and_caret(cx).0;
            let at = text.find("Some prose").unwrap_or(0);
            text[at.saturating_sub(60)..at + 10].to_string()
        });
        steps.check(
            "⌘⇧E in the Visual view asks for the environment in the window's dialog, and its Enter wraps the page's selection in it",
            opened && wrapped,
            json!({ "handled_in_page": asked, "dialog": opened, "closed": closed, "wrapped": wrapped, "before_prose": line }),
        );

        // ⌘⌥R with the page's caret inside: the dialog offers `equation`,
        // and the name typed over it renames both delimiters.
        self.pause(cx, Duration::from_millis(300)).await;
        let asked = self
            .evaluate(cx, island, &page_chord("r", 82, false, true))
            .await;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).references.rename.is_some()
            })
            .await;
        self.press(cx, 'a', true).await?;
        self.type_text(cx, "align\n").await?;
        let renamed_text = "\\begin{align}\n  \n\\end{align}";
        let renamed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                panel.read(cx).text_and_caret(cx).0.contains(renamed_text)
            })
            .await;
        let page_focused = cx.update(|cx| island.read(cx).page_focused());
        steps.check(
            "⌘⌥R in the Visual view renames both delimiters of the environment at the page's caret to the name typed in the dialog, the keyboard back in the page",
            opened && renamed && page_focused,
            json!({ "handled_in_page": asked, "dialog": opened, "renamed": renamed, "page_focused": page_focused }),
        );

        // The text as it was, for the steps after.
        self.with_window(cx, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                let len = panel.text_and_caret(cx).0.len();
                panel.replace_range(0, len, &original, 0, window, cx)
            })
        })?;
        Ok(())
    }
}
