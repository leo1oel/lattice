//! Export review PDF (`review-pdf-sheet.tsx`): with a note on words of
//! chapters/intro.tex, the sheet over the live PDF finds the words and
//! offers the note ticked as a highlight; exported, the copy carries the
//! note as a Highlight annotation whose `/NM` is the note's id and whose
//! comment starts with its pin number, and the cover note on page 1, while
//! the compiled PDF itself is left as it was.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lopdf::{Document, Object};
use serde_json::json;

use super::Steps;
use crate::{
    annotations::{model, store},
    scenario::Run,
};

/// Words of the fixture's introduction that earlier modules leave as they are.
const WORDS: &str = "paragraph introduces the document";

/// Each annotation of the PDF at `path`: its subtype, `/NM` and contents.
fn annotations_of(path: &Path) -> Vec<(String, String, String)> {
    let Ok(document) = Document::load(path) else {
        return Vec::new();
    };
    let text = |object: Option<&Object>| match object {
        Some(Object::String(bytes, _)) => {
            if bytes.starts_with(&[0xfe, 0xff]) {
                let units: Vec<u16> = bytes[2..]
                    .chunks(2)
                    .map(|pair| u16::from_be_bytes([pair[0], *pair.get(1).unwrap_or(&0)]))
                    .collect();
                String::from_utf16_lossy(&units)
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
        Some(Object::Name(name)) => String::from_utf8_lossy(name).into_owned(),
        _ => String::new(),
    };
    let mut found = Vec::new();
    for (_, page) in document.get_pages() {
        let Ok(annots) = document
            .get_dictionary(page)
            .and_then(|page| page.get(b"Annots"))
            .and_then(|annots| {
                document
                    .dereference(annots)
                    .map(|(_, object)| object.clone())
            })
            .and_then(|object| object.as_array().cloned())
        else {
            continue;
        };
        for annot in annots {
            let Ok((_, Object::Dictionary(annot))) = document.dereference(&annot) else {
                continue;
            };
            found.push((
                text(annot.get(b"Subtype").ok()),
                text(annot.get(b"NM").ok()),
                text(annot.get(b"Contents").ok()),
            ));
        }
    }
    found
}

impl Run {
    async fn pdf_review(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        const STEP: &str = "PDF: Export review PDF places a note on its words as a highlight, ticked, and the copy carries it as a Highlight with its id and number, with the cover note on page 1, leaving the compiled PDF as it was";
        let path = "chapters/intro.tex";
        let text = std::fs::read_to_string(root.join(path))?;
        let (Some(start), Some(project)) = (
            text.find(WORDS),
            cx.update(|cx| self.shell.read(cx).root(cx)),
        ) else {
            steps.check(STEP, false, json!({ "fixture": false }));
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
        let number = cx.update(|cx| {
            store
                .read(cx)
                .get(&project, &id)
                .map_or(0, |note| note.number)
        });
        // The live PDF learns of the note before the sheet reads it.
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            view.read(cx)
                .note_places()
                .iter()
                .any(|(placed, _)| *placed == id)
        })
        .await;
        let compiled = cx.update(|cx| view.read(cx).review_source().map(|source| source.path));
        let before = compiled.as_ref().and_then(|path| std::fs::read(path).ok());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_review_sheet(None, window, cx))
        })?;
        let sheet = cx.update(|cx| self.shell.read(cx).review_sheet_entity());
        let placed = match &sheet {
            Some(sheet) => {
                self.wait_for(cx, Duration::from_secs(20), |_, cx| {
                    sheet.read(cx).placed().is_some()
                })
                .await
            }
            None => false,
        };
        let (kinds, ticked) = sheet.as_ref().map_or((None, Vec::new()), |sheet| {
            cx.update(|cx| {
                let sheet = sheet.read(cx);
                (
                    sheet.placed().map(|placed| {
                        placed
                            .into_iter()
                            .map(|(id, kind)| (id, kind.to_string()))
                            .collect::<Vec<_>>()
                    }),
                    sheet.ticked(),
                )
            })
        });
        self.snapshot(cx, "pdf-review-sheet").await;
        let highlighted = kinds.as_ref().is_some_and(|kinds| {
            kinds
                .iter()
                .any(|(placed, kind)| *placed == id && kind == "highlight")
        });
        let destination = root.with_file_name("review-copy.pdf");
        let _ = std::fs::remove_file(&destination);
        if let Some(sheet) = &sheet {
            let destination = destination.clone();
            self.with_window(cx, {
                let sheet = sheet.clone();
                move |_, window, cx| {
                    sheet.update(cx, |sheet, cx| sheet.export_to(destination, window, cx))
                }
            })?;
        }
        let closed = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).review_sheet_entity().is_none()
            })
            .await;
        let failure = sheet
            .as_ref()
            .and_then(|sheet| cx.update(|cx| sheet.read(cx).failure().map(str::to_string)));
        let annotations = annotations_of(&destination);
        let carried = annotations.iter().any(|(kind, nm, contents)| {
            // lattice-core names each `lattice-annotation-<id>`.
            kind == "Highlight" && nm.ends_with(&id) && contents.starts_with(&format!("#{number}"))
        });
        let cover = annotations
            .iter()
            .any(|(kind, nm, _)| kind == "Text" && nm.ends_with("review-cover"));
        let untouched = before.is_some()
            && compiled.as_ref().and_then(|path| std::fs::read(path).ok()) == before;
        steps.check(
            STEP,
            placed
                && highlighted
                && ticked.contains(&id)
                && closed
                && carried
                && cover
                && untouched,
            json!({
                "placed": placed, "kinds": kinds, "ticked": ticked, "closed": closed,
                "failure": failure, "annotations": annotations, "untouched": untouched,
            }),
        );
        cx.update(|cx| store.update(cx, |store, cx| store.delete(&project, &id, cx)));
        Ok(())
    }
}

/// This file's registration as the e2e module `pdf_review` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 53,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/pdf/review_place.rs",
        "gpui/crates/lattice-gpui/src/pdf/review_sheet.rs",
        "gpui/crates/lattice-gpui/src/pdf/view/review.rs",
        "gpui/crates/lattice-gpui/src/shell/review_pdf_flow.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.pdf_review(cx, steps, &fixture.root)),
};
