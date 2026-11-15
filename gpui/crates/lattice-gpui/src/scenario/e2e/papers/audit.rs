//! Check references' review queue, offline: the sheet read, its references
//! are given the findings a check would have (a fix that fills in blank
//! fields, one that publishes a preprint, and an unverified candidate), and
//! the writer walks them from the keyboard as the Tauri app's queue does
//! (`reference-check-keys.ts`): wide, the list stands beside the first fix;
//! J and K walk the list, S skips to the next finding, and A applies the
//! open fix, writes it into the `.bib` and moves to the next. Ticking
//! references shows Select all and Check selected, which checks only the
//! ticked ones; the last fix applied settles the report, whose pane shows
//! the reading glass. The shortcut sheet lists the queue's keys under Check
//! references. With `LATTICE_E2E_SHOTS=DIR` it saves the queue on a fix
//! with its edits marked, on the candidate's word comparison, with two
//! references ticked and settled, light and dark, in English and
//! Simplified Chinese.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Keystroke};
use serde_json::{Value, json};

use super::super::Steps;
use crate::{
    papers::audit::{Candidate, Change, Finding, Source},
    scenario::Run,
};

fn change(field: &str, before: &str, after: &str) -> Change {
    Change {
        field: field.into(),
        before: before.into(),
        after: after.into(),
    }
}

/// What a check would have said of each reference the fixture holds.
fn finding(entry: &lattice_core::citation_audit::AuditEntry) -> Option<Finding> {
    let before = entry.bibtex.clone();
    let update = |after: String, changes: Vec<Change>| Finding {
        status: "update".into(),
        message: "A published version is available.".into(),
        before: before.clone(),
        after: Some(after),
        changes,
        ..Finding::default()
    };
    match entry.key.as_str() {
        // Blank fields filled in: two that print, one that does not.
        "knuth1984" => Some(update(
            before.replace(
                "  year = {1984}",
                "  volume = {A},\n  pages = {1--483},\n  doi = {10.5555/1102013},\n  year = {1984}",
            ),
            vec![
                change("volume", "", "A"),
                change("pages", "", "1--483"),
                change("doi", "", "10.5555/1102013"),
            ],
        )),
        "vaswani2017attention" => Some(update(
            before.replace("journal = {NeurIPS}", "booktitle = {Advances in Neural Information Processing Systems 30}"),
            vec![
                change("journal", "NeurIPS", ""),
                change("booktitle", "", "Advances in Neural Information Processing Systems 30"),
            ],
        )),
        "unsaved2024" => Some(Finding {
            status: "unavailable".into(),
            message: "identity_conflict".into(),
            publication_reason: Some("identity_conflict".into()),
            before,
            sources: vec![
                Source { source: "dblp".into(), outcome: "candidate_cached".into() },
                Source { source: "crossref".into(), outcome: "forbidden".into() },
            ],
            candidate: Some(Candidate {
                bibtex: "@inproceedings{other,\n  title = {Typed, Then Saved},\n  publisher = {Candidate Press}\n}".into(),
                changes: vec![
                    change("title", "Typed, Not Saved", "Typed, Then Saved"),
                    change("publisher", "Original Press", "Candidate Press"),
                ],
                reasons: vec!["title".into(), "year".into()],
            }),
            ..Finding::default()
        }),
        _ => None,
    }
}

impl Run {
    /// The open finding's key and whether the queue is up.
    fn audit_open(&self, cx: &mut AsyncApp) -> (Option<String>, bool) {
        cx.update(|cx| {
            self.shell
                .read(cx)
                .audit()
                .map(|audit| audit.read(cx).open_key())
                .unwrap_or_default()
        })
    }

