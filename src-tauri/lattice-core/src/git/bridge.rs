//! Syncing a project folder with a remote over plain git, the way Overleaf's
//! git bridge wants it: fetch, merge what is new, push what is committed.
//!
//! Nothing here commits for the writer. A sync moves commits that already
//! exist; edits that are not committed stay where they are and are reported,
//! so the history in the project's repository is the one the writer wrote.
//!
//! The token never reaches a file, the remote's URL or a command line: it
//! travels in the environment of the one git process that needs it, scoped to
//! the remote's own URL so a redirect cannot carry it elsewhere.

use super::{
    ensure_internal_ignored, git_command, git_output, git_run, has_head, is_repository,
    nul_separated, require_git, rev_parse, run_git,
};
use crate::commands;
use base64::Engine;
use std::path::Path;
use std::process::{Command, Output};

/// The remote this sync owns. Anything the writer set up as `origin` is theirs.
const REMOTE: &str = "overleaf";

/// What one sync moved.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Files the merge brought in, or changed.
    pub pulled: Vec<String>,
    /// Files in the commits that went up.
    pub pushed: Vec<String>,
    /// Files left with conflict markers. The merge stays open until the
    /// writer resolves them and commits; nothing was pushed.
    pub conflicts: Vec<String>,
    /// Files with changes that are not committed, so did not go up.
    pub uncommitted: Vec<String>,
}

fn tracking_ref(branch: &str) -> String {
    format!("refs/remotes/{REMOTE}/{branch}")
}

/// Where the last sync left Overleaf's branch, when there has been one. Only
/// a ref that exists is returned, so the log never names a missing revision.
pub(super) fn remote_tip(root: &Path) -> Option<String> {
    let listed = git_output(
        root,
        &["for-each-ref", "--format=%(refname)", &format!("refs/remotes/{REMOTE}")],
    )
    .ok()?;
    listed
        .lines()
        .map(str::trim)
        .find(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_string)
}

/// A git process for the remote, carrying `token` as HTTP basic credentials
/// (the user name is not checked by Overleaf) and no credential helper, so a
/// stale saved credential cannot answer in its place.
fn remote_command(root: &Path, url: &str, token: &str) -> Command {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("git:{token}"));
    let mut command = git_command(root);
    command
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", format!("http.{url}.extraHeader"))
        .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {encoded}"))
        .env("GIT_CONFIG_KEY_1", "credential.helper")
        .env("GIT_CONFIG_VALUE_1", "");
    command
}

/// What git said when the remote refused or could not be reached, in words
/// that say what to do. Git's own text is kept for anything unrecognised.
fn explain(output: &Output) -> String {
    let text = commands::stderr_or(output, "git could not reach Overleaf.");
    let lower = text.to_ascii_lowercase();
    if ["401", "403", "authentication failed", "invalid username or password", "could not read"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        "Overleaf did not accept the git token. Check it in Settings → Overleaf. Git access \
         needs an Overleaf plan that includes the git integration."
            .to_string()
    } else if lower.contains("404") || lower.contains("repository not found") {
        "Overleaf's git bridge has no such project. It may not be available for this account or \
         host."
            .to_string()
    } else if lower.contains("non-fast-forward") || lower.contains("fetch first") {
        "Overleaf changed while this was syncing. Sync again to merge those changes.".to_string()
    } else {
        text
    }
}

fn run_remote(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|error| format!("Could not run git: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(explain(&output))
    }
}

fn names(root: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    Ok(nul_separated(&git_output(root, args)?).map(str::to_string).collect())
}

/// The commits only `left` has, then only `right` has.
fn divergence(root: &Path, left: &str, right: &str) -> Result<(usize, usize), String> {
    let counts =
        git_output(root, &["rev-list", "--left-right", "--count", &format!("{left}...{right}")])?;
    let mut parts = counts.split_whitespace().map(|part| part.parse::<usize>().unwrap_or(0));
    Ok((parts.next().unwrap_or(0), parts.next().unwrap_or(0)))
}

fn point_remote_at(root: &Path, url: &str) -> Result<(), String> {
    match git_output(root, &["remote", "get-url", REMOTE]) {
        Ok(existing) if existing.trim() == url => Ok(()),
        Ok(_) => git_run(root, &["remote", "set-url", REMOTE, url]),
        Err(_) => git_run(root, &["remote", "add", REMOTE, url]),
    }
}

/// The branch Overleaf's git bridge serves for this project: the remote's own
/// default when it names one, else `master`, else `main`, else the only branch
/// it has. Older projects use `master`; assuming it failed on the others.
fn remote_branch(root: &Path, url: &str, token: &str) -> Result<String, String> {
    let output = remote_command(root, url, token)
        .args(["ls-remote", "--symref", url, "HEAD", "refs/heads/*"])
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        return Err(explain(&output));
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    // `ref: refs/heads/main<TAB>HEAD` names the default branch.
    let default = listed.lines().find_map(|line| {
        line.strip_prefix("ref: refs/heads/").and_then(|rest| rest.split_whitespace().next())
    });
    if let Some(name) = default {
        return Ok(name.to_string());
    }
    let heads: Vec<&str> = listed
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1)?.strip_prefix("refs/heads/"))
        .collect();
    ["master", "main"]
        .into_iter()
        .find(|preferred| heads.contains(preferred))
        .or_else(|| heads.first().copied())
        .map(str::to_string)
        .ok_or_else(|| "Overleaf's git bridge has no branch for this project yet.".to_string())
}

