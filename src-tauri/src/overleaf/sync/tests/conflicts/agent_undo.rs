//! What an Agent Undo puts on Overleaf. Synara's undo reverses the agent's
//! own turn diff onto the current text (strict `git apply --reverse`, then a
//! diff3 three-way merge in a throwaway index), never restoring a snapshot
//! over the workspace. These tests run those same git commands against a
//! linked project and sync each step with the real `sync()` and the mock
//! Overleaf, so what uploads is exactly what the undo left on disk: the
//! co-author's text stays, and an overlap is held back as a conflict.
//! Synara's own regression tests (CheckpointStore.coauthorUndo.test.ts and
//! CheckpointReactor.test.ts in the fork) pin the undo itself.

use super::*;
use std::process::Command;

const BASE: &str = "\\section{Intro}\n\nP: The old opening paragraph says one thing.\n\nQ: The second paragraph stays as written.\n\nEnd.\n";
const OLD_P: &str = "P: The old opening paragraph says one thing.";
const AGENT_P: &str = "P: The agent rewrote the opening paragraph completely.";
const OLD_Q: &str = "Q: The second paragraph stays as written.";
const COAUTHOR_Q: &str = "Q: The second paragraph stays as written, with a co-author clause.";
const OTHER: &str = "Other file, as before.\n";

fn git(root: &Path, args: &[&str], index: Option<&Path>) -> std::process::Output {
    let mut command = Command::new("git");
    command.args(args).current_dir(root);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    command.output().expect("git runs")
}

