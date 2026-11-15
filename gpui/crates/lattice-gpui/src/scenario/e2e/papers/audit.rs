//! Check references' review queue, offline: the sheet read, its references
//! are given the findings a check would have (a fix that fills in blank
//! fields, one that publishes a preprint, and an unverified candidate), and
//! the writer walks them from the keyboard as the Tauri app's queue does
//! (`reference-check-keys.ts`): wide, the list stands beside the first fix;
//! J and K walk the list, S skips to the next finding, and A applies the
//! open fix, writes it into the `.bib` and moves to the next. The shortcut
//! sheet lists the queue's keys under Check references. With
//! `LATTICE_E2E_SHOTS=DIR` it saves the queue on a fix with its edits
//! marked, and on the candidate's word comparison, light and dark, in
//! English and Simplified Chinese.

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
        self.shortcut_sheet_references(cx, steps).await
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
