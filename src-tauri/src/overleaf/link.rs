//! The link between a local folder and an Overleaf project: the persisted sync
//! state in `.research/overleaf.json`, its small setters, and the three ways a
//! link comes to exist — cloning a project, adopting a folder already on disk,
//! or publishing a local project as a new one.

use super::account::{ensure_user_id, load_session};
use super::api::{
    csrf_token, download_project_zip, err, fetch_remote_version, http_client, read_zip_entries,
    send_as, sync_host, JSON,
};
use super::files::{
    has_conflict_markers, is_excluded, is_latex_save_error_path, is_transient_pdf_render_path,
    read_local_files, sha256_hex, write_base_copy, write_local_file, LocalFiles,
};
use super::review::HistoryFrom;
use crate::project_fs::ProjectDir;
use reqwest::header::{ACCEPT, COOKIE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const STATE_DIR: &str = ".research";
pub(super) const STATE_FILE: &str = "overleaf.json";
pub(super) const PAUSED: &str =
    "Syncing is paused for this project. Resume it in Settings → Overleaf.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafLink {
    pub project_id: String,
    pub project_name: String,
    pub host: String,
    pub last_sync: Option<String>,
    /// Linked, but not syncing until it is resumed.
    pub paused: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncState {
    pub host: String,
    pub project_id: String,
    pub project_name: String,
    /// Root entity returned by realtime `joinProject`. Per-file REST uploads
    /// require it; the ordinary project HTTP pages do not expose it.
    #[serde(default)]
    pub root_folder_id: Option<String>,
    #[serde(default)]
    pub last_sync: Option<String>,
    /// Newest history version seen on Overleaf at the last sync. Comparing a
    /// cheap probe against this is what lets live mode poll every few seconds
    /// without downloading the project each time.
    #[serde(default)]
    pub remote_version: Option<i64>,
    /// What this account may do to the project, as Overleaf last reported it.
    /// Absent on projects linked before this was recorded (see
    /// [`permits_writing`]).
    #[serde(default)]
    pub permission: Option<String>,
    /// Relative path (forward slashes) → sha256 hex of the content at the
    /// last successful sync.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Syncing is switched off for this project, but everything needed to
    /// switch it back on is kept — including `files`, the common ancestor a
    /// resumed sync merges against. Deleting the link instead would throw that
    /// away, and reconnecting afterwards could only offer conflict copies.
    #[serde(default)]
    pub paused: bool,
    /// Explicit local moves, replayed by entity id before content sync. Keep
    /// these across offline edits and restarts rather than inferring identity
    /// from identical bytes (two different files may have the same content).
    #[serde(default)]
    pub pending_relocations: Vec<PendingRelocation>,
    /// Paths whose download would have emptied or gutted the local file
    /// without Overleaf's history confirming the change.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub refused: BTreeMap<String, Refusal>,
}

/// One download kept out of a local file (see `SyncState::refused`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Refusal {
    /// Where the agreed copy stood at the first refusal (`None`: there was
    /// none). History from then on can still confirm the change, even when
    /// one check could not read it.
    pub since: Option<HistoryFrom>,
    /// sha256 hex of the Overleaf copy refused, so the same download is
    /// reported once rather than on every sync.
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PendingRelocation {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub entity_id: Option<String>,
}

impl SyncState {
    fn linked(
        host: String, project_id: &str, project_name: &str, permission: Option<&str>,
    ) -> Self {
        SyncState {
            host,
            project_id: project_id.to_string(),
            project_name: project_name.to_string(),
            permission: permission.map(str::to_string),
            ..Default::default()
        }
    }

    fn link(self) -> OverleafLink {
        let SyncState { project_id, project_name, host, last_sync, paused, .. } = self;
        OverleafLink { project_id, project_name, host, last_sync, paused }
    }

    /// The root folder id uploads need, once realtime has supplied it.
    pub fn root_folder(&self) -> Result<&str, String> {
        self.root_folder_id.as_deref().ok_or_else(|| {
            "Overleaf is still preparing file uploads. Try syncing again in a moment.".to_string()
        })
    }
}

/// True only when Overleaf explicitly said this account may change project
/// contents.
///
/// Older links did not persist a permission. Treating that unknown state as
/// writable lets an automatic sync attempt mutations before the realtime
/// channel has refreshed the account's current role. Incoming work may still
/// be pulled; outgoing work stays local until a fresh owner/editor permission
/// is recorded.
pub(super) fn permits_writing(permission: Option<&str>) -> bool {
    matches!(permission, Some("owner") | Some("readAndWrite"))
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true).to_string()
}

