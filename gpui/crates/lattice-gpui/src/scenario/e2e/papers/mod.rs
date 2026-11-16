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

mod audit;
mod cards;
mod library;
mod prewarm;
// The reader's checks read its page from the webview island, which only
// macOS has.
#[cfg(target_os = "macos")]
mod reader;
#[cfg(target_os = "macos")]
mod selection_actions;

const BUNDLE: &str = ".research/papers/1706.03762";
const ENTRY: &str = "\n@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},\n  journal = {NeurIPS},\n  year = {2017},\n  eprint = {1706.03762}\n}\n";
const PAPER: &str = "---\ntitle: Attention Is All You Need\n---\n\n# Attention Is All You Need\n\n## Abstract\n\nThe dominant sequence transduction models are based on recurrent networks.\n\n## Method\n\nWe call our particular attention scaled dot-product attention:\n\n$$\\mathrm{softmax}(QK^\\top / \\sqrt{d_k})\\,V$$\n";

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

        let outcome = self.papers_panel_steps(cx, steps, root, &papers).await;
        std::fs::write(&bibliography, original)?;
        std::fs::remove_dir_all(root.join(BUNDLE))?;
        outcome?;
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

    /// The Papers panel's steps, on the bibliography with the entry added.
    async fn papers_panel_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        papers: &gpui::Entity<crate::papers::PapersPanel>,
    ) -> Result<()> {
        let papers = papers.clone();
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
        let field_of = |title: &str, field: &str| {
            rows.iter()
                .find(|row| row["title"] == title)
                .map(|row| row[field].clone())
        };
        let uses_of = |title: &str| field_of(title, "uses");
        steps.check(
            "Papers lists the bibliography with the saved text and how often the manuscript cites each",
            listed
                // Earlier steps cite it again (a completed \cite), so at
                // least the fixture's own citation.
                && uses_of("The TeXbook")
                    .and_then(|uses| uses.as_u64())
                    .is_some_and(|uses| uses >= 1)
                && uses_of("Attention Is All You Need") == Some(json!(0))
                // The bundle's paper has its text; the book only its entry.
                && field_of("Attention Is All You Need", "fullText") == Some(json!(true))
                && field_of("The TeXbook", "fullText") == Some(json!(false)),
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

        // Metadata narrows at once: an author's name, one in no citation
        // key or saved text (the entry's second author), so only the
        // authors field can match it.
        self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| panel.type_query("shazeer", window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            papers.read(cx).settled(cx)
        })
        .await;
        let by_author = cx.update(|cx| papers.read(cx).shown_titles(cx));
        steps.check(
            "typing an author's name keeps the papers whose metadata holds it",
            by_author == ["Attention Is All You Need"],
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
        self.papers_library(cx, steps, &papers).await?;
        self.papers_citation_card(cx, steps).await?;

        let reading = format!("{BUNDLE}/paper.md");
        let warmed = self
            .papers_prewarm(cx, steps, &papers, "Attention Is All You Need", &reading)
            .await?;

        // A click opens the saved text in the paper's reader (its body under
        // the converter's front matter, which the visual editor leaves out),
        // and marks its row as the open one.
        let opened = self.with_window(cx, |_, window, cx| {
            papers.update(cx, |panel, cx| {
                panel.open_titled("Attention Is All You Need", window, cx)
            })
        })?;
        let open = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).front_reader(cx).is_some_and(|(path, text)| {
                    path == reading
                        && crate::papers::model::strip_frontmatter(&text)
                            .trim_start()
                            .starts_with("# Attention Is All You Need")
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
        // The click found the text the pointer's rest readied.
        let used = cx.update(|cx| {
            self.shell
                .read(cx)
                .front_reader_panel(cx)
                .and_then(|reader| reader.read(cx).editor().map(|editor| editor.entity_id()))
        });
        steps.check(
            "the paper opens in its reader with the text readied while the pointer rested on its row",
            warmed.is_some() && used == warmed,
            json!({ "warmed": warmed.map(|id| id.as_u64()), "used": used.map(|id| id.as_u64()) }),
        );
        if open {
            // The paper reads in the Tauri app's visual editor, in Preview
            // (`openPaper` sets the canvas to its preview), on its own page.
            let reading = self
                .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                    shell
                        .read(cx)
                        .front_reader_state(cx)
                        .is_some_and(|(view, page, pdf)| {
                            view == Some(crate::editor_panel::views::DocumentView::Preview)
                                && page
                                && !pdf
                        })
                })
                .await;
            let state = self.with_window(cx, |shell, _, cx| {
                shell
                    .read(cx)
                    .front_reader_state(cx)
                    .map(|(view, page, pdf)| (format!("{view:?}"), page, pdf))
            })?;
            steps.check(
                "the paper reads in the visual editor's Preview, its page drawn",
                reading,
                json!({ "state": state }),
            );
            self.papers_shot(cx, "papers-reader").await;
            self.press(cx, 'w', true).await?;
            #[cfg(target_os = "macos")]
            self.paper_reader(cx, steps, root, &papers, BUNDLE).await?;
        }

        self.add_papers_sheet(cx, steps, &papers).await?;
        self.check_references(cx, steps, &papers, root).await?;
        self.add_without_full_text(cx, steps, &papers, root).await?;

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

    /// Adding a paper with Also save full text off, its default
    /// (`save-full-text-setting.ts`), adds its citation and never fetches
    /// or writes its text: an entry with an arXiv id, which a full-text add
    /// would download and convert under `.research/papers/<id>/` (reporting
    /// the "fulltext" stage before it reaches the network, and offline
    /// raising "Citation added without full text"), lands in the
    /// bibliography alone and raises no notice, its row saying it. The bibliographies are put back after, so
    /// what follows sees the fixture as it was.
    async fn add_without_full_text(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<crate::papers::PapersPanel>,
        root: &Path,
    ) -> Result<()> {
        let bibliographies: Vec<(std::path::PathBuf, Vec<u8>)> = std::fs::read_dir(root)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "bib"))
            .filter_map(|path| std::fs::read(&path).ok().map(|bytes| (path, bytes)))
            .collect();
        let full_text = cx.update(|cx| crate::settings::get(cx).save_full_text);
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let entry = "@article{kingma2013vae,\n  title = {Auto-Encoding Variational Bayes},\n  author = {Kingma, Diederik P. and Welling, Max},\n  year = {2013},\n  eprint = {1312.6114},\n  archivePrefix = {arXiv}\n}\n";
        let started = cx.update(|cx| {
            papers.update(cx, |panel, cx| {
                panel.import_entry(
                    entry.to_string(),
                    "Auto-Encoding Variational Bayes".into(),
                    false,
                    cx,
                )
            })
        });
        let mut stages: Vec<String> = Vec::new();
        let settled = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                let Some(importing) = &papers.read(cx).importing else {
                    return true;
                };
                if let Some(stage) = &importing.stage
                    && stages.last() != Some(stage)
                {
                    stages.push(stage.clone());
                }
                false
            })
            .await;
        let fetched = stages.iter().any(|stage| stage == "fulltext");
        let raised: Vec<String> = cx.update(|cx| {
            notices
                .read(cx)
                .titles()
                .into_iter()
                .map(|title| title.to_string())
                .collect()
        });
        let cited = bibliographies.iter().any(|(path, _)| {
            std::fs::read_to_string(path).is_ok_and(|text| text.contains("kingma2013vae"))
        });
        let bundle = root.join(".research/papers/1312.6114");
        let text_written = bundle.join("paper.md").exists();
        steps.check(
            "with Also save full text off (its default), adding a paper adds its citation and writes no full text",
            !full_text && started && settled && cited && !fetched && raised.is_empty() && !text_written,
            json!({ "save_full_text": full_text, "started": started, "settled": settled, "cited": cited, "stages": stages, "notices": raised, "paper_md": text_written }),
        );
        for (path, bytes) in &bibliographies {
            std::fs::write(path, bytes)?;
        }
        std::fs::remove_dir_all(&bundle).ok();
        self.pause(cx, Duration::from_millis(500)).await;
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
        if read {
            self.check_references_queue(cx, steps, root).await?;
        }
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        Ok(())
    }
}

/// This file's registration as the e2e module `papers` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 52,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/papers",
        "gpui/crates/lattice-gpui/src/shell/papers.rs",
        "gpui/crates/lattice-gpui/src/shell/papers/",
        // The opener whose refusal Papers reports, and the full text's
        // selection actions' requests of the app.
        "gpui/crates/lattice-gpui/src/opener.rs",
        "gpui/crates/lattice-gpui/src/structured/markdown/paper_quotes.rs",
        // The paper reader's text and its reading form in the island.
        "gpui/crates/lattice-gpui/src/editor_panel/paper_text.rs",
        "gpui/islands/markdown/",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.papers_panel(cx, steps, &fixture.root)),
};
