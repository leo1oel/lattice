//! Cloning a repository from a URL into a new project folder.
//!
//! Runs the user's own git, as the rest of this module does, so their SSH
//! agent, `~/.ssh/config` and credential helper decide how it signs in. git
//! runs in a session of its own with no terminal: neither git nor ssh can stop
//! to ask for a password or a host key (a launch from a terminal would
//! otherwise ask there and never return), so a missing credential fails at
//! once and says so.

use crate::commands;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, PoisonError};

/// Why a clone did not produce a project. The page words each kind itself;
/// `detail` is git's own last word, shown under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum CloneError {
    /// Not something git clones: an https, ssh or git URL, or `user@host:path`.
    InvalidUrl,
    /// Something already sits at the destination.
    FolderExists,
    /// The folder the clone goes in is not there.
    NoParent,
    GitMissing,
    /// git could not sign in: no credential, a refused key, an unknown host key.
    Auth(String),
    /// The host answered that there is no such repository (or it is private).
    NotFound(String),
    /// The host could not be reached.
    Network(String),
    Cancelled,
    Failed(String),
}

/// How far a clone has come, for the page's progress bar.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    /// "connecting", "receiving", "resolving" or "checkout".
    pub stage: &'static str,
    /// The whole clone's share done, 0 to 1.
    pub progress: f64,
}

/// The clone running for each window, by label: its process group and
/// whether it was asked to stop.
static CLONES: LazyLock<Mutex<HashMap<String, (u32, bool)>>> = LazyLock::new(Default::default);

/// Whether git would clone `url`. Bare local paths are left out: a folder on
/// this Mac is opened, not cloned.
pub fn is_clone_url(url: &str) -> bool {
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_whitespace) {
        return false;
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let path = rest[host.len()..].trim_matches('/');
        // file:// has no host; a repository on a mounted volume is cloned by it.
        let has_host = scheme == "file" || !host.rsplit('@').next().unwrap_or_default().is_empty();
        let known = ["https", "http", "ssh", "git", "git+ssh", "ssh+git", "file"];
        return known.contains(&scheme.as_str()) && has_host && !path.is_empty();
    }
    // scp-like `[user@]host:path`: git reads it so only when no slash comes
    // before the first colon.
    match url.split_once(':') {
        Some((host, path)) => {
            let host = host.rsplit('@').next().unwrap_or_default();
            !host.is_empty() && !host.contains('/') && !path.trim_matches('/').is_empty()
        }
        None => false,
    }
}

/// Clone `url` into `destination`, a folder that must not exist yet (or be
/// empty), reporting progress as git prints it. `window` names the clone so
/// [`cancel`] can stop it.
pub fn clone(
    window: &str, url: &str, destination: &Path, on_progress: impl Fn(CloneProgress),
) -> Result<(), CloneError> {
    let url = url.trim();
    if !is_clone_url(url) {
        return Err(CloneError::InvalidUrl);
    }
    if !destination.parent().is_some_and(Path::is_dir) {
        return Err(CloneError::NoParent);
    }
    let existed = destination.exists();
    if existed && fs::read_dir(destination).map_or(true, |mut entries| entries.next().is_some()) {
        return Err(CloneError::FolderExists);
    }
    if !commands::available("git") {
        return Err(CloneError::GitMissing);
    }
    // Registered before git starts, so a cancel that comes first still counts.
    CLONES.lock().unwrap_or_else(PoisonError::into_inner).insert(window.to_string(), (0, false));
    on_progress(CloneProgress { stage: "connecting", progress: 0.0 });
    let mut command = commands::command("git");
    command
        .args(["-c", "core.hooksPath=/dev/null", "clone", "--progress", "--", url])
        .arg(destination)
        .current_dir(destination.parent().unwrap_or(destination))
        .env("GIT_TERMINAL_PROMPT", "0")
        // English, whatever the user's locale, so the failure can be told
        // apart below; the page words it in the writer's language.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    detach_from_terminal(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            CLONES.lock().unwrap_or_else(PoisonError::into_inner).remove(window);
            return Err(CloneError::GitMissing);
        }
    };
    if let Some((pid, cancelled)) =
        CLONES.lock().unwrap_or_else(PoisonError::into_inner).get_mut(window)
    {
        *pid = child.id();
        if *cancelled {
            commands::signal_process_group(*pid, libc::SIGTERM);
        }
    }
    // Everything git said that was not progress, for telling a failure.
    let mut said = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        read_progress(stderr, |line| {
            if let Some(progress) = parse_progress(line) {
                on_progress(progress);
            } else if !line.trim().is_empty() && !line.starts_with("Cloning into") {
                said.push(line.trim().to_string());
            }
        });
    }
    let status = child.wait();
    let (_, cancelled) =
        CLONES.lock().unwrap_or_else(PoisonError::into_inner).remove(window).unwrap_or((0, false));
    if status.as_ref().is_ok_and(|status| status.success()) && !cancelled {
        return Ok(());
    }
    // git clears up after itself on a failure or a SIGTERM; a folder it left
    // anyway is half a repository nobody asked for.
    remove_partial_clone(destination, existed);
    if cancelled {
        return Err(CloneError::Cancelled);
    }
    Err(classify_failure(&said))
}

