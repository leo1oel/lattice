//! Overleaf over its REST interface: the session, cloning and publishing, chat,
//! comments, tracked changes, Overleaf's own history, and ZIP syncs. The live
//! editing channel is `overleaf_realtime`.

use super::overleaf_realtime::realtime_client;
use super::workspace::documents_folder;
use super::{current_root, in_project, pinned_root, run_blocking, run_quietly, scoped_root};
use crate::app_state::{AppState, Lease, ProjectLease};
use crate::{command_diagnostics, git, overleaf};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Window};
use tokio::time::Instant;

const LOGIN_WINDOW: &str = "overleaf-login";
const TASK: &str = "The Overleaf task";
const CHAT: &str = "The Overleaf chat task";
const COMMENTS: &str = "The Overleaf comment task";
const HISTORY: &str = "The Overleaf history";
const COMPARISON: &str = "The Overleaf comparison";

/// At most one full project download per this interval, across every window.
const FULL_SYNC_MIN_GAP: Duration = Duration::from_secs(7);

pub(crate) fn overleaf_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve the app config folder: {error}"))
}

/// Run an Overleaf REST call with the stored session for the window's pinned
/// project. `call` receives the config folder and the project root.
async fn rest_call<T: Send + 'static>(
    app: &AppHandle, state: &AppState, window: &Window, project_root: &str, label: &'static str,
    call: impl FnOnce(&Path, &Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let config = overleaf_config_dir(app)?;
    let root = scoped_root(state, window, project_root)?;
    run_blocking(label, move || call(&config, &root)).await
}

/// [`rest_call`] under the project's shared sync lease, so the call cannot
/// interleave with a full sync.
async fn leased_rest_call<T: Send + 'static>(
    app: &AppHandle, state: &AppState, window: &Window, project_root: &str, label: &'static str,
    call: impl FnOnce(&Path, &Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let _lease = state.lease(project_root, Lease::Shared).await;
    rest_call(app, state, window, project_root, label, call).await
}

/// Paths the realtime channel is editing right now. Syncing skips them: the
/// channel is already converging both copies, and a REST upload of the same
/// text would reach collaborators as an out-of-band overwrite.
fn live_paths(live: Option<Vec<String>>) -> BTreeSet<String> {
    live.unwrap_or_default().into_iter().collect()
}

/// [`live_paths`] plus every document the backend has joined for `root`,
/// which a stale UI snapshot may not list yet.
fn with_joined_paths(
    lease: &ProjectLease, root: &Path, live: Option<Vec<String>>,
) -> BTreeSet<String> {
    let mut paths = live_paths(live);
    if let Ok(realtime) = lease.project.realtime.lock() {
        realtime.extend_joined_paths(root, &mut paths);
    }
    paths
}

fn full_sync_delay(previous: Option<Instant>, now: Instant) -> Duration {
    previous
        .map(|started| (started + FULL_SYNC_MIN_GAP).saturating_duration_since(now))
        .unwrap_or_default()
}

/// The exclusive lease for a full project download, taken only once the
/// account-wide cooldown since the previous download has passed.
async fn full_sync_lease(state: &AppState, project_root: &str) -> ProjectLease {
    // Hold this guard until the write lease is ours. That admits only one
    // waiter at a time while document-level realtime work continues during
    // the cooldown, then records the actual full-download start.
    let mut previous_sync = state.overleaf_sync_started.lock().await;
    let delay = full_sync_delay(*previous_sync, Instant::now());
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let lease = state.lease(project_root, Lease::Exclusive).await;
    *previous_sync = Some(Instant::now());
    lease
}

#[tauri::command]
pub async fn overleaf_status(app: AppHandle) -> Result<overleaf::OverleafStatus, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf status", move || overleaf::session_status(&config)).await
}

