use super::*;
use crate::project::entries::{create_entry, delete_entry};
use crate::project::test_support::Fixture;

fn edits(files: &[(&str, &str)]) -> Vec<(String, String)> {
    files.iter().map(|(path, content)| (path.to_string(), content.to_string())).collect()
}

fn editor_save(
    fixture: &Fixture, path: &str, content: &str, base: Option<&str>, expected: Option<&str>,
) -> Result<EditorWriteResult, String> {
    apply_editor_transaction(
        &fixture.root,
        path.to_string(),
        content.to_string(),
        base.map(str::to_string),
        expected.map(str::to_string),
    )
}

#[test]
fn transactions_revert_edits_creations_and_deletions_but_never_newer_changes() {
    let fixture = Fixture::project("transaction");
    let root = &fixture.root;
    fixture.write("main.tex", "before");
    let transaction =
        apply_transaction(root, "edit", edits(&[("main.tex", "after")])).unwrap().unwrap();
    assert_eq!(fixture.read("main.tex"), "after");
    let restore = revert(root, &transaction.id, None).unwrap();
    assert_eq!(fixture.read("main.tex"), "before");
    assert_eq!(history(root).unwrap().len(), 2);
    assert!(transaction_path(root, &transaction.id).unwrap().exists());
    assert_eq!(restore.undo_of.as_deref(), Some(transaction.id.as_str()));
    assert_eq!(restore.kind.as_deref(), Some("restore"));

    // A file changed since the entry is never overwritten by a restore.
    fixture.write("main.tex", "newer");
    let error = revert(root, &transaction.id, None).unwrap_err();
    assert!(error.contains("changed after this history entry"));
    assert_eq!(fixture.read("main.tex"), "newer");
    assert_eq!(history(root).unwrap().len(), 2);

    // Deleting entries forgets them without touching the file.
    for item in history(root).unwrap() {
        delete_history(root, &item.id).unwrap();
    }
    assert_eq!(fixture.read("main.tex"), "newer");
    assert!(history(root).unwrap().is_empty());

    // Creating and deleting files revert as well.
    create_entry(root, "created.tex", "file").unwrap();
    fixture.write("removed.tex", "remove me");
    delete_entry(root, "removed.tex").unwrap();
    for item in history(root).unwrap() {
        let restore = revert(root, &item.id, None).unwrap();
        assert_eq!(restore.undo_of.as_deref(), Some(item.id.as_str()));
    }
    assert!(!fixture.path("created.tex").exists());
    assert_eq!(fixture.read("removed.tex"), "remove me");
}

#[test]
fn live_editor_write_requires_the_expected_disk_snapshot() {
    let fixture = Fixture::empty("live-editor-agent-race");
    fixture.write("section.tex", "agent caption");
    for remote in ["old caption", "remote caption"] {
        let result = editor_save(&fixture, "section.tex", remote, None, Some("old caption"));
        assert!(result.unwrap_err().contains("changed outside live editing"));
        assert_eq!(fixture.read("section.tex"), "agent caption");
    }
    assert!(history(&fixture.root).unwrap().is_empty());
    fs::remove_file(fixture.path("section.tex")).unwrap();
    assert!(
        editor_save(&fixture, "section.tex", "remote caption", None, Some("old caption")).is_err()
    );
    assert!(!fixture.path("section.tex").exists());
    fixture.write("section.tex", "old caption");
    let result =
        editor_save(&fixture, "section.tex", "remote caption", None, Some("old caption")).unwrap();
    assert_eq!(result.content, "remote caption");
    assert_eq!(fixture.read("section.tex"), "remote caption");
}

#[test]
fn editor_saves_merge_against_external_agent_edits() {
    let fixture = Fixture::empty("editor-agent-merge");
    // A stale clean buffer keeps the complete external edit.
    let seed = "# Draft\n\nInitial notes\n";
    let agent_draft = "# Native VLM\n\n## Results\n\n![Result](figures/result.png)\n";
    fixture.write("draft.md", agent_draft);
    let result = editor_save(&fixture, "draft.md", seed, Some(seed), None).unwrap();
    assert_eq!(result.content, agent_draft);
    assert!(result.external_changes_merged && !result.had_conflicts);
    assert_eq!(fixture.read("draft.md"), agent_draft);
    assert!(history(&fixture.root).unwrap().is_empty());

    // Non-overlapping local and agent edits both survive.
    fixture.write("draft.md", "# Finished deck\n\nShared point\n");
    let local = "# Draft\n\nShared point\n\nLocal note\n";
    let result =
        editor_save(&fixture, "draft.md", local, Some("# Draft\n\nShared point\n"), None).unwrap();
    assert!(result.external_changes_merged && !result.had_conflicts);
    assert!(result.content.contains("# Finished deck") && result.content.contains("Local note"));
    assert_eq!(fixture.read("draft.md"), result.content);

    // Overlapping edits keep both sides behind conflict markers.
    fixture.write("draft.md", "# Agent title\n");
    let result =
        editor_save(&fixture, "draft.md", "# Local title\n", Some("# Draft title\n"), None)
            .unwrap();
    assert!(result.had_conflicts);
    for side in ["<<<<<<<", "# Local title", "# Agent title"] {
        assert!(result.content.contains(side), "{side}");
    }
    assert_eq!(fixture.read("draft.md"), result.content);
}