pub(super) fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STATE_FILE)
}

pub(super) fn load_state(root: &Path) -> Result<SyncState, String> {
    let raw = fs::read_to_string(state_path(root))
        .map_err(|_| "This project is not linked to an Overleaf project.".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Could not read {STATE_DIR}/{STATE_FILE}: {e}"))
}

pub(super) fn save_state(root: &Path, state: &SyncState) -> Result<(), String> {
    fs::create_dir_all(root.join(STATE_DIR)).map_err(err)?;
    let body = serde_json::to_string_pretty(state).map_err(err)?;
    ProjectDir::open(root)?
        .atomic_write(&format!("{STATE_DIR}/{STATE_FILE}"), (body + "\n").as_bytes())
}

/// Called while the structural mutation/sync lease is held. Failure must
/// roll back the local move, otherwise the next sync sees a deletion.
pub fn record_relocation(root: &Path, from: &str, to: &str) -> Result<(), String> {
    if from == to || !state_path(root).exists() {
        return Ok(());
    }
    let mut state = load_state(root)?;
    let relocation =
        PendingRelocation { from: from.to_string(), to: to.to_string(), entity_id: None };
    state.pending_relocations.push(relocation);
    save_state(root, &state)
}

pub fn project_link(root: &Path) -> Result<Option<OverleafLink>, String> {
    if !state_path(root).exists() {
        return Ok(None);
    }
    Ok(Some(load_state(root)?.link()))
}

/// Stop or restart syncing this project, keeping the link either way.
///
/// Pausing is not unlinking: the state file and the base copies stay, so
/// resuming picks up as an ordinary sync against the last common ancestor —
/// edits made on either side while it was paused merge line by line, and only
/// genuinely overlapping ones need a person.
pub fn set_paused(root: &Path, paused: bool) -> Result<(), String> {
    let mut state = load_state(root)?;
    state.paused = paused;
    save_state(root, &state)
}

/// Record what Overleaf says this account may do, so syncing can respect it
/// even when the realtime channel is not connected.
pub fn set_permission(root: &Path, permission: &str) -> Result<(), String> {
    let mut state = load_state(root)?;
    if state.permission.as_deref() == Some(permission) {
        return Ok(());
    }
    state.permission = Some(permission.to_string());
    save_state(root, &state)
}

/// Record upload metadata available only from realtime `joinProject`.
///
/// This is persisted before the frontend treats the channel as live, so the
/// first automatic sync can upload new files without racing the socket join.
pub fn set_realtime_metadata(
    root: &Path, root_folder_id: &str, permission: &str,
) -> Result<(), String> {
    let root_folder_id = root_folder_id.trim();
    if root_folder_id.is_empty() {
        return Err("Overleaf's project join returned no root folder id.".to_string());
    }
    let mut state = load_state(root)?;
    if state.root_folder_id.as_deref() == Some(root_folder_id)
        && state.permission.as_deref() == Some(permission)
    {
        return Ok(());
    }
    state.root_folder_id = Some(root_folder_id.to_string());
    state.permission = Some(permission.to_string());
    save_state(root, &state)
}

/// What the realtime channel needs to open a connection for this project:
/// (host, cookie, project id, our account id).
pub fn realtime_config(
    config_dir: &Path, root: &Path,
) -> Result<(String, String, String, Option<String>), String> {
    let mut session = load_session(config_dir)?;
    let state = load_state(root)?;
    if state.paused {
        return Err(PAUSED.to_string());
    }
    let host = sync_host(&state, &session)?;
    let user_id = ensure_user_id(config_dir, &mut session);
    Ok((host, session.cookie, state.project_id, user_id))
}

// ---- Opening a project from Overleaf -----------------------------------------

/// What "Open from Overleaf" would do with a project, so the app can ask
/// before it acts rather than quietly pick.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneTarget {
    /// `open` — already linked here, just open it.
    /// `fresh` — nothing in the way, download it.
    /// `occupied` — a folder of that name holds files but is not linked to
    /// any Overleaf project. Unlinking leaves exactly this, so it is the
    /// state a project is in after Stop syncing.
    pub kind: String,
    pub path: String,
    /// The folder's name, for saying which one is meant.
    pub folder: String,
}

