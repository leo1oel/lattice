//! The e2e checks of the Overleaf collaboration panel (`overleaf::collab`),
//! with main.tex live: it opens as the window's comments view and lists the
//! collaborator's thread and suggestion; and a comment started on the
//! selection ("Annotate selection"), typed with native keys and sent with
//! Enter, is posted and anchored on Overleaf.

use std::time::Duration;

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::super::Steps;
use crate::{
    editor_panel::EditorPanel,
    overleaf::collab::CollabTab,
    scenario::{Run, overleaf_mock::MockOverleaf},
};

impl Run {
    /// The panel opens and shows what the collaborator left.
    pub(super) async fn overleaf_review_panel(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_overleaf_collab(Some(CollabTab::Comments), window, cx)
            })
        })?;
        let shown = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).view_on_screen("comments", cx)
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.review_shot(cx, "overleaf-collab-comments").await;
        self.with_window(cx, |shell, _, cx| {
            let panel = shell.read(cx).overleaf_collab.clone();
            panel.update(cx, |panel, cx| panel.set_tab(CollabTab::Suggestions, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        self.review_shot(cx, "overleaf-collab-suggestions").await;
        self.with_window(cx, |shell, _, cx| {
            let panel = shell.read(cx).overleaf_collab.clone();
            panel.update(cx, |panel, cx| panel.set_tab(CollabTab::Comments, cx))
        })?;
        steps.check(
            "the Overleaf collaboration panel opens as the window's comments view",
            shown,
            json!({ "shown": shown }),
        );
        Ok(())
    }

    /// A comment started on the selection, typed and sent with Enter.
    pub(super) async fn overleaf_annotate(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
        editor: &Entity<EditorPanel>,
        quote: &str,
        note: &str,
    ) -> Result<()> {
        let text = self.editor_text(cx, editor);
        let Some(start) = text.find(quote) else {
            steps.check(
                "a comment typed on the selection reaches Overleaf",
                false,
                json!({ "text": text }),
            );
            return Ok(());
        };
        let end = start + quote.len();
        let zed = cx.update(|cx| editor.read(cx).editor().clone());
        self.with_window(cx, |_, window, cx| {
            zed.update(cx, |zed, cx| {
                zed.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(start)..editor::MultiBufferOffset(end)
                    ])
                })
            })
        })?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.annotate_selection(window, cx))
        })?;
        let composing = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).overleaf_collab.read(cx).composing_comment()
            })
            .await;
        {
            let _front = self.focused(cx, "overleaf annotate").await?;
            self.type_text(cx, note).await?;
            self.press(cx, '\n', false).await?;
        }
        let anchored = self
            .wait_for(cx, Duration::from_secs(15), |_, _| {
                mock.comments("main.tex").iter().any(|range| {
                    range.quote == quote
                        && mock
                            .thread(&range.thread_id)
                            .is_some_and(|(messages, _)| messages.iter().any(|m| m == note))
                })
            })
            .await;
        self.review_shot(cx, "overleaf-collab-new-comment").await;
        steps.check(
            "a comment typed on the selection (Annotate selection, Enter) is posted and anchored on Overleaf",
            composing && anchored && mock.rejected().is_empty(),
            json!({ "composing": composing, "anchored": anchored, "comments": mock.comments("main.tex") }),
        );
        Ok(())
    }

    async fn review_shot(&self, cx: &mut AsyncApp, name: &str) {
        self.adapter_shot(cx, name).await;
    }
}
