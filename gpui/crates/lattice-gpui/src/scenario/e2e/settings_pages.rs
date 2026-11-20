//! Settings' pages beyond Appearance and Editor & builds, end to end: every
//! section the Tauri app's Settings lists is in the GPUI app's too, in its
//! order, and each draws its page. Providers, MCP, Skills and Usage & limits
//! share Synara's one settings surface, switched to the section asked for;
//! Model endpoint, Environment and Literature services draw their rows, and
//! Settings search finds the pages and reveals their rows. With Literature
//! services' full-text choice off,
//! adding a Zotero paper attaches no PDF. Acknowledgements lists the shipped
//! notices and opens them in a sheet over Settings, which Escape closes
//! before Settings.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use lattice_settings::{Choice as _, SettingsTab};
use serde_json::json;

use super::{super::Run, Steps};
use crate::{
    papers::{
        batch::{BatchRequest, ZoteroExtras},
        model::ReferenceKind,
    },
    settings,
};

/// Each page, the row it must draw, and for Synara's pages the section.
const PAGES: &[(SettingsTab, Option<&str>, Option<&str>)] = &[
    (SettingsTab::Agent, None, Some("providers")),
    (SettingsTab::Mcp, None, Some("integrations")),
    (SettingsTab::Api, None, Some("skills")),
    (SettingsTab::Usage, None, Some("usage")),
    (SettingsTab::Archived, None, Some("archived")),
    (SettingsTab::ModelEndpoint, Some("model-endpoint-address"), None),
    (SettingsTab::Environment, Some("agent-restart"), None),
    (SettingsTab::Literature, Some("literature-email"), None),
    (SettingsTab::Editor, Some("auto-build"), None),
    (SettingsTab::Acknowledgements, None, None),
];