fn fetch(root: &Path, url: &str, token: &str, branch: &str) -> Result<(), String> {
    let spec = format!("+refs/heads/{branch}:{}", tracking_ref(branch));
    run_remote(remote_command(root, url, token).args([
        "fetch",
        "--quiet",
        "--no-tags",
        REMOTE,
        &spec,
    ]))
}

/// Whether the remote has commits this folder has not fetched. One cheap
/// request, so a poll can badge incoming work without downloading it.
pub fn remote_changed(root: &Path, url: &str, token: &str) -> Result<bool, String> {
    require_git()?;
    let branch = remote_branch(root, url, token)?;
    let output = remote_command(root, url, token)
        .args(["ls-remote", url, &format!("refs/heads/{branch}")])
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        return Err(explain(&output));
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    let Some(remote) = listed.split_whitespace().next() else { return Ok(false) };
    Ok(rev_parse(root, &[&tracking_ref(&branch)]).map_or(true, |known| known != remote))
}

/// Fetch, merge and push, in that order, and report what moved.
///
/// Refuses a folder that is only part of a larger repository: pushing `HEAD`
/// there would send the whole repository to Overleaf.
pub fn sync(root: &Path, url: &str, token: &str) -> Result<Outcome, String> {
    require_git()?;
    if !is_repository(root) {
        git_run(root, &["init"])?;
    }
    if !rev_parse(root, &["--show-prefix"])?.is_empty() {
        return Err("Git sync needs the project folder to be its own git repository, not a folder inside another one.".to_string());
    }
    if git_output(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err(
            "A merge with Overleaf is unfinished. Resolve the conflicts, commit, then sync again."
                .to_string(),
        );
    }
    ensure_internal_ignored(root);
    point_remote_at(root, url)?;
    let branch = remote_branch(root, url, token)?;
    fetch(root, url, token, &branch)?;
    let remote = tracking_ref(&branch);
    let mut outcome = Outcome::default();

    if !has_head(root) {
        // A folder with no commits yet takes Overleaf's. Checkout refuses to
        // overwrite a file of the same name that is not in the repository, so
        // nothing written here is lost.
        let local = git_output(root, &["symbolic-ref", "--short", "HEAD"])
            .map(|name| name.trim().to_string())
            .unwrap_or_else(|_| branch.clone());
        git_run(root, &["checkout", "--quiet", "-B", &local, &remote])?;
        outcome.pulled = names(root, &["ls-tree", "-r", "-z", "--name-only", &remote])?;
        return Ok(outcome);
    }

    let (_, behind) = divergence(root, "HEAD", &remote)?;
    if behind > 0 {
        let before = rev_parse(root, &["HEAD"])?;
        let output = merge(root, &remote)?;
        if !output.status.success() {
            outcome.conflicts = names(root, &["diff", "-z", "--name-only", "--diff-filter=U"])?;
            if outcome.conflicts.is_empty() {
                return Err(commands::stderr_or(&output, "git merge failed."));
            }
            return Ok(outcome);
        }
        outcome.pulled = names(root, &["diff", "-z", "--name-only", &before, "HEAD"])?;
    }

    let (ahead, _) = divergence(root, "HEAD", &remote)?;
    if ahead > 0 {
        outcome.pushed = names(root, &["diff", "-z", "--name-only", &remote, "HEAD"])?;
        run_remote(remote_command(root, url, token).args([
            "push",
            "--quiet",
            REMOTE,
            &format!("HEAD:refs/heads/{branch}"),
        ]))?;
    }

    let mut uncommitted = names(root, &["diff", "-z", "--name-only", "HEAD"])?;
    uncommitted.extend(names(root, &["ls-files", "-z", "--others", "--exclude-standard"])?);
    uncommitted.sort();
    uncommitted.dedup();
    outcome.uncommitted = uncommitted;
    Ok(outcome)
}

/// Merge Overleaf's branch in. A folder first linked through the REST sync
/// has a history of its own, unrelated to Overleaf's, so unrelated histories
/// are allowed: files that agree merge silently and the rest conflict as usual.
/// The writer's own name signs the merge when git has one; otherwise a fixed
/// one does, so the merge cannot fail on a machine with no identity set.
fn merge(root: &Path, remote: &str) -> Result<Output, String> {
    let configured = |key: &str| {
        git_output(root, &["config", "--get", key]).is_ok_and(|value| !value.trim().is_empty())
    };
    let mut args = Vec::new();
    if !configured("user.name") {
        args.extend(["-c", "user.name=Lattice"]);
    }
    if !configured("user.email") {
        args.extend(["-c", "user.email=lattice@local"]);
    }
    args.extend(["merge", "--no-edit", "--allow-unrelated-histories", remote]);
    run_git(root, &args)
}

#[cfg(test)]
mod tests;
