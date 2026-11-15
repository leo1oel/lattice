//! The e2e check of Overleaf's suggestions in a Markdown file's visual
//! editor (`gpui/islands/markdown/main.tsx`, `md:overleaf`): with Edit left
//! as the Markdown view on primer.md, notes.md opens live in Edit, where no
//! visual editor exists yet, and a collaborator suggests an insertion past
//! the front matter; choosing Preview paints it over the inserted words at
//! once (the panel keeps the suggestions for a visual editor made later),
//! and the card it opens under the pointer accepts it on both sides. Edit is
//! chosen again after, and main.tex made live again.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use lattice_core::overleaf_rt::ot::insert;
use serde_json::{Value, json};

use super::super::Steps;
use crate::{
    editor_panel::DocumentView,
    scenario::{Run, overleaf_mock::MockOverleaf},
};

pub(super) const NOTES_PATH: &str = "notes.md";
pub(super) const NOTES: &str = "---\ntitle: Notes\n---\n\n# Notes\n\nThe opening line of the notes.\n";
/// A Markdown file left in Edit first, so notes.md opens in Edit with no
/// visual editor made (the view is remembered for Markdown files).
pub(super) const PRIMER_PATH: &str = "primer.md";
pub(super) const PRIMER: &str = "# Primer\n";
const INSERTED: &str = "freshly ";

impl Run {
    pub(super) async fn overleaf_markdown_review(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let root = self.root(cx).await?;
        let primer = root.join(PRIMER_PATH);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_path(primer.clone(), None, window, cx))
        })?;
        let primer_panel = cx
            .update(|cx| self.shell.update(cx, |shell, cx| shell.open_editor(&primer, cx)))
            .context("primer.md is open")?;
        self.with_window(cx, move |_, window, cx| {
            primer_panel.update(cx, |panel, cx| {
                panel.set_document_view(DocumentView::Source, window, cx)
            })
        })?;
        let path = root.join(NOTES_PATH);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_path(path.clone(), None, window, cx))
        })?;
        let live = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                let bridge = shell.read(cx).overleaf.read(cx);
                bridge.live_file() == Some(NOTES_PATH) && !bridge.live_sending()
            })
            .await;
        let panel = cx
            .update(|cx| self.shell.update(cx, |shell, cx| shell.open_editor(&path, cx)))
            .context("notes.md is open")?;
        let opened_in = cx.update(|cx| panel.read(cx).document_view());
        let page_before = cx.update(|cx| panel.read(cx).markdown_document().is_some());

        // The collaborator suggests "freshly " before "opening", past the
        // front matter the visual editor never shows.
        let text = mock.file(NOTES_PATH).unwrap_or_default();
        let at = text
            .find("opening")
            .map(|byte| text[..byte].encode_utf16().count())
            .unwrap_or(0);
        let suggested = mock.peer_suggested(NOTES_PATH, vec![insert(at, INSERTED)]);
        let arrived = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                shell
                    .read(cx)
                    .overleaf
                    .read(cx)
                    .live_review(NOTES_PATH)
                    .is_some_and(|review| {
                        review.changes.iter().any(|change| {
                            change.text == INSERTED
                                && !lattice_core::overleaf_rt::tracked::is_provisional(change)
                        })
                    })
            })
            .await;
        // Settle so the bridge's notify has come and gone before the page
        // exists: only the panel's kept payload can paint it then.
        self.pause(cx, Duration::from_millis(500)).await;

        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    panel.set_document_view(DocumentView::Preview, window, cx)
                })
            }
        })?;
        let watched = panel.clone();
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), move |_, cx| {
                watched
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let island = cx.update(|cx| {
            panel
                .read(cx)
                .markdown_document()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let probe = "JSON.stringify(Array.from(document.querySelectorAll('[data-lx-change]')).map((el) => ({ \
                     id: el.getAttribute('data-lx-change'), text: el.textContent, insert: el.classList.contains('is-insert') })))";
        let mut marks = Value::Null;
        let mut card = Value::Null;
        let mut accepted = false;
        if let Some(island) = island.filter(|_| drawn) {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(15) {
                marks = self.evaluate(cx, &island, probe).await;
                if marks.as_array().is_some_and(|marks| !marks.is_empty()) {
                    break;
                }
                self.pause(cx, Duration::from_millis(250)).await;
            }
            self.window_shots(cx, "overleaf-markdown-suggestion").await?;
            // The pointer over the mark opens its card, named and with
            // Accept and Reject.
            let open_card = "JSON.stringify((() => { const mark = document.querySelector('[data-lx-change]'); \
                             if (!mark) return null; mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })())";
            self.evaluate(cx, &island, open_card).await;
            let card_probe = "JSON.stringify((() => { const card = document.querySelector('[role=dialog][aria-label=\"Suggested change\"]'); \
                              if (!card) return null; return { text: card.textContent, \
                              buttons: Array.from(card.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || b.textContent) }; })())";
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                card = self.evaluate(cx, &island, card_probe).await;
                if card.is_object() {
                    break;
                }
                self.pause(cx, Duration::from_millis(100)).await;
            }
            self.window_shots(cx, "overleaf-markdown-suggestion-card").await?;
            let accept = "JSON.stringify((() => { const card = document.querySelector('[role=dialog][aria-label=\"Suggested change\"]'); \
                          const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || b.textContent || '').includes('Accept')); \
                          if (!button) return false; button.click(); return true; })())";
            let clicked = self.evaluate(cx, &island, accept).await == true;
            accepted = clicked
                && self
                    .wait_for(cx, Duration::from_secs(15), |_, _| {
                        mock.changes(NOTES_PATH).is_empty()
                            && mock.file(NOTES_PATH).is_some_and(|text| text.contains("freshly opening"))
                    })
                    .await;
        }
        let inserted_marked = marks.as_array().is_some_and(|marks| {
            marks
                .iter()
                .any(|mark| {
                    mark["text"] == INSERTED
                        && mark["insert"] == true
                        && !mark["id"].as_str().is_some_and(|id| id.starts_with("provisional"))
                })
        });
        steps.check(
            "a collaborator's Overleaf suggestion on a .md file made while in Edit is painted in Preview's visual editor over the inserted words",
            live
                && suggested
                && arrived
                && opened_in == Some(DocumentView::Source)
                && !page_before
                && drawn
                && inserted_marked,
            json!({ "live": live, "suggested": suggested, "arrived": arrived, "opened_in": format!("{opened_in:?}"), "page_before": page_before, "drawn": drawn, "marks": marks }),
        );
        let card_ok = card["text"].as_str().is_some_and(|text| text.contains("Ada Lovelace"))
            && card["buttons"].as_array().is_some_and(|buttons| {
                buttons.iter().any(|b| b.as_str().is_some_and(|b| b.contains("Accept")))
                    && buttons.iter().any(|b| b.as_str().is_some_and(|b| b.contains("Reject")))
            });
        steps.check(
            "the Markdown suggestion's card names its author with Accept and Reject, and Accept clears it on Overleaf keeping the words",
            card_ok && accepted,
            json!({ "card": card, "accepted": accepted, "changes": mock.changes(NOTES_PATH), "overleaf": mock.file(NOTES_PATH) }),
        );

        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    panel.set_document_view(DocumentView::Source, window, cx)
                })
            }
        })?;
        // main.tex live again and every sync settled, as the checks after
        // this one were written to start from.
        let main = root.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_path(main.clone(), None, window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            let bridge = shell.read(cx).overleaf.read(cx);
            bridge.live_file() == Some("main.tex") && !bridge.live_sending() && !bridge.syncing()
        })
        .await;
        Ok(())
    }
}
