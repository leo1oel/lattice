//! The e2e checks of review drawn in the source
//! (`editor_panel::overleaf_review`): a comment's passage and a suggested
//! insertion marked, a suggested deletion's text struck through at its
//! point, and the card a suggestion opens under the pointer.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const LAYER: &str = "overleaf-review";

impl Run {
    /// `main.tex` is live with a suggested insertion of `inserted` and a
    /// comment on `quote`: both are marked, and the suggestion's card opens
    /// under the pointer, naming its author, with Accept and Reject.
    pub(super) async fn overleaf_review_marks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
        inserted: &str,
        quote: &str,
    ) -> Result<()> {
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let watched = lattice.clone();
        let wanted = [inserted.to_string(), quote.to_string()];
        let editor_wait = editor.clone();
        let marked = self
            .wait_for(cx, Duration::from_secs(10), move |_, cx| {
                let text = editor_wait.read(cx).overleaf_text(cx);
                let ranges = watched.read(cx).mark_ranges(LAYER, cx);
                wanted.iter().all(|want| {
                    ranges
                        .iter()
                        .any(|range| text.get(range.clone()) == Some(want.as_str()))
                })
            })
            .await;
        let ranges = cx.update(|cx| lattice.read(cx).mark_ranges(LAYER, cx));
        let _front = self.focused(cx, "overleaf review marks").await?;
        let (_, at) = self.text_point(cx, editor, &lattice, inserted, 2).await?;
        self.hover_at(cx, at.center()).await?;
        let card = self
            .wait_for_card(cx, &lattice, "overleaf-suggestion")
            .await;
        self.adapter_shot(cx, "overleaf-suggestion-card").await;
        let text = self.editor_text(cx, editor);
        let covers = card
            .as_ref()
            .is_some_and(|(range, _)| text.get(range.clone()) == Some(inserted));
        steps.check(
            "a comment's passage and a suggested insertion are marked in the source, and the suggestion's card opens under the pointer",
            marked && covers,
            json!({ "marked": marked, "ranges": format!("{ranges:?}"), "card": card.map(|(range, bounds)| format!("{range:?} {bounds:?}")) }),
        );
        Ok(())
    }

    /// A suggested deletion of `removed` at its point is shown there, its
    /// text struck through: an inline text starting where the caret at the
    /// point stands, as wide as the text.
    pub(super) async fn overleaf_deletion_drawn(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
        removed: &str,
    ) -> Result<()> {
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let watched = lattice.clone();
        let drawn = self
            .wait_for(cx, Duration::from_secs(10), move |_, cx| {
                watched
                    .read(cx)
                    .painted()
                    .inline
                    .iter()
                    .any(|(layer, _, bounds)| *layer == LAYER && bounds.size.width > gpui::px(0.))
            })
            .await;
        let painted = cx.update(|cx| lattice.read(cx).painted().inline.clone());
        self.adapter_shot(cx, "overleaf-suggested-deletion").await;
        let at_point = match painted.first() {
            Some((_, offset, bounds)) => {
                let offset = *offset;
                let lattice = lattice.clone();
                let caret = self.with_window(cx, move |_, window, cx| {
                    lattice.update(cx, |lattice, cx| lattice.offset_bounds(offset, window, cx))
                })?;
                caret.is_some_and(|caret| (caret.left() - bounds.left()).abs() < gpui::px(1.))
            }
            None => false,
        };
        // It takes room as the removed text would: some pixels a character.
        let width = painted
            .first()
            .map(|(_, _, bounds)| f32::from(bounds.size.width));
        let line = cx.update(|cx| lattice.read(cx).painted().line_height.map(f32::from));
        let wide = width.is_some_and(|width| width > removed.chars().count() as f32 * 3.);
        steps.check(
            "a suggested deletion's text is shown at its point, struck through",
            drawn && at_point && wide,
            json!({ "drawn": drawn, "at_point": at_point, "width": width, "line_height": line, "painted": format!("{painted:?}") }),
        );
        Ok(())
    }
}