/// `fresh`, `open` or `occupied`, as in [`CloneTarget::kind`].
fn occupancy(root: &Path, project_id: &str) -> &'static str {
    if !root.exists() || fs::read_dir(root).is_ok_and(|mut entries| entries.next().is_none()) {
        "fresh"
    } else if load_state(root).is_ok_and(|state| state.project_id == project_id) {
        "open"
    } else {
        "occupied"
    }
}

/// Describe the destination without touching anything.
pub fn clone_target(
    project_id: &str, project_name: &str, dest_parent: &Path,
) -> Result<CloneTarget, String> {
    let folder = sanitize_project_name(project_name)?;
    let root = dest_parent.join(&folder);
    let kind = occupancy(&root, project_id).to_string();
    Ok(CloneTarget { kind, path: root.to_string_lossy().into_owned(), folder })
}

/// Fold a project name into a safe folder name, mirroring
/// `project::validate_new_project_name` (no separators) and stripping
/// characters macOS cannot store.
fn sanitize_project_name(name: &str) -> Result<String, String> {
    let cleaned: String = (name.trim().chars())
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("That Overleaf project name cannot be used as a folder name.".to_string());
    }
    Ok(cleaned)
}

/// Link a folder that is already on disk to an Overleaf project, without
/// downloading over it.
///
/// No base copies are written, and the file table starts empty, which is the
/// truth: there is no common ancestor for these two copies. The first sync
/// therefore treats every file that differs as a conflict — Overleaf's version
/// takes the path and the local one is kept beside it as
/// `name (local conflict …)` — and files that are byte-identical stay quiet.
/// Nothing is overwritten silently and nothing is thrown away.
pub fn adopt_project(
    config_dir: &Path, project_id: &str, project_name: &str, root: &Path,
    access_level: Option<&str>,
) -> Result<PathBuf, String> {
    let session = load_session(config_dir)?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    save_state(root, &SyncState::linked(session.host, project_id, project_name, access_level))?;
    Ok(root.to_path_buf())
}

