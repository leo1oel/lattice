use super::*;
use crate::test_support::TempDir;

fn scratch(label: &str) -> TempDir {
    TempDir::new(&format!("git-{label}"))
}

/// A repository with a local identity, or `None` when git is not
/// installed and these tests have nothing to exercise.
fn repo(label: &str) -> Option<TempDir> {
    if !commands::available("git") {
        return None;
    }
    let root = scratch(label);
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "lattice@example.com"]);
    git(&root, &["config", "user.name", "Lattice"]);
    Some(root)
}

/// Run git in `root`, which must succeed, and return its trimmed stdout.
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {} failed", args.join(" "));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn user_name_reads_the_repository_identity() {
    let Some(root) = repo("user-name") else { return };
    assert_eq!(user_name(&root).as_deref(), Some("Lattice"));
    git(&root, &["config", "user.name", "  Ada Lovelace  "]);
    assert_eq!(user_name(&root).as_deref(), Some("Ada Lovelace"));
}

/// Write `files`, commit everything as `message`, and return the new HEAD.
fn commit(root: &TempDir, files: &[(&str, &str)], message: &str) -> String {
    for (path, contents) in files {
        root.write(path, contents);
    }
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", message]);
    git(root, &["rev-parse", "HEAD"])
}

fn last_commit(root: &Path, format: &str) -> String {
    git(root, &["log", "-1", &format!("--format={format}")])
}

fn kind_of<'a>(entry: &'a GitLogEntry, path: &str) -> Option<&'a str> {
    entry.files.iter().find(|file| file.path == path).map(|file| file.kind.as_str())
}

#[test]
fn status_and_init_on_a_folder_that_is_not_yet_a_repository_then_track_edits() {
    let report = status(&scratch("none")).unwrap();
    assert_eq!((report.available, report.repository, report.files.len()), (true, false, 0));
    if !commands::available("git") {
        return;
    }
    // An empty folder becomes a repository; one with files also gets a
    // first version so the timeline has a starting point.
    assert!(init(&scratch("init")).unwrap().repository);
    let root = scratch("init-commit");
    root.write("main.tex", "hello\n");
    let report = init(&root).unwrap();
    assert!(report.repository);
    assert!(report.files.is_empty(), "everything should be committed");
    assert_eq!(last_commit(&root, "%s"), "Initialize version tracking");

    // An edit is an unstaged change until a version records it.
    root.write("main.tex", "hello\nagain\n");
    let files = status(&root).unwrap().files;
    assert_eq!(files.len(), 1);
    assert_eq!((files[0].path.as_str(), files[0].unstaged), ("main.tex", true));
    auto_commit(&root, "update", None).unwrap();
    assert!(status(&root).unwrap().files.is_empty());
}

#[test]
fn log_parses_history_with_file_kinds() {
    let Some(root) = repo("log") else { return };
    // Neither a plain folder nor a repository without commits has history.
    assert!(log(&scratch("log-none"), 10).unwrap().is_empty());
    assert!(log(&root, 10).unwrap().is_empty());
    commit(&root, &[("a.tex", "alpha\n"), ("b.tex", "beta\n")], "first");
    fs::remove_file(root.join("b.tex")).unwrap();
    commit(&root, &[("a.tex", "alpha\nmore\n"), ("c.tex", "gamma\n")], "second");
    git(&root, &["mv", "c.tex", "d.tex"]);
    commit(&root, &[], "third");

    let entries = log(&root, 10).unwrap();
    let messages = entries.iter().map(|entry| entry.message.as_str()).collect::<Vec<_>>();
    assert_eq!(messages, ["third", "second", "first"]);
    assert_eq!(entries[0].hash.len(), 40);
    assert!(entries[0].hash.starts_with(&entries[0].short_hash));
    assert_eq!(entries[0].author_name, "Lattice");
    assert!(entries[0].timestamp.contains('T'), "expected ISO timestamp");
    for (entry, path, kind) in [
        (0, "d.tex", "renamed"),
        (1, "a.tex", "modified"),
        (1, "b.tex", "deleted"),
        (1, "c.tex", "added"),
        (2, "a.tex", "added"),
        (2, "b.tex", "added"),
    ] {
        assert_eq!(kind_of(&entries[entry], path), Some(kind), "{path} in entry {entry}");
    }
    assert_eq!(log(&root, 1).unwrap().len(), 1);
}

