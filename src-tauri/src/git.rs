//! Git for the project folder: its status and the version timeline (history,
//! per-file diffs, restore, and the automatic commits that record versions).
//!
//! Everything runs the user's own git with terminal prompts disabled, so
//! their SSH agent or credential helper applies and nothing can block.

use crate::commands;
use crate::models::{GitFileDiff, GitLogEntry, GitStatus};
use crate::project;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

mod parse;

use parse::{parse_log, parse_porcelain_v2};

/// File extensions the version timeline always treats as binary, so we never
/// try to render their blobs as text diffs.
const BINARY_EXTENSIONS: &[&str] = &["pdf", "png", "jpg", "jpeg", "gif", "zip"];

/// Directories inside a project that belong to the tools, not to the writing.
///
/// `.research/` is Lattice's own: Overleaf sync state, the search index, agent
/// sessions and caches. Legacy `.omp/` folders may hold old MCP server config
/// — whose `env` is where someone puts an API key, which is reason enough on
/// its own never to commit it.
const INTERNAL_DIRS: &[&str] = &[".research", ".omp"];

fn is_internal_path(path: &str) -> bool {
    let path = path.trim_start_matches("./");
    INTERNAL_DIRS.iter().any(|dir| path == *dir || path.starts_with(&format!("{dir}/")))
}

/// Keep the tools' own directories out of version history.
///
/// Without this every Overleaf sync writes `.research/overleaf.json`, so
/// `git add -A` records a version whose only change is a timestamp and a hash
/// table — the timeline fills up with the app talking to itself instead of
/// with the user's edits — and an MCP server's API key lands in the repository.
///
/// Best effort throughout: a project that cannot be ignored still commits.
fn ensure_internal_ignored(root: &Path) {
    let present: Vec<&str> =
        INTERNAL_DIRS.iter().copied().filter(|dir| root.join(dir).exists()).collect();
    // Nothing to ignore yet: a project the tools have not written state into
    // should not gain a .gitignore, and a commit it triggers should stay a
    // no-op on an otherwise clean tree.
    if present.is_empty() {
        return;
    }
    let ignore_path = root.join(".gitignore");
    let existing = fs::read_to_string(&ignore_path).unwrap_or_default();
    let mut next = existing.clone();
    for dir in &present {
        let covered = next
            .lines()
            .map(str::trim)
            .any(|line| line == *dir || line == format!("{dir}/") || line == format!("/{dir}/"));
        if !covered {
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(&format!("{dir}/\n"));
        }
    }
    if next != existing {
        let _ = fs::write(&ignore_path, next);
    }
    // A project that was already committing these keeps doing so until the
    // files are dropped from the index; .gitignore alone does not untrack.
    for dir in &present {
        let tracked = git_output(root, &["ls-files", "-z", "--", dir]).unwrap_or_default();
        if nul_separated(&tracked).next().is_some() {
            let _ = git_run(root, &["rm", "-r", "--cached", "--quiet", "--", dir]);
        }
    }
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    let available = commands::available("git");
    if !available || !is_repository(root) {
        return Ok(GitStatus { available, repository: false, ..parse_porcelain_v2("") });
    }
    // The frontend polls this every couple of seconds, so subprocess count
    // matters: one porcelain-v2 spawn carries every file's status. `-z`
    // sidesteps C-style path quoting entirely.
    let porcelain = git_output(root, &["status", "--porcelain=v2", "-z", "-uall"])?;
    let mut status = parse_porcelain_v2(&porcelain);
    (status.remote, status.remote_url) = cached_remote(root);
    Ok(status)
}

/// A remote's name and URL.
type Remote = (Option<String>, Option<String>);

/// Remote name/URL memo with a short TTL. Remotes essentially never change
/// mid-session (Lattice never edits them), so the 2-second status poll does not
/// need to re-spawn `git remote` + `git remote get-url` every tick.
static REMOTE_CACHE: LazyLock<Mutex<HashMap<PathBuf, (Instant, Remote)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const REMOTE_CACHE_TTL: Duration = Duration::from_secs(30);

