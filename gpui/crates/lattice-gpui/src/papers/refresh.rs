//! Refresh entry (`refresh-cited-entry.ts`): re-adding a paper that is
//! already cited leaves its entry alone, so the notice saying so offers to
//! put that entry through the check Add papers runs on a new record, and to
//! write the result unless it would replace a value the writer stated (a
//! disputed fix, which waits in Check references like any other).
//!
//! The shell saves what the editors hold first, as the Tauri app saves the
//! document in front, then hands the key back to [`PapersPanel::refresh_saved`].

use gpui::{AppContext as _, Context};
use lattice_core::citation_audit;
use lattice_i18n::t;

use super::{
    PapersPanel,
    audit::{Finding, FixGroup, fix_group},
};
use crate::notices;

/// What refreshing one cited entry did.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// Rewrote it from its sources.
    Updated,
    /// It already matched them.
    Current,
    /// The sources differ in a way the writer decides, in Check references.
    Review,
}

/// What a check of the entry asks for: written, left as it is, or reviewed.
fn decide(finding: &Finding) -> Option<Outcome> {
    if finding.status == "checked" {
        return Some(Outcome::Current);
    }
    if finding.status != "update"
        || finding.after.is_none()
        || finding.candidate.is_some()
        || fix_group(&finding.changes) == FixGroup::Disputed
    {
        return Some(Outcome::Review);
    }
    None
}

fn refresh(root: &std::path::Path, bibliography: &str, key: &str) -> Result<Outcome, String> {
    let scan = citation_audit::scan(root)?;
    let Some(entry) = scan
        .entries
        .into_iter()
        .find(|entry| entry.inline.is_none() && entry.path == bibliography && entry.key == key)
    else {
        return Ok(Outcome::Review);
    };
    let (path, before) = (entry.path.clone(), entry.bibtex.clone());
    let result = citation_audit::check_entry(root, entry, None)?;
    let finding = Finding::from_core(&result)
        .ok_or_else(|| "The check's answer could not be read.".to_string())?;
    if let Some(outcome) = decide(&finding) {
        return Ok(outcome);
    }
    let after = finding.after.unwrap_or_default();
    citation_audit::apply(root, &path, key, &before, &after)?;
    Ok(Outcome::Updated)
}

impl PapersPanel {
    /// Check the cited entry `key` against its sources and write what they
    /// say, the editors' edits saved already.
    pub(crate) fn refresh_saved(&mut self, key: String, cx: &mut Context<Self>) {
        let (Some(root), Some(project)) = (self.root.clone(), self.project.clone()) else {
            return;
        };
        let bibliography = project.read(cx).manifest().primary_bibliography.clone();
        if bibliography.is_empty() {
            return;
        }
        let command = format!("\\cite{{{key}}}");
        let job_root = root.clone();
        let job = cx.background_spawn(async move { refresh(&job_root, &bibliography, &key) });
        cx.spawn(async move |this, cx| {
            let outcome = job.await;
            this.update(cx, |this, cx| {
                // A project switched meanwhile has its own papers.
                if this.root.as_deref() != Some(root.as_path()) {
                    return;
                }
                match outcome {
                    Ok(Outcome::Updated) => {
                        notices::info(
                            t!("Papers"),
                            t!(
                                "Updated the entry for {citationCommand} from its sources.",
                                citationCommand = command
                            ),
                            cx,
                        );
                        cx.emit(super::PapersEvent::Rewritten);
                        this.reload(cx);
                    }
                    Ok(Outcome::Current) => notices::info(
                        t!("Papers"),
                        t!(
                            "The entry for {citationCommand} already matches its sources.",
                            citationCommand = command
                        ),
                        cx,
                    ),
                    Ok(Outcome::Review) => notices::warning(
                        t!(
                            "The sources differ from the entry for {citationCommand}. Compare them in Check references.",
                            citationCommand = command
                        ),
                        cx,
                    ),
                    Err(error) => notices::error(t!("Papers"), error, cx),
                }
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::audit::Change;

    fn finding(status: &str, after: Option<&str>, changes: Vec<Change>) -> Finding {
        Finding {
            status: status.into(),
            after: after.map(str::to_string),
            changes,
            ..Default::default()
        }
    }

    #[test]
    fn a_checked_entry_is_current_and_an_unclear_one_waits_for_review() {
        assert_eq!(
            decide(&finding("checked", None, vec![])),
            Some(Outcome::Current)
        );
        assert_eq!(
            decide(&finding("update", None, vec![])),
            Some(Outcome::Review)
        );
        assert_eq!(
            decide(&finding("not_found", None, vec![])),
            Some(Outcome::Review)
        );
        let mut candidate = finding("update", Some("@article{a,}"), vec![]);
        candidate.candidate = Some(Default::default());
        assert_eq!(decide(&candidate), Some(Outcome::Review));
    }

    #[test]
    fn an_update_that_only_fills_in_is_written() {
        let filled = Change {
            field: "doi".into(),
            before: String::new(),
            after: "10.1/x".into(),
        };
        assert_eq!(
            decide(&finding("update", Some("@article{a,}"), vec![filled])),
            None
        );
    }
}