/// Open Overleaf's own login page in a dedicated window. The user signs in
/// exactly as they would in a browser (including SSO); `overleaf_poll_login`
/// then captures the session cookie — no manual copying for the common case.
#[tauri::command]
pub fn overleaf_begin_login(app: AppHandle, host: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url = format!("{host}/login")
        .parse()
        .map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    tauri::WebviewWindowBuilder::new(&app, LOGIN_WINDOW, tauri::WebviewUrl::External(url))
        .title("Sign in to Overleaf")
        .inner_size(1040.0, 780.0)
        .build()
        .map_err(|error| format!("Could not open the Overleaf sign-in window: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn overleaf_poll_login(
    app: AppHandle, host: Option<String>,
) -> Result<overleaf::OverleafLoginPoll, String> {
    let Some(window) = app.get_webview_window(LOGIN_WINDOW) else {
        return Ok(overleaf::OverleafLoginPoll::cancelled());
    };
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url =
        host.parse().map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    let target_host = url.host_str().unwrap_or_default().to_string();
    // Read the whole jar and match domains ourselves: wry's `cookies_for_url`
    // compares cookie domain and URL host for equality, so a `.overleaf.com`
    // cookie never matches `www.overleaf.com` and sign-in appears to hang.
    let cookies = window.cookies().unwrap_or_default();
    let for_host = |domain: &str| overleaf::cookie_domain_matches(domain, &target_host);
    let matching: Vec<_> =
        cookies.iter().filter(|cookie| cookie.domain().is_some_and(for_host)).collect();
    if !overleaf::has_session_cookie(matching.iter().map(|cookie| cookie.name())) {
        return Ok(overleaf::OverleafLoginPoll::pending(None));
    }
    let pairs: Vec<_> =
        matching.iter().map(|cookie| format!("{}={}", cookie.name(), cookie.value())).collect();
    let header = pairs.join("; ");
    let config = overleaf_config_dir(&app)?;
    // Polled every second while the user signs in, and a rejected cookie is
    // the normal "not yet".
    let validated = run_quietly("The Overleaf login task", move || {
        Ok(overleaf::store_session_cookie(&config, &host, &header))
    })
    .await?;
    match validated {
        // A session cookie exists before the user finishes signing in (even
        // anonymous visitors get one), so a rejected cookie usually just means
        // "not yet" — keep polling, but hand the reason back so the UI can stop
        // spinning silently if it never resolves.
        Err(reason) => Ok(overleaf::OverleafLoginPoll::pending(Some(reason))),
        Ok(session) => {
            let _ = window.close();
            Ok(overleaf::OverleafLoginPoll::connected(session))
        }
    }
}

#[tauri::command]
pub async fn overleaf_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.close();
    }
    // The live channel authenticates with the session being thrown away.
    state.shutdown_all_realtime();
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf disconnect", move || overleaf::disconnect(&config)).await
}

#[tauri::command]
pub async fn overleaf_list_projects(
    app: AppHandle,
) -> Result<Vec<overleaf::OverleafProject>, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking(TASK, move || overleaf::list_projects(&config)).await
}

/// Where Overleaf projects are downloaded to.
fn overleaf_projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    documents_folder(app, "Overleaf Projects", "the Overleaf Projects folder")
}

