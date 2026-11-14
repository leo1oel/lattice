//! The e2e checks of margin review's cards beside a crowded end of the
//! document (`editor_panel::margin_review`): with the documents' panel
//! framed to the whole window, so the cards stand beside the text, eight
//! more comments on main.tex's last line stack under one another past it and
//! past the view's bottom. Every
//! card stays right of the text (none over a highlighted passage), the
//! editor keeps room under the last line, and scrolled to the end the last
//! card is inside the view rather than cut off at its bottom.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;
use trellis::runtime::keymap::Command as Trellis;

use super::super::Steps;
use crate::{
    editor_panel::{EditorPanel, MarginLayout},
    scenario::{Run, overleaf_mock::MockOverleaf},
};

/// The last line's words the extra comments quote.
const LAST_LINE: &str = "% A note from Overleaf";
/// More comments than the view holds, so the stack reaches past its bottom
/// and past the document's last line.
const QUOTES: [&str; 8] = [
    "A", "note", "from", "Overleaf", "A note", "note from", "from Overleaf", "Overleaf",
];

impl Run {
    pub(super) async fn overleaf_margin_end(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let text = mock.file("main.tex").unwrap_or_default();
        let Some(line) = text.rfind(LAST_LINE) else {
            steps.check(
                "margin review: the cards beside the last line stay beside the text and in reach",
                false,
                json!({ "missing": LAST_LINE, "text": text }),
            );
            return Ok(());
        };
        let mut threads = Vec::new();
        for quote in QUOTES {
            let byte = line + LAST_LINE.find(quote).unwrap_or(0);
            let at = text[..byte].encode_utf16().count() as i64;
            threads.push(mock.peer_commented(
                "main.tex",
                at,
                quote,
                &format!("A remark on “{quote}”, long enough to wrap onto a second line."),
            ));
        }
        // The documents' panel framed to the window: room for the cards.
        self.frame_editor(cx, editor)?;
        let watched = editor.clone();
        let wanted: Vec<String> = threads.iter().map(|id| format!("comment:{id}")).collect();
        let keys = wanted.clone();
        let wide = self
            .wait_for(cx, Duration::from_secs(15), move |_, cx| {
                let editor = watched.read(cx);
                let painted = editor.margin_painted();
                editor.margin_layout() == Some(MarginLayout::Wide)
                    && keys.iter().all(|key| painted.iter().any(|(k, _)| k == key))
                    && editor.margin_room() > 0
            })
            .await;
        // Scrolled to the end of the document: the room under the last line
        // reaches the editor's layout a frame after the margin asks for it,
        // so the scroll is asked again once that frame is drawn.
        for _ in 0..2 {
            self.with_window(cx, {
                let editor = editor.clone();
                move |_, window, cx| {
                    let zed = editor.read(cx).editor().clone();
                    zed.update(cx, |zed, cx| {
                        zed.move_to_end(&editor::actions::MoveToEnd, window, cx);
                        zed.set_scroll_position(gpui::point(0., 1.0e6), window, cx);
                    });
                }
            })?;
            self.pause(cx, Duration::from_millis(500)).await;
        }
        let (painted, view, text_right, room) = cx.update(|cx| {
            let panel = editor.read(cx);
            (
                panel.margin_painted(),
                panel.margin_view(),
                panel.lattice_editor().read(cx).painted().bounds.map(|b| b.right()),
                panel.margin_room(),
            )
        });
        let cards: Vec<_> = painted
            .iter()
            .filter(|(key, _)| key.starts_with("comment:") || key.starts_with("change:"))
            .collect();
        // Beside the text: every card starts right of where the text ends.
        let beside = text_right.is_some_and(|right| {
            !cards.is_empty() && cards.iter().all(|(_, bounds)| bounds.left() >= right)
        });
        // In reach: the last stacked card is wholly inside the view.
        let last = cards
            .iter()
            .filter(|(key, _)| wanted.contains(key))
            .map(|(_, bounds)| *bounds)
            .max_by(|a, b| a.bottom().partial_cmp(&b.bottom()).unwrap_or(std::cmp::Ordering::Equal));
        let reached = matches!(
            (last, view),
            (Some(last), Some(view)) if last.top() >= view.top() && last.bottom() <= view.bottom()
        );
        let last = last.map(|last| last.bottom());
        self.adapter_shot(cx, "overleaf-margin-end").await;
        steps.check(
            "margin review: the cards beside the last line stay beside the text and in reach",
            wide && beside && reached,
            json!({
                "wide": wide, "beside": beside, "reached": reached, "room": room,
                "text_right": text_right.map(f32::from),
                "last_bottom": last.map(f32::from),
                "view": view.map(|v| [f32::from(v.top()), f32::from(v.bottom())]),
                "cards": cards.iter().map(|(k, b)| json!([k, f32::from(b.left()), f32::from(b.top()), f32::from(b.bottom())])).collect::<Vec<_>>(),
            }),
        );
        // Back as it was: the extra threads gone, the layout restored.
        for thread in &threads {
            let thread = thread.clone();
            self.with_window(cx, move |shell, _, cx| {
                let bridge = shell.read(cx).overleaf.clone();
                bridge.update(cx, |bridge, cx| bridge.delete_thread(&thread, cx));
            })?;
        }
        let watched = editor.clone();
        let keys = wanted.clone();
        self.wait_for(cx, Duration::from_secs(10), move |_, cx| {
            let editor = watched.read(cx);
            !editor
                .margin_painted()
                .iter()
                .any(|(key, _)| keys.contains(key))
                && editor.margin_room() == 0
        })
        .await;
        self.frame_editor(cx, editor)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    /// Frame the editor's panel to the whole window, or restore it.
    fn frame_editor(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Result<()> {
        let editor = editor.clone();
        self.with_window(cx, move |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                if let Some(view) = shell.view_of_editor(&editor) {
                    shell.engine_do(cx, |engine| engine.focus_view(&view));
                }
                shell.run_trellis(Trellis::FrameToggle, cx);
            })
        })
    }
}