    async fn audit_key(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<Option<String>> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx)
        })?;
        self.frame_after_input(cx).await?;
        Ok(self.audit_open(cx).0)
    }

    pub(super) async fn check_references_queue(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        cx.update(|cx| {
            if let Some(audit) = self.shell.read(cx).audit().cloned() {
                audit.update(cx, |audit, cx| audit.seed(finding, cx));
            }
        });
        self.frame_after_input(cx).await?;
        let (opened, queue) = self.audit_open(cx);
        let width = self.with_window(cx, |_, window, _| f32::from(window.viewport_size().width))?;
        steps.check(
            "wide, Check references stands its list beside the first fix to review",
            queue && opened.as_deref() == Some("knuth1984"),
            json!({ "open": opened, "queue": queue, "width": width }),
        );
        self.papers_looks(cx, "papers-7-audit-queue-fix").await?;

        let next = self.audit_key(cx, "j").await?;
        let back = self.audit_key(cx, "k").await?;
        let skipped = self.audit_key(cx, "s").await?;
        let candidate = self.audit_key(cx, "j").await?;
        // The end of the list holds.
        let end = self.audit_key(cx, "j").await?;
        steps.check(
            "J and K walk the queue, S skips to the next finding, and J stops at the end",
            next.as_deref() == Some("vaswani2017attention")
                && back.as_deref() == Some("knuth1984")
                && skipped.as_deref() == Some("vaswani2017attention")
                && candidate.as_deref() == Some("unsaved2024")
                && end.as_deref() == Some("unsaved2024"),
            json!({ "j": next, "k": back, "s": skipped, "candidate": candidate, "end": end }),
        );
        self.papers_looks(cx, "papers-8-audit-candidate-compare")
            .await?;

        self.audit_key(cx, "k").await?;
        self.audit_key(cx, "k").await?;
        self.audit_key(cx, "a").await?;
        let bibliography = root.join("references.bib");
        let applied = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).audit().is_some_and(|audit| {
                    let audit = audit.read(cx);
                    !audit.is_applying()
                        && audit.rows().iter().any(|(key, bucket)| {
                            key == "knuth1984" && format!("{bucket:?}") == "Verified"
                        })
                })
            })
            .await;
        let written = std::fs::read_to_string(&bibliography).unwrap_or_default();
        let (after_apply, _) = self.audit_open(cx);
        steps.check(
            "A applies the open fix into the .bib and moves on to the next finding",
            applied
                && written.contains("pages = {1--483}")
                && after_apply.as_deref() == Some("vaswani2017attention"),
            json!({ "applied": applied, "open": after_apply, "written": written.contains("1--483") }),
        );
        self.check_references_narrow(cx, steps).await?;
        self.check_references_selection(cx, steps).await?;
        self.check_references_settled(cx, steps).await?;
        self.shortcut_sheet_references(cx, steps).await
    }

    fn audit_update<R>(
        &self,
        cx: &mut AsyncApp,
        f: impl FnOnce(
            &mut crate::papers::audit::Audit,
            &mut gpui::Context<crate::papers::audit::Audit>,
        ) -> R,
    ) -> Option<R> {
        cx.update(|cx| {
            let audit = self.shell.read(cx).audit().cloned()?;
            Some(audit.update(cx, f))
        })
    }

    /// Ticking references as the Tauri sheet's test does (`checks one row
    /// without its neighbors, then only selected rows`): two ticked show the
    /// bar with Select all mixed, Select all ticks the rest and a press on the
    /// full box clears them, and Check selected checks only the ticked ones,
    /// clearing the ticks once the references are read again. The run is
    /// cancelled as soon as it has counted them, so nothing is looked up.
    async fn check_references_selection(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        use lattice_ui::components::CheckState;
        let picked = ["knuth1984", "unsaved2024"];
        for key in picked {
            self.audit_update(cx, |audit, cx| audit.tick(key, true, cx));
        }
        self.frame_after_input(cx).await?;
        let (two, two_box) = self
            .audit_update(cx, |audit, _| audit.ticked())
            .unwrap_or_default();
        self.papers_looks(cx, "papers-9-audit-selection").await?;
        self.audit_update(cx, |audit, cx| audit.press_select_all(cx));
        let (all, all_box) = self
            .audit_update(cx, |audit, _| audit.ticked())
            .unwrap_or_default();
        self.audit_update(cx, |audit, cx| audit.press_select_all(cx));
        let (none, _) = self
            .audit_update(cx, |audit, _| audit.ticked())
            .unwrap_or_default();
        let total = cx.update(|cx| {
            self.shell
                .read(cx)
                .audit()
                .map_or(0, |audit| audit.read(cx).rows().len())
        });
        steps.check(
            "ticking two references shows Select all mixed; Select all ticks every reference, and pressed again clears them",
            two == picked
                && two_box == CheckState::Mixed
                && all.len() == total
                && total > picked.len()
                && all_box == CheckState::On
                && none.is_empty(),
            json!({ "two": two, "two_box": format!("{two_box:?}"), "all": all.len(), "total": total, "all_box": format!("{all_box:?}"), "cleared": none }),
        );

        for key in picked {
            self.audit_update(cx, |audit, cx| audit.tick(key, true, cx));
        }
        self.audit_update(cx, |audit, cx| audit.press_check_selected(cx));
        let mut run = None;
        let counted = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let Some(audit) = shell.read(cx).audit().cloned() else {
                    return false;
                };
                let Some(keys) = audit.read(cx).run_keys() else {
                    return false;
                };
                run = Some(keys);
                // Cancelled before Semantic Scholar's head start runs out:
                // no reference is looked up on its own.
                audit.update(cx, |audit, cx| audit.press_cancel(cx));
                true
            })
            .await;
        let finished = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                shell
                    .read(cx)
                    .audit()
                    .is_some_and(|audit| !audit.read(cx).is_busy())
            })
            .await;
        let (after, _) = self
            .audit_update(cx, |audit, _| audit.ticked())
            .unwrap_or_default();
        let (run_total, run_keys) = run.clone().unwrap_or_default();
        steps.check(
            "Check selected checks only the ticked references, and the fresh read clears the ticks",
            counted
                && finished
                && run_total == picked.len()
                && run_keys == ["knuth1984", "unsaved2024"]
                && after.is_empty(),
            json!({ "counted": counted, "finished": finished, "run": run, "ticked_after": after }),
        );
        Ok(())
    }

    /// The last fix applied with every other reference verified: nothing is
    /// left to act on, so Apply opens no next finding and the queue's pane
    /// shows the research desk's reading glass.
    async fn check_references_settled(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.audit_update(cx, |audit, cx| {
            audit.seed(
                |entry| {
                    (entry.key != "vaswani2017attention").then(|| Finding {
                        status: "checked".into(),
                        message: "The record matches.".into(),
                        before: entry.bibtex.clone(),
                        ..Finding::default()
                    })
                },
                cx,
            )
        });
        self.frame_after_input(cx).await?;
        let (last, _) = self.audit_open(cx);
        self.audit_key(cx, "a").await?;
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            shell.read(cx).audit().is_some_and(|audit| {
                let audit = audit.read(cx);
                !audit.is_applying() && audit.is_settled()
            })
        })
        .await;
        self.frame_after_input(cx).await?;
        let settled = self
            .audit_update(cx, |audit, _| audit.is_settled())
            .unwrap_or(false);
        let (open, queue) = self.audit_open(cx);
        self.papers_looks(cx, "papers-10-audit-settled").await?;
        steps.check(
            "applying the last fix settles the report: the queue opens nothing and shows the reading glass",
            last.as_deref() == Some("vaswani2017attention") && settled && queue && open.is_none(),
            json!({ "last": last, "settled": settled, "queue": queue, "open": open }),
        );
        Ok(())
    }

    /// Below Tauri's `queueWidth` (800px) the list stands alone and the open
    /// finding unfolds under its row; back at full width the queue returns.
    async fn check_references_narrow(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let resize = |width: f32, height: f32| {
            move |_: &gpui::Entity<crate::shell::Shell>,
                  window: &mut gpui::Window,
                  _: &mut gpui::App| {
                window.resize(gpui::size(gpui::px(width), gpui::px(height)))
            }
        };
        let (wide_width, wide_height) = self.with_window(cx, |_, window, _| {
            let size = window.viewport_size();
            (f32::from(size.width), f32::from(size.height))
        })?;
        self.with_window(cx, resize(720., wide_height))?;
        self.wait_for(cx, Duration::from_secs(3), |_, cx| {
            self.window
                .update(cx, |_, window, _| {
                    f32::from(window.viewport_size().width) < 800.
                })
                .unwrap_or(false)
        })
        .await;
        for _ in 0..2 {
            self.with_window(cx, |shell, _, cx| shell.update(cx, |_, cx| cx.notify()))?;
            self.frame_after_input(cx).await?;
        }
        let narrow_width =
            self.with_window(cx, |_, window, _| f32::from(window.viewport_size().width))?;
        let (narrow_open, narrow_queue) = self.audit_open(cx);
        self.papers_looks(cx, "papers-7b-audit-narrow").await?;

        self.with_window(cx, resize(wide_width, wide_height))?;
        self.wait_for(cx, Duration::from_secs(3), |_, cx| {
            self.window
                .update(cx, |_, window, _| {
                    (f32::from(window.viewport_size().width) - wide_width).abs() < 1.
                })
                .unwrap_or(false)
        })
        .await;
        for _ in 0..2 {
            self.with_window(cx, |shell, _, cx| shell.update(cx, |_, cx| cx.notify()))?;
            self.frame_after_input(cx).await?;
        }
        let (wide_open, wide_queue) = self.audit_open(cx);
        steps.check(
            "narrower than 800px, Check references drops the side pane and keeps the open finding under its row; wide again, the queue returns",
            narrow_width < 800.
                && !narrow_queue
                && narrow_open.as_deref() == Some("vaswani2017attention")
                && wide_queue
                && wide_open.as_deref() == Some("vaswani2017attention"),
            json!({
                "narrow": { "width": narrow_width, "queue": narrow_queue, "open": narrow_open },
                "wide": { "width": wide_width, "queue": wide_queue, "open": wide_open },
            }),
        );
        Ok(())
    }

    /// The shortcut sheet's Check references group, from the keymap.
    async fn shortcut_sheet_references(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_shortcuts(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let rows: Vec<Value> = cx.update(|cx| {
            let Some(sheet) = self.shell.read(cx).shortcuts_view() else {
                return Vec::new();
            };
            sheet
                .read(cx)
                .shown()
                .iter()
                .filter(|group| group.title == "Check references")
                .flat_map(|group| group.rows.iter())
                .map(|row| {
                    json!([
                        row.label.to_string(),
                        row.combos
                            .iter()
                            .map(|keys| keys.to_string())
                            .collect::<Vec<_>>()
                    ])
                })
                .collect()
        });
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        let chord = if cfg!(target_os = "macos") {
            "⌘↩"
        } else {
            "Ctrl+↩"
        };
        steps.check(
            "the shortcut sheet lists the review queue's keys under Check references",
            rows == [
                json!(["Next reference", ["J"]]),
                json!(["Previous reference", ["K"]]),
                json!(["Apply the fix", ["A", chord]]),
                json!(["Skip to the next finding", ["S"]]),
            ],
            json!({ "rows": rows }),
        );
        Ok(())
    }
}