#[test]
fn transaction_rolls_back_files_written_before_a_later_write_fails() {
    let fixture = Fixture::empty("transaction-rollback");
    let outside = Fixture::empty("transaction-rollback-outside");
    fixture.write("first.tex", "first before");
    outside.write("second.tex", "second before");
    std::os::unix::fs::symlink(outside.path("second.tex"), fixture.path("second.tex")).unwrap();

    let two = edits(&[("first.tex", "first after"), ("second.tex", "second after")]);
    assert!(apply_transaction(&fixture.root, "Edit two files", two).is_err());
    assert_eq!(fixture.read("first.tex"), "first before");
    assert_eq!(outside.read("second.tex"), "second before");
    assert!(history(&fixture.root).unwrap().is_empty());
}

#[test]
fn legacy_and_unchanged_history_records_are_read_without_rewriting_them() {
    let fixture = Fixture::empty("legacy-history-metadata");
    let record = |id: &str, label: &str, before: &str| {
        format!(
            r#"{{"id": "{id}", "label": "{label}", "timestamp": "2026-07-29T12:00:00Z",
                "changes": [{{"path":"main.tex","before":"{before}","after":"new"}}]}}"#
        )
    };
    fixture.write(
        ".research/history/legacy.json",
        record("legacy", "Agent: revise the abstract", "old"),
    );
    // A record whose change has no effect is hidden.
    fixture.write(".research/history/unchanged.json", record("unchanged", "Edit main.tex", "new"));

    let items = history(&fixture.root).unwrap();

    assert_eq!(items.len(), 1);
    assert_eq!(
        (items[0].actor.as_str(), items[0].kind.as_str(), items[0].source.as_str()),
        ("agent", "agent", "agent")
    );
    assert_eq!(get_history_entry(&fixture.root, "legacy").unwrap().schema_version, 1);
}

#[test]
fn conversation_checkpoints_are_pruned_by_session_and_total_size() {
    let fixture = Fixture::empty("conversation-checkpoint-limit");
    let sessions = [Uuid::new_v4(), Uuid::new_v4()];
    for session in sessions {
        for _ in 0..4 {
            fixture.write(
                &format!(".research/checkpoints/{session}/{}.json", Uuid::new_v4()),
                "0123456789",
            );
        }
    }

    prune_conversation_checkpoints(&fixture.root, 2, 30).unwrap();

    let remaining = walkdir::WalkDir::new(fixture.path(".research/checkpoints"))
        .into_iter()
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .count();
    assert_eq!(remaining, 3);
    for session in sessions {
        let directory = fixture.path(&format!(".research/checkpoints/{session}"));
        assert!(fs::read_dir(directory).unwrap().count() <= 2);
    }
}

#[test]
fn rapid_edits_coalesce_and_multi_file_entries_restore_single_files() {
    let fixture = Fixture::project("history-coalesce");
    let root = &fixture.root;
    let original = fixture.read("main.tex");
    apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% one\n")])).unwrap();
    apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% two\n")])).unwrap();
    let items = history(root).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].label, "Edit main.tex");
    let entry = get_history_entry(root, &items[0].id).unwrap();
    assert_eq!(entry.changes[0].after.as_deref(), Some("% two\n"));
    assert_eq!(entry.changes[0].before.as_deref(), Some(original.as_str()));
    assert!(get_history_entry(root, "../escape").is_err());

    // Returning to the original content removes the coalesced entry, and
    // saving unchanged content then records nothing.
    for _ in 0..2 {
        let transaction =
            apply_transaction(root, "Edit main.tex", edits(&[("main.tex", &original)])).unwrap();
        assert!(transaction.is_none());
        assert_eq!(fixture.read("main.tex"), original);
        assert!(history(root).unwrap().is_empty());
    }

    // One file of a multi-file entry restores on its own.
    let both = edits(&[("main.tex", "% main-new\n"), ("references.bib", "% bib-new\n")]);
    let entry = apply_transaction(root, "Edit both", both).unwrap().unwrap();
    revert(root, &entry.id, Some("main.tex")).unwrap();
    assert_eq!(fixture.read("main.tex"), original);
    assert_eq!(fixture.read("references.bib"), "% bib-new\n");
    assert!(transaction_path(root, &entry.id).unwrap().exists());
}

#[test]
fn latest_history_memo_tracks_mutations() {
    let fixture = Fixture::project("history-memo");
    let root = &fixture.root;
    // Distinct labels so the two records do not coalesce.
    apply_transaction(root, "Edit main.tex", edits(&[("main.tex", "% a\n")])).unwrap();
    let refs = edits(&[("refs.bib", "@misc{x}\n")]);
    let newest = apply_transaction(root, "Update refs.bib", refs).unwrap().unwrap();
    assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
    // A memo hit must agree with a cold directory scan.
    forget_latest_history(root);
    assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
    // Deleting a non-newest record leaves the memo valid.
    let items = history(root).unwrap();
    let older = items.iter().find(|item| item.id != newest.id).unwrap();
    delete_history(root, &older.id).unwrap();
    assert_eq!(latest_history_record(root).unwrap().unwrap().id, newest.id);
    // Deleting the newest invalidates it; the rescan finds nothing left.
    delete_history(root, &newest.id).unwrap();
    assert!(latest_history_record(root).unwrap().is_none());
}
