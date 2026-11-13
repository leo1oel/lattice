//! A `.bib` file's visual form, on the project's own bibliography: Preview
//! lists its references, a click brings one to the front with its fields,
//! a field written in the form lands in the file's text (the source
//! editor's buffer) and ⌘Z in the form steps it back; Split shows the
//! source beside the list. With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves
//! Preview and Split for a look review.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{editor_panel::DocumentView, scenario::Run};

impl Run {
    pub(super) async fn bib_visual_editor(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("references.bib"), None)?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_document_view(DocumentView::Preview, window, cx)
            })
        })?;
        let listed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                editor
                    .read(cx)
                    .bib_editor()
                    .is_some_and(|bib| bib.read(cx).keys().contains(&"knuth1984".to_string()))
            })
            .await;
        let Some(bib) = cx.update(|cx| editor.read(cx).bib_editor().cloned()) else {
            steps.check(
                "a .bib file's Preview lists its references",
                false,
                json!({ "listed": listed }),
            );
            return Ok(());
        };
        cx.update(|cx| bib.update(cx, |bib, cx| bib.pick("knuth1984", cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        let front = cx.update(|cx| bib.read(cx).selected_key().map(str::to_string));
        steps.check(
            "a .bib file's Preview lists its references and a click brings one to the front",
            listed && front.as_deref() == Some("knuth1984"),
            json!({ "listed": listed, "front": front }),
        );
        self.papers_shot(cx, "bib-1-preview").await;

        // The form writes into the source editor's buffer; ⌘Z in the form
        // steps the file back.
        let before = self.editor_text(cx, &editor);
        let written = cx
            .update(|cx| bib.update(cx, |bib, cx| bib.set_field("knuth1984", "year", "1986", cx)));
        let after = self.editor_text(cx, &editor);
        self.with_window(cx, |_, window, cx| {
            let focus = gpui::Focusable::focus_handle(bib.read(cx), cx);
            window.focus(&focus, cx);
        })?;
        self.press(cx, 'z', true).await?;
        let undone = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                editor.read(cx).editor().read(cx).text(cx) == before
            })
            .await;
        steps.check(
            "a field written in the .bib form lands in the source, and ⌘Z steps it back",
            written && after.contains("year = {1986}") && !before.contains("1986") && undone,
            json!({ "written": written, "landed": after.contains("year = {1986}"), "undone": undone }),
        );

        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_document_view(DocumentView::Split, window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.papers_shot(cx, "bib-2-split").await;
        let split = cx.update(|cx| {
            editor.read(cx).document_view() == Some(DocumentView::Split)
                && editor.read(cx).bib_editor().is_some()
        });
        steps.check(
            "Split shows the .bib source beside its list",
            split,
            json!({ "split": split }),
        );
        // The next bibliography opens in the source again.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_document_view(DocumentView::Source, window, cx)
            })
        })?;
        self.press(cx, 'w', true).await?;
        // The writer goes back to the manuscript, as the steps after expect.
        self.open(cx, &root.join("main.tex"), None)?;
        Ok(())
    }
}
