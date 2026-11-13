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
    /// Focus the form's box for `field`, select what it holds, type `text`
    /// and leave the box for the list, as a writer would; false when the
    /// form has no such box.
    async fn type_into_field(
        &self,
        cx: &mut AsyncApp,
        bib: &gpui::Entity<crate::papers::bib_editor::BibEditor>,
        field: &str,
        text: &str,
    ) -> Result<bool> {
        let Some(focus) = cx.update(|cx| bib.read(cx).field_focus(field, cx)) else {
            return Ok(false);
        };
        self.with_window(cx, |_, window, cx| window.focus(&focus, cx))?;
        self.press(cx, 'a', true).await?;
        self.type_text(cx, text).await?;
        self.with_window(cx, |_, window, cx| {
            let list = gpui::Focusable::focus_handle(bib.read(cx), cx);
            window.focus(&list, cx);
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        Ok(true)
    }

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
        // The form's boxes hold the entry as the fixture writes it.
        let fields = cx.update(|cx| bib.read(cx).form_fields(cx));
        let expected: Vec<(String, String)> = [
            ("title", "The TeXbook"),
            ("author", "Knuth, Donald E."),
            ("publisher", "Addison-Wesley"),
            ("year", "1984"),
        ]
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        steps.check(
            "a .bib file's Preview lists its references and brings one to the front with its fields",
            listed && front.as_deref() == Some("knuth1984") && fields == expected,
            json!({ "listed": listed, "front": front, "fields": fields }),
        );
        self.papers_shot(cx, "bib-1-preview").await;

        // A value typed into the form's year box lands in the source editor's
        // buffer when the box is left; ⌘Z in the form steps the file back.
        let before = self.editor_text(cx, &editor);
        let typed = self.type_into_field(cx, &bib, "year", "1986").await?;
        let after = self.editor_text(cx, &editor);
        self.press(cx, 'z', true).await?;
        let undone = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                editor.read(cx).editor().read(cx).text(cx) == before
            })
            .await;
        steps.check(
            "a field typed in the .bib form lands in the source, and ⌘Z steps it back",
            typed
                && after == before.replace("year = {1984}", "year = {1986}")
                && before.contains("year = {1984}")
                && undone,
            json!({ "typed": typed, "landed": after.contains("year = {1986}"), "undone": undone }),
        );
        // Written, then typed back to what the file first held: the second
        // write lands too.
        let mut retyped = self.type_into_field(cx, &bib, "year", "1986").await?;
        let changed = self.editor_text(cx, &editor);
        retyped &= self.type_into_field(cx, &bib, "year", "1984").await?;
        let back = self.editor_text(cx, &editor);
        steps.check(
            "a field typed back to its first value in the .bib form is written back",
            retyped && changed.contains("year = {1986}") && back == before,
            json!({ "retyped": retyped, "changed": changed.contains("year = {1986}"), "back": back == before }),
        );

        // Alone, the form spans the panel; beside the source it is laid out
        // narrower, the source taking the rest.
        let alone = cx.update(|cx| bib.read(cx).laid_out_width());
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_document_view(DocumentView::Split, window, cx)
            })
        })?;
        let split = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                let beside = bib.read(cx).laid_out_width();
                beside > 0. && beside < alone - 100.
            })
            .await;
        self.papers_shot(cx, "bib-2-split").await;
        let beside = cx.update(|cx| bib.read(cx).laid_out_width());
        steps.check(
            "Split shows the .bib source beside its list",
            alone > 0. && split,
            json!({ "alone": alone, "beside": beside }),
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