fn cached_remote(root: &Path) -> Remote {
    if let Some((resolved_at, remote)) = REMOTE_CACHE.lock().unwrap().get(root) {
        if resolved_at.elapsed() < REMOTE_CACHE_TTL {
            return remote.clone();
        }
    }
    let remote = primary_remote(root);
    let remote_url = remote
        .as_ref()
        .and_then(|name| git_output(root, &["remote", "get-url", name]).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let resolved = (remote, remote_url);
    REMOTE_CACHE.lock().unwrap().insert(root.to_path_buf(), (Instant::now(), resolved.clone()));
    resolved
}

pub fn init(root: &Path) -> Result<GitStatus, String> {
    require_git()?;
    if !is_repository(root) {
        git_run(root, &["init"])?;
    }
    ensure_internal_ignored(root);
    if !has_head(root) {
        // Give the version timeline a starting point. Best effort: a failure
        // here (e.g. a hook) must not undo the successful init.
        let _ = auto_commit(root, "Initialize version tracking", None);
    }
    status(root)
}

pub fn log(root: &Path, limit: usize) -> Result<Vec<GitLogEntry>, String> {
    if !commands::available("git") || !is_repository(root) || !has_head(root) {
        return Ok(Vec::new());
    }
    let limit_arg = format!("--max-count={limit}");
    let format = "--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s";
    Ok(parse_log(&git_output(root, &["log", "--name-status", "-M", &limit_arg, format])?))
}

pub fn show_diff(root: &Path, rev: &str, path: &str) -> Result<GitFileDiff, String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    let relative = normalize_relative(path)?;
    project::safe_path(root, &relative)?;
    let binary = GitFileDiff { before: None, after: None, binary: true };
    if is_binary_path(&relative) {
        return Ok(binary);
    }
    // `rev^:path` fails both when rev has no parent and when the file was
    // added in rev; either way there is no "before" side.
    let before = show_blob_bytes(root, &format!("{rev}^:{relative}"));
    let after = show_blob_bytes(root, &format!("{rev}:{relative}"));
    if [&before, &after].iter().any(|blob| blob.as_ref().is_some_and(|bytes| bytes.contains(&0))) {
        return Ok(binary);
    }
    let text =
        |blob: Option<Vec<u8>>| blob.map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    Ok(GitFileDiff { before: text(before), after: text(after), binary: false })
}

pub fn restore_file(root: &Path, rev: &str, path: &str) -> Result<(), String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    let relative = normalize_relative(path)?;
    project::safe_path(root, &relative)?;
    if git_run(root, &["cat-file", "-e", &format!("{rev}:{relative}")]).is_err() {
        return Err(format!("{relative} did not exist at revision {rev}."));
    }
    git_run(root, &["restore", "--source", &rev, "--worktree", "--", &relative])
}

/// Forward-only restore: make the worktree match `rev`, then commit that as a
/// new snapshot on top of the current history. Untracked files (like
/// `.research/`) are never touched.
pub fn restore_project(root: &Path, rev: &str) -> Result<String, String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    git_run(root, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?;
    git_run(root, &["restore", "--source", &rev, "--worktree", "--", "."])?;
    // `git restore` never deletes, so drop tracked files that did not exist
    // at rev. Untracked files are absent from `ls-files` and stay intact.
    let at_rev = git_output(root, &["ls-tree", "-r", "--name-only", "-z", &rev])?;
    let at_rev = nul_separated(&at_rev).collect::<HashSet<_>>();
    for name in nul_separated(&git_output(root, &["ls-files", "-z"])?) {
        if !at_rev.contains(name) {
            let _ = fs::remove_file(root.join(name));
        }
    }
    let short = rev_parse(root, &["--short", &rev])?;
    match auto_commit(root, &format!("Restore project to {short}"), None)? {
        Some(hash) => Ok(hash),
        None => rev_parse(root, &["HEAD"]),
    }
}

