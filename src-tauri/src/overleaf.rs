//! Overleaf sync bridge.
//!
//! Talks to Overleaf's private web API the same way the browser does, using a
//! session cookie the user copies from a logged-in browser. Protocol facts,
//! pinned against overleaf-sync (moritzgloeckl), overleaf-sync-rs, and the
//! current overleaf/overleaf server source:
//!
//! - Auth is the plain `Cookie` header (`overleaf_session2=...` on
//!   overleaf.com; self-hosted instances may use `sharelatex.sid`). We store
//!   the full cookie header value verbatim.
//! - `GET {host}/project` (the dashboard) embeds everything we need in meta
//!   tags: `ol-csrfToken`, `ol-prefetchedProjectsBlob` (HTML-entity-encoded
//!   JSON `{ totalSize, projects: [...] }`; legacy instances use
//!   `ol-projects` with a bare array), and `ol-user` (JSON with `email`,
//!   `first_name`, `last_name`).
//! - `GET {host}/project/{id}/download/zip` returns the whole project as a
//!   zip archive.
//! - `POST {host}/project/new/upload` creates a project from a zip archive as
//!   multipart fields `name` and `qqfile`. The JSON response carries the new
//!   `project_id`; CSRF uses the same dashboard token as other mutations.
//! - `POST {host}/project/{id}/upload?folder_id={folder}` uploads one file as
//!   multipart: `name` (file name), `relativePath`, and the file part
//!   `qqfile`. CSRF goes in the `X-Csrf-Token` header (plus `_csrf` query
//!   param, mirroring overleaf-sync). `folder_id` is **required**: the server
//!   reads it from the query string and answers 422 `folder_not_found` when
//!   it is missing, so it cannot be omitted for root-level files.
//! - The root folder id is only exposed over socket.io (`joinProject`). The
//!   realtime bridge records that id in the local link state, then REST uploads
//!   use `folder_id=<root>` and the project-relative path verbatim. Overleaf
//!   creates missing subfolders for nested relative paths.
//!
//! Layout: `account` is the signed-in session, `link` the persisted link
//! between a folder and a project (and how one is made), `files` the local
//! side of sync and its merge bases, `sync` the ZIP-based sync, preview and
//! probe, `review` chat, comments, history and tracked changes, and `api` the
//! HTTP plumbing all of them share.

mod account;
mod api;
mod files;
mod link;
mod review;
mod sync;
#[cfg(test)]
mod test_support;

pub use account::{
    cookie_domain_matches, disconnect, has_session_cookie, list_projects, normalize_host,
    session_status, store_session_cookie, OverleafLoginPoll, OverleafProject, OverleafStatus,
};
pub use files::{checkpoint_realtime_text, is_conflict_copy, RealtimeCheckpoint};
pub use link::{
    adopt_project, clone_project, clone_target, project_link, publish_project, realtime_config,
    record_relocation, set_paused, set_permission, set_realtime_metadata, CloneTarget,
    OverleafLink,
};
pub use review::{
    accept_changes, change_authors, chat_messages, comment_anchors, delete_entity, delete_message,
    delete_thread, edit_message, history_add_label, history_delete_label, history_diff,
    history_files, history_restore_file, history_revert, history_updates, reply_to_thread,
    resolve_thread, send_chat_message, threads, OverleafCommentAnchor, OverleafMessage,
    OverleafThread,
};
pub use sync::{
    preview, probe, sync, sync_relocations, OverleafPreview, OverleafProbe, OverleafSyncResult,
};
