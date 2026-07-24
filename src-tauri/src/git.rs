use crate::commands;
use crate::models::{
    GitDiff, GitFileDiff, GitFileStatus, GitLogEntry, GitLogFile, GitRemoteResult, GitStatus,
};
use crate::project;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::Command;

/// File extensions the version timeline always treats as binary, so we never
/// try to render their blobs as text diffs.
const BINARY_EXTENSIONS: &[&str] = &["pdf", "png", "jpg", "jpeg", "gif", "zip"];

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
    if !is_repository(root)? {
        git_run(root, &["init"])?;
    }
    if !has_head(root) {
        // Give the version timeline a starting point. Best effort: a failure
        // here (e.g. a hook) must not undo the successful init.
        let _ = auto_commit(root, "Initialize version tracking", None);
    }
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

pub fn log(root: &Path, limit: usize) -> Result<Vec<GitLogEntry>, String> {
    if !commands::available("git") || !is_repository(root)? || !has_head(root) {
        return Ok(Vec::new());
    }
    let limit_arg = format!("--max-count={limit}");
    let output = git_output(
        root,
        &[
            "log",
            "--name-status",
            "-M",
            &limit_arg,
            "--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s",
        ],
    )?;
    Ok(parse_log(&output))
}

pub fn show_diff(root: &Path, rev: &str, path: &str) -> Result<GitFileDiff, String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    let relative = normalize_relative(path)?;
    let _ = project::safe_path(root, &relative)?;
    if is_binary_path(&relative) {
        return Ok(GitFileDiff {
            before: None,
            after: None,
            binary: true,
        });
    }
    // `rev^:path` fails both when rev has no parent and when the file was
    // added in rev; either way there is no "before" side.
    let before = show_blob_bytes(root, &format!("{rev}^:{relative}"));
    let after = show_blob_bytes(root, &format!("{rev}:{relative}"));
    let has_nul = |bytes: &Option<Vec<u8>>| bytes.as_ref().is_some_and(|blob| blob.contains(&0));
    if has_nul(&before) || has_nul(&after) {
        return Ok(GitFileDiff {
            before: None,
            after: None,
            binary: true,
        });
    }
    Ok(GitFileDiff {
        before: before.map(|blob| String::from_utf8_lossy(&blob).into_owned()),
        after: after.map(|blob| String::from_utf8_lossy(&blob).into_owned()),
        binary: false,
    })
}

pub fn restore_file(root: &Path, rev: &str, path: &str) -> Result<(), String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    let relative = normalize_relative(path)?;
    let absolute = project::safe_path(root, &relative)?;
    let spec = format!("{rev}:{relative}");
    if git_run(root, &["cat-file", "-e", &spec]).is_err() {
        return Err(format!("{relative} did not exist at revision {rev}."));
    }
    if git_run(
        root,
        &["restore", "--source", &rev, "--worktree", "--", &relative],
    )
    .is_ok()
    {
        return Ok(());
    }
    // Older git without `restore`: write the blob contents directly.
    let output = git_command(root)
        .args(["show", &spec])
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        return Err(format!("Could not read {relative} at revision {rev}."));
    }
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not restore {relative}: {error}"))?;
    }
    fs::write(&absolute, &output.stdout)
        .map_err(|error| format!("Could not restore {relative}: {error}"))
}

/// Forward-only restore: make the worktree match `rev`, then commit that as a
/// new snapshot on top of the current history. Untracked files (like
/// `.research/`) are never touched.
pub fn restore_project(root: &Path, rev: &str) -> Result<String, String> {
    ensure_repository(root)?;
    let rev = validate_rev(rev)?;
    git_run(
        root,
        &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
    )?;
    git_run(
        root,
        &["restore", "--source", &rev, "--worktree", "--", "."],
    )?;
    // `git restore` never deletes, so drop tracked files that did not exist
    // at rev. Untracked files are absent from `ls-files` and stay intact.
    let at_rev = git_output(root, &["ls-tree", "-r", "--name-only", "-z", &rev])?
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let tracked = git_output(root, &["ls-files", "-z"])?;
    for name in tracked.split('\0').filter(|name| !name.is_empty()) {
        if !at_rev.contains(name) {
            let _ = fs::remove_file(root.join(name));
        }
    }
    let short = git_output(root, &["rev-parse", "--short", &rev])?
        .trim()
        .to_string();
    match auto_commit(root, &format!("Restore project to {short}"), None)? {
        Some(hash) => Ok(hash),
        None => git_output(root, &["rev-parse", "HEAD"]).map(|value| value.trim().to_string()),
    }
}

