use super::*;
use crate::test_support::TempDir;
use std::fs;
use std::process::Command;

const TOKEN: &str = "olp_secret_token";

fn run(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A working repository with an identity, committing nothing yet.
fn working(label: &str) -> TempDir {
    let root = TempDir::new(&format!("bridge-{label}"));
    run(&root, &["init", "--quiet", "--initial-branch=master"]);
    run(&root, &["config", "user.email", "writer@example.com"]);
    run(&root, &["config", "user.name", "Writer"]);
    run(&root, &["config", "core.autocrlf", "false"]);
    root
}

fn commit(root: &TempDir, files: &[(&str, &str)], message: &str) {
    for (path, contents) in files {
        root.write(path, contents);
    }
    run(root, &["add", "-A"]);
    run(root, &["commit", "--quiet", "-m", message]);
}

/// A bare repository standing in for Overleaf, seeded with `files` on
/// `master`, and where a collaborator's edits are made through `other`.
struct Overleaf {
    bare: TempDir,
    other: TempDir,
}

impl Overleaf {
    fn new(files: &[(&str, &str)]) -> Option<Self> {
        if !commands::available("git") {
            return None;
        }
        let bare = TempDir::new("bridge-remote");
        run(&bare, &["init", "--quiet", "--bare", "--initial-branch=master"]);
        let other = working("collaborator");
        commit(&other, files, "Initial version");
        let overleaf = Overleaf { bare, other };
        overleaf.publish();
        Some(overleaf)
    }

    fn url(&self) -> String {
        self.bare.to_string_lossy().to_string()
    }

    fn publish(&self) {
        run(&self.other, &["push", "--quiet", &self.url(), "HEAD:refs/heads/master"]);
    }

    /// An edit made on Overleaf's side, as another person's commit.
    fn edit(&self, path: &str, contents: &str) {
        run(&self.other, &["pull", "--quiet", "--no-rebase", &self.url(), "master"]);
        commit(&self.other, &[(path, contents)], &format!("Edit {path}"));
        self.publish();
    }

    fn head(&self) -> String {
        run(&self.bare, &["rev-parse", "refs/heads/master"])
    }

    fn file(&self, path: &str) -> String {
        run(&self.bare, &["show", &format!("refs/heads/master:{path}")])
    }
}

/// A folder cloned from the remote, as a writer's working copy would be.
fn clone_of(overleaf: &Overleaf, label: &str) -> TempDir {
    let root = working(label);
    run(&root, &["pull", "--quiet", &overleaf.url(), "master"]);
    root
}

fn sync_with(overleaf: &Overleaf, root: &Path) -> Result<Outcome, String> {
    sync(root, &overleaf.url(), TOKEN)
}

#[test]
fn a_folder_without_commits_takes_what_overleaf_has() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "hello\n"), ("sections/a.tex", "a\n")])
    else {
        return;
    };
    // Initialised but with no commits, and with line endings left alone so
    // the assertion below does not depend on the machine's global setting.
    let root = working("empty");

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert_eq!(outcome.pulled, ["main.tex", "sections/a.tex"]);
    assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "hello\n");
    assert!(outcome.pushed.is_empty() && outcome.conflicts.is_empty());
}

#[test]
fn what_the_writer_committed_goes_up_and_the_rest_does_not() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "one\n")]) else { return };
    let root = clone_of(&overleaf, "push");
    commit(&root, &[("main.tex", "two\n")], "Rewrite the opening");
    let written = run(&root, &["rev-parse", "HEAD"]);
    root.write("notes.tex", "not committed yet\n");

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert_eq!(outcome.pushed, ["main.tex"]);
    assert_eq!(overleaf.file("main.tex"), "two");
    assert_eq!(overleaf.head(), written);
    // The sync wrote no commit of its own, and said what it left behind.
    assert_eq!(run(&root, &["rev-parse", "HEAD"]), written);
    assert_eq!(outcome.uncommitted, ["notes.tex"]);
    assert!(run(&overleaf.bare, &["ls-tree", "-r", "--name-only", "refs/heads/master"])
        .lines()
        .all(|path| path != "notes.tex"));
}

