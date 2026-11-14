//! The Papers panel on the project's own bibliography: a cited entry and a
//! saved paper (a bundle written into the scratch copy, as an import leaves
//! one) are listed with how often the manuscript cites each; typing narrows
//! the list by metadata and by the saved text, whose matching lines come
//! back under the paper; the Cited filter keeps what the manuscript cites;
//! a click opens the paper in its reader and marks its row as the open one. The
//! bibliography is put back afterwards, so the steps after this one see the
//! project as it was. With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the
//! panel listing, searching and filtered, for a look review.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{papers::model::Filter, scenario::Run};

const BUNDLE: &str = ".research/papers/1706.03762";
const ENTRY: &str = "\n@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},\n  journal = {NeurIPS},\n  year = {2017},\n  eprint = {1706.03762}\n}\n";
const PAPER: &str = "---\ntitle: Attention Is All You Need\n---\n\n# Attention Is All You Need\n\n## Abstract\n\nThe dominant sequence transduction models are based on recurrent networks.\n\n## Method\n\nWe call our particular attention scaled dot-product attention.\n";

impl Run {
    pub(super) async fn papers_panel(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let bibliography = root.join("references.bib");
        let original = std::fs::read_to_string(&bibliography)
            .context("the e2e project needs references.bib")?;
        std::fs::create_dir_all(root.join(BUNDLE))?;
        std::fs::write(root.join(BUNDLE).join("paper.md"), PAPER)?;
        std::fs::write(&bibliography, format!("{original}{ENTRY}"))?;
        let papers = cx.update(|cx| self.shell.read(cx).papers().clone());

        // The watcher sees the bibliography change; the panel reads the
        // library again once the change settles.
        let listed = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                let panel = papers.read(cx);
                panel.papers.len() == 2 && panel.uses_known()
            })
            .await;
        let rows = cx.update(|cx| {
            let panel = papers.read(cx);
            panel
                .papers
                .iter()
                .map(|paper| {
                    json!({
                        "title": paper.title,
                        "uses": panel.facts.uses(paper),
                        "fullText": paper.has_full_text,
                    })
                })
                .collect::<Vec<_>>()
        });
        let uses_of = |title: &str| {
            rows.iter()
                .find(|row| row["title"] == title)
                .map(|row| row["uses"].clone())
        };
        steps.check(
            "Papers lists the bibliography with the saved text and how often the manuscript cites each",
            listed
                // Earlier steps cite it again (a completed \cite), so at
                // least the fixture's own citation.
                && uses_of("The TeXbook")
                    .and_then(|uses| uses.as_u64())
                    .is_some_and(|uses| uses >= 1)
                && uses_of("Attention Is All You Need") == Some(json!(0))
                && rows.iter().any(|row| row["fullText"] == true),
            json!({ "rows": rows }),
        );
        self.papers_shot(cx, "papers-1-listed").await;

        // A phrase only the saved text holds finds the paper, with its line.
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| panel.type_query("dot-product", window, cx))
        })?;
        let answered = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                papers.read(cx).settled(cx)
            })
            .await;
        let (shown, hits) = cx.update(|cx| {
            let panel = papers.read(cx);
            let hits = panel
                .current_hits(cx)
                .map(|hits| {
                    hits.values()
                        .flat_map(|found| found.hits.iter().map(|hit| hit.text.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (panel.shown_titles(cx), hits)
        });
        steps.check(
            "a search finds a paper by its saved text and shows the matching line under it",
            answered
                && shown == ["Attention Is All You Need"]
                && hits.iter().any(|hit| hit.contains("dot-product")),
            json!({ "shown": shown, "hits": hits }),
        );
        self.papers_shot(cx, "papers-2-search").await;

        // Metadata narrows at once: an author's name.
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| panel.type_query("knuth", window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            papers.read(cx).settled(cx)
        })
        .await;
        let by_author = cx.update(|cx| papers.read(cx).shown_titles(cx));
        steps.check(
            "typing an author's name keeps the papers whose metadata holds it",
            by_author == ["The TeXbook"],
            json!({ "shown": by_author }),
        );

        // The Cited filter keeps what the manuscript cites.
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.type_query("", window, cx);
                panel.set_filter(Filter::Cited, cx);
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let cited = cx.update(|cx| papers.read(cx).shown_titles(cx));
        self.papers_shot(cx, "papers-3-cited").await;
        cx.update(|cx| papers.update(cx, |panel, cx| panel.set_filter(Filter::All, cx)));
        steps.check(
            "the Cited filter keeps the papers the manuscript cites",
            cited == ["The TeXbook"],
            json!({ "shown": cited }),
        );

        // A click opens the saved text in the paper's reader, without the
        // converter's front matter, and marks its row as the open one.
        let opened = self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.open_titled("Attention Is All You Need", window, cx)
            })
        })?;
        let reading = format!("{BUNDLE}/paper.md");
        let open = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).front_reader(cx).is_some_and(|(path, text)| {
                    path == reading && text.starts_with("# Attention Is All You Need")
                })
            })
            .await;
        let marked = cx.update(|cx| papers.read(cx).active_key());
        let shown = self.with_window(cx, |shell, _, cx| {
            shell.read(cx).front_reader(cx).map(|(path, _)| path)
        })?;
        steps.check(
            "a click on a saved paper opens it in its reader and marks its row as the open one",
            opened && open && marked.as_deref() == Some("1706.03762"),
            json!({ "opened": opened, "open": open, "reader": shown, "marked": marked }),
        );
        if open {
            self.papers_shot(cx, "papers-reader").await;
            self.press(cx, 'w', true).await?;
        }

        self.add_papers_sheet(cx, steps, &papers).await?;
        self.check_references(cx, steps, &papers, root).await?;

        std::fs::write(&bibliography, original)?;
        std::fs::remove_dir_all(root.join(BUNDLE))?;
        let restored = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                papers.read(cx).papers.len() == 1
            })
            .await;
        let left: Vec<String> = cx.update(|cx| {
            papers
                .read(cx)
                .papers
                .iter()
                .map(|paper| paper.title.clone())
                .collect()
        });
        steps.check(
            "the project's bibliography and papers are put back as they were",
            restored && left == ["The TeXbook"],
            json!({ "restored": restored, "papers": left }),
        );
        Ok(())
    }

    /// Save the window as `name` under `LATTICE_E2E_SHOTS`.
    pub(super) async fn papers_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            self.pause(cx, Duration::from_millis(300)).await;
            let path = Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }
}