/// Download a project and link it. `access_level` is what the dashboard said
/// this account may do, so syncing respects it even before the realtime
/// channel has a chance to confirm.
///
/// A project that is already downloaded here simply opens: a second copy of a
/// project that syncs would only be a second thing to keep in step. A folder of
/// the same name holding something else does not block the download either;
/// the copy lands beside it under a numbered name, the way a second download of
/// the same file would.
pub fn clone_project(
    config_dir: &Path, project_id: &str, project_name: &str, dest_parent: &Path,
    access_level: Option<&str>,
) -> Result<PathBuf, String> {
    let session = load_session(config_dir)?;
    let folder_name = sanitize_project_name(project_name)?;
    let candidates = std::iter::once(folder_name.clone())
        .chain((2..100).map(|suffix| format!("{folder_name} ({suffix})")))
        .map(|name| dest_parent.join(name));
    let mut root = dest_parent.join(&folder_name);
    for candidate in candidates {
        match occupancy(&candidate, project_id) {
            "fresh" => {
                root = candidate;
                break;
            }
            "open" => {
                // The one thing that can have changed while it sat there: what
                // this account is now allowed to do with the project. A
                // missing dashboard role clears an old writable role: unknown
                // must fail closed until realtime supplies fresh evidence.
                let mut state = load_state(&candidate)?;
                if state.permission.as_deref() != access_level {
                    state.permission = access_level.map(str::to_string);
                    save_state(&candidate, &state)?;
                }
                return Ok(candidate);
            }
            _ => {}
        }
    }
    let client = http_client(120)?;
    // This version was observed before the downloaded snapshot. Recording a
    // newer version fetched afterwards could claim that edits made while the
    // zip was in flight are already present on disk.
    let remote_version = fetch_remote_version(&client, &session.host, &session.cookie, project_id);
    let zip_bytes = download_project_zip(&client, &session.host, &session.cookie, project_id)?;
    let entries = read_zip_entries(&zip_bytes)?;

    fs::create_dir_all(&root).map_err(err)?;
    let mut files = BTreeMap::new();
    for (rel, data) in &entries {
        // Old Lattice versions could upload local PDF-render intermediates and
        // failed-build outputs. Do not materialize either when cloning the
        // Overleaf project; a later sync asks the live tree to remove them.
        if is_transient_pdf_render_path(rel) || is_latex_save_error_path(rel) {
            continue;
        }
        write_local_file(&root, rel, data)?;
        if !is_excluded(rel) {
            files.insert(rel.clone(), sha256_hex(data));
            // The freshly cloned state is the first common ancestor, so later
            // syncs can merge concurrent edits instead of choosing a winner.
            write_base_copy(&root, rel, data)?;
        }
    }
    let state = SyncState {
        last_sync: Some(now_iso()),
        remote_version,
        files,
        ..SyncState::linked(session.host, project_id, project_name, access_level)
    };
    save_state(&root, &state)?;
    Ok(root)
}