/// What opening this project would do, so the app can ask before it acts.
#[tauri::command]
pub async fn overleaf_clone_target(
    app: AppHandle, project_id: String, name: String,
) -> Result<overleaf::CloneTarget, String> {
    let parent = overleaf_projects_dir(&app)?;
    run_blocking("Overleaf project location", move || {
        overleaf::clone_target(&project_id, &name, &parent)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_clone_project(
    app: AppHandle,
    project_id: String,
    name: String,
    access_level: Option<String>,
    // `adopt`: link the folder already sitting there instead of downloading a
    // second copy beside it. Only meaningful when `overleaf_clone_target`
    // reported `occupied`.
    adopt: Option<bool>,
) -> Result<String, String> {
    let config = overleaf_config_dir(&app)?;
    let parent = overleaf_projects_dir(&app)?;
    let root = run_blocking("The Overleaf download", move || {
        let access_level = access_level.as_deref();
        if adopt.unwrap_or(false) {
            let target = overleaf::clone_target(&project_id, &name, &parent)?;
            if target.kind == "occupied" {
                let existing = Path::new(&target.path);
                return overleaf::adopt_project(
                    &config,
                    &project_id,
                    &name,
                    existing,
                    access_level,
                );
            }
        }
        overleaf::clone_project(&config, &project_id, &name, &parent, access_level)
    })
    .await?;
    // Cloned projects start version tracking immediately so the Versions
    // timeline can show what each future sync changed.
    let _ = git::init(&root);
    // Downloading and opening are separate phases. The picker opens this root
    // through `open_project` only after the download succeeds, so a failed
    // open can never leave the backend on B while the UI restores A.
    Ok(root.to_string_lossy().to_string())
}

/// Publish the currently open local project to a new Overleaf project, then
/// keep this same folder as its synchronized working copy.
#[tauri::command]
pub async fn overleaf_publish_project(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    project_name: String,
) -> Result<overleaf::OverleafLink, String> {
    let _lease = state.lease(&project_root, Lease::Exclusive).await;
    rest_call(&app, &state, &window, &project_root, "The Overleaf upload", move |config, root| {
        overleaf::publish_project(config, root, &project_name)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_link(
    state: State<'_, AppState>, window: Window,
) -> Result<Option<overleaf::OverleafLink>, String> {
    in_project(&state, &window, "Overleaf project link", overleaf::project_link).await
}

#[tauri::command]
pub async fn overleaf_chat_messages(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    limit: Option<u32>,
) -> Result<Vec<overleaf::OverleafMessage>, String> {
    let limit = limit.unwrap_or(80);
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    run_quietly(CHAT, move || overleaf::chat_messages(&config, &root, limit)).await
}

#[tauri::command]
pub async fn overleaf_send_chat_message(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    content: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, CHAT, move |config, root| {
        overleaf::send_chat_message(config, root, &content)
    })
    .await
}

/// Record what Overleaf says this account may do to the linked project.
#[tauri::command]
pub async fn overleaf_set_permission(
    state: State<'_, AppState>, window: Window, project_root: String, permission: String,
) -> Result<(), String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = current_root(&state, &window)?;
    // The realtime result is scoped to the project that was connected. An
    // invoke can cross a UI project switch before this handler is scheduled;
    // never write the previous project's role into the newly active project.
    if root != Path::new(&project_root) {
        return Ok(());
    }
    run_blocking("Overleaf permission update", move || overleaf::set_permission(&root, &permission))
        .await
}

#[tauri::command]
pub async fn overleaf_history_updates(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    before: Option<i64>, count: Option<u32>,
) -> Result<serde_json::Value, String> {
    let (updates, next) =
        rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
            overleaf::history_updates(config, root, before, count.unwrap_or(20))
        })
        .await?;
    Ok(serde_json::json!({ "updates": updates, "nextBefore": next }))
}

#[tauri::command]
pub async fn overleaf_history_diff(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, path: String,
    from: i64, to: i64,
) -> Result<serde_json::Value, String> {
    rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_diff(config, root, &path, from, to)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_files(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_files(config, root, from, to)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_labels(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Vec<overleaf::OverleafLabel>, String> {
    rest_call(&app, &state, &window, &project_root, HISTORY, overleaf::history_labels).await
}

/// Roll one file back, or the whole project when `path` is absent.
#[tauri::command]
pub async fn overleaf_history_revert(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    path: Option<String>,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_revert(config, root, version, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_restore_file(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    path: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_restore_file(config, root, version, &path)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_add_label(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, version: i64,
    comment: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_add_label(config, root, version, &comment)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_history_delete_label(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    label_id: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, HISTORY, move |config, root| {
        overleaf::history_delete_label(config, root, &label_id)
    })
    .await
}

/// Accept tracked changes, turning the suggested text into ordinary text.
#[tauri::command]
pub async fn overleaf_accept_changes(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    doc_id: String, change_ids: Vec<String>,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, TASK, move |config, root| {
        overleaf::accept_changes(config, root, &doc_id, &change_ids)
    })
    .await
}

/// Who wrote the suggestions in this project.
#[tauri::command]
pub async fn overleaf_change_authors(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<serde_json::Value, String> {
    rest_call(&app, &state, &window, &project_root, TASK, overleaf::change_authors).await
}

/// Delete a document, file or folder on Overleaf.
#[tauri::command]
pub async fn overleaf_delete_entity(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String, kind: String,
    entity_id: String,
) -> Result<(), String> {
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let config = overleaf_config_dir(&app)?;
    let root = pinned_root(&state, &window, &project_root, "the Overleaf item could be removed")?;
    run_blocking(TASK, move || overleaf::delete_entity(&config, &root, &kind, &entity_id)).await
}

#[tauri::command]
pub async fn overleaf_threads(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Vec<overleaf::OverleafThread>, String> {
    rest_call(&app, &state, &window, &project_root, COMMENTS, overleaf::threads).await
}

/// Where every comment in the project is anchored, whatever file it is in.
#[tauri::command]
pub async fn overleaf_comment_anchors(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Vec<overleaf::OverleafCommentAnchor>, String> {
    rest_call(&app, &state, &window, &project_root, COMMENTS, overleaf::comment_anchors).await
}

#[tauri::command]
pub async fn overleaf_edit_message(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    thread_id: String, message_id: String, content: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::edit_message(config, root, &thread_id, &message_id, &content)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_delete_message(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    thread_id: String, message_id: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::delete_message(config, root, &thread_id, &message_id)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_reply_to_thread(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    thread_id: String, content: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::reply_to_thread(config, root, &thread_id, &content)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_resolve_thread(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    doc_id: String, thread_id: String, resolved: bool,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::resolve_thread(config, root, &doc_id, &thread_id, resolved)
    })
    .await
}

#[tauri::command]
pub async fn overleaf_delete_thread(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    doc_id: String, thread_id: String,
) -> Result<(), String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::delete_thread(config, root, &doc_id, &thread_id)
    })
    .await
}

/// Dry run: what a sync would change, without writing or uploading anything.
#[tauri::command]
pub async fn overleaf_preview(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafPreview, String> {
    let live = live_paths(live);
    leased_rest_call(&app, &state, &window, &project_root, COMPARISON, move |config, root| {
        overleaf::preview(config, root, &live)
    })
    .await
}

/// Stop or restart syncing for the open project.
#[tauri::command]
pub async fn overleaf_set_paused(
    state: State<'_, AppState>, window: Window, project_root: String, paused: bool,
) -> Result<(), String> {
    let lease = state.lease(&project_root, Lease::Exclusive).await;
    let root = scoped_root(&state, &window, &project_root)?;
    if paused {
        // A socket left open would keep delivering edits, chat and presence
        // for a project the user just asked us to leave alone.
        lease.project.shutdown_realtime();
    }
    run_blocking("Overleaf sync setting", move || overleaf::set_paused(&root, paused)).await
}

#[tauri::command]
pub async fn overleaf_probe(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    check_local: Option<bool>, live: Option<Vec<String>>,
) -> Result<overleaf::OverleafProbe, String> {
    let lease = state.lease(&project_root, Lease::Shared).await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    let local_live_paths =
        check_local.unwrap_or(false).then(|| with_joined_paths(&lease, &root, live));
    run_quietly("The Overleaf check", move || {
        overleaf::probe(&config, &root, local_live_paths.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn overleaf_sync(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    live: Option<Vec<String>>, observed_remote_version: Option<i64>,
    diagnostic_context: Option<command_diagnostics::DiagnosticContext>,
) -> Result<overleaf::OverleafSyncResult, String> {
    command_diagnostics::traced("overleaf_sync", diagnostic_context, async {
        let lease = full_sync_lease(&state, &project_root).await;
        let config = overleaf_config_dir(&app)?;
        let root = pinned_root(&state, &window, &project_root, "Overleaf sync could start")?;
        let live = with_joined_paths(&lease, &root, live);
        let entities =
            realtime_client(&state, &window).ok().and_then(|client| client.current_entities());
        run_blocking("The Overleaf sync", move || {
            overleaf::sync_relocations(&config, &root, entities)?;
            overleaf::sync(&config, &root, &live, observed_remote_version)
        })
        .await
    })
    .await
}

/// Replay local moves already committed to the Share catalog, then prepare
/// content sync from its authoritative snapshot. Content does not mutate
/// until the frontend applies the returned actions to Yjs and calls
/// `overleaf_commit_prepared_sync` with the exact accepted bytes.
// Keep the existing IPC fields separate from the optional diagnostic context.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn overleaf_prepare_sync(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    authoritative_inventory: Vec<overleaf::OverleafAuthoritativeEntry>, live: Option<Vec<String>>,
    observed_remote_version: Option<i64>,
    diagnostic_context: Option<command_diagnostics::DiagnosticContext>,
) -> Result<overleaf::OverleafPreparedSync, String> {
    command_diagnostics::traced("overleaf_prepare_sync", diagnostic_context, async {
        let _lease = full_sync_lease(&state, &project_root).await;
        let config = overleaf_config_dir(&app)?;
        let root = pinned_root(&state, &window, &project_root, "Overleaf sync could start")?;
        let live = live_paths(live);
        let entities =
            realtime_client(&state, &window).ok().and_then(|client| client.current_entities());
        run_blocking("The Overleaf sync preparation", move || {
            overleaf::sync_relocations(&config, &root, entities)?;
            let inventory = &authoritative_inventory;
            overleaf::prepare_sync(&config, &root, inventory, &live, observed_remote_version)
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn overleaf_commit_prepared_sync(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    prepared_plan_id: String, accepted_actions: Vec<overleaf::OverleafAcceptedAction>,
    diagnostic_context: Option<command_diagnostics::DiagnosticContext>,
) -> Result<overleaf::OverleafSyncResult, String> {
    command_diagnostics::traced("overleaf_commit_prepared_sync", diagnostic_context, async {
        let _lease = state.lease(&project_root, Lease::Exclusive).await;
        let config = overleaf_config_dir(&app)?;
        let root = pinned_root(&state, &window, &project_root, "Overleaf sync could finish")?;
        run_blocking("The Overleaf sync commit", move || {
            overleaf::commit_prepared_sync(&config, &root, &prepared_plan_id, &accepted_actions)
        })
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_overleaf_syncs_cannot_exhaust_the_download_allowance() {
        let now = Instant::now();

        assert!(full_sync_delay(None, now).is_zero());
        assert_eq!(
            full_sync_delay(Some(now - Duration::from_secs(3)), now),
            Duration::from_secs(4)
        );
        assert!(full_sync_delay(Some(now - Duration::from_secs(7)), now).is_zero());
    }
}