/// Stage everything and commit it, quietly doing nothing when git is missing,
/// the folder is not a repository, or the tree is clean. Always supplies a
/// fallback identity via `-c` so commits succeed on machines with no
/// `user.email` configured.
pub fn auto_commit(
    root: &Path,
    message: &str,
    author_name: Option<&str>,
) -> Result<Option<String>, String> {
    if !commands::available("git") || !is_repository(root)? {
        return Ok(None);
    }
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    git_run(root, &["add", "-A"])?;
    let porcelain = git_output(root, &["status", "--porcelain"])?;
    if porcelain.trim().is_empty() {
        return Ok(None);
    }
    let identity = author_name
        .map(sanitize_author_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Lattice".to_string());
    let mut args = vec![
        "-c".to_string(),
        format!("user.name={identity}"),
        "-c".to_string(),
        "user.email=lattice@local".to_string(),
        "commit".to_string(),
        "-m".to_string(),
        trimmed.to_string(),
    ];
    let mut command = git_command(root);
    if author_name.is_some() {
        let email = format!("{}@lattice.local", author_email_slug(&identity));
        args.push("--author".to_string());
        args.push(format!("{identity} <{email}>"));
        command.env("GIT_COMMITTER_NAME", &identity);
        command.env("GIT_COMMITTER_EMAIL", &email);
    }
    let output = command
        .args(&args)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git commit failed.".to_string()
        } else {
            stderr
        });
    }
    let hash = git_output(root, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(Some(hash))
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

fn show_blob_bytes(root: &Path, spec: &str) -> Option<Vec<u8>> {
    let output = git_command(root).args(["show", spec]).output().ok()?;
    if output.status.success() {
        Some(output.stdout)
    } else {
        None
    }
}

fn validate_rev(rev: &str) -> Result<String, String> {
    let trimmed = rev.trim();
    let hex = trimmed.len() >= 4
        && trimmed.len() <= 40
        && trimmed.chars().all(|ch| ch.is_ascii_hexdigit());
    if !hex {
        return Err("Invalid revision: expected a commit hash.".to_string());
    }
    Ok(trimmed.to_string())
}

fn is_binary_path(relative: &str) -> bool {
    Path::new(relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            let lower = extension.to_ascii_lowercase();
            BINARY_EXTENSIONS.contains(&lower.as_str())
        })
}

fn sanitize_author_name(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, '<' | '>' | '"'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn author_email_slug(name: &str) -> String {
    let slug = name
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        "author".to_string()
    } else {
        slug
    }
}

fn parse_log(raw: &str) -> Vec<GitLogEntry> {
    let mut entries = Vec::new();
    for record in raw.split('\u{1e}') {
        let record = record.trim_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut lines = record.lines();
        let header = lines.next().unwrap_or("");
        let mut fields = header.splitn(5, '\u{1f}');
        let hash = fields.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        let short_hash = fields.next().unwrap_or("").to_string();
        let author_name = fields.next().unwrap_or("").to_string();
        let timestamp = fields.next().unwrap_or("").to_string();
        let message = fields.next().unwrap_or("").to_string();
        let files = lines.filter_map(parse_name_status_line).collect();
        entries.push(GitLogEntry {
            hash,
            short_hash,
            author_name,
            timestamp,
            message,
            files,
        });
    }
    entries
}

