//! The e2e check of margin review in a `.tex` file's Visual view
//! (`gpui/islands/latex/margin-review.tsx`): with main.tex live and a
//! collaborator's comment on it, choosing Visual shows the thread's passage
//! marked in the page, and its margin review item (a card in the wide
//! layout, a pip in the markers one) beside the text, as the source shows
//! them, and the collaborator's tracked change marked there too. Source is
//! chosen again after, for the checks that follow.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_settings::LatexView;
use serde_json::{Value, json};

use super::super::Steps;
use crate::{
    editor_panel::{EditorPanel, choose_latex_view},
    scenario::Run,
};

impl Run {
    pub(super) async fn overleaf_margin_visual(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
        thread: &str,
        quote: &str,
    ) -> Result<()> {
        cx.update(|cx| choose_latex_view(LatexView::Visual, cx));
        let watched = editor.clone();
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), move |_, cx| {
                watched
                    .read(cx)
                    .latex_visual_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let island = cx.update(|cx| {
            editor
                .read(cx)
                .latex_visual_document()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let probe = format!(
            "JSON.stringify({{ \
             mark: document.querySelector('.cm-editor-comment[data-comment-id={id:?}]')?.textContent ?? null, \
             items: document.querySelectorAll('.margin-review-card, .margin-review-pip').length, \
             suggested: document.querySelectorAll('.cm-tracked-change-insert, .cm-tracked-change-delete').length, \
             layout: document.querySelector('.source-editor')?.getAttribute('data-margin-review') ?? null }})",
            id = format!("overleaf:{thread}"),
        );
        let mut facts = Value::Null;
        if let Some(island) = island.filter(|_| drawn) {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(15) {
                facts = self.evaluate(cx, &island, &probe).await;
                if facts["mark"].is_string()
                    && facts["items"].as_u64().is_some_and(|items| items > 0)
                    && facts["suggested"].as_u64().is_some_and(|marks| marks > 0)
                {
                    break;
                }
                self.pause(cx, Duration::from_millis(250)).await;
            }
            self.window_shots(cx, "overleaf-margin-visual").await?;
        }
        steps.check(
            "in a .tex file's Visual view, a collaborator's Overleaf comment is marked over its passage and shown in margin review beside the text, as in the source",
            drawn
                && facts["mark"].as_str().is_some_and(|mark| mark.contains(quote))
                && facts["items"].as_u64().is_some_and(|items| items > 0)
                && facts["layout"].is_string(),
            json!({ "drawn": drawn, "page": facts }),
        );
        steps.check(
            "in a .tex file's Visual view, a collaborator's Overleaf suggestion is marked as in the source",
            drawn && facts["suggested"].as_u64().is_some_and(|marks| marks > 0),
            json!({ "drawn": drawn, "suggested": facts["suggested"] }),
        );
        cx.update(|cx| choose_latex_view(LatexView::Source, cx));
        let watched = editor.clone();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            watched.read(cx).latex_view(cx) == Some(LatexView::Source)
        })
        .await;
        Ok(())
    }
}
