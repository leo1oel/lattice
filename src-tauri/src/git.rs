use crate::commands;
use crate::models::{GitDiff, GitFileStatus, GitRemoteResult, GitStatus};
use crate::project;
use std::path::Path;
use std::process::Command;

pub fn status(root: &Path) -> Result<GitStatus, String> {
    if !commands::available("git") {
        return Ok(empty_status(false, false));
    }
    if !is_repository(root)? {
        return Ok(empty_status(true, false));
    }
    let branch = git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "HEAD");
    let remote = primary_remote(root);
    let remote_url = remote
        .as_ref()
        .and_then(|name| git_output(root, &["remote", "get-url", name]).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let upstream = git_output(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
    let (ahead, behind) = ahead_behind(root, upstream.is_some());
    let porcelain = git_output(root, &["status", "--porcelain=v1", "-uall"])?;
    let files = parse_porcelain(&porcelain);
    Ok(GitStatus {
        available: true,
        repository: true,
        branch,
        remote,
        remote_url,
        upstream,
        ahead,
        behind,
        files,
    })
}

pub fn diff(root: &Path, path: &str, staged: bool) -> Result<GitDiff, String> {
    ensure_repository(root)?;
    let relative = normalize_relative(path)?;
    let _ = project::safe_path(root, &relative)?;
    let before = if staged {
        show_blob(root, &format!("HEAD:{relative}"))
    } else if has_head(root) {
        // Prefer index version when present so unstaged diffs match `git diff`.
        show_blob(root, &format!(":{relative}"))
            .or_else(|| show_blob(root, &format!("HEAD:{relative}")))
    } else {
        None
    };
    let after = if staged {
        show_blob(root, &format!(":{relative}"))
    } else if project::safe_path(root, &relative)?.is_file() {
        Some(project::read_file(root, &relative)?)
    } else {
        None
    };
    Ok(GitDiff {
        path: relative,
        staged,
        before,
        after,
    })
}

pub fn stage(root: &Path, paths: &[String]) -> Result<(), String> {
    ensure_repository(root)?;
    let relative_paths = validated_paths(root, paths)?;
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(relative_paths);
    git_run(root, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    Ok(())
}

pub fn unstage(root: &Path, paths: &[String]) -> Result<(), String> {
    ensure_repository(root)?;
    let relative_paths = validated_paths(root, paths)?;
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(relative_paths);
    match git_run(root, &args.iter().map(String::as_str).collect::<Vec<_>>()) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Older git / first commit: fall back to `git reset HEAD -- paths`.
            let mut fallback = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
            fallback.extend(validated_paths(root, paths)?);
            git_run(
                root,
                &fallback.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        }
    }
}

pub fn commit(root: &Path, message: &str) -> Result<String, String> {
    ensure_repository(root)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    git_run(root, &["commit", "-m", trimmed])?;
    git_output(root, &["rev-parse", "--short", "HEAD"]).map(|value| value.trim().to_string())
}

pub fn init(root: &Path) -> Result<GitStatus, String> {
    if !commands::available("git") {
        return Err("git is not installed or not on PATH.".to_string());
    }
    if is_repository(root)? {
        return status(root);
    }
    git_run(root, &["init"])?;
    status(root)
}

pub fn set_remote(root: &Path, name: &str, url: &str) -> Result<GitStatus, String> {
    ensure_repository(root)?;
    let remote_name = normalize_remote_name(name)?;
    let remote_url = normalize_remote_url(url)?;
    if remote_exists(root, &remote_name) {
        git_run(root, &["remote", "set-url", &remote_name, &remote_url])?;
    } else {
        git_run(root, &["remote", "add", &remote_name, &remote_url])?;
    }
    status(root)
}

pub fn push(root: &Path) -> Result<GitRemoteResult, String> {
    ensure_repository(root)?;
    let remote =
        primary_remote(root).ok_or_else(|| "Add a remote URL before pushing.".to_string())?;
    let branch = current_branch(root)?
        .ok_or_else(|| "Checkout a named branch before pushing.".to_string())?;
    let has_upstream = git_run(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_ok();
    let output = if has_upstream {
        git_run_capture(root, &["push"])?
    } else {
        git_run_capture(root, &["push", "-u", &remote, &branch])?
    };
    Ok(GitRemoteResult {
        summary: summarize_remote_output("Push", &output),
        status: status(root)?,
    })
}

pub fn pull(root: &Path) -> Result<GitRemoteResult, String> {
    ensure_repository(root)?;
    if primary_remote(root).is_none() {
        return Err("Add a remote URL before pulling.".to_string());
    }
    let has_upstream = git_run(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_ok();
    let output = if has_upstream {
        git_run_capture(root, &["pull", "--ff-only"])?
    } else {
        let remote = primary_remote(root).unwrap();
        let branch = current_branch(root)?
            .ok_or_else(|| "Checkout a named branch before pulling.".to_string())?;
        git_run_capture(root, &["pull", "--ff-only", &remote, &branch])?
    };
    Ok(GitRemoteResult {
        summary: summarize_remote_output("Pull", &output),
        status: status(root)?,
    })
}

pub fn fetch(root: &Path) -> Result<GitRemoteResult, String> {
    ensure_repository(root)?;
    let remote =
        primary_remote(root).ok_or_else(|| "Add a remote URL before fetching.".to_string())?;
    let output = git_run_capture(root, &["fetch", &remote])?;
    Ok(GitRemoteResult {
        summary: summarize_remote_output("Fetch", &output),
        status: status(root)?,
    })
}

fn empty_status(available: bool, repository: bool) -> GitStatus {
    GitStatus {
        available,
        repository,
        branch: None,
        remote: None,
        remote_url: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    }
}

fn ensure_repository(root: &Path) -> Result<(), String> {
    if !commands::available("git") {
        return Err("git is not installed or not on PATH.".to_string());
    }
    if !is_repository(root)? {
        return Err("This project is not inside a Git repository.".to_string());
    }
    Ok(())
}

fn is_repository(root: &Path) -> Result<bool, String> {
    match git_output(root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(value) => Ok(value.trim() == "true"),
        Err(_) => Ok(false),
    }
}

fn has_head(root: &Path) -> bool {
    git_run(root, &["rev-parse", "--verify", "HEAD"]).is_ok()
}

fn current_branch(root: &Path) -> Result<Option<String>, String> {
    let value = git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = value.trim();
    if branch.is_empty() || branch == "HEAD" {
        Ok(None)
    } else {
        Ok(Some(branch.to_string()))
    }
}

fn primary_remote(root: &Path) -> Option<String> {
    let remotes = git_output(root, &["remote"]).ok()?;
    let mut names = remotes
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if names.is_empty() {
        return None;
    }
    if let Some(index) = names.iter().position(|name| name == "origin") {
        return Some(names.swap_remove(index));
    }
    Some(names.remove(0))
}

fn remote_exists(root: &Path, name: &str) -> bool {
    git_output(root, &["remote"])
        .ok()
        .map(|value| value.lines().any(|line| line.trim() == name))
        .unwrap_or(false)
}

fn ahead_behind(root: &Path, has_upstream: bool) -> (u32, u32) {
    if !has_upstream {
        return (0, 0);
    }
    let Ok(value) = git_output(
        root,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) else {
        return (0, 0);
    };
    let mut parts = value.split_whitespace();
    let behind = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn normalize_remote_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("Remote name must be a simple identifier like origin.".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_remote_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Remote URL cannot be empty.".to_string());
    }
    if trimmed.contains('\n') || trimmed.contains('\r') || trimmed.contains(' ') {
        return Err("Remote URL looks invalid.".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("git@")
        || lower.starts_with("ssh://")
        || lower.starts_with("git://"))
    {
        return Err("Remote URL must be https, ssh, or git.".to_string());
    }
    Ok(trimmed.to_string())
}

fn validated_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Select at least one file.".to_string());
    }
    paths
        .iter()
        .map(|path| {
            let relative = normalize_relative(path)?;
            let _ = project::safe_path(root, &relative)?;
            Ok(relative)
        })
        .collect()
}

fn normalize_relative(path: &str) -> Result<String, String> {
    let relative = path.trim().replace('\\', "/");
    if relative.is_empty() || relative.starts_with('/') || relative.contains("..") {
        return Err(format!("Invalid project path: {path}"));
    }
    Ok(relative)
}

fn show_blob(root: &Path, spec: &str) -> Option<String> {
    git_output(root, &["show", spec]).ok()
}

fn git_command(root: &Path) -> Command {
    let mut command = commands::command("git");
    command.current_dir(root);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn git_run(root: &Path, args: &[&str]) -> Result<(), String> {
    git_run_capture(root, args).map(|_| ())
}

fn git_run_capture(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(root)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(if !stdout.is_empty() { stdout } else { stderr });
    }
    Err(rewrite_auth_error(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git {} failed.", args.join(" "))
    }))
}

fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(root)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed.", args.join(" "))
        } else {
            stderr
        });
    }
    String::from_utf8(output.stdout).map_err(|error| format!("Invalid git output: {error}"))
}