impl Run {
    /// Add papers, offline: a pasted BibTeX entry is read as it stands and
    /// an id the library already holds needs no lookup, so neither reaches
    /// the network. Closing it adds nothing.
    async fn add_papers_sheet(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<crate::papers::PapersPanel>,
    ) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| panel.open_add_sheet(window, cx))
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).add_papers().is_some()
            })
            .await;
        let pasted = "@article{hinton2006,\n  title = {A Fast Learning Algorithm for Deep Belief Nets},\n  author = {Hinton, Geoffrey E. and Osindero, Simon and Teh, Yee-Whye},\n  journal = {Neural Computation},\n  year = {2006}\n}\narXiv:1706.03762\n";
        let sheet = cx.update(|cx| self.shell.read(cx).add_papers().cloned());
        let Some(sheet) = sheet.filter(|_| opened) else {
            steps.check(
                "Add papers opens from the Papers panel's +",
                false,
                json!({}),
            );
            return Ok(());
        };
        self.with_window(cx, |_, window, cx| {
            sheet.update(cx, |sheet, cx| sheet.paste(pasted, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let rows = cx.update(|cx| {
            sheet
                .read(cx)
                .row_states(cx)
                .into_iter()
                .map(|(title, state)| json!({ "title": title, "state": format!("{state:?}") }))
                .collect::<Vec<_>>()
        });
        self.papers_shot(cx, "papers-4-add-sheet").await;
        steps.check(
            "Add papers reads a pasted BibTeX entry as new and an id the library holds as already in Papers",
            rows == [
                json!({ "title": "A Fast Learning Algorithm for Deep Belief Nets", "state": "New" }),
                json!({ "title": "Attention Is All You Need", "state": "Duplicate" }),
            ],
            json!({ "rows": rows }),
        );
        // Zotero… reads the library in place of the paste box; this HOME
        // has none, and the browser says so with the way to choose one.
        self.with_window(cx, |_, window, cx| {
            sheet.update(cx, |sheet, cx| sheet.open_zotero(window, cx))
        })?;
        let answered = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                sheet.read(cx).zotero().is_some_and(|browser| {
                    let (read, error) = browser.read(cx).read_state();
                    read || error.is_some()
                })
            })
            .await;
        let not_found = cx.update(|cx| {
            sheet.read(cx).zotero().is_some_and(|browser| {
                let (read, error) = browser.read(cx).read_state();
                !read && error.is_some()
            })
        });
        let state = cx.update(|cx| {
            sheet.read(cx).zotero().map(|browser| {
                let (read, error) = browser.read(cx).read_state();
                json!({ "read": read, "error": error })
            })
        });
        self.papers_shot(cx, "papers-4b-zotero").await;
        steps.check(
            "Add papers' Zotero… opens the library browser, which says this HOME has no library",
            answered && not_found,
            json!({ "zotero": state }),
        );
        self.with_window(cx, |_, window, cx| {
            sheet.update(cx, |sheet, cx| sheet.cancel(window, cx))
        })?;
        // Closing it adds nothing: no rows queued, the library as it was.
        self.pause(cx, Duration::from_millis(200)).await;
        let (queued, held) = cx.update(|cx| {
            let panel = papers.read(cx);
            (panel.batch.items.len(), panel.papers.len())
        });
        steps.check(
            "closing Add papers adds nothing",
            queued == 0 && held == 2,
            json!({ "queued": queued, "papers": held }),
        );
        Ok(())
    }

    /// Check references, offline: opening saves what the editors hold, then
    /// reads the references, an entry typed and not yet saved among them,
    /// and leaves each unchecked until the writer asks (the checks reach
    /// the network).
    async fn check_references(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<crate::papers::PapersPanel>,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("references.bib"), None)?;
        self.pause(cx, Duration::from_millis(200)).await;
        cx.update(|cx| {
            let buffer = editor.read(cx).lattice_editor().read(cx).buffer().clone();
            buffer.update(cx, |buffer, cx| {
                let end = buffer.len();
                let typed = "\n@misc{unsaved2024,\n  title = {Typed, Not Saved}\n}\n";
                buffer.edit([(end..end, typed)], None, cx);
            })
        });
        cx.update(|cx| {
            papers.update(cx, |_, cx| {
                cx.emit(crate::papers::PapersEvent::CheckReferences)
            })
        });
        let read = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .audit()
                    .is_some_and(|audit| audit.read(cx).loaded())
            })
            .await;
        let rows = cx.update(|cx| {
            self.shell
                .read(cx)
                .audit()
                .map(|audit| {
                    audit
                        .read(cx)
                        .rows()
                        .into_iter()
                        .map(|(key, bucket)| json!({ "key": key, "bucket": format!("{bucket:?}") }))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        });
        self.papers_shot(cx, "papers-5-check-references").await;
        steps.check(
            "Check references saves the editors, reads every reference and leaves each unchecked until asked",
            read && ["knuth1984", "unsaved2024"].iter().all(|key| {
                rows.iter()
                    .any(|row| row["key"] == *key && row["bucket"] == "Unchecked")
            }),
            json!({ "rows": rows }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        Ok(())
    }
}