/// Stop the clone `window` started, if one is running.
pub fn cancel(window: &str) {
    let mut clones = CLONES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((pid, cancelled)) = clones.get_mut(window) {
        *cancelled = true;
        // The whole session: git's transport helper and ssh run under it.
        // Before git has started there is nothing to signal; it is stopped
        // as soon as it does.
        if *pid != 0 {
            commands::signal_process_group(*pid, libc::SIGTERM);
        }
    }
}

/// A session of its own: no controlling terminal for git or ssh to prompt
/// on, and one process group [`cancel`] can signal.
fn detach_from_terminal(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe and touches no memory.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

fn remove_partial_clone(destination: &Path, existed: bool) {
    if !existed {
        let _ = fs::remove_dir_all(destination);
        return;
    }
    // The folder was the writer's, empty: keep it, empty again.
    if let Ok(entries) = fs::read_dir(destination) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        }
    }
}

/// Hand each line git prints to `line`. Progress rewrites one line with
/// carriage returns, so those end a line too.
fn read_progress(stream: impl Read, mut line: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while matches!(reader.read(&mut byte), Ok(1)) {
        if byte[0] == b'\r' || byte[0] == b'\n' {
            line(&String::from_utf8_lossy(&buffer));
            buffer.clear();
        } else {
            buffer.push(byte[0]);
        }
    }
    if !buffer.is_empty() {
        line(&String::from_utf8_lossy(&buffer));
    }
}

/// The share done that one of git's progress lines reports, e.g.
/// `Receiving objects:  45% (450/1000), 1.2 MiB | 1.1 MiB/s`. Receiving is
/// most of the wait, so it fills most of the bar.
fn parse_progress(line: &str) -> Option<CloneProgress> {
    let line = line.trim().trim_start_matches("remote:").trim();
    let (phase, rest) = line.split_once(':')?;
    let percent: f64 = rest.trim_start().split('%').next()?.trim().parse().ok()?;
    let share = (percent / 100.0).clamp(0.0, 1.0);
    let (stage, from, span) = match phase {
        "Receiving objects" => ("receiving", 0.0, 0.8),
        "Resolving deltas" => ("resolving", 0.8, 0.15),
        "Updating files" | "Checking out files" => ("checkout", 0.95, 0.05),
        // The host counting and compressing: before anything arrives.
        _ => ("connecting", 0.0, 0.0),
    };
    Some(CloneProgress { stage, progress: from + span * share })
}

/// What went wrong, from the lines git printed. The first says it; the
/// lines after it are git's general advice ("Please make sure you have the
/// correct access rights and the repository exists") whatever the cause.
fn classify_failure(said: &[String]) -> CloneError {
    let lower = said.join("\n").to_ascii_lowercase();
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| lower.contains(phrase));
    let first = said.first().map_or("", String::as_str);
    let detail = first.trim_start_matches("fatal:").trim_start_matches("ERROR:").trim().to_string();
    if says(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied",
        "host key verification failed",
        "invalid username or password",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
    ]) {
        CloneError::Auth(detail)
    } else if says(&[
        "repository not found",
        "not found",
        "does not appear to be a git repository",
        "does not exist",
    ]) {
        CloneError::NotFound(detail)
    } else if says(&[
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection closed by",
        "connection reset",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "failed to connect",
        "no route to host",
    ]) {
        CloneError::Network(detail)
    } else if detail.is_empty() {
        CloneError::Failed("git clone failed.".to_string())
    } else {
        CloneError::Failed(detail)
    }
}

#[cfg(test)]
mod tests;