fn parse_name_status_line(line: &str) -> Option<GitLogFile> {
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split('\t');
    let code = parts.next()?;
    let first = code.chars().next()?;
    // Renames and copies list old then new; report the new path so the
    // timeline points at the file that exists in that commit.
    let path = if matches!(first, 'R' | 'C') {
        let _old = parts.next()?;
        parts.next()?
    } else {
        parts.next()?
    };
    let kind = match first {
        'A' | 'C' => "added",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    };
    Some(GitLogFile {
        path: path.replace('\\', "/"),
        kind: kind.to_string(),
    })
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

    fn capture(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {} failed", args.join(" "));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repo(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "lattice@example.com"]);
        run(&root, &["config", "user.name", "Lattice"]);
        root
    }

    fn commit_all(root: &Path, message: &str) {
        run(root, &["add", "-A"]);
        run(root, &["commit", "-m", message]);
    }

    fn head(root: &Path) -> String {
        capture(root, &["rev-parse", "HEAD"])
    }

    fn kind_of<'a>(entry: &'a crate::models::GitLogEntry, path: &str) -> Option<&'a str> {
        entry
            .files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.kind.as_str())
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

    #[test]
    fn log_parses_history_with_file_kinds() {
        if !commands::available("git") {
            return;
        }
        let root = repo("log");
        fs::write(root.join("a.tex"), "alpha\n").unwrap();
        fs::write(root.join("b.tex"), "beta\n").unwrap();
        commit_all(&root, "first");
        fs::write(root.join("a.tex"), "alpha\nmore\n").unwrap();
        fs::remove_file(root.join("b.tex")).unwrap();
        fs::write(root.join("c.tex"), "gamma\n").unwrap();
        commit_all(&root, "second");
        run(&root, &["mv", "c.tex", "d.tex"]);
        commit_all(&root, "third");

        let entries = log(&root, 10).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].message, "third");
        assert_eq!(entries[0].hash.len(), 40);
        assert!(entries[0].hash.starts_with(&entries[0].short_hash));
        assert_eq!(entries[0].author_name, "Lattice");
        assert!(entries[0].timestamp.contains('T'), "expected ISO timestamp");
        assert_eq!(kind_of(&entries[0], "d.tex"), Some("renamed"));
        assert_eq!(kind_of(&entries[1], "a.tex"), Some("modified"));
        assert_eq!(kind_of(&entries[1], "b.tex"), Some("deleted"));
        assert_eq!(kind_of(&entries[1], "c.tex"), Some("added"));
        assert_eq!(entries[2].message, "first");
        assert_eq!(kind_of(&entries[2], "a.tex"), Some("added"));
        assert_eq!(kind_of(&entries[2], "b.tex"), Some("added"));
        assert_eq!(log(&root, 1).unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn log_is_empty_without_history() {
        if !commands::available("git") {
            return;
        }
        let plain = temp_root("log-none");
        assert!(log(&plain, 10).unwrap().is_empty());
        let empty = repo("log-empty");
        assert!(log(&empty, 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(plain);
        let _ = fs::remove_dir_all(empty);
    }

    #[test]
    fn show_diff_reports_added_modified_deleted_and_binary() {
        if !commands::available("git") {
            return;
        }
        let root = repo("show-diff");
        fs::write(root.join("a.tex"), "one\n").unwrap();
        fs::write(root.join("gone.tex"), "bye\n").unwrap();
        commit_all(&root, "first");
        let first = head(&root);
        fs::write(root.join("a.tex"), "one\ntwo\n").unwrap();
        fs::write(root.join("new.tex"), "hi\n").unwrap();
        fs::remove_file(root.join("gone.tex")).unwrap();
        fs::write(root.join("doc.pdf"), b"%PDF-1.4 fake").unwrap();
        fs::write(root.join("blob.bin"), b"a\0b").unwrap();
        commit_all(&root, "second");
        let second = head(&root);

        let modified = show_diff(&root, &second, "a.tex").unwrap();
        assert_eq!(modified.before.as_deref(), Some("one\n"));
        assert_eq!(modified.after.as_deref(), Some("one\ntwo\n"));
        assert!(!modified.binary);

        let added = show_diff(&root, &second, "new.tex").unwrap();
        assert_eq!(added.before, None);
        assert_eq!(added.after.as_deref(), Some("hi\n"));

        let deleted = show_diff(&root, &second, "gone.tex").unwrap();
        assert_eq!(deleted.before.as_deref(), Some("bye\n"));
        assert_eq!(deleted.after, None);

        let pdf = show_diff(&root, &second, "doc.pdf").unwrap();
        assert!(pdf.binary);
        assert_eq!(pdf.before, None);
        assert_eq!(pdf.after, None);

        let nul = show_diff(&root, &second, "blob.bin").unwrap();
        assert!(nul.binary);

        let rootless = show_diff(&root, &first, "a.tex").unwrap();
        assert_eq!(rootless.before, None, "first commit has no parent");
        assert_eq!(rootless.after.as_deref(), Some("one\n"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rev_validation_rejects_unsafe_input() {
        if !commands::available("git") {
            return;
        }
        let root = repo("rev");
        fs::write(root.join("a.tex"), "one\n").unwrap();
        commit_all(&root, "first");
        assert!(show_diff(&root, "HEAD; rm -rf", "a.tex").is_err());
        assert!(show_diff(&root, "HEAD", "a.tex").is_err());
        assert!(show_diff(&root, "abc", "a.tex").is_err());
        assert!(restore_file(&root, "HEAD; rm -rf", "a.tex").is_err());
        assert!(restore_project(&root, "--force").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_file_round_trips_content() {
        if !commands::available("git") {
            return;
        }
        let root = repo("restore-file");
        fs::write(root.join("a.tex"), "one\n").unwrap();
        commit_all(&root, "first");
        let first = head(&root);
        fs::write(root.join("a.tex"), "two\n").unwrap();
        commit_all(&root, "second");

        restore_file(&root, &first, "a.tex").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.tex")).unwrap(), "one\n");
        assert!(restore_file(&root, &first, "missing.tex").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_project_rewinds_worktree_and_commits() {
        if !commands::available("git") {
            return;
        }
        let root = repo("restore-project");
        fs::write(root.join(".gitignore"), ".research/\n").unwrap();
        fs::write(root.join("keep.tex"), "k1\n").unwrap();
        commit_all(&root, "first");
        let first = head(&root);
        fs::write(root.join("keep.tex"), "k2\n").unwrap();
        fs::write(root.join("extra.tex"), "x\n").unwrap();
        commit_all(&root, "second");
        fs::create_dir_all(root.join(".research")).unwrap();
        fs::write(root.join(".research/notes.md"), "notes\n").unwrap();

        let restored = restore_project(&root, &first).unwrap();
        assert_eq!(restored, head(&root));
        assert_eq!(fs::read_to_string(root.join("keep.tex")).unwrap(), "k1\n");
        assert!(!root.join("extra.tex").exists());
        assert_eq!(
            fs::read_to_string(root.join(".research/notes.md")).unwrap(),
            "notes\n"
        );
        let short = capture(&root, &["rev-parse", "--short", &first]);
        assert_eq!(
            capture(&root, &["log", "-1", "--format=%s"]),
            format!("Restore project to {short}")
        );
        assert_eq!(capture(&root, &["rev-list", "--count", "HEAD"]), "3");

        // A second identical restore finds a clean tree and returns HEAD.
        let unchanged = restore_project(&root, &first).unwrap();
        assert_eq!(unchanged, restored);
        assert_eq!(capture(&root, &["rev-list", "--count", "HEAD"]), "3");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auto_commit_skips_clean_tree_and_records_author() {
        if !commands::available("git") {
            return;
        }
        let plain = temp_root("auto-none");
        assert_eq!(auto_commit(&plain, "noop", None).unwrap(), None);

        let root = repo("auto");
        fs::write(root.join("a.tex"), "one\n").unwrap();
        commit_all(&root, "first");
        assert_eq!(auto_commit(&root, "noop", None).unwrap(), None);

        fs::write(root.join("b.tex"), "two\n").unwrap();
        let hash = auto_commit(&root, "checkpoint", Some("Ada Lovelace"))
            .unwrap()
            .expect("expected a commit");
        assert_eq!(hash, head(&root));
        assert_eq!(
            capture(&root, &["log", "-1", "--format=%an"]),
            "Ada Lovelace"
        );
        assert_eq!(
            capture(&root, &["log", "-1", "--format=%ae"]),
            "ada-lovelace@lattice.local"
        );
        let _ = fs::remove_dir_all(plain);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auto_commit_works_without_user_config() {
        if !commands::available("git") {
            return;
        }
        // Mask any global/system git identity for the whole process; every
        // other test either sets repo-local config or relies on the same
        // fallback this test exercises.
        let config = temp_root("gitconfig").join("empty");
        fs::write(&config, "").unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &config);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

        let root = temp_root("auto-bare");
        run(&root, &["init"]);
        fs::write(root.join("a.tex"), "one\n").unwrap();
        let hash = auto_commit(&root, "auto", None)
            .unwrap()
            .expect("expected a commit");
        assert_eq!(hash, head(&root));
        assert_eq!(capture(&root, &["log", "-1", "--format=%an"]), "Lattice");
        assert_eq!(
            capture(&root, &["log", "-1", "--format=%ae"]),
            "lattice@local"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn init_creates_initial_commit_when_files_exist() {
        if !commands::available("git") {
            return;
        }
        let root = temp_root("init-commit");
        fs::write(root.join("main.tex"), "hello\n").unwrap();
        let report = init(&root).unwrap();
        assert!(report.repository);
        assert!(report.files.is_empty(), "everything should be committed");
        assert_eq!(
            capture(&root, &["log", "-1", "--format=%s"]),
            "Initialize version tracking"
        );
        let _ = fs::remove_dir_all(root);
    }
}
