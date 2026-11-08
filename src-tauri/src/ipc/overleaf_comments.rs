//! Overleaf's comment threads: reading them and their anchors, and the
//! messages, resolutions and deletions that change them, all through the
//! signed-in session's REST calls for the window's pinned project.

use super::overleaf::{leased_rest_call, rest_call};
use crate::app_state::AppState;
use crate::overleaf;
use tauri::{AppHandle, State, Window};

const COMMENTS: &str = "The Overleaf comment task";

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

/// Start a thread on a passage of a document the editor does not have open:
/// a comment made on the PDF, on text from another file. `from` counts UTF-16
/// units into `source`, Lattice's copy of that file, where `quote` starts.
/// See `overleaf::comment_in_document` for why it joins the document itself.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn overleaf_comment_in_document(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    doc_id: String, source: String, from: usize, quote: String, thread_id: String, content: String,
) -> Result<overleaf::CommentPlacement, String> {
    leased_rest_call(&app, &state, &window, &project_root, COMMENTS, move |config, root| {
        overleaf::comment_in_document(
            config, root, &doc_id, &source, from, &quote, &thread_id, &content,
        )
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
