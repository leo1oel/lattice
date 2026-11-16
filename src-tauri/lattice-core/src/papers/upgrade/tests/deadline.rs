//! The Agent's upgrade within its request's deadline, against a bibcite that
//! takes a second per preprint as the real one does. Before per-entry checks,
//! a dozen preprints ran serially past the 30-second deadline every time, and
//! one rejected proposal discarded every other upgrade.

use super::*;
use crate::agent_literature::AgentBibliographyMutation;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn preprint(key: &str) -> String {
    format!(
        "@misc{{{key},\n  title = {{Paper {key}}},\n  author = {{Smith, Alice}},\n  journal = {{arXiv preprint}},\n  year = {{2024}}\n}}\n\n"
    )
}

/// A bibcite whose `upgrade` takes a second and publishes the preprint at
/// `10.5555/<key>` (except `bad`, whose proposal swaps the title), whose
/// `get` returns that DOI's record, and which logs every call.
fn slow_bibcite(project: &TestProject) -> (std::path::PathBuf, std::path::PathBuf) {
    let log = project.parent.join("calls.log");
    let tool = project.parent.join("bibcite");
    write_test_tool(
        &tool,
        &format!(
            r#"#!/bin/sh
set -eu
case "$1" in
  upgrade)
    [ "$2" = --no-tidy ] || exit 23
    key=$(sed -n 's/^@misc{{\([^,]*\),.*/\1/p' "$3")
    echo "upgrade $key" >> '{log}'
    sleep 1
    [ "$key" != bad ] || sed -i.orig 's/title = {{Paper bad}}/title = {{A Different Paper}}/' "$3"
    sed -i.orig -e 's/^@misc{{/@inproceedings{{/' -e "s|journal = {{arXiv preprint}}|booktitle = {{Conference on Tests}}, doi = {{10.5555/$key}}|" "$3"
    printf '{{"upgraded": 1, "matched": 1, "entries": [{{"key": "%s", "matched": true, "venue": "Conference on Tests", "source": "dblp"}}]}}\n' "$key"
    ;;
  get)
    key=${{3#10.5555/}}
    echo "get $key" >> '{log}'
    printf '{{"key": "%s", "source": "crossref", "bibtex": "@inproceedings{{%s, title = {{Paper %s}}, author = {{Smith, Alice}}, booktitle = {{Conference on Tests}}, year = {{2024}}, doi = {{%s}}}}"}}\n' "$key" "$key" "$key" "$3"
    ;;
  *) exit 25 ;;
esac
"#,
            log = log.display(),
        ),
    );
    (tool, log)
}

fn unix_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

#[test]
fn agent_upgrade_answers_before_its_deadline_and_continues_without_repeating_lookups() {
    let _lock = tool_lock();
    let keys: Vec<String> = (1..=9).map(|n| format!("p{n}")).collect();
    let project = TestProject::new(&keys.iter().map(|key| preprint(key)).collect::<String>());
    let (tool, log) = slow_bibcite(&project);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);

    let mut calls = 0;
    let last = loop {
        calls += 1;
        assert!(calls <= 5, "the upgrade never completed");
        // The broker's deadline, as Lattice receives it in `expiresAt`.
        let window = Duration::from_millis(10_500);
        let deadline = Instant::now() + window;
        let result = AgentBibliographyMutation::UpgradeBibliography { dry_run: false }
            .run(&project.root, Some(unix_ms(SystemTime::now() + window)))
            .unwrap();
        assert!(Instant::now() < deadline, "answered after the deadline: {result:#}");
        if calls == 1 {
            // Nine preprints at a second each, three at once, cannot finish
            // in the 6.5 s left after the commit margin with a 5 s floor.
            assert_eq!(result["complete"], false, "{result:#}");
            let pending = result["pending"].as_array().unwrap();
            assert!(!pending.is_empty() && pending.len() < keys.len(), "{result:#}");
            assert!(result["summary"]
                .as_str()
                .unwrap()
                .contains("call upgrade_bibliography again"));
            // What finished is saved now, not after the batch.
            assert!(project.bibliography().contains("doi = {10.5555/"), "{result:#}");
        }
        if result["complete"] == true {
            break result;
        }
    };
    assert!(calls >= 2);
    assert!(last["pending"].as_array().unwrap().is_empty());
    let bibliography = project.bibliography();
    for key in &keys {
        assert!(bibliography.contains(&format!("@inproceedings{{{key},")), "{bibliography}");
        assert!(bibliography.contains(&format!("doi = {{10.5555/{key}}}")), "{bibliography}");
    }
    // Continuing never asked bibcite again about a preprint it had answered.
    let calls = std::fs::read_to_string(log).unwrap();
    for key in &keys {
        let upgrades = calls.lines().filter(|line| *line == format!("upgrade {key}")).count();
        assert_eq!(upgrades, 1, "{key}: {calls}");
    }
}

#[test]
fn one_rejected_proposal_leaves_the_other_upgrades_standing() {
    let _lock = tool_lock();
    let before = ["p1", "bad", "p2"].map(preprint).concat();
    let project = TestProject::new(&before);
    let (tool, _) = slow_bibcite(&project);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);

    let result = upgrade_bibliography(&project.root, false, None).unwrap();
    let statuses: Vec<_> = result.report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["key"].as_str().unwrap(), row["status"].as_str().unwrap()))
        .collect();
    assert_eq!(statuses, [("p1", "upgraded"), ("bad", "rejected"), ("p2", "upgraded")]);
    assert!(result.changed && result.complete);
    assert!(result.summary.contains("safety check"), "{}", result.summary);
    let after = project.bibliography();
    assert!(after.contains(&preprint("bad")), "{after}");
    assert!(after.contains("doi = {10.5555/p1}") && after.contains("doi = {10.5555/p2}"));
}