/// Stage everything and commit it, quietly doing nothing when git is missing,
/// the folder is not a repository, or the tree is clean. Always supplies a
/// fallback identity via `-c` so commits succeed on machines with no
/// `user.email` configured.
pub fn auto_commit(
    root: &Path, message: &str, author_name: Option<&str>,
) -> Result<Option<String>, String> {
    if !commands::available("git") || !is_repository(root) {
        return Ok(None);
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    ensure_internal_ignored(root);
    git_run(root, &["add", "-A"])?;
    if git_output(root, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(None);
    }
    let identity = author_name
        .map(sanitize_author_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Lattice".to_string());
    let user_name = format!("user.name={identity}");
    let mut command = git_command(root);
    command.args(["-c", &user_name, "-c", "user.email=lattice@local", "commit", "-m", message]);
    if author_name.is_some() {
        let email = format!("{}@lattice.local", author_email_slug(&identity));
        command
            .arg("--author")
            .arg(format!("{identity} <{email}>"))
            .env("GIT_COMMITTER_NAME", &identity)
            .env("GIT_COMMITTER_EMAIL", &email);
    }
    let output = command.output().map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        return Err(commands::stderr_or(&output, "git commit failed."));
    }
    rev_parse(root, &["HEAD"]).map(Some)
}

fn require_git() -> Result<(), String> {
    if commands::available("git") {
        Ok(())
    } else {
        Err("git is not installed or not on PATH.".to_string())
    }
}

fn ensure_repository(root: &Path) -> Result<(), String> {
    require_git()?;
    if !is_repository(root) {
        return Err("This project is not inside a Git repository.".to_string());
    }
    Ok(())
}

fn is_repository(root: &Path) -> bool {
    rev_parse(root, &["--is-inside-work-tree"]).is_ok_and(|value| value == "true")
}

fn has_head(root: &Path) -> bool {
    git_run(root, &["rev-parse", "--verify", "HEAD"]).is_ok()
}

/// `origin` when it exists, else the first remote git lists.
fn primary_remote(root: &Path) -> Option<String> {
    let remotes = git_output(root, &["remote"]).ok()?;
    let names = remotes.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    names.iter().find(|name| **name == "origin").or(names.first()).map(|name| name.to_string())
}

fn normalize_relative(path: &str) -> Result<String, String> {
    let relative = path.trim().replace('\\', "/");
    if relative.is_empty() || relative.starts_with('/') || relative.contains("..") {
        return Err(format!("Invalid project path: {path}"));
    }
    Ok(relative)
}

fn validate_rev(rev: &str) -> Result<String, String> {
    let trimmed = rev.trim();
    if !(4..=40).contains(&trimmed.len()) || !trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid revision: expected a commit hash.".to_string());
    }
    Ok(trimmed.to_string())
}

fn is_binary_path(relative: &str) -> bool {
    Path::new(relative).extension().and_then(|extension| extension.to_str()).is_some_and(
        |extension| BINARY_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()),
    )
}

fn sanitize_author_name(name: &str) -> String {
    name.chars().filter(|ch| !matches!(ch, '<' | '>' | '"')).collect::<String>().trim().to_string()
}

fn author_email_slug(name: &str) -> String {
    let slug = name
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    if slug.is_empty() { "author" } else { slug }.to_string()
}

fn nul_separated(text: &str) -> impl Iterator<Item = &str> {
    text.split('\0').filter(|name| !name.is_empty())
}

fn show_blob_bytes(root: &Path, spec: &str) -> Option<Vec<u8>> {
    run_git(root, &["show", spec])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout)
}

fn git_command(root: &Path) -> Command {
    let mut command = commands::command("git");
    command.current_dir(root).env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn run_git(root: &Path, args: &[&str]) -> Result<Output, String> {
    git_command(root).args(args).output().map_err(|error| format!("Could not run git: {error}"))
}

/// Stdout of a successful run, exactly as printed.
fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git(root, args)?;
    if !output.status.success() {
        return Err(commands::stderr_or(&output, &format!("git {} failed.", args.join(" "))));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("Invalid git output: {error}"))
}

fn rev_parse(root: &Path, args: &[&str]) -> Result<String, String> {
    let args = [&["rev-parse"], args].concat();
    git_output(root, &args).map(|value| value.trim().to_string())
}