fn rewrite_auth_error(error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("permission denied (publickey)")
        || lower.contains("terminal prompts disabled")
        || lower.contains("could not read password")
    {
        format!(
            "{error}\n\nLattice uses your system Git credentials (SSH agent or credential helper). Authenticate once in Terminal, then retry."
        )
    } else {
        error
    }
}

fn summarize_remote_output(action: &str, output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        format!("{action} complete.")
    } else {
        let first = trimmed.lines().next().unwrap_or(trimmed);
        format!("{action}: {first}")
    }
}

fn parse_porcelain(porcelain: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let index = line.as_bytes()[0] as char;
        let worktree = line.as_bytes()[1] as char;
        let rest = &line[3..];
        let path = if rest.contains(" -> ") {
            rest.rsplit_once(" -> ")
                .map(|(_, right)| right)
                .unwrap_or(rest)
        } else {
            rest
        }
        .replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        let staged = index != ' ' && index != '?';
        let unstaged = worktree != ' ' || index == '?';
        let status = classify_status(index, worktree);
        files.push(GitFileStatus {
            path,
            status,
            staged,
            unstaged,
        });
    }
    files
}

fn classify_status(index: char, worktree: char) -> String {
    let code = if worktree == 'U' || index == 'U' || (index == 'A' && worktree == 'A') {
        'U'
    } else if worktree == '?' {
        '?'
    } else if worktree != ' ' {
        worktree
    } else {
        index
    };
    match code {
        'A' => "added".to_string(),
        'D' => "deleted".to_string(),
        'R' => "renamed".to_string(),
        'C' => "copied".to_string(),
        'U' => "conflict".to_string(),
        '?' => "untracked".to_string(),
        'M' | 'T' => "modified".to_string(),
        _ => "modified".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("lattice-git-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn run(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .unwrap();
        assert!(status.success(), "git {} failed", args.join(" "));
    }

    #[test]
    fn parses_porcelain_status_lines() {
        let files = parse_porcelain(
            " M main.tex\nA  sections/intro.tex\n?? notes.md\nR  old.tex -> new.tex\n",
        );
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "main.tex");
        assert!(files[0].unstaged);
        assert!(!files[0].staged);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].path, "sections/intro.tex");
        assert!(files[1].staged);
        assert_eq!(files[1].status, "added");
        assert_eq!(files[2].path, "notes.md");
        assert_eq!(files[2].status, "untracked");
        assert_eq!(files[3].path, "new.tex");
        assert_eq!(files[3].status, "renamed");
    }

    #[test]
    fn status_reports_non_repository_quietly() {
        let root = temp_root("none");
        let report = status(&root).unwrap();
        assert!(report.available);
        assert!(!report.repository);
        assert!(report.files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn init_creates_a_repository() {
        if !commands::available("git") {
            return;
        }
        let root = temp_root("init");
        let before = status(&root).unwrap();
        assert!(!before.repository);
        let after = init(&root).unwrap();
        assert!(after.repository);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stages_commits_and_diffs_a_repository() {
        if !commands::available("git") {
            return;
        }
        let root = temp_root("repo");
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "lattice@example.com"]);
        run(&root, &["config", "user.name", "Lattice"]);
        fs::write(root.join("main.tex"), "one\n").unwrap();
        stage(&root, &["main.tex".to_string()]).unwrap();
        let hash = commit(&root, "initial").unwrap();
        assert!(!hash.is_empty());

        fs::write(root.join("main.tex"), "one\ntwo\n").unwrap();
        let report = status(&root).unwrap();
        assert!(report.repository);
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].path, "main.tex");
        assert!(report.files[0].unstaged);

        let unstaged = diff(&root, "main.tex", false).unwrap();
        assert_eq!(unstaged.before.as_deref(), Some("one\n"));
        assert_eq!(unstaged.after.as_deref(), Some("one\ntwo\n"));

        stage(&root, &["main.tex".to_string()]).unwrap();
        let staged_diff = diff(&root, "main.tex", true).unwrap();
        assert_eq!(staged_diff.after.as_deref(), Some("one\ntwo\n"));
        let _ = commit(&root, "update");
        let clean = status(&root).unwrap();
        assert!(clean.files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn set_remote_adds_and_updates_origin() {
        if !commands::available("git") {
            return;
        }
        let root = temp_root("remote");
        run(&root, &["init"]);
        let first = set_remote(&root, "origin", "https://example.com/lattice/paper.git").unwrap();
        assert_eq!(first.remote.as_deref(), Some("origin"));
        assert!(
            first
                .remote_url
                .as_deref()
                .is_some_and(|url| url.contains("lattice/paper.git")),
            "unexpected remote url: {:?}",
            first.remote_url
        );
        let second =
            set_remote(&root, "origin", "ssh://git@example.com/lattice/paper2.git").unwrap();
        assert!(
            second
                .remote_url
                .as_deref()
                .is_some_and(|url| url.contains("paper2.git")),
            "unexpected remote url: {:?}",
            second.remote_url
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_invalid_remote_urls() {
        assert!(normalize_remote_url("not a url").is_err());
        assert!(normalize_remote_name("bad name").is_err());
        assert!(normalize_remote_url("https://github.com/example/paper.git").is_ok());
    }
}
