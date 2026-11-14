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
    /// point stands, as wide as the text, with the text after it moved on.
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
        // Shaped on its own in the editor's text style, the removed text is
        // as wide as the band, and the real text after the point starts
        // where the band ends: Zed laid the inlay out there, pushing it on.
        let measured = match painted.first() {
            Some((_, offset, bounds)) => {
                let (offset, bounds) = (*offset, *bounds);
                let (lattice, editor, removed) =
                    (lattice.clone(), editor.clone(), removed.to_string());
                self.with_window(cx, move |_, window, cx| {
                    let text = editor.read(cx).overleaf_text(cx);
                    let next = text.get(offset..).and_then(|rest| rest.chars().next())?;
                    let zed = lattice.read(cx).editor().clone();
                    let style = zed.update(cx, |zed, cx| zed.style(cx).text.clone());
                    let shaped =
                        lattice_editor::inline_texts::text_width(&removed, &style, window, cx);
                    let next_width = lattice_editor::inline_texts::text_width(
                        &next.to_string(),
                        &style,
                        window,
                        cx,
                    );
                    let caret = lattice
                        .update(cx, |lattice, cx| lattice.offset_bounds(offset, window, cx))?;
                    let after = lattice.update(cx, |lattice, cx| {
                        lattice.offset_bounds(offset + next.len_utf8(), window, cx)
                    })?;
                    Some((bounds, caret, after, shaped, next_width))
                })?
            }
            None => None,
        };
        let close = |a: gpui::Pixels, b: gpui::Pixels| (a - b).abs() < gpui::px(1.5);
        let at_point =
            measured.is_some_and(|(bounds, caret, _, _, _)| close(caret.left(), bounds.left()));
        let as_wide =
            measured.is_some_and(|(bounds, _, _, shaped, _)| close(bounds.size.width, shaped));
        let pushes_next = measured.is_some_and(|(bounds, caret, after, _, next_width)| {
            after.top() == caret.top() && close(after.left(), bounds.right() + next_width)
        });
        let line = cx.update(|cx| lattice.read(cx).painted().line_height.map(f32::from));
        steps.check(
            "a suggested deletion's text is shown at its point, struck through",
            drawn && at_point && as_wide && pushes_next,
            json!({
                "drawn": drawn,
                "at_point": at_point,
                "as_wide": as_wide,
                "pushes_next": pushes_next,
                "measured": format!("{measured:?}"),
                "line_height": line,
                "painted": format!("{painted:?}"),
            }),
        );
        Ok(())
    }
}
