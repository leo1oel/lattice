//! The e2e checks of margin review (`editor_panel::margin_review`), with
//! main.tex live and a comment and a suggestion on it: in this window the
//! editor has no room for a card beside the measure, so they show as
//! markers, a pip each in the lane at the text's right, and a pip's card
//! opens over it under the pointer; Off takes them away.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::super::Steps;
use crate::{
    editor_panel::{EditorPanel, MarginLayout, MarginMode},
    scenario::Run,
};

impl Run {
    pub(super) async fn overleaf_margin_review(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
        thread: &str,
    ) -> Result<()> {
        let watched = editor.clone();
        let comment_key = format!("comment:{thread}");
        let wanted = comment_key.clone();
        let markers = self
            .wait_for(cx, Duration::from_secs(10), move |_, cx| {
                let editor = watched.read(cx);
                matches!(
                    editor.margin_layout(),
                    Some(MarginLayout::Markers | MarginLayout::Wide)
                ) && editor
                    .margin_painted()
                    .iter()
                    .any(|(key, _)| *key == wanted)
                    && editor
                        .margin_painted()
                        .iter()
                        .any(|(key, _)| key.starts_with("change:"))
            })
            .await;
        let (layout, painted) = cx.update(|cx| {
            let editor = editor.read(cx);
            (editor.margin_layout(), editor.margin_painted())
        });
        // The comment's pip opens its card under the pointer.
        let pip = painted
            .iter()
            .find(|(key, _)| *key == comment_key)
            .map(|(_, bounds)| *bounds);
        let mut opened = layout == Some(MarginLayout::Wide);
        if let (Some(pip), Some(MarginLayout::Markers)) = (pip, layout) {
            let _front = self.focused(cx, "margin review").await?;
            self.hover_at(cx, pip.center()).await?;
            let watched = editor.clone();
            let wanted = comment_key.clone();
            opened = self
                .wait_for(cx, Duration::from_secs(3), move |_, cx| {
                    watched.read(cx).margin_open() == Some(wanted.as_str())
                })
                .await;
            self.adapter_shot(cx, "overleaf-margin-markers").await;
        }
        steps.check(
            "margin review shows the comment and the suggestion beside their lines, and a pip opens its card",
            markers && opened,
            json!({ "layout": format!("{layout:?}"), "painted": format!("{painted:?}"), "opened": opened }),
        );
        // Off: nothing in the margin; then Auto again.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.set_margin_mode(MarginMode::Off, cx))
        })?;
        let watched = editor.clone();
        let off = self
            .wait_for(cx, Duration::from_secs(5), move |_, cx| {
                watched.read(cx).margin_layout().is_none()
            })
            .await;
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.set_margin_mode(MarginMode::Auto, cx))
        })?;
        steps.check(
            "margin review: Off takes it away",
            off,
            json!({ "off": off }),
        );
        Ok(())
    }
}