/// Create a new Overleaf project from the current local files and make this
/// folder its synchronized working copy.
///
/// The archive is built from the same filtered snapshot ordinary sync uses, so app state, credentials, build output and
/// oversized files cannot leak through a broader export path. Recording that
/// snapshot as the first common ancestor means an edit made locally while the
/// upload is in flight is pushed by the next sync rather than mistaken for
/// content already present remotely.
pub fn publish_project(
    config_dir: &Path, root: &Path, requested_name: &str,
) -> Result<OverleafLink, String> {
    if state_path(root).exists() {
        return Err("This project is already linked to an Overleaf project.".to_string());
    }
    let project_name = sanitize_project_name(requested_name)?;
    let LocalFiles { files, oversized } = read_local_files(root)?;
    if !oversized.is_empty() {
        return Err(format!("These files are too large for Overleaf: {}.", oversized.join(", ")));
    }
    if files.is_empty() {
        return Err("This project has no files that can be uploaded to Overleaf.".to_string());
    }
    let unresolved: Vec<&str> = (files.iter())
        .filter(|(_, bytes)| has_conflict_markers(bytes))
        .map(|(path, _)| path.as_str())
        .collect();
    if !unresolved.is_empty() {
        return Err(format!(
            "Resolve the conflict markers before publishing: {}.",
            unresolved.join(", ")
        ));
    }

    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in &files {
        writer
            .start_file(path, zip::write::SimpleFileOptions::default())
            .map_err(err)
            .and_then(|()| writer.write_all(bytes).map_err(err))
            .map_err(|error| format!("Could not prepare {path} for Overleaf: {error}"))?;
    }
    let archive = writer
        .finish()
        .map_err(|error| format!("Could not finish the Overleaf archive: {error}"))?
        .into_inner();

    let session = load_session(config_dir)?;
    let client = http_client(180)?;
    let csrf = csrf_token(&client, &session.host, &session.cookie)?;
    let archive_name = format!("{project_name}.zip");
    let part = reqwest::blocking::multipart::Part::bytes(archive)
        .file_name(archive_name.clone())
        .mime_str("application/zip")
        .map_err(err)?;
    let form =
        reqwest::blocking::multipart::Form::new().text("name", archive_name).part("qqfile", part);
    let request = client
        .post(format!("{}/project/new/upload", session.host))
        .header(COOKIE, &session.cookie)
        .header("X-Csrf-Token", &csrf)
        .header(ACCEPT, JSON)
        .multipart(form);
    let response =
        send_as(request, |error| format!("Could not upload the project to Overleaf: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let payload = serde_json::from_str::<Value>(&body).ok();
    let field = |key: &str| payload.as_ref().and_then(|value| value.get(key));
    let success = field("success").and_then(Value::as_bool).unwrap_or(status.is_success());
    if !status.is_success() || !success {
        let detail = field("error").and_then(Value::as_str).unwrap_or(body.trim());
        let detail = if detail.is_empty() { "the server did not explain why" } else { detail };
        return Err(format!("Overleaf could not create the project ({status}): {detail}"));
    }
    let project_id = field("project_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Overleaf created the project but returned no project id.".to_string())?
        .to_string();

    let remote_version = fetch_remote_version(&client, &session.host, &session.cookie, &project_id);
    let state = SyncState {
        last_sync: Some(now_iso()),
        remote_version,
        files: files.iter().map(|(path, bytes)| (path.clone(), sha256_hex(bytes))).collect(),
        ..SyncState::linked(session.host.clone(), &project_id, &project_name, Some("owner"))
    };
    let finish_link = (|| {
        for (path, bytes) in &files {
            write_base_copy(root, path, bytes)?;
        }
        save_state(root, &state)
    })();
    if let Err(error) = finish_link {
        return Err(format!(
            "Overleaf created {}/project/{project_id}, but Lattice could not link this folder: {error}",
            session.host
        ));
    }
    Ok(state.link())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::files::read_base_copy;
    use crate::overleaf::test_support::*;

    /// `last_sync` and conflict-copy stamps are written with chrono; both
    /// must parse back into the instant they were taken.
    #[test]
    fn sync_timestamps_round_trip_through_chrono() {
        let before = chrono::Utc::now();
        let iso = now_iso();
        let stamp = crate::overleaf::sync::sync_stamp();
        let after = chrono::Utc::now();

        assert!(iso.ends_with('Z'), "{iso}");
        let parsed =
            chrono::DateTime::parse_from_rfc3339(&iso).unwrap().with_timezone(&chrono::Utc);
        assert_eq!(parsed.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), iso);
        assert!(
            parsed.timestamp() >= before.timestamp() && parsed.timestamp() <= after.timestamp()
        );

        let local = chrono::NaiveDateTime::parse_from_str(&stamp, "%Y%m%d-%H%M").unwrap();
        assert_eq!(local.format("%Y%m%d-%H%M").to_string(), stamp);
        let minute = |t: chrono::DateTime<chrono::Utc>| {
            t.with_timezone(&chrono::Local).naive_local().format("%Y%m%d-%H%M").to_string()
        };
        assert!(stamp == minute(before) || stamp == minute(after), "{stamp}");
    }

    /// Pausing, and recording what the realtime channel learned, keep what a
    /// resumed sync needs to merge.
    ///
    /// The whole reason to pause rather than unlink: the file table is the
    /// common ancestor, and without it reconnecting can only offer a conflict
    /// copy of every file that differs.
    #[test]
    fn pausing_and_realtime_metadata_keep_the_link_and_its_common_ancestor() {
        let base = b"the copy from the last sync\n";
        let root = linked_root(&[], &[("main.tex", base)]);
        edit_state(&root, |state| state.remote_version = Some(42));
        let keeps_the_base = || {
            let state = load_state(&root).unwrap();
            assert_eq!(state.files.get("main.tex"), Some(&sha256_hex(base)));
            assert_eq!(state.remote_version, Some(42));
            let copy = read_base_copy(&root, "main.tex").map(String::into_bytes);
            assert_eq!(copy, Some(base.to_vec()));
        };

        set_paused(&root, true).unwrap();
        let link = project_link(&root).unwrap().expect("still linked");
        assert!(link.paused);
        assert_eq!(link.project_id, "proj-1");
        keeps_the_base();
        set_paused(&root, false).unwrap();
        assert!(!project_link(&root).unwrap().unwrap().paused);

        set_realtime_metadata(&root, "new-root-folder", "owner").unwrap();
        let state = load_state(&root).unwrap();
        assert_eq!(state.root_folder_id.as_deref(), Some("new-root-folder"));
        assert_eq!(state.permission.as_deref(), Some("owner"));
        keeps_the_base();
    }

    /// Stop syncing, edit, then open the project from Overleaf again.
    ///
    /// Unlinking deletes the state file, so the folder is no longer
    /// recognisable as that project; it must be offered for relinking, not
    /// downloaded again into `Name (2)` with the edits stranded beside it. An
    /// absent or empty folder is a plain download.
    #[test]
    fn a_folder_left_by_unlinking_is_offered_for_relinking_not_duplicated() {
        let (parent, config) = (TempDir::new("adopt"), signed_in("https://www.overleaf.com"));
        let root = parent.join("Attention Paper");
        let kind = |project_id: &str| clone_target(project_id, "Attention Paper", &parent).unwrap();
        assert_eq!(kind("proj-1").kind, "fresh");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(kind("proj-1").kind, "fresh");
        fs::write(root.join("main.tex"), b"edited after unlinking\n").unwrap();

        // Files present, no link: the state Stop syncing leaves behind.
        let target = kind("proj-1");
        assert_eq!((target.kind.as_str(), target.folder.as_str()), ("occupied", "Attention Paper"));

        let adopted =
            adopt_project(&config, "proj-1", "Attention Paper", &root, Some("readAndWrite"))
                .unwrap();
        assert_eq!(adopted, root);
        // The edit is untouched — adopting links, it does not download over it.
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "edited after unlinking\n");
        // No common ancestor is claimed, which is what makes the first sync
        // treat a file that differs as a conflict instead of picking a winner.
        let state = load_state(&root).unwrap();
        assert_eq!(state.project_id, "proj-1");
        assert!(state.files.is_empty());
        assert_eq!((state.remote_version, state.last_sync), (None, None));

        // Now that it is linked, opening it again just opens it; a different
        // project of the same name is still a separate folder.
        assert_eq!(kind("proj-1").kind, "open");
        assert_eq!(kind("proj-2").kind, "occupied");
    }

    #[test]
    fn publishes_local_project_and_records_the_uploaded_snapshot_as_its_base() {
        let server = Mock::project(&[("main.tex", b"local body")]).serve();
        let (config, root) = (signed_in(&server.base), TempDir::new("publish-project"));
        for (rel, data) in [
            ("main.tex", "local body"),
            ("figures/plot.pdf", "%PDF figure"),
            ("paper.pdf", "%PDF build output"),
            (".research/private.json", "secret"),
        ] {
            root.write(rel, data);
        }

        let link = publish_project(&config, &root, "Local Paper").unwrap();

        assert_eq!(link.project_id, "published-project-1");
        assert_eq!(link.project_name, "Local Paper");
        assert_eq!(link.host, server.base);
        let request = (server.recorded().into_iter())
            .find(|request| request.method == "POST" && request.url == "/project/new/upload")
            .expect("project upload request");
        assert_eq!(request.csrf_header.as_deref(), Some(CSRF));
        assert_eq!(request.cookie_header.as_deref(), Some("overleaf_session2=fixture-cookie"));
        let body = request.body_text();
        for expected in
            ["name=\"name\"", "Local Paper.zip", "name=\"qqfile\"", "main.tex", "figures/plot.pdf"]
        {
            assert!(body.contains(expected), "{expected}");
        }
        for leaked in ["paper.pdf", "private.json", "secret"] {
            assert!(!body.contains(leaked), "{leaked}");
        }

        let state = load_state(&root).unwrap();
        assert_eq!(state.permission.as_deref(), Some("owner"));
        assert_eq!(state.files.len(), 2);
        assert_eq!(state.files.get("main.tex"), Some(&sha256_hex(b"local body")));
        assert_eq!(read_base_copy(&root, "main.tex").as_deref(), Some("local body"));
        assert!(read_base_copy(&root, "figures/plot.pdf").is_none());
    }

    #[test]
    fn overleaf_clone_project_extracts_and_writes_state() {
        let server = Mock::project(&[
            ("main.tex", b"\\documentclass{article}"),
            ("refs.bib", b"@article{a}"),
            ("figures/fig1.pdf", b"%PDF-1.5 fake"),
            ("nested/chapter.tex", b"\\section{One}"),
            ("lambda_gpu_proposal.bbl-SAVE-ERROR", b"failed bibliography output"),
            ("tmp/pdfs/full-appendix/page-01.png", b"temporary preview"),
        ])
        .serve();
        let (config, parent) = (signed_in(&server.base), TempDir::new("clone-parent"));
        let clone = |project_id: &str, role| {
            clone_project(&config, project_id, "Test: Project", &parent, role).unwrap()
        };

        let root = clone("proj-1", Some("owner"));
        assert_eq!(root, parent.join("Test- Project"));
        for (rel, data) in [
            ("main.tex", &b"\\documentclass{article}"[..]),
            ("nested/chapter.tex", b"\\section{One}"),
            ("figures/fig1.pdf", b"%PDF-1.5 fake"),
        ] {
            assert_eq!(read_local(&root, rel).as_deref(), Some(data), "{rel}");
        }
        assert!(read_local(&root, "lambda_gpu_proposal.bbl-SAVE-ERROR").is_none());
        assert!(read_local(&root, "tmp/pdfs/full-appendix/page-01.png").is_none());

        let state = load_state(&root).unwrap();
        assert_eq!(
            (state.project_id.as_str(), state.project_name.as_str()),
            ("proj-1", "Test: Project")
        );
        assert_eq!((state.host, state.permission.as_deref()), (server.base.clone(), Some("owner")));
        assert_eq!(state.files.len(), 4);
        assert_eq!(state.files.get("refs.bib"), Some(&sha256_hex(b"@article{a}")));
        let link = project_link(&root).unwrap().unwrap();
        assert_eq!(
            (link.project_id.as_str(), link.project_name.as_str()),
            ("proj-1", "Test: Project")
        );

        // Opening the same project again opens the copy that is already there,
        // rather than refusing and asking someone to go and find it; a role
        // nobody reported clears the stale writable one.
        assert_eq!(clone("proj-1", None), root);
        assert_eq!(load_state(&root).unwrap().permission, None);
        // A different project that happens to share a name lands beside it
        // instead of being blocked by it…
        let other = clone("proj-2", None);
        assert_ne!(other, root);
        assert_eq!(load_state(&other).unwrap().project_id, "proj-2");
        // …and opening *that* one again finds it under its numbered name.
        assert_eq!(clone("proj-2", None), other);
    }

    #[test]
    fn overleaf_clone_project_rejects_zip_slip() {
        let server = Mock { zip: build_malicious_zip(), ..Default::default() }.serve();
        let (config, parent) = (signed_in(&server.base), TempDir::new("slip-parent"));
        let message = clone_project(&config, "proj-1", "Evil", &parent, None).unwrap_err();
        assert!(message.contains("unsafe path"), "got: {message}");
        assert!(!parent.join("evil.tex").exists());
        assert!(!parent.parent().unwrap().join("evil.tex").exists());
    }

    /// Opening a project that is already downloaded opens it — the commonest
    /// thing anyone does in the Overleaf picker.
    #[test]
    #[ignore = "reads overleaf.com with the signed-in session"]
    fn opening_an_already_downloaded_project_opens_it() {
        let (config, existing) = crate::overleaf_rt::tests::live_project();
        let state = load_state(&existing).expect("the project is linked");
        let parent = existing.parent().expect("a parent folder");
        let opened = clone_project(
            &config,
            &state.project_id,
            &state.project_name,
            parent,
            Some("readAndWrite"),
        )
        .expect("opening an already-downloaded project should succeed");
        assert_eq!(opened, existing, "it should be the copy already on disk");
    }
}