fn git_ok(root: &Path, args: &[&str], index: Option<&Path>) -> String {
    let output = git(root, args, index);
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Lattice puts a linked project under git; its sync state stays out.
fn init_repository(root: &Path) {
    git_ok(root, &["init", "-q"], None);
    git_ok(root, &["config", "user.email", "test@example.com"], None);
    git_ok(root, &["config", "user.name", "Test"], None);
    fs::write(root.join(".git/info/exclude"), ".research/\n").unwrap();
    git_ok(root, &["add", "-A"], None);
    git_ok(root, &["commit", "-qm", "base"], None);
}

/// A checkpoint as Synara captures one: the whole working tree, through a
/// throwaway index, as a commit at a hidden ref.
fn capture(root: &Path, name: &str) -> String {
    let index = root.join(".git").join(format!("checkpoint-{name}"));
    git_ok(root, &["read-tree", "HEAD"], Some(&index));
    git_ok(root, &["add", "-A", "--", "."], Some(&index));
    let tree = git_ok(root, &["write-tree"], Some(&index));
    let commit = git_ok(root, &["commit-tree", &tree, "-m", name], None);
    git_ok(root, &["update-ref", &format!("refs/lattice/checkpoints/test/{name}"), &commit], None);
    commit
}

/// Reverse one turn's diff onto the current text, as the fork's
/// `reverseCheckpointDiff` does. Returns the files left with conflicts.
fn undo_turn(root: &Path, start: &str, end: &str) -> Vec<String> {
    // Untrimmed: a hunk's last context line can be a lone space.
    let patch = git(root, &["diff", "--binary", "--full-index", start, end], None).stdout;
    let patch_path = root.join(".git/turn.patch");
    fs::write(&patch_path, patch).unwrap();
    let patch_arg = patch_path.to_string_lossy().into_owned();
    if git(root, &["apply", "--reverse", "--whitespace=nowarn", "--", &patch_arg], None)
        .status
        .success()
    {
        return Vec::new();
    }
    let index = root.join(".git/undo-index");
    git_ok(root, &["read-tree", "HEAD"], Some(&index));
    git_ok(root, &["add", "-A", "--", "."], Some(&index));
    let merged = git(
        root,
        &[
            "-c",
            "merge.conflictStyle=diff3",
            "apply",
            "--reverse",
            "--3way",
            "--whitespace=nowarn",
            "--",
            &patch_arg,
        ],
        Some(&index),
    );
    let unmerged = git_ok(root, &["ls-files", "--unmerged"], Some(&index));
    let mut paths: Vec<String> =
        unmerged.lines().filter_map(|line| line.split('\t').nth(1)).map(str::to_string).collect();
    paths.dedup();
    assert!(
        merged.status.success() || !paths.is_empty(),
        "undo refused: {}",
        String::from_utf8_lossy(&merged.stderr)
    );
    paths
}

/// Sync against a fresh mock Overleaf serving `remote`; returns what uploaded.
fn sync_with(root: &Path, remote: Files) -> (OverleafSyncResult, Vec<String>) {
    let server = Mock::project(remote).serve();
    edit_state(root, |state| state.host = server.base.clone());
    let config = signed_in(&server.base);
    let result = sync(&config, root, NO_LIVE, None).unwrap();
    let uploads = server
        .uploads()
        .iter()
        .map(|upload| String::from_utf8_lossy(&upload.body).into_owned())
        .collect();
    (result, uploads)
}

/// A linked project at `BASE`, an agent turn that rewrote P, synced up.
fn agent_turn_synced() -> (TempDir, String, String, String) {
    let root = linked_root(
        &[("main.tex", BASE.as_bytes()), ("other.tex", OTHER.as_bytes())],
        &[("main.tex", BASE.as_bytes()), ("other.tex", OTHER.as_bytes())],
    );
    init_repository(&root);
    let start = capture(&root, "turn-start");
    let agent = BASE.replace(OLD_P, AGENT_P);
    fs::write(root.join("main.tex"), &agent).unwrap();
    let end = capture(&root, "turn-end");
    let (result, _) =
        sync_with(&root, &[("main.tex", BASE.as_bytes()), ("other.tex", OTHER.as_bytes())]);
    assert_eq!(result.pushed, ["main.tex"]);
    (root, start, end, agent)
}

#[test]
fn s0_undo_with_no_other_edits_uploads_the_original_text() {
    let (root, start, end, agent) = agent_turn_synced();
    assert!(undo_turn(&root, &start, &end).is_empty());
    let (result, uploads) =
        sync_with(&root, &[("main.tex", agent.as_bytes()), ("other.tex", OTHER.as_bytes())]);
    assert_eq!(result.pushed, ["main.tex"]);
    assert_eq!(text(&root, "main.tex"), BASE);
    assert!(uploads[0].contains(OLD_P) && !uploads[0].contains(AGENT_P));
}

#[test]
fn s1_undo_keeps_and_uploads_a_coauthors_edit_to_the_next_paragraph() {
    let (root, start, end, agent) = agent_turn_synced();
    let coauthor = agent.replace(OLD_Q, COAUTHOR_Q);
    let (pulled, _) =
        sync_with(&root, &[("main.tex", coauthor.as_bytes()), ("other.tex", OTHER.as_bytes())]);
    assert_eq!(pulled.pulled, ["main.tex"]);
    assert!(undo_turn(&root, &start, &end).is_empty());
    let (result, uploads) =
        sync_with(&root, &[("main.tex", coauthor.as_bytes()), ("other.tex", OTHER.as_bytes())]);
    assert_eq!(result.pushed, ["main.tex"]);
    assert_eq!(text(&root, "main.tex"), BASE.replace(OLD_Q, COAUTHOR_Q));
    assert!(uploads[0].contains(OLD_P) && uploads[0].contains(COAUTHOR_Q));
}

#[test]
fn s5_undo_leaves_a_file_the_agent_never_touched_alone() {
    let (root, start, end, agent) = agent_turn_synced();
    let coauthor_other = "Other file, edited by a co-author.\n";
    let remote: Files = &[("main.tex", agent.as_bytes()), ("other.tex", coauthor_other.as_bytes())];
    let (pulled, _) = sync_with(&root, remote);
    assert_eq!(pulled.pulled, ["other.tex"]);
    assert!(undo_turn(&root, &start, &end).is_empty());
    let (result, _) = sync_with(&root, remote);
    assert_eq!(result.pushed, ["main.tex"]);
    assert_eq!(text(&root, "other.tex"), coauthor_other);
}

#[test]
fn s2_an_overlapping_undo_is_a_conflict_for_that_spot_and_uploads_nothing() {
    let (root, start, end, agent) = agent_turn_synced();
    let coauthor = agent.replace(AGENT_P, &format!("{AGENT_P} Co-author sentence."));
    let remote: Files = &[("main.tex", coauthor.as_bytes()), ("other.tex", OTHER.as_bytes())];
    sync_with(&root, remote);
    assert_eq!(undo_turn(&root, &start, &end), ["main.tex"]);
    let marked = text(&root, "main.tex");
    assert!(marked.contains("<<<<<<< ours\nP: The agent rewrote the opening paragraph completely. Co-author sentence.\n||||||| base\n"));
    assert!(marked.contains(&format!("=======\n{OLD_P}\n>>>>>>> theirs\n")));
    let (result, uploads) = sync_with(&root, remote);
    assert!(result.pushed.is_empty() && uploads.is_empty(), "{result:?}");
    assert_eq!(text(&root, "main.tex"), marked);
}
