//! Tauri command handlers, grouped by the part of the app they serve.
//!
//! A handler is a thin shell over a domain module: resolve the calling
//! window's project, take whatever project lease the operation needs, then run
//! the domain call off the async runtime. The helpers below are those steps;
//! behaviour belongs in the domain modules, not here.

pub(crate) mod bibliography;
pub(crate) mod build;
pub(crate) mod files;
pub(crate) mod git;
pub(crate) mod history;
pub(crate) mod overleaf;
pub(crate) mod overleaf_realtime;
pub(crate) mod papers;
pub(crate) mod search;
pub(crate) mod windows;
pub(crate) mod workspace;

use crate::app_state::{AppState, Lease, ProjectLease};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};
use tauri::Window;

/// The project of the window that sent the request.
pub(crate) fn current_root(state: &AppState, window: &Window) -> Result<PathBuf, String> {
    state.root_for(window.label())?.ok_or_else(|| "Open a project first.".to_string())
}

/// The window's project, provided it is still the one the request named.
///
/// Tauri commands can be scheduled after the writer has already switched
/// projects. Reading `current_root` alone would reinterpret a delayed action
/// for A as an action on B, so every command that can mutate project files
/// pins itself before touching disk or the network. `action` completes the
/// refusal "The project changed before {action}."
pub(crate) fn pinned_root(
    state: &AppState, window: &Window, project_root: &str, action: &str,
) -> Result<PathBuf, String> {
    expect_root(current_root(state, window)?, project_root, action)
}

/// [`pinned_root`] with the generic refusal.
pub(crate) fn scoped_root(
    state: &AppState, window: &Window, project_root: &str,
) -> Result<PathBuf, String> {
    pinned_root(state, window, project_root, "the action could start")
}

/// [`pinned_root`] for a request that may leave its project unnamed.
pub(crate) fn maybe_pinned_root(
    state: &AppState, window: &Window, project_root: Option<&str>, action: &str,
) -> Result<PathBuf, String> {
    match project_root {
        Some(project_root) => pinned_root(state, window, project_root, action),
        None => current_root(state, window),
    }
}

fn expect_root(root: PathBuf, project_root: &str, action: &str) -> Result<PathBuf, String> {
    if root != Path::new(project_root) {
        return Err(format!("The project changed before {action}."));
    }
    Ok(root)
}

/// Only a caller that pinned a project takes its lease; an unpinned request is
/// a best-effort convenience and must not queue behind a sync.
pub(crate) async fn lease_if_pinned(
    state: &AppState, project_root: Option<&String>,
) -> Option<ProjectLease> {
    Some(state.lease(project_root?, Lease::Shared).await)
}

/// Run blocking domain work on the blocking pool, logging any failure.
pub(crate) async fn run_blocking<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_quietly(label, move || {
        task().inspect_err(|reason| {
            log::error!(target: "lattice::tasks", "{label} failed: {reason}");
        })
    })
    .await
}

/// [`run_blocking`] without logging the task's own failures, for commands the
/// frontend polls: a persistent failure there (offline, expired session) is
/// routine and would otherwise add a log line on every poll.
pub(crate) async fn run_quietly<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // The blocking pool does not inherit the caller's span; carry it over so
    // the task's fields land on the operation that started it.
    let span = tracing::Span::current();
    tauri::async_runtime::spawn_blocking(move || span.in_scope(task)).await.map_err(|error| {
        log::error!(target: "lattice::tasks", "{label} stopped unexpectedly: {error}");
        format!("{label} stopped unexpectedly: {error}")
    })?
}

/// Run `task` against the calling window's project on the blocking pool.
pub(crate) async fn in_project<T, F>(
    state: &AppState, window: &Window, label: &'static str, task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T, String> + Send + 'static,
{
    let root = current_root(state, window)?;
    run_blocking(label, move || task(&root)).await
}

/// Destination and contents of a file save sent as a raw IPC body. The
/// destination travels base64-encoded in `header` so any path survives it.
pub(crate) fn binary_save(
    request: &tauri::ipc::Request<'_>, header: &str, missing: &str, subject: &str, not_binary: &str,
) -> Result<(PathBuf, Vec<u8>), String> {
    let destination = request
        .headers()
        .get(header)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| missing.to_string())?;
    let invalid =
        |error: &dyn std::fmt::Display| format!("The {subject} destination is invalid: {error}");
    let decoded = STANDARD.decode(destination).map_err(|error| invalid(&error))?;
    let path = String::from_utf8(decoded).map_err(|error| invalid(&error))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(not_binary.to_string());
    };
    Ok((PathBuf::from(path), bytes.clone()))
}

#[cfg(test)]
mod tests {
    use super::expect_root;
    use std::path::PathBuf;

    #[test]
    fn a_delayed_project_action_cannot_move_to_the_new_project() {
        let root_a = PathBuf::from("/project/a");
        let action = "the action could start";

        assert_eq!(expect_root(root_a.clone(), "/project/a", action), Ok(root_a.clone()));
        assert_eq!(
            expect_root(root_a, "/project/b", action),
            Err("The project changed before the action could start.".to_string())
        );
    }
}