fn git_run(root: &Path, args: &[&str]) -> Result<(), String> {
    let output = run_git(root, args)?;
    if output.status.success() {
        return Ok(());
    }
    // Some commands explain a failure on stdout only.
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let fallback =
        if stdout.is_empty() { format!("git {} failed.", args.join(" ")) } else { stdout };
    Err(commands::stderr_or(&output, &fallback))
}

#[cfg(test)]
mod tests {
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
        assert!(report.available);
        assert!(!report.repository);
        assert!(report.files.is_empty());
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
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].message, "third");
        assert_eq!(entries[0].hash.len(), 40);
        assert!(entries[0].hash.starts_with(&entries[0].short_hash));
        assert_eq!(entries[0].author_name, "Lattice");
        assert!(entries[0].timestamp.contains('T'), "expected ISO timestamp");
        assert_eq!(entries[2].message, "first");
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

    #[test]
    fn restore_file_round_trips_content_and_rejects_unsafe_revisions() {
        let Some(root) = repo("restore-file") else { return };
        let first = commit(&root, &[("a.tex", "one\n")], "first");
        commit(&root, &[("a.tex", "two\n")], "second");
        for rev in ["HEAD; rm -rf", "HEAD", "abc"] {
            assert!(show_diff(&root, rev, "a.tex").is_err(), "{rev}");
        }
        assert!(restore_file(&root, "HEAD; rm -rf", "a.tex").is_err());
        assert!(restore_project(&root, "--force").is_err());

        restore_file(&root, &first, "a.tex").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.tex")).unwrap(), "one\n");
        assert!(restore_file(&root, &first, "missing.tex").is_err());
    }

    #[test]
    fn restore_project_rewinds_worktree_and_commits() {
        let Some(root) = repo("restore-project") else { return };
        let first = commit(&root, &[(".gitignore", ".research/\n"), ("keep.tex", "k1\n")], "first");
        commit(&root, &[("keep.tex", "k2\n"), ("extra.tex", "x\n")], "second");
        root.write(".research/notes.md", "notes\n");

        let restored = restore_project(&root, &first).unwrap();
        assert_eq!(restored, git(&root, &["rev-parse", "HEAD"]));
        assert_eq!(fs::read_to_string(root.join("keep.tex")).unwrap(), "k1\n");
        assert!(!root.join("extra.tex").exists());
        assert_eq!(fs::read_to_string(root.join(".research/notes.md")).unwrap(), "notes\n");
        let short = git(&root, &["rev-parse", "--short", &first]);
        assert_eq!(last_commit(&root, "%s"), format!("Restore project to {short}"));
        assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "3");

        // A second identical restore finds a clean tree and returns HEAD.
        assert_eq!(restore_project(&root, &first).unwrap(), restored);
        assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "3");
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
            assert!(fs::read_to_string(root.join(".gitignore"))
                .unwrap()
                .contains(&format!("{dir}/")));
            assert_eq!(git(&root, &["ls-files", "--", dir]), "");
            assert!(internal.exists(), "ignoring {dir} must not delete it");

            fs::write(&internal, second).unwrap();
            assert!(auto_commit(&root, "internal only", None).unwrap().is_none());
        }
    }

    #[test]
    fn auto_commit_untracks_internal_state_committed_before_it_was_ignored() {
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
        let hash = auto_commit(&root, "checkpoint", Some("Ada Lovelace"))
            .unwrap()
            .expect("expected a commit");
        assert_eq!(hash, git(&root, &["rev-parse", "HEAD"]));
        assert_eq!(last_commit(&root, "%an"), "Ada Lovelace");
        assert_eq!(last_commit(&root, "%ae"), "ada-lovelace@lattice.local");
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
        let config =
            std::env::temp_dir().join(format!("lattice-gitconfig-{}", uuid::Uuid::new_v4()));
        fs::write(&config, "").unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &config);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

        let root = scratch("auto-bare");
        git(&root, &["init"]);
        root.write("a.tex", "one\n");
        let hash = auto_commit(&root, "auto", None).unwrap().expect("expected a commit");
        assert_eq!(hash, git(&root, &["rev-parse", "HEAD"]));
        assert_eq!(last_commit(&root, "%an"), "Lattice");
        assert_eq!(last_commit(&root, "%ae"), "lattice@local");
    }
}