impl Run {
    pub(super) async fn settings_pages(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let before = cx.update(|cx| settings::get(cx).clone());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Appearance), window, cx)
            })
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| shell.read(cx).settings.is_some())
            .await;
        if !opened {
            steps.check("Settings opens for its other pages", false, json!({}));
            return Ok(());
        }
        let dialog = cx.update(|cx| self.shell.read(cx).settings.clone());
        let Some(dialog) = dialog else {
            return Ok(());
        };

        let mut drawn = Vec::new();
        let mut all = true;
        for (tab, row, section) in PAGES {
            cx.update(|cx| dialog.update(cx, |dialog, cx| dialog.open_tab(*tab, cx)));
            self.pause(cx, Duration::from_millis(300)).await;
            let (shown, rows, synara) = cx.update(|cx| {
                let dialog = dialog.read(cx);
                (dialog.tab(), dialog.drawn_rows(), dialog.synara_section(cx))
            });
            let ok = shown == *tab
                && row.is_none_or(|row| rows.contains(&row))
                && section.is_none_or(|section| synara == section);
            all &= ok;
            drawn.push(json!({
                "tab": tab.tag(), "shown": shown.tag(), "ok": ok,
                "section": synara, "rows": rows.len(),
            }));
        }
        steps.check(
            "every Settings section the Tauri app lists draws its page, Synara's five on one surface",
            all,
            json!({ "pages": drawn }),
        );

        // Search finds the new pages and reveals their rows.
        let mut found = Vec::new();
        let mut searched = true;
        for (query, tab, row) in [
            ("mcp", SettingsTab::Mcp, None),
            ("https_proxy", SettingsTab::Environment, None),
            ("crossref", SettingsTab::Literature, Some("literature-email")),
            ("automatic build", SettingsTab::Editor, Some("auto-build")),
        ] {
            let result = cx.update(|cx| {
                let dialog = dialog.read(cx);
                let entries = settings::search::entries(dialog.has_project(), None);
                settings::search::search(&entries, query).into_iter().next()
            });
            let ok = result
                .as_ref()
                .is_some_and(|entry| entry.tab == tab && entry.id == row);
            if let Some(entry) = result.clone() {
                cx.update(|cx| dialog.update(cx, |dialog, cx| dialog.open_entry(entry, cx)));
                self.pause(cx, Duration::from_millis(250)).await;
            }
            let revealed = cx.update(|cx| dialog.read(cx).revealed_row());
            let ok = ok && revealed == row;
            searched &= ok;
            found.push(json!({ "query": query, "ok": ok, "revealed": revealed }));
        }
        steps.check(
            "Settings search finds the agent, integration and build pages and reveals their rows",
            searched,
            json!({ "found": found }),
        );

        self.citation_only_import(cx, steps, root).await?;

        // Acknowledgements opens the notices in a sheet; Escape closes it
        // and leaves Settings open.
        cx.update(|cx| {
            dialog.update(cx, |dialog, cx| dialog.open_tab(SettingsTab::Acknowledgements, cx))
        });
        self.pause(cx, Duration::from_millis(300)).await;
        self.with_window(cx, |_, window, cx| {
            dialog.update(cx, |dialog, cx| dialog.open_notices(window, cx))
        })?;
        let sheet = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| dialog.read(cx).sheet_open(cx))
            .await;
        // Escape is a native key, which reaches only the key window.
        let front = self.foreground(cx, "settings pages' sheet").await?;
        self.press(cx, '\u{1b}', false).await?;
        drop(front);
        let closed = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| !dialog.read(cx).sheet_open(cx))
            .await;
        let settings_open = cx.update(|cx| self.shell.read(cx).settings.is_some());
        steps.check(
            "Acknowledgements opens the third-party notices over Settings, and Escape closes them first",
            sheet && closed && settings_open,
            json!({ "sheet": sheet, "closed": closed, "settings_open": settings_open }),
        );

        // Put everything back.
        cx.update(|cx| {
            settings::update(cx, |s| {
                s.save_full_text = before.save_full_text;
                s.settings_tab = before.settings_tab;
            })
        });
        self.with_window(cx, |shell, _, cx| shell.update(cx, |shell, cx| shell.close_settings(cx)))?;
        self.pause(cx, Duration::from_millis(200)).await;
        Ok(())
    }

    /// With Literature services' full-text choice off, a Zotero paper with
    /// a PDF is added without it: no attachment is even looked for. The
    /// pasted entry saves no text either way, so its `full_text` is only a
    /// sanity check; the e2e has no offline source whose text Save fetches.
    async fn citation_only_import(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let bibliography = root.join("references.bib");
        let original = std::fs::read_to_string(&bibliography)
            .context("the e2e project needs references.bib")?;
        let papers = cx.update(|cx| self.shell.read(cx).papers().clone());
        let started = cx.update(|cx| {
            settings::update(cx, |s| s.save_full_text = false);
            papers.update(cx, |panel, cx| {
                panel.run_batch(
                    vec![BatchRequest {
                        id: "settings-full-text".into(),
                        input: CITATION_ONLY.into(),
                        label: "Citation Only Paper".into(),
                        kind: ReferenceKind::Bibtex,
                        byline: String::new(),
                        zotero: Some(ZoteroExtras {
                            pdf: Some("E2EPDF01".into()),
                            ..ZoteroExtras::default()
                        }),
                    }],
                    cx,
                )
            })
        });
        let settled = started
            && self
                .wait_for(cx, Duration::from_secs(15), |_, cx| {
                    let panel = papers.read(cx);
                    !panel.batch.running
                        && panel
                            .papers
                            .iter()
                            .any(|paper| paper.citation_key.as_deref() == Some(CITATION_ONLY_KEY))
                })
                .await;
        let outcome = cx.update(|cx| {
            let panel = papers.read(cx);
            let item = panel.batch.items.first();
            let paper = panel
                .papers
                .iter()
                .find(|paper| paper.citation_key.as_deref() == Some(CITATION_ONLY_KEY));
            json!({
                "state": item.map(|item| format!("{:?}", item.state)),
                "note": item.and_then(|item| item.note.clone()),
                "full_text": paper.map(|paper| paper.has_full_text),
                "pdf": paper.map(|paper| paper.has_local_pdf),
            })
        });
        std::fs::write(&bibliography, original)?;
        steps.check(
            "with full text off, adding a Zotero paper attaches no PDF",
            settled
                && outcome["state"] == "Added"
                && outcome["note"].is_null()
                && outcome["full_text"] == false
                && outcome["pdf"] == false,
            json!({ "started": started, "outcome": outcome }),
        );
        Ok(())
    }
}

/// A pasted entry, which is imported as it stands without a lookup.
const CITATION_ONLY_KEY: &str = "e2ecitationonly2024";
const CITATION_ONLY: &str = "@article{e2ecitationonly2024,\n  title = {Citation Only Paper},\n  author = {Writer, Ada},\n  journal = {Journal of Tests},\n  year = {2024}\n}\n";

/// This file's registration as the e2e module `settings_pages` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 61,
    needs: &[],
    setup: true,
    covers: &[
        "gpui/crates/lattice-gpui/src/settings",
        "gpui/crates/lattice-settings/",
        "gpui/islands/agent/settings.tsx",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.settings_pages(cx, steps, &fixture.root)),
};