#[test]
fn show_diff_reports_added_modified_deleted_and_binary() {
    let Some(root) = repo("show-diff") else { return };
    let first = commit(&root, &[("a.tex", "one\n"), ("gone.tex", "bye\n")], "first");
    fs::remove_file(root.join("gone.tex")).unwrap();
    root.write("blob.bin", b"a\0b");
    let files = [("a.tex", "one\ntwo\n"), ("new.tex", "hi\n"), ("doc.pdf", "%PDF-1.4 fake")];
    let second = commit(&root, &files, "second");

    let text = |rev: &str, path: &str| {
        let diff = show_diff(&root, rev, path).unwrap();
        assert!(!diff.binary, "{path} is text");
        (diff.before, diff.after)
    };
    let owned = |text: &str| Some(text.to_string());
    assert_eq!(text(&second, "a.tex"), (owned("one\n"), owned("one\ntwo\n")));
    assert_eq!(text(&second, "new.tex"), (None, owned("hi\n")));
    assert_eq!(text(&second, "gone.tex"), (owned("bye\n"), None));
    // The first commit has no parent.
    assert_eq!(text(&first, "a.tex"), (None, owned("one\n")));

    let pdf = show_diff(&root, &second, "doc.pdf").unwrap();
    assert!(pdf.binary);
    assert_eq!((pdf.before, pdf.after), (None, None));
    assert!(show_diff(&root, &second, "blob.bin").unwrap().binary);
}

