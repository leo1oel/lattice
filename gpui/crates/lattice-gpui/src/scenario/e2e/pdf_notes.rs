//! The project's annotations on the compiled PDF (`pdf-annotations.tsx`): a
//! note made in chapters/intro.tex is drawn over the words it quotes where
//! SyncTeX puts its line, with its pin; a click on its highlight opens its
//! comment card, and Escape closes it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{
    AsyncApp, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    PlatformInput, Point, point, px,
};
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
        self.pdf_notes_stacked(cx, steps, &project, &store, &view, &text, start, &id)
            .await;
        cx.update(|cx| store.update(cx, |store, cx| store.delete(&project, &id, cx)));
        Ok(())
    }

    /// A second note starting on the same line: its pin stands beside the
    /// first one, outward from the column, and each pin opens its own card;
    /// a click off the pages closes the card, and the pointer leaving the
    /// pages unlights the note it lit.
    #[allow(clippy::too_many_arguments)]
    async fn pdf_notes_stacked(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        project: &Path,
        store: &gpui::Entity<store::AnnotationStore>,
        view: &gpui::Entity<crate::pdf::PdfView>,
        text: &str,
        start: usize,
        first: &str,
    ) {
        let send = |cx: &mut AsyncApp, input: PlatformInput| {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(input, cx);
            })
        };
        let click = |cx: &mut AsyncApp, at: Point<Pixels>| {
            send(
                cx,
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
            )
            .ok();
            send(
                cx,
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
            )
            .ok();
        };
        let hover = |cx: &mut AsyncApp, at: Point<Pixels>| {
            send(
                cx,
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: at,
                    pressed_button: None,
                    modifiers: Modifiers::default(),
                }),
            )
            .ok();
        };
        // "introduces", inside the first note's quote: the same line.
        let inner = "introduces";
        let from = start + text[start..].find(inner).unwrap_or(0);
        let second = cx
            .update(|cx| {
                let author = store::author(project, cx);
                let note = model::new_note(
                    "chapters/intro.tex",
                    text,
                    from,
                    from + inner.len(),
                    "Second.",
                    None,
                    &author,
                )?;
                store.update(cx, |store, cx| store.add(project, note, cx))
            })
            .unwrap_or_default();
        let placed = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                view.read(cx)
                    .note_places()
                    .iter()
                    .any(|(placed, _)| *placed == second)
            })
            .await;
        let pins = cx.update(|cx| {
            let view = view.read(cx);
            (view.note_pin_center(first), view.note_pin_center(&second))
        });
        let (mut beside, mut opens_second, mut opens_first) = (false, false, false);
        let (mut off_closes, mut lit, mut unlit) = (false, false, false);
        if let (Some(a), Some(b)) = pins {
            // Side by side on one row, apart by at least a pin (18px), the
            // later one farther from the text (left of the first, on this
            // single-column page).
            beside = (f32::from(a.y) - f32::from(b.y)).abs() < 1.
                && f32::from(a.x) - f32::from(b.x) >= 18.;
            click(cx, b);
            self.pause(cx, Duration::from_millis(300)).await;
            opens_second = cx.update(|cx| view.read(cx).note_card() == Some(second.as_str()));
            self.snapshot(cx, "pdf-note-stacked-pins").await;
            click(cx, a);
            self.pause(cx, Duration::from_millis(300)).await;
            opens_first = cx.update(|cx| view.read(cx).note_card() == Some(first));
            // Off the pages: left of the PDF's viewport, in the editor.
            let viewport = cx.update(|cx| view.read(cx).viewport_bounds());
            let off = point(viewport.origin.x - px(250.), viewport.center().y);
            click(cx, off);
            self.pause(cx, Duration::from_millis(300)).await;
            off_closes = cx.update(|cx| view.read(cx).note_card().is_none());
            hover(cx, a);
            self.pause(cx, Duration::from_millis(200)).await;
            lit = cx.update(|cx| view.read(cx).note_hovered() == Some(first));
            self.snapshot(cx, "pdf-note-hover-lit").await;
            hover(cx, off);
            self.pause(cx, Duration::from_millis(200)).await;
            unlit = cx.update(|cx| view.read(cx).note_hovered().is_none());
            self.snapshot(cx, "pdf-note-hover-left").await;
        }
        steps.check(
            "PDF: two notes on one line stand their pins side by side, each pin opens its own card, a click off the pages closes it, and leaving the pages unlights the note",
            placed && beside && opens_second && opens_first && off_closes && lit && unlit,
            json!({
                "placed": placed, "pins": format!("{pins:?}"), "beside": beside,
                "opens_second": opens_second, "opens_first": opens_first,
                "off_closes": off_closes, "lit": lit, "unlit": unlit,
            }),
        );
        cx.update(|cx| store.update(cx, |store, cx| store.delete(project, &second, cx)));
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
