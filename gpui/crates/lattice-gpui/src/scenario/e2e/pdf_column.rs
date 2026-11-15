//! The PDF's comment column and a passage's preview (`pdf-comment-column.tsx`,
//! `use-pdf-comment-column.ts`, `PdfCommentPreview`): with a note on words of
//! chapters/intro.tex drawn on the live PDF, the narrow PDF panel keeps the
//! column folded behind its count, and resting the pointer on the passage
//! previews the note; opened, the column lists the note's card, a click on it
//! opens the full card in place and Escape closes it. With the PDF beside the
//! document in focus mode, wide enough, the column docks beside the pages,
//! its card level with the note's pin, and the pages give it their width.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, MouseMoveEvent, PlatformInput, point, px};
use serde_json::json;

use super::Steps;
use crate::{
    annotations::{model, store},
    scenario::Run,
};

/// Words of the fixture's introduction that earlier modules leave as they are.
const WORDS: &str = "paragraph introduces the document";

impl Run {
    async fn pdf_column(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        const FOLDED: &str = "PDF: on a narrow PDF the comment column is folded behind its count, a passage previews its note after a rest, and the opened column's card opens in place on a click and closes on Escape";
        const DOCKED: &str = "PDF: wide enough, the comment column docks beside the pages, which give it their width, its card level with the note's pin";
        let path = "chapters/intro.tex";
        let text = std::fs::read_to_string(root.join(path))?;
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let (Some(start), Some(project)) = (
            text.find(WORDS),
            cx.update(|cx| self.shell.read(cx).root(cx)),
        ) else {
            steps.check(FOLDED, false, json!({ "fixture": false }));
            steps.check(DOCKED, false, json!({ "fixture": false }));
            return Ok(());
        };
        let store = cx.update(store::store);
        cx.update(|cx| store.update(cx, |store, cx| store.ensure(&project, cx)));
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            store.read(cx).loaded(&project)
        })
        .await;
        let id = cx
            .update(|cx| {
                let author = store::author(&project, cx);
                let note = model::new_note(
                    path,
                    &text,
                    start,
                    start + WORDS.len(),
                    "Name what it introduces.",
                    None,
                    &author,
                )?;
                store.update(cx, |store, cx| store.add(&project, note, cx))
            })
            .unwrap_or_default();
        let placed = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                view.read(cx)
                    .note_places()
                    .iter()
                    .any(|(placed, _)| *placed == id)
            })
            .await;
        // The live PDF beside the editor is narrower than a docked column needs.
        let folded = cx.update(|cx| view.read(cx).comment_column_layout().is_none());
        let rest = cx.update(|cx| view.read(cx).note_center(&id));
        let mut previewed = false;
        if let Some(at) = rest {
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: at,
                        pressed_button: None,
                        modifiers: Modifiers::default(),
                    }),
                    cx,
                );
            })?;
            previewed = self
                .wait_for(cx, Duration::from_secs(3), |_, cx| {
                    view.read(cx).note_preview() == Some(id.as_str())
                })
                .await;
            self.snapshot(cx, "pdf-note-preview").await;
            self.with_window(cx, move |_, window, cx| {
                window.dispatch_event(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: point(px(4.), px(4.)),
                        pressed_button: None,
                        modifiers: Modifiers::default(),
                    }),
                    cx,
                );
            })?;
        }
        self.with_window(cx, {
            let view = view.clone();
            move |_, _, cx| view.update(cx, |view, cx| view.choose_comment_column(true, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        let over = cx.update(|cx| view.read(cx).comment_column_layout());
        let slot = cx.update(|cx| view.read(cx).comment_slot(&id));
        self.snapshot(cx, "pdf-column-folded-open").await;
        let mut opened = false;
        if let Some(slot) = slot {
            self.click_at(cx, slot.center())?;
            opened = self
                .wait_for(cx, Duration::from_secs(2), |_, cx| {
                    view.read(cx).note_card() == Some(id.as_str())
                })
                .await;
            self.snapshot(cx, "pdf-column-card-open").await;
        }
        self.dispatch_keys(cx, "escape")?;
        self.pause(cx, Duration::from_millis(300)).await;
        let closed = cx.update(|cx| view.read(cx).note_card().is_none());
        steps.check(
            FOLDED,
            placed
                && folded
                && previewed
                && over.is_some_and(|over| !over.docked)
                && opened
                && closed,
            json!({
                "placed": placed, "folded": folded, "previewed": previewed,
                "over": format!("{over:?}"), "slot": format!("{slot:?}"),
                "opened": opened, "closed": closed,
            }),
        );
        self.pdf_column_docked(cx, steps, &view, &id).await?;
        cx.update(|cx| store.update(cx, |store, cx| store.delete(&project, &id, cx)));
        Ok(())
    }

    /// In focus mode with the PDF beside the document, the column docks.
    async fn pdf_column_docked(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        view: &gpui::Entity<crate::pdf::PdfView>,
        id: &str,
    ) -> Result<()> {
        const DOCKED: &str = "PDF: wide enough, the comment column docks beside the pages, which give it their width, its card level with the note's pin";
        let pdf_before =
            cx.update(|cx| crate::shell::workspaces::Workspaces::global(cx).focus_pdf());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.set_focus_mode(true, window, cx);
                shell.set_focus_pdf(true, window, cx);
            })
        })?;
        let docked = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                view.read(cx)
                    .comment_column_layout()
                    .is_some_and(|layout| layout.docked)
            })
            .await;
        self.pause(cx, Duration::from_millis(600)).await;
        let (layout, slot, pin, column) = cx.update(|cx| {
            let view = view.read(cx);
            (
                view.comment_column_layout(),
                view.comment_slot(id),
                view.note_pin_center(id),
                view.comment_column_center(),
            )
        });
        self.snapshot(cx, "pdf-column-docked").await;
        // The preview's meta line (its top padding and half its 20px row)
        // stands level with the pin.
        let level = match (slot, pin) {
            (Some(slot), Some(pin)) => ((slot.top() + px(18.)) - pin.y).abs() < px(4.),
            _ => false,
        };
        // Beside the pages: the column is right of the pin's page.
        let beside = match (column, pin) {
            (Some(column), Some(pin)) => column.x > pin.x,
            _ => false,
        };
        let width = layout.map(|layout| layout.width);
        self.pdf_column_docked_pointer(cx, steps, view, id, width, slot, column)
            .await?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(false, window, cx))
        })?;
        cx.update(|cx| {
            crate::shell::workspaces::Workspaces::update(cx, |library| {
                library.set_focus_pdf(pdf_before)
            })
        });
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            DOCKED,
            docked && level && beside,
            json!({
                "docked": docked, "layout": format!("{layout:?}"), "slot": format!("{slot:?}"),
                "pin": format!("{pin:?}"), "level": level, "beside": beside,
            }),
        );
        Ok(())
    }
}