/// Two versions compare with each other, or with the files as they are
/// now, untracked ones included; either side writes out whole, without
/// Lattice's state or what the project ignores.
#[test]
fn compares_any_two_versions_and_writes_either_out() {
    let Some(root) = repo("compare") else { return };
    let intro = "a\nb\nc\nd\n";
    let files = [
        (".gitignore", ".research/\n*.aux\n"),
        ("main.tex", "one\n"),
        ("old.tex", "o\n"),
        ("intro.tex", intro),
    ];
    let first = commit(&root, &files, "first");
    fs::remove_file(root.join("old.tex")).unwrap();
    fs::remove_file(root.join("intro.tex")).unwrap();
    let files =
        [("main.tex", "two\n"), ("sec/intro.tex", "i\n"), ("sections/intro.tex", "a\nb\nc\nD\n")];
    let second = commit(&root, &files, "second");
    root.write("main.tex", "three\n");
    root.write("draft.tex", "d\n");
    root.write("main.aux", "build output");
    root.write(".research/notes.md", "private");

    let listed = |to: Option<&str>| {
        let mut files = compare_files(&root, &first, to)
            .unwrap()
            .into_iter()
            .map(|file| match file.old_path {
                Some(old) => format!("{} {old} -> {}", file.kind, file.path),
                None => format!("{} {}", file.kind, file.path),
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    };
    let renamed = "renamed intro.tex -> sections/intro.tex";
    assert_eq!(
        listed(Some(&second)),
        ["added sec/intro.tex", "deleted old.tex", "modified main.tex", renamed]
    );
    assert_eq!(
        listed(None),
        ["added draft.tex", "added sec/intro.tex", "deleted old.tex", "modified main.tex", renamed]
    );

    let text = |to: Option<&str>| {
        let diff = compare_file(&root, &first, to, "main.tex", None).unwrap();
        (diff.before.unwrap(), diff.after.unwrap())
    };
    assert_eq!(text(Some(&second)), ("one\n".to_string(), "two\n".to_string()));
    assert_eq!(text(None), ("one\n".to_string(), "three\n".to_string()));
    let moved = compare_file(&root, &first, Some(&second), "sections/intro.tex", Some("intro.tex"))
        .unwrap();
    assert_eq!(
        (moved.before.unwrap(), moved.after.unwrap()),
        (intro.to_string(), "a\nb\nc\nD\n".to_string())
    );
    assert_eq!(compare_file(&root, &first, None, "old.tex", None).unwrap().after, None);
    assert!(compare_file(&root, "HEAD", None, "main.tex", None).is_err());
    assert!(compare_file(&root, &first, None, "../main.tex", None).is_err());
    assert!(compare_file(&root, &first, None, "main.tex", Some("../main.tex")).is_err());

    let older = scratch("compare-older");
    write_version(&root, Some(&first), &older).unwrap();
    assert_eq!(fs::read_to_string(older.join("main.tex")).unwrap(), "one\n");
    assert!(older.join("old.tex").exists() && !older.join("sec").exists());
    let now = scratch("compare-now");
    write_version(&root, None, &now).unwrap();
    assert_eq!(fs::read_to_string(now.join("main.tex")).unwrap(), "three\n");
    assert!(now.join("draft.tex").exists() && now.join("sec/intro.tex").exists());
    assert!(!now.join("old.tex").exists() && !now.join("main.aux").exists());
    assert!(!now.join(".research").exists());
}

#[test]
fn restores_one_file_or_rewinds_the_project_and_rejects_unsafe_revisions() {
    let Some(root) = repo("restore") else { return };
    let files = [(".gitignore", ".research/\n"), ("a.tex", "one\n"), ("keep.tex", "k1\n")];
    let first = commit(&root, &files, "first");
    commit(&root, &[("a.tex", "two\n"), ("keep.tex", "k2\n"), ("extra.tex", "x\n")], "second");
    for rev in ["HEAD; rm -rf", "HEAD", "abc"] {
        assert!(show_diff(&root, rev, "a.tex").is_err(), "{rev}");
    }
    assert!(restore_file(&root, "HEAD; rm -rf", "a.tex").is_err());
    assert!(restore_project(&root, "--force").is_err());
    assert!(restore_file(&root, &first, "missing.tex").is_err());
    restore_file(&root, &first, "a.tex").unwrap();
    assert_eq!(fs::read_to_string(root.join("a.tex")).unwrap(), "one\n");

    root.write(".research/notes.md", "notes\n");
    let restored = restore_project(&root, &first).unwrap();
    assert_eq!(restored, git(&root, &["rev-parse", "HEAD"]));
    assert_eq!(fs::read_to_string(root.join("keep.tex")).unwrap(), "k1\n");
    assert!(!root.join("extra.tex").exists());
    assert_eq!(fs::read_to_string(root.join(".research/notes.md")).unwrap(), "notes\n");
    let short = git(&root, &["rev-parse", "--short", &first]);
    assert_eq!(last_commit(&root, "%s"), format!("Restore project to {short}"));
    // A second identical restore finds a clean tree and returns HEAD.
    assert_eq!(restore_project(&root, &first).unwrap(), restored);
    assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "3");
}

/// Only a `..` path segment is traversal; a file name that contains two
/// dots is an ordinary project file whose history can be read and restored.
#[test]
fn dotted_file_names_are_project_paths_but_parent_segments_are_not() {
    for path in ["", ".", "/etc/passwd", "../a.tex", "a/../../b.tex", "a\\..\\b.tex"] {
        assert!(normalize_relative(path).is_err(), "{path:?}");
    }
    assert_eq!(normalize_relative(" ./ch/a..b.tex ").unwrap(), "ch/a..b.tex");
    assert_eq!(normalize_relative("ch\\intro.tex").unwrap(), "ch/intro.tex");

    let Some(root) = repo("dotted") else { return };
    let first = commit(&root, &[("a..b.tex", "one\n")], "first");
    let second = commit(&root, &[("a..b.tex", "two\n")], "second");
    let diff = show_diff(&root, &second, "a..b.tex").unwrap();
    assert_eq!((diff.before.as_deref(), diff.after.as_deref()), (Some("one\n"), Some("two\n")));
    restore_file(&root, &first, "a..b.tex").unwrap();
    assert_eq!(fs::read_to_string(root.join("a..b.tex")).unwrap(), "one\n");
}

/// Lattice's own state, and a legacy `.omp/mcp.json` (whose `env` is where
/// an MCP server's API key goes), stay on disk but out of history, and a
/// change to only them is not a version.
#[test]
fn auto_commit_keeps_internal_state_out_of_history() {
    for (dir, file, first, second) in [
        (".research", "overleaf.json", "{\"v\":1}\n", "{\"v\":2}\n"),
        (
            ".omp",
            "mcp.json",
            "{\"mcpServers\":{\"x\":{\"env\":{\"API_KEY\":\"secret\"}}}}\n",
            "{\"mcpServers\":{}}\n",
        ),
    ] {
        let Some(root) = repo("internal-ignored") else { return };
        let internal = root.write(&format!("{dir}/{file}"), first);
        root.write("paper.tex", "one\n");

        auto_commit(&root, "first", None).unwrap().unwrap();
        assert!(fs::read_to_string(root.join(".gitignore")).unwrap().contains(&format!("{dir}/")));
        assert_eq!(git(&root, &["ls-files", "--", dir]), "");
        assert!(internal.exists(), "ignoring {dir} must not delete it");

        fs::write(&internal, second).unwrap();
        assert!(auto_commit(&root, "internal only", None).unwrap().is_none());
    }

    // State committed before it was ignored is untracked, not deleted.
    let Some(root) = repo("internal-untrack") else { return };
    let files = [(".research/overleaf.json", "{\"v\":1}\n"), ("paper.tex", "one\n")];
    commit(&root, &files, "first");
    assert!(!git(&root, &["ls-files", "--", ".research"]).is_empty());
    root.write("paper.tex", "two\n");
    auto_commit(&root, "second", None).unwrap().unwrap();
    assert_eq!(git(&root, &["ls-files", "--", ".research"]), "");
    assert!(root.join(".research/overleaf.json").exists());

    // The commit that only dropped internal files is not shown as a
    // version, but the one that also edited the paper still is.
    let entries = log(&root, 10).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(kind_of(&entries[0], "paper.tex"), Some("modified"));
    assert!(entries
        .iter()
        .all(|entry| entry.files.iter().all(|file| !file.path.starts_with(".research"))));
}

#[test]
fn auto_commit_skips_clean_tree_and_records_author() {
    let Some(root) = repo("auto") else { return };
    assert_eq!(auto_commit(&scratch("auto-none"), "noop", None).unwrap(), None);
    commit(&root, &[("a.tex", "one\n")], "first");
    assert_eq!(auto_commit(&root, "noop", None).unwrap(), None);

    root.write("b.tex", "two\n");
    let hash = auto_commit(&root, "checkpoint", Some("Ada Lovelace")).unwrap();
    assert_eq!(hash, Some(git(&root, &["rev-parse", "HEAD"])));
    assert_eq!(last_commit(&root, "%an <%ae>"), "Ada Lovelace <ada-lovelace@lattice.local>");
}

/// A paper at `monorepo/paper/`: a sync's commit takes the paper and nothing
/// else, whether the rest of the repository's changes are staged or not.
#[test]
fn auto_commit_in_a_folder_of_a_larger_repository_commits_only_that_folder() {
    let Some(repo) = repo("nested") else { return };
    commit(
        &repo,
        &[("paper/main.tex", "one\n"), ("src/lib.rs", "a\n"), ("README", "r\n")],
        "first",
    );
    repo.write("src/lib.rs", "unrelated edit\n");
    repo.write("README", "staged elsewhere\n");
    git(&repo, &["add", "README"]);
    repo.write("paper/main.tex", "two\n");
    repo.write("paper/figure.tex", "new\n");
    repo.write("paper/.research/overleaf.json", "{}\n");
    let paper = repo.join("paper");

    auto_commit(&paper, "Sync with Overleaf", None).unwrap().unwrap();
    let changed = git(&repo, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(
        changed.lines().collect::<Vec<_>>(),
        ["paper/.gitignore", "paper/figure.tex", "paper/main.tex"]
    );
    // The rest of the repository is exactly as the writer left it.
    assert_eq!(git(&repo, &["status", "--porcelain"]), "M  README\n M src/lib.rs");
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "README");
    assert!(auto_commit(&paper, "noop", None).unwrap().is_none());
}

/// Before the repository's first commit, the folder's files are all there is.
#[test]
fn auto_commit_in_a_folder_of_a_repository_without_commits() {
    let Some(repo) = repo("nested-empty") else { return };
    repo.write("src/lib.rs", "a\n");
    repo.write("paper/main.tex", "one\n");
    auto_commit(&repo.join("paper"), "Initialize version tracking", None).unwrap().unwrap();
    let committed = git(&repo, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert_eq!(committed.lines().collect::<Vec<_>>(), ["paper/main.tex"]);
    assert_eq!(git(&repo, &["status", "--porcelain"]), "?? src/");
}

#[test]
fn auto_commit_works_without_user_config() {
    if !commands::available("git") {
        return;
    }
    // Mask any global/system git identity for the whole process; every
    // other test either sets repo-local config or relies on the same
    // fallback this test exercises. The config outlives this test on
    // purpose: the variable keeps pointing at it.
    let config = std::env::temp_dir().join(format!("lattice-gitconfig-{}", uuid::Uuid::new_v4()));
    fs::write(&config, "").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &config);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

    let root = scratch("auto-bare");
    git(&root, &["init"]);
    root.write("a.tex", "one\n");
    let hash = auto_commit(&root, "auto", None).unwrap();
    assert_eq!(hash, Some(git(&root, &["rev-parse", "HEAD"])));
    assert_eq!(last_commit(&root, "%an <%ae>"), "Lattice <lattice@local>");
}
