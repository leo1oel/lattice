//! The project's annotations on the compiled PDF (`pdf-annotations.tsx`): a
//! note made in chapters/intro.tex is drawn over the words it quotes where
//! SyncTeX puts its line, with its pin; a click on its highlight opens its
//! comment card, and Escape closes it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput};
use serde_json::json;

use super::Steps;
use crate::{
    annotations::{model, store},
    scenario::Run,
};

impl Run {
    async fn pdf_notes(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let path = "chapters/intro.tex";
        let text = std::fs::read_to_string(root.join(path))?;
        // Words earlier steps leave as they are.
        let quote = "paragraph introduces the document";
        let Some(start) = text.find(quote) else {
            steps.check(
                "PDF: a note made in the source is drawn on the PDF",
                false,
                json!({ "quote": false }),
            );
            return Ok(());
        };
        let store = cx.update(store::store);
        let shell_root = cx.update(|cx| self.shell.read(cx).root(cx));
        let Some(project) = shell_root else {
            steps.check(
                "PDF: a note made in the source is drawn on the PDF",
                false,
                json!({ "project": false }),
            );
            return Ok(());
        };
        cx.update(|cx| store.update(cx, |store, cx| store.ensure(&project, cx)));
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            store.read(cx).loaded(&project)
        })
        .await;
        let id = cx.update(|cx| {
            let author = store::author(&project, cx);
            let note = model::new_note(
                path,
                &text,
                start,
                start + quote.len(),
                "Tighten this.",
                None,
                &author,
            )?;
            store.update(cx, |store, cx| store.add(&project, note, cx))
        });
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let id = id.unwrap_or_default();
        let placed = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                view.read(cx)
                    .note_places()
                    .iter()
                    .any(|(placed, _)| *placed == id)
            })
            .await;
        let place = cx.update(|cx| {
            view.read(cx)
                .note_places()
                .into_iter()
                .find(|(placed, _)| *placed == id)
                .map(|(_, place)| place)
        });
        self.snapshot(cx, "pdf-note-mark").await;
        let mut opened = false;
        let mut closed = false;
        if let Some(at) = cx.update(|cx| view.read(cx).note_center(&id)) {
            let send = |cx: &mut AsyncApp, input: PlatformInput| {
                self.with_window(cx, move |_, window, cx| {
                    window.dispatch_event(input, cx);
                })
            };
            send(
                cx,
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
            )?;
            send(
                cx,
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
            )?;
            self.pause(cx, Duration::from_millis(400)).await;
            opened = cx.update(|cx| view.read(cx).note_card() == Some(id.as_str()));
            self.snapshot(cx, "pdf-note-card").await;
            self.press(cx, '\u{1b}', false).await.ok();
            self.pause(cx, Duration::from_millis(300)).await;
            closed = cx.update(|cx| view.read(cx).note_card().is_none());
        }
        steps.check(
            "PDF: a note made in the source is drawn over its words on the PDF, its card opens on a click and Escape closes it",
            // One line, over its own words: narrower than the line.
            placed
                && place.as_ref().is_some_and(|place| place.bands.len() == 1 && place.bands[0].width < 0.5)
                && opened
                && closed,
            json!({ "id": id, "placed": placed, "place": format!("{place:?}"), "opened": opened, "closed": closed }),
        );
        cx.update(|cx| store.update(cx, |store, cx| store.delete(&project, &id, cx)));
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_notes`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 50,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/annotation_place.rs",
        "gpui/crates/lattice-gpui/src/pdf/view/notes.rs",
        "gpui/crates/lattice-gpui/src/shell/pdf_notes.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_notes(cx, steps, &fixture.root)),
};