impl Run {
    /// The docked column sits outside the narrowed pages' viewport, where
    /// the window-wide listeners otherwise end a hover and close the card:
    /// moving within a docked card keeps its passage lit past the first
    /// move, and a press on the resize grip's outer half (left of the
    /// column, over the pages' padding) leaves the open card open.
    #[allow(clippy::too_many_arguments)]
    async fn pdf_column_docked_pointer(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        view: &gpui::Entity<crate::pdf::PdfView>,
        id: &str,
        width: Option<f32>,
        slot: Option<gpui::Bounds<gpui::Pixels>>,
        column: Option<gpui::Point<gpui::Pixels>>,
    ) -> Result<()> {
        const POINTER: &str = "PDF: a docked comment card keeps its passage lit while the pointer moves on it, and a press on the column's resize grip keeps its open card open";
        let move_to = |run: &Self, cx: &mut AsyncApp, at: gpui::Point<gpui::Pixels>| {
            run.with_window(cx, move |_, window, cx| {
                window.dispatch_event(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: at,
                        pressed_button: None,
                        modifiers: Modifiers::default(),
                    }),
                    cx,
                );
            })
        };
        let (Some(drawn), Some(slot), Some(column)) = (width, slot, column) else {
            steps.check(POINTER, false, json!({ "docked": false }));
            return Ok(());
        };
        // Several moves inside the card, as a real pointer makes.
        let mut lit = Vec::new();
        for step in 0..4 {
            let at = slot.center() + point(px(4. * step as f32), px(step as f32));
            move_to(self, cx, at)?;
            self.pause(cx, Duration::from_millis(60)).await;
            lit.push(cx.update(|cx| view.read(cx).note_hovered() == Some(id)));
        }
        self.snapshot(cx, "pdf-column-docked-hover").await;
        let stays_lit = lit.iter().all(|lit| *lit);
        // Open the card in place, then press the grip's outer half.
        self.click_at(cx, slot.center())?;
        let opened = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                view.read(cx).note_card() == Some(id)
            })
            .await;
        let edge = column.x - px(drawn / 2.);
        let open_slot = cx.update(|cx| view.read(cx).comment_slot(id));
        // The grip's inner half lies on the column itself.
        let inner = point(edge + px(2.), column.y);
        self.click_at(cx, inner)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let kept_inner = cx.update(|cx| view.read(cx).note_card() == Some(id));
        // Its outer half: the press and the release apart, to tell which
        // of them closes the card when one does.
        let grip = point(edge - px(2.), column.y);
        let button = |down: bool| {
            if down {
                PlatformInput::MouseDown(gpui::MouseDownEvent {
                    button: gpui::MouseButton::Left,
                    position: grip,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                })
            } else {
                PlatformInput::MouseUp(gpui::MouseUpEvent {
                    button: gpui::MouseButton::Left,
                    position: grip,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                })
            }
        };
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_event(button(true), cx);
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        let kept_pressed = cx.update(|cx| view.read(cx).note_card() == Some(id));
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_event(button(false), cx);
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (kept, width) = cx.update(|cx| {
            let view = view.read(cx);
            (
                view.note_card() == Some(id),
                view.comment_column_layout().map(|layout| layout.width),
            )
        });
        self.snapshot(cx, "pdf-column-docked-grip-press").await;
        self.dispatch_keys(cx, "escape")?;
        self.pause(cx, Duration::from_millis(300)).await;
        let closed = cx.update(|cx| view.read(cx).note_card().is_none());
        move_to(self, cx, point(px(4.), px(4.)))?;
        steps.check(
            POINTER,
            stays_lit
                && opened
                && kept_inner
                && kept_pressed
                && kept
                && width == Some(drawn)
                && closed,
            json!({
                "lit": lit, "opened": opened, "grip": format!("{grip:?}"),
                "slot": format!("{open_slot:?}"), "kept_inner": kept_inner,
                "kept_pressed": kept_pressed, "kept": kept,
                "width": width, "closed": closed,
            }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_column` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 52,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/view/column.rs",
        "gpui/crates/lattice-gpui/src/pdf/comment_margin.rs",
        "gpui/crates/lattice-gpui/src/annotations/card.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_column(cx, steps, &fixture.root)),
};
