//! Annotating a PDF selection (`pdf-annotations.tsx`'s Annotate offer and
//! `pdf-annotation-composer.tsx`): a drag over words of chapters/intro.tex
//! on the live PDF offers Annotate under the selection's end; choosing it
//! opens the note, which SyncTeX places in chapters/intro.tex; ⌘↵ saves it
//! as an annotation on those words, kept where on the page it was made and
//! drawn there. A second note with words in it, closed with Escape, leaves.

use std::time::Duration;

use anyhow::Result;
use gpui::{
    AsyncApp, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    PlatformInput, Point,
};
use serde_json::json;

use super::Steps;
use crate::{annotations::store, scenario::Run};

/// Words of the fixture's introduction that earlier modules leave as they are.
const WORDS: &str = "paragraph introduces";

impl Run {
    async fn pdf_annotate(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        const STEP: &str = "PDF: a selection offers Annotate, its note is placed in the source by SyncTeX, and ⌘↵ saves it on those words, drawn where it was made";
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let Some(project) = cx.update(|cx| self.shell.read(cx).root(cx)) else {
            steps.check(STEP, false, json!({ "project": false }));
            return Ok(());
        };
        let store = cx.update(store::store);
        cx.update(|cx| store.update(cx, |store, cx| store.ensure(&project, cx)));
        let found = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                view.read(cx).text_span_points(0, WORDS).is_some()
            })
            .await;
        let Some((from, to)) = cx.update(|cx| view.read(cx).text_span_points(0, WORDS)) else {
            steps.check(STEP, false, json!({ "words": found }));
            return Ok(());
        };
        let before: Vec<String> = cx.update(|cx| {
            store
                .read(cx)
                .annotations(&project)
                .iter()
                .map(|note| note.id.clone())
                .collect()
        });
        self.select_pdf_words(cx, from, to)?;
        let offered = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                view.read(cx).offer_shown()
            })
            .await;
        self.snapshot(cx, "pdf-annotate-offer").await;
        let at = cx.update(|cx| view.read(cx).annotate_offer_center());
        if let Some(at) = at {
            self.click_at(cx, at)?;
        }
        let mapped = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                view.read(cx)
                    .annotate_composer_state()
                    .is_some_and(|(mapped, error)| mapped.is_some() || error.is_some())
            })
            .await;
        let state = cx.update(|cx| view.read(cx).annotate_composer_state());
        self.with_window(cx, {
            let view = view.clone();
            move |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.annotate_composer_write("Say what it introduces.", window, cx);
                    cx.notify();
                })
            }
        })?;
        self.snapshot(cx, "pdf-annotate-composer").await;
        self.dispatch_keys(cx, "cmd-enter")?;
        let saved = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                store
                    .read(cx)
                    .annotations(&project)
                    .iter()
                    .any(|note| !before.contains(&note.id))
            })
            .await;
        let note = cx.update(|cx| {
            store
                .read(cx)
                .annotations(&project)
                .into_iter()
                .find(|note| !before.contains(&note.id))
                .cloned()
        });
        let id = note
            .as_ref()
            .map(|note| note.id.clone())
            .unwrap_or_default();
        let drawn = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                view.read(cx)
                    .note_places()
                    .iter()
                    .any(|(placed, place)| *placed == id && place.page == 0)
            })
            .await;
        self.snapshot(cx, "pdf-annotate-saved").await;
        let closed = cx.update(|cx| view.read(cx).annotate_composer_state().is_none());
        let on_words = note.as_ref().is_some_and(|note| {
            note.path == "chapters/intro.tex"
                && note.quote.contains(WORDS)
                && note.body == "Say what it introduces."
                && note.pdf.as_ref().is_some_and(|pdf| {
                    pdf.page == 1 && !pdf.rects.is_empty() && pdf.text.contains(WORDS)
                })
        });
        steps.check(
            STEP,
            offered && mapped && saved && closed && drawn && on_words
                && state.as_ref().is_some_and(|(mapped, _)| {
                    mapped.as_ref().is_some_and(|(path, _)| path == "chapters/intro.tex")
                }),
            json!({
                "offered": offered, "mapped": mapped, "state": format!("{state:?}"),
                "saved": saved, "closed": closed, "drawn": drawn,
                "note": note.as_ref().map(|note| json!({
                    "path": note.path, "quote": note.quote, "body": note.body,
                    "pdf": note.pdf.as_ref().map(|pdf| json!({ "page": pdf.page, "rects": pdf.rects.len(), "text": pdf.text })),
                })),
            }),
        );
        if !id.is_empty() {
            cx.update(|cx| store.update(cx, |store, cx| store.delete(&project, &id, cx)));
        }
        self.pdf_annotate_discarded(cx, steps, &view, from, to)
            .await
    }

    /// A note with words in it, closed with Escape, leaves the PDF.
    async fn pdf_annotate_discarded(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        view: &gpui::Entity<crate::pdf::PdfView>,
        from: Point<Pixels>,
        to: Point<Pixels>,
    ) -> Result<()> {
        self.select_pdf_words(cx, from, to)?;
        let offered = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                view.read(cx).offer_shown()
            })
            .await;
        if let Some(at) = cx.update(|cx| view.read(cx).annotate_offer_center()) {
            self.click_at(cx, at)?;
        }
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                view.read(cx).annotate_composer_state().is_some()
            })
            .await;
        self.with_window(cx, {
            let view = view.clone();
            move |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.annotate_composer_write("Draft.", window, cx)
                })
            }
        })?;
        self.dispatch_keys(cx, "escape")?;
        self.pause(cx, Duration::from_millis(300)).await;
        let closed = cx.update(|cx| view.read(cx).annotate_composer_state().is_none());
        // A press on the pages takes a fresh offer away.
        self.select_pdf_words(cx, from, to)?;
        let again = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                view.read(cx).offer_shown()
            })
            .await;
        self.click_at(cx, from)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let withdrawn = cx.update(|cx| !view.read(cx).offer_shown());
        steps.check(
            "PDF: a note closed with Escape leaves, and a press on the pages takes Annotate away",
            offered && opened && closed && again && withdrawn,
            json!({ "offered": offered, "opened": opened, "closed": closed, "again": again, "withdrawn": withdrawn }),
        );
        Ok(())
    }

    /// A drag on the PDF from `from` to `to`, as the pointer selects text.
    pub(super) fn select_pdf_words(
        &self,
        cx: &mut AsyncApp,
        from: Point<Pixels>,
        to: Point<Pixels>,
    ) -> Result<()> {
        let mut events = vec![PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position: from,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        })];
        for step in 1..=8 {
            let t = step as f32 / 8.;
            events.push(PlatformInput::MouseMove(MouseMoveEvent {
                position: gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t),
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::default(),
            }));
        }
        events.push(PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position: to,
            modifiers: Modifiers::default(),
            click_count: 1,
        }));
        for event in events {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(event, cx);
            })?;
        }
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_annotate`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 51,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/view/annotate.rs",
        "gpui/crates/lattice-gpui/src/pdf/source_anchor.rs",
        "gpui/crates/lattice-gpui/src/annotations/form.rs",
    ],
    run: |run, cx, steps, _| Box::pin(run.pdf_annotate(cx, steps)),
};
