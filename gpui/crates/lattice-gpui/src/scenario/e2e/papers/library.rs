//! The Papers panel's keyboard, its palette rows and Add reference's form,
//! offline: the box's down arrow comes into the list and the arrows walk
//! it, the up arrow from the first paper going back to the box; the palette
//! lists Add papers, Discover literature and Check references under
//! Research, and Add papers runs from it; adding a paper saves its citation
//! alone until the writer turns on "Also save full text"; and Add reference,
//! entered by hand, steps its year, shows the BibTeX it will write and
//! offers to cite the entry at the caret.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Keystroke};
use serde_json::json;

use super::super::Steps;
use crate::{papers::PapersPanel, scenario::Run};

impl Run {
    pub(super) async fn papers_library(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<PapersPanel>,
    ) -> Result<()> {
        self.papers_keyboard(cx, steps, papers).await?;
        self.papers_research_rows(cx, steps).await?;
        self.papers_full_text_setting(cx, steps, papers).await?;
        self.add_reference_form(cx, steps).await?;
        Ok(())
    }

    /// Save the window in light and dark, English and Simplified Chinese,
    /// under `LATTICE_E2E_SHOTS`, then put it back in light English.
    async fn papers_looks(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
        use lattice_settings::InterfaceLanguage;
        use lattice_ui::{Appearance, LatticeTheme};
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return Ok(());
        }
        for (appearance, language, look) in [
            (Appearance::Light, InterfaceLanguage::En, "light"),
            (Appearance::Dark, InterfaceLanguage::En, "dark"),
            (Appearance::Light, InterfaceLanguage::ZhCn, "zh-light"),
            (Appearance::Dark, InterfaceLanguage::ZhCn, "zh-dark"),
        ] {
            cx.update(|cx| {
                LatticeTheme::set_appearance(appearance, cx);
                crate::settings::update_appearance(cx, |a| a.interface_language = language);
            });
            self.frame_after_input(cx).await?;
            self.pause(cx, Duration::from_millis(300)).await;
            self.papers_shot(cx, &format!("{name}-{look}")).await;
        }
        cx.update(|cx| {
            LatticeTheme::set_appearance(Appearance::Light, cx);
            crate::settings::update_appearance(cx, |a| {
                a.interface_language = InterfaceLanguage::En
            });
        });
        self.frame_after_input(cx).await?;
        Ok(())
    }

    fn papers_key(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }

    /// Where the list's keyboard is: the paper it holds, and whether the
    /// box holds it instead.
    fn papers_keyboard_at(
        &self,
        cx: &mut AsyncApp,
        papers: &gpui::Entity<PapersPanel>,
    ) -> Result<(Option<String>, bool)> {
        let papers = papers.clone();
        self.with_window(cx, move |_, window, cx| {
            let (stop, in_box) = papers.read(cx).keyboard(window, cx);
            (stop.map(|stop| stop.key), in_box)
        })
    }

    async fn papers_keyboard(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<PapersPanel>,
    ) -> Result<()> {
        let panel = papers.clone();
        self.with_window(cx, move |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.type_query("", window, cx);
                panel.focus_box(window, cx);
            })
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let order: Vec<String> = cx.update(|cx| {
            let panel = papers.read(cx);
            panel
                .shown(cx)
                .into_iter()
                .map(crate::papers::model::paper_key)
                .collect()
        });
        let mut walked = Vec::new();
        for keys in ["down", "down", "up", "up"] {
            self.papers_key(cx, keys)?;
            self.pause(cx, Duration::from_millis(60)).await;
            walked.push(self.papers_keyboard_at(cx, papers)?);
            if walked.len() == 2 {
                self.papers_looks(cx, "papers-keyboard").await?;
            }
        }
        let first = order.first().cloned();
        let second = order.get(1).cloned();
        steps.check(
            "the box's down arrow comes into the Papers list, the arrows walk it and the up arrow from the first paper goes back to the box",
            order.len() == 2
                && walked
                    == [
                        (first.clone(), false),
                        (second, false),
                        (first, false),
                        (None, true),
                    ],
            json!({ "order": order, "walked": format!("{walked:?}") }),
        );
        Ok(())
    }

    async fn papers_research_rows(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let rows = self.with_window(cx, |shell, _, cx| {
            let context = shell.read(cx).command_context(cx);
            crate::shell::commands::commands(&context)
                .into_iter()
                .filter(|command| command.section == crate::shell::commands::Section::Research)
                .map(|command| (command.id.to_string(), format!("{:?}", command.section)))
                .collect::<Vec<_>>()
        })?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::research_flow::AddPapers), cx)
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).add_papers().is_some()
            })
            .await;
        self.papers_looks(cx, "papers-6-add-from-palette").await?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        steps.check(
            "the palette lists Add papers, Discover literature and Check references under Research, and Add papers opens from it",
            rows == [
                ("bib".to_string(), "Research".to_string()),
                ("discover".to_string(), "Research".to_string()),
                ("check-references".to_string(), "Research".to_string()),
            ] && opened,
            json!({ "rows": rows, "opened": opened }),
        );
        Ok(())
    }

    /// Add papers' full-text switch decides what an import started after it
    /// does, and the import keeps that choice when the switch moves again:
    /// the box's pending row names Metadata alone, or Metadata, Full text
    /// and Overview, and Add papers' own batch saves the full text or not
    /// as the switch said at Add.
    async fn papers_full_text_setting(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &gpui::Entity<PapersPanel>,
    ) -> Result<()> {
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .ok_or_else(|| anyhow::anyhow!("the Papers e2e needs a project"))?;
        let manifest =
            lattice_core::project::read_manifest(&root).map_err(|error| anyhow::anyhow!(error))?;
        let bibliography = root.join(manifest.primary_bibliography);
        let original = std::fs::read_to_string(&bibliography)?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::research_flow::AddPapers), cx)
        })?;
        let sheet = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).add_papers().is_some()
            })
            .await
            .then(|| cx.update(|cx| self.shell.read(cx).add_papers().cloned()))
            .flatten();
        let Some(sheet) = sheet else {
            steps.check(FULL_TEXT_STEP, false, json!({ "sheet": false }));
            return Ok(());
        };
        // The switch starts on, so its first click turns it off.
        cx.update(|cx| crate::settings::update(cx, |settings| settings.save_full_text = true));
        let mut seen = Vec::new();
        for (entry, key) in [(SKIP_ENTRY, SKIP_KEY), (SAVE_ENTRY, SAVE_KEY)] {
            // A click on the switch, then the box's import of a pasted
            // entry (no lookup, so offline), then the switch again while
            // it runs.
            let (sheet, panel) = (sheet.clone(), papers.clone());
            let stages = self.with_window(cx, move |_, window, cx| {
                sheet.update(cx, |sheet, cx| sheet.toggle_full_text(window, cx));
                let on = crate::settings::get(cx).save_full_text;
                let started = panel.update(cx, |panel, cx| {
                    panel.import_entry(entry.to_string(), key.to_string(), false, cx)
                });
                let first = panel.read(cx).pending_stages();
                sheet.update(cx, |sheet, cx| sheet.toggle_full_text(window, cx));
                let moved = panel.read(cx).pending_stages();
                sheet.update(cx, |sheet, cx| sheet.toggle_full_text(window, cx));
                (on, started, first, moved)
            })?;
            let landed = self
                .wait_for(cx, Duration::from_secs(15), |_, cx| {
                    let panel = papers.read(cx);
                    panel.importing.is_none()
                        && panel
                            .papers
                            .iter()
                            .any(|paper| paper.citation_key.as_deref() == Some(key))
                })
                .await;
            seen.push((stages, landed));
        }
        // Add papers' own Add, in a sheet of its own each time: its batch
        // saves what the switch said at Add, and keeps that when the switch
        // moves while it runs.
        let mut batches = Vec::new();
        for (entry, key, on) in [
            (BATCH_SKIP_ENTRY, BATCH_SKIP_KEY, false),
            (BATCH_ENTRY, BATCH_KEY, true),
        ] {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx));
                window.dispatch_action(Box::new(crate::shell::research_flow::AddPapers), cx)
            })?;
            let opened = self
                .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                    shell.read(cx).add_papers().is_some()
                })
                .await
                .then(|| cx.update(|cx| self.shell.read(cx).add_papers().cloned()))
                .flatten();
            let Some(sheet) = opened else {
                batches.push(json!({ "sheet": false }));
                continue;
            };
            let pasted = sheet.clone();
            self.with_window(cx, move |_, window, cx| {
                if crate::settings::get(cx).save_full_text != on {
                    pasted.update(cx, |sheet, cx| sheet.toggle_full_text(window, cx));
                }
                pasted.update(cx, |sheet, cx| sheet.paste(entry, window, cx))
            })?;
            let listed = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    sheet
                        .read(cx)
                        .row_states(cx)
                        .iter()
                        .any(|(_, state)| *state == crate::papers::add_sheet::RowState::New)
                })
                .await;
            let (adder, panel) = (sheet.clone(), papers.clone());
            let (switch, first, moved) = self.with_window(cx, move |_, window, cx| {
                let switch = crate::settings::get(cx).save_full_text;
                adder.update(cx, |sheet, cx| sheet.add(cx));
                let first = panel.read(cx).batch_full_text();
                adder.update(cx, |sheet, cx| sheet.toggle_full_text(window, cx));
                let moved = panel.read(cx).batch_full_text();
                (switch, first, moved)
            })?;
            let landed = self
                .wait_for(cx, Duration::from_secs(15), |_, cx| {
                    let panel = papers.read(cx);
                    !panel.batch.running
                        && panel
                            .papers
                            .iter()
                            .any(|paper| paper.citation_key.as_deref() == Some(key))
                })
                .await;
            batches.push(json!({
                "switch": switch,
                "listed": listed,
                "first": first.map(|full_text| format!("{full_text:?}")),
                "moved": moved.map(|full_text| format!("{full_text:?}")),
                "landed": landed,
            }));
        }
        std::fs::write(&bibliography, original)?;
        cx.update(|cx| {
            crate::settings::update(cx, |settings| settings.save_full_text = false);
            papers.update(cx, |panel, cx| panel.reload(cx));
        });
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        let restored = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                !papers.read(cx).papers.iter().any(|paper| {
                    matches!(
                        paper.citation_key.as_deref(),
                        Some(SKIP_KEY | SAVE_KEY | BATCH_SKIP_KEY | BATCH_KEY)
                    )
                })
            })
            .await;
        let metadata: &[&str] = &["resolving"];
        let everything: &[&str] = &["resolving", "fulltext", "overview"];
        let expected = [
            ((false, true, Some(metadata), Some(metadata)), true),
            ((true, true, Some(everything), Some(everything)), true),
        ];
        let batch = |switch: bool, full_text: &str| {
            json!({
                "switch": switch,
                "listed": true,
                "first": full_text,
                "moved": full_text,
                "landed": true,
            })
        };
        let batches_expected = vec![batch(false, "Skip"), batch(true, "Save")];
        steps.check(
            FULL_TEXT_STEP,
            seen == expected && batches == batches_expected && restored,
            json!({
                "seen": format!("{seen:?}"),
                "batches": batches,
                "restored": restored,
            }),
        );
        Ok(())
    }

    async fn add_reference_form(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::research_flow::AddPapers), cx)
        })?;
        let sheet = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).add_papers().is_some()
            })
            .await
            .then(|| cx.update(|cx| self.shell.read(cx).add_papers().cloned()))
            .flatten();
        let Some(sheet) = sheet else {
            steps.check(
                "Add reference opens from Add papers' Enter manually",
                false,
                json!({}),
            );
            return Ok(());
        };
        cx.update(|cx| {
            sheet.update(cx, |_, cx| {
                cx.emit(crate::papers::add_sheet::AddPapersEvent::EnterManually)
            })
        });
        let form = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).add_reference().is_some()
            })
            .await
            .then(|| cx.update(|cx| self.shell.read(cx).add_reference().cloned()))
            .flatten();
        let Some(form) = form else {
            steps.check(
                "Add reference opens from Add papers' Enter manually",
                false,
                json!({}),
            );
            return Ok(());
        };
        let entered = form.clone();
        self.with_window(cx, move |_, window, cx| {
            entered.update(cx, |form, cx| {
                form.fill_for_scenario(
                    (
                        "A Mathematical Theory of Communication",
                        "Shannon, Claude E.",
                        "1948",
                    ),
                    window,
                    cx,
                );
                form.step_year_for_scenario(1, window, cx);
                form.step_year_for_scenario(1, window, cx);
                form.step_year_for_scenario(-1, window, cx);
            })
        })?;
        let (preview, fields, cite, year) =
            cx.update(|cx| form.update(cx, |form, cx| form.preview_for_scenario(cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        self.papers_looks(cx, "papers-7-add-reference").await?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        steps.check(
            "Add reference entered by hand steps its year, previews the BibTeX it will write and offers to cite it at the caret",
            fields
                && cite
                && year == "1949"
                && preview.starts_with("@article{shannon1949")
                && preview.contains("year = {1949}"),
            json!({ "preview": preview, "year": year, "cite": cite }),
        );
        Ok(())
    }
}

const FULL_TEXT_STEP: &str = "after Add papers' \"Also save full text\" switch, the box's import saves the citation alone or the full text too, and so does Add papers' own Add, each keeping its choice when the switch moves";

/// Pasted entries, imported as they stand without a lookup.
const SKIP_KEY: &str = "e2efulltextoff2024";
const SKIP_ENTRY: &str = "@article{e2efulltextoff2024,\n  title = {Switch Off Paper},\n  author = {Writer, Ada},\n  journal = {Journal of Tests},\n  year = {2024}\n}\n";
const SAVE_KEY: &str = "e2efulltexton2024";
const SAVE_ENTRY: &str = "@article{e2efulltexton2024,\n  title = {Switch On Paper},\n  author = {Writer, Ada},\n  journal = {Journal of Tests},\n  year = {2024}\n}\n";
const BATCH_KEY: &str = "e2efulltextbatch2024";
const BATCH_ENTRY: &str = "@article{e2efulltextbatch2024,\n  title = {Switch Batch Paper},\n  author = {Writer, Ada},\n  journal = {Journal of Tests},\n  year = {2024}\n}\n";
const BATCH_SKIP_KEY: &str = "e2efulltextbatchoff2024";
const BATCH_SKIP_ENTRY: &str = "@article{e2efulltextbatchoff2024,\n  title = {Switch Batch Off Paper},\n  author = {Writer, Ada},\n  journal = {Journal of Tests},\n  year = {2024}\n}\n";