#[test]
fn edits_on_both_sides_in_different_files_merge_and_go_up() {
    let Some(overleaf) = Overleaf::new(&[("a.tex", "a\n"), ("b.tex", "b\n")]) else { return };
    let root = clone_of(&overleaf, "merge");
    commit(&root, &[("a.tex", "a here\n")], "Edit a");
    overleaf.edit("b.tex", "b there\n");

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert_eq!(outcome.pulled, ["b.tex"]);
    assert_eq!(outcome.pushed, ["a.tex"]);
    assert_eq!(fs::read_to_string(root.join("b.tex")).unwrap(), "b there\n");
    assert_eq!(overleaf.file("a.tex"), "a here");
    assert_eq!(overleaf.file("b.tex"), "b there");
}

#[test]
fn overlapping_edits_stay_marked_up_and_nothing_goes_up() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "shared line\n")]) else { return };
    let root = clone_of(&overleaf, "conflict");
    commit(&root, &[("main.tex", "my line\n")], "Mine");
    overleaf.edit("main.tex", "their line\n");
    let theirs = overleaf.head();

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert_eq!(outcome.conflicts, ["main.tex"]);
    assert!(outcome.pushed.is_empty());
    let marked = fs::read_to_string(root.join("main.tex")).unwrap();
    assert!(
        marked.contains("<<<<<<<") && marked.contains("my line") && marked.contains("their line")
    );
    assert_eq!(overleaf.head(), theirs);
    // Until it is resolved and committed, another sync says so instead of
    // stacking a second merge on the first.
    let error = sync_with(&overleaf, &root).unwrap_err();
    assert!(error.contains("unfinished"), "{error}");

    fs::write(root.join("main.tex"), "our line\n").unwrap();
    run(&root, &["add", "main.tex"]);
    run(&root, &["commit", "--quiet", "--no-edit"]);
    let resolved = sync_with(&overleaf, &root).unwrap();
    assert_eq!(resolved.pushed, ["main.tex"]);
    assert_eq!(overleaf.file("main.tex"), "our line");
}

/// A folder first linked through the REST sync has a history of its own.
#[test]
fn a_history_unrelated_to_overleafs_merges_when_the_files_agree() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "hello\n")]) else { return };
    let root = working("unrelated");
    commit(&root, &[("main.tex", "hello\n")], "Initialize version tracking");
    overleaf.edit("extra.tex", "new\n");

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert!(outcome.conflicts.is_empty(), "{outcome:?}");
    assert!(root.join("extra.tex").exists());
    assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "hello\n");
}

#[test]
fn a_synced_folder_changes_nothing_on_the_next_sync() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "hello\n")]) else { return };
    let root = clone_of(&overleaf, "idle");
    let head = overleaf.head();

    let outcome = sync_with(&overleaf, &root).unwrap();

    assert_eq!(outcome, Outcome::default());
    assert_eq!(overleaf.head(), head);
    assert!(!remote_changed(&root, &overleaf.url(), TOKEN).unwrap());
    overleaf.edit("main.tex", "changed\n");
    assert!(remote_changed(&root, &overleaf.url(), TOKEN).unwrap());
}

#[test]
fn the_token_is_never_written_into_the_repository() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "hello\n")]) else { return };
    let root = clone_of(&overleaf, "token");
    commit(&root, &[("main.tex", "bye\n")], "Edit");

    sync_with(&overleaf, &root).unwrap();

    let config = fs::read_to_string(root.join(".git/config")).unwrap();
    assert!(!config.contains(TOKEN) && !config.contains("olp_"));
    assert!(config.contains("[remote \"overleaf\"]"));
}

#[test]
fn a_folder_inside_another_repository_is_refused() {
    let Some(overleaf) = Overleaf::new(&[("main.tex", "hello\n")]) else { return };
    let outer = working("outer");
    commit(&outer, &[("README.md", "outer\n")], "Outer");
    let inner = outer.join("paper");
    fs::create_dir_all(&inner).unwrap();

    let error = sync_with(&overleaf, &inner).unwrap_err();

    assert!(error.contains("its own git repository"), "{error}");
    assert!(run(&outer, &["remote"]).is_empty());
}
