//! A citation key's card beyond the bibliography, offline, in `main.tex`:
//! the card lists the key's uses here ("Cited N× here"), each in its
//! section with the page its note names; "Why cited" from the card files a
//! reason with its role and note, which the card's row then shows; a
//! right-click on a key opens "Why cited" too, and the card stays away
//! meanwhile; and a reason whose cite is deleted joins the notes in the
//! Annotations panel and the titlebar's count.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{annotations::store, native, scenario::Run};

const KEY: &str = "knuth1984";
/// A second use of the key, in a section of its own, naming a page.
const LATER: &str = "\n\\section{Later}\nAs the book says~\\cite[p.~5]{knuth1984}.\n";

impl Run {
    pub(super) async fn papers_citation_card(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .ok_or_else(|| anyhow::anyhow!("the Papers e2e needs a project"))?;
        let panel = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let end = original.find("\\end{document}").unwrap_or(original.len());
        let edit = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            edit.update(cx, |panel, cx| {
                panel.replace_range(end, end, LATER, end, window, cx)
            })
        })?;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());

        // The card over the first use lists them all, in their sections.
        self.reveal(cx, &panel, KEY).await?;
        let (_, key) = self.text_point(cx, &panel, &lattice, KEY, 4).await?;
        self.hover_at(cx, key.center()).await?;
        let shown = self.wait_for_card(cx, &lattice, "citation").await;
        let library = cx.update(|cx| lattice.read(cx).citation_slot().borrow().clone());
        let uses = match &library {
            Some(library) => cx.update(|cx| {
                let text = panel.read(cx).buffer_snapshot(cx);
                library.uses(KEY, &text, cx)
            }),
            None => Vec::new(),
        };
        self.papers_looks(cx, "papers-8-citation-card").await?;
        // One use per cite of the key in the file. A full run's earlier
        // modules may have cited it again in `\section{Method}` (the
        // editor adapter's completion step does), so count them in the
        // text rather than assume the fixture's one; only the cite added
        // here names a page, in its own section, last.
        let cites = cx.update(|cx| panel.read(cx).text_and_caret(cx).0).matches("{knuth1984}").count();
        let (earlier, last) = uses.split_at(uses.len().saturating_sub(1));
        steps.check(
            "a citation card lists the key's uses here, each in its section with the page its note names",
            shown.is_some()
                && cites >= 2
                && uses.len() == cites
                && earlier.iter().all(|row| row.page.is_none())
                && last.first().is_some_and(|row| {
                    row.page == Some(5)
                        && row.section.as_deref().is_some_and(|section| section.ends_with("Later"))
                }),
            json!({ "shown": shown.is_some(), "cites": cites, "uses": format!("{uses:?}") }),
        );

        // "Why cited" from the card files a reason on that use.
        let range = shown.map(|(range, _)| range).unwrap_or_default();
        if let Some(library) = library.clone() {
            let range = range.clone();
            self.with_window(cx, move |_, window, cx| {
                library.why_cited(KEY, range, window, cx)
            })?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let opened = cx.update(|cx| panel.read(cx).why_cited_key());
        let hidden = cx.update(|cx| lattice.read(cx).shown_hover(cx).is_empty());
        self.papers_looks(cx, "papers-9-why-cited").await?;
        let file = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            file.update(cx, |panel, cx| {
                panel.file_reason_for_scenario("method", "Its macro language", window, cx)
            })
        })?;
        let filed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                reason_of(cx, &root).is_some()
            })
            .await;
        let row = library.as_ref().map(|library| {
            cx.update(|cx| {
                let text = panel.read(cx).buffer_snapshot(cx);
                library
                    .uses(KEY, &text, cx)
                    .first()
                    .and_then(|row| row.reason.clone())
            })
        });
        steps.check(
            "\"Why cited\" from the card files the reason, and the card's row then says why",
            opened.as_deref() == Some(KEY)
                && hidden
                && filed
                && row.flatten().is_some_and(|(role, _, note)| {
                    role == "method" && note == "Its macro language"
                }),
            json!({ "opened": opened, "hidden": hidden, "filed": filed }),
        );

        // A right-click on a key opens it too.
        let (_, key) = self.text_point(cx, &panel, &lattice, KEY, 2).await?;
        native::send_right_click(self.native(cx)?, key.center())?;
        let right = self
            .wait_for(cx, Duration::from_secs(3), {
                let panel = panel.clone();
                move |_, cx| panel.read(cx).why_cited_key().is_some()
            })
            .await;
        let close = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            close.update(cx, |panel, cx| {
                panel.close_why_cited_for_scenario(window, cx)
            })
        })?;
        steps.check(
            "a right-click on a citation key opens \"Why cited\" there",
            right,
            json!({}),
        );

        // The first cite deleted, its reason is orphaned: it joins the notes.
        let first = cx.update(|cx| panel.read(cx).text_and_caret(cx).0);
        let cite = "\\cite{knuth1984}";
        let at = first.find(cite).unwrap_or(0);
        let cut = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            cut.update(cx, |panel, cx| {
                panel.replace_range(at, at + cite.len(), "", at, window, cx)
            })
        })?;
        let id = cx.update(|cx| reason_of(cx, &root)).unwrap_or_default();
        let listed = self
            .wait_for(cx, Duration::from_secs(6), {
                let (root, id) = (root.clone(), id.clone());
                move |_, cx| {
                    crate::annotations::orphans::panel_reasons(&root, cx)
                        .iter()
                        .any(|reason| reason.id == id)
                }
            })
            .await;
        let counted = cx.update(|cx| crate::annotations::orphans::open_orphans(&root, cx));
        steps.check(
            "a reason whose cite is deleted joins the notes in the Annotations panel and the titlebar's count",
            listed && counted == 1,
            json!({ "listed": listed, "counted": counted }),
        );

        // Put the file and the annotations back.
        let restore = panel.clone();
        self.with_window(cx, move |_, window, cx| {
            restore.update(cx, |panel, cx| {
                let len = panel.text_and_caret(cx).0.len();
                panel.replace_range(0, len, &original, 0, window, cx)
            })
        })?;
        cx.update(|cx| {
            if let Some(store) = store::try_store(cx) {
                store.update(cx, |store, cx| {
                    store.commit(
                        &root,
                        |notes| {
                            notes.annotations.retain(|item| item.id != id);
                            true
                        },
                        cx,
                    )
                });
            }
        });
        Ok(())
    }
}

/// The reason filed on the key, by id.
fn reason_of(cx: &gpui::App, root: &std::path::Path) -> Option<String> {
    store::try_store(cx)?
        .read(cx)
        .notes(root)?
        .annotations
        .iter()
        .find(|item| {
            item.citation
                .as_ref()
                .is_some_and(|citation| citation.key == KEY)
        })
        .map(|item| item.id.clone())
}
