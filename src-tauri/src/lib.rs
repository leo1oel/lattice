mod alphaxiv;
mod collab_credentials;
mod commands;
mod doctor;
mod firecrawl;
mod format_latex;
mod fts;
mod git;
mod latex;
mod link_preview;
mod literature;
#[cfg(target_os = "macos")]
mod macos_window;
mod models;
mod openalex;
mod overleaf;
mod overleaf_rt;
mod papers;
mod pdf_fonts;
mod project;
mod project_fs;
mod synara;
mod tex_setup;
mod texcount;
mod texlab;

use base64::{engine::general_purpose::STANDARD, Engine};
use models::{
    AssetPreview, BuildResult, CitationInfo, DoctorReport, EditorComment, GitDiff, GitRemoteResult,
    GitStatus, HistoryItem, ImportResult, LiteraturePage, OpenAlexWork, PaperSummary, PdfMark,
    PdfSyncTarget, ProjectManifest, ProjectSearchResult, ProjectSnapshot, ReferenceInfo,
    RenameSymbolResult, ReplacePreview, ReplaceResult, ResolvedCitation, SymbolOccurrence,
    SyncTexTarget, TexlabCompletionItem, TexlabHover, TexlabLocation, TodoHit, TransactionRecord,
    UnusedSymbols, WordCount,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
struct OverleafRealtimeState {
    /// Advances whenever a connection is replaced or cancelled. A client that
    /// finishes connecting under an older generation must never become active.
    generation: u64,
    /// Project that owns both an in-progress and an established connection.
    root: Option<PathBuf>,
    client: Option<Arc<overleaf_rt::RealtimeClient>>,
    /// Documents currently joined on the socket. Sync snapshots this under
    /// the same lease that prevents a new join until the sync finishes.
    joined_paths: std::collections::BTreeMap<String, String>,
}

impl OverleafRealtimeState {
    fn begin(&mut self, root: PathBuf) -> (u64, Option<Arc<overleaf_rt::RealtimeClient>>) {
        self.generation = self.generation.wrapping_add(1);
        self.root = Some(root);
        self.joined_paths.clear();
        (self.generation, self.client.take())
    }

    fn owns(&self, generation: u64, root: &Path) -> bool {
        self.generation == generation && self.root.as_deref() == Some(root)
    }

    fn extend_joined_paths(&self, root: &Path, paths: &mut std::collections::BTreeSet<String>) {
        if self.root.as_deref() == Some(root) {
            paths.extend(self.joined_paths.values().cloned());
        }
    }

    /// Cancel everything when `root` is `None`, or only the matching project's
    /// request when a stale React cleanup names its former root.
    fn cancel(&mut self, root: Option<&Path>) -> Option<Arc<overleaf_rt::RealtimeClient>> {
        if root.is_some() && self.root.as_deref() != root {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        self.root = None;
        self.joined_paths.clear();
        self.client.take()
    }
}

#[cfg(test)]
mod realtime_generation_tests {
    use super::{
        ensure_expected_project_root, project, prune_old_share_workspaces, OverleafRealtimeState,
    };
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    #[test]
    fn share_workspace_pruning_requires_an_owned_shared_project_manifest() {
        let temp =
            std::env::temp_dir().join(format!("lattice-share-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let current = project::create_blank(&temp, "Current — Shared abc123").unwrap();
        let old = project::create_blank(&temp, "Old — Shared def456").unwrap();
        let unrelated = temp.join("Notes — Shared Archive");
        std::fs::create_dir_all(&unrelated).unwrap();

        prune_old_share_workspaces(&temp, &current, 0);

        assert!(current.exists());
        assert!(!old.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn a_late_connect_and_stale_cleanup_cannot_replace_the_new_project() {
        let mut state = OverleafRealtimeState::default();
        let root_a = PathBuf::from("/project/a");
        let root_b = PathBuf::from("/project/b");
        let (generation_a, _) = state.begin(root_a.clone());
        let (generation_b, _) = state.begin(root_b.clone());

        assert!(!state.owns(generation_a, &root_a));
        assert!(state.owns(generation_b, &root_b));
        assert!(state.cancel(Some(&root_a)).is_none());
        assert!(state.owns(generation_b, &root_b));
    }

    #[test]
    fn a_new_backend_join_is_protected_even_when_the_ui_snapshot_is_stale() {
        let mut state = OverleafRealtimeState::default();
        let root = PathBuf::from("/project/a");
        state.begin(root.clone());
        state
            .joined_paths
            .insert("doc-1".to_string(), "newly-joined.tex".to_string());
        let mut paths = BTreeSet::new();

        state.extend_joined_paths(&root, &mut paths);

        assert_eq!(paths, BTreeSet::from(["newly-joined.tex".to_string()]));
    }

    #[test]
    fn changing_the_app_root_invalidates_events_from_the_old_generation() {
        let mut state = OverleafRealtimeState::default();
        let root = PathBuf::from("/project/a");
        let (generation, _) = state.begin(root.clone());

        state.cancel(None);

        assert!(!state.owns(generation, &root));
        assert!(state.root.is_none());
    }

    #[test]
    fn a_delayed_project_action_cannot_move_to_the_new_project() {
        let root_a = PathBuf::from("/project/a");

        assert_eq!(
            ensure_expected_project_root(root_a.clone(), "/project/a"),
            Ok(root_a.clone())
        );
        assert_eq!(
            ensure_expected_project_root(root_a, "/project/b"),
            Err("The project changed before the action could start.".to_string())
        );
    }
}

struct AppState {
    root: Mutex<Option<PathBuf>>,
    active_build: latex::ActiveBuild,
    texlab: Arc<Mutex<texlab::TexlabPool>>,
    /// Live connection to Overleaf's editing channel, when one is open.
    realtime: Arc<Mutex<OverleafRealtimeState>>,
    /// Serializes a whole ZIP sync against document join/leave and outgoing
    /// realtime mutations, closing the ownership-snapshot race.
    overleaf_sync_lease: Arc<tokio::sync::RwLock<()>>,
    /// Serializes project-wide create/delete/rename/move catalog mutations.
    structural_mutation: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    fn from_environment() -> Self {
        let root = std::env::var_os("LATTICE_PROJECT")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .and_then(|path| path.canonicalize().ok());
        Self {
            root: Mutex::new(root),
            active_build: latex::new_active_build(),
            texlab: Arc::new(Mutex::new(texlab::TexlabPool::default())),
            realtime: Arc::new(Mutex::new(OverleafRealtimeState::default())),
            overleaf_sync_lease: Arc::new(tokio::sync::RwLock::new(())),
            structural_mutation: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

fn current_root(state: &tauri::State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Open a project first.".to_string())
}

fn ensure_expected_project_root(root: PathBuf, project_root: &str) -> Result<PathBuf, String> {
    if root != Path::new(project_root) {
        return Err("The project changed before the action could start.".to_string());
    }
    Ok(root)
}

/// Resolve a request against the project the UI captured when it started.
///
/// Tauri commands can be scheduled after the writer has already switched
/// projects. Reading `current_root` alone would reinterpret a delayed action
/// for A as an action on B. Every command that can mutate project files must
/// use this guard before touching disk or the network.
fn scoped_root(state: &tauri::State<'_, AppState>, project_root: &str) -> Result<PathBuf, String> {
    ensure_expected_project_root(current_root(state)?, project_root)
}

async fn set_root(state: &tauri::State<'_, AppState>, root: PathBuf) -> Result<(), String> {
    // A root switch must wait for a ZIP sync or a root-scoped Overleaf
    // mutation to finish. The UI invalidates its old generation immediately,
    // while this lease ensures the backend cannot reinterpret a request for A
    // against B halfway through it.
    let _lease = state.overleaf_sync_lease.write().await;
    // Keep root switching in the same lock order as root-scoped structural
    // commands: Overleaf lease, then catalog mutation lock.
    let _mutation = state.structural_mutation.lock().await;
    if let Ok(mut pool) = state.texlab.lock() {
        pool.reset();
    }
    // Hold the project root while invalidating realtime under the same lock
    // order used by connect. This makes "claim generation for A" and "switch
    // to B" mutually exclusive rather than two checks with a gap between.
    let mut current = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?;
    let previous = state
        .realtime
        .lock()
        .map_err(|_| "The Overleaf connection is unavailable.".to_string())?
        .cancel(None);
    *current = Some(root);
    drop(current);
    if let Some(previous) = previous {
        previous.shutdown();
    }
    Ok(())
}

async fn run_blocking<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let result = task();
        if let Err(reason) = &result {
            log::error!(target: "lattice::tasks", "{label} failed: {reason}");
        }
        result
    })
    .await
    .map_err(|error| {
        log::error!(target: "lattice::tasks", "{label} stopped unexpectedly: {error}");
        format!("{label} stopped unexpectedly: {error}")
    })?
}

#[tauri::command]
async fn create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
    venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let venue = project::Venue::parse(venue.as_deref().unwrap_or("neurips"))?;
    let (root, snapshot) = run_blocking("Project creation", move || {
        let root = if venue == project::Venue::Neurips {
            project::create(Path::new(&parent), &name)?
        } else {
            project::create_with_venue(Path::new(&parent), &name, venue)?
        };
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    set_root(&state, root).await?;
    Ok(snapshot)
}

#[tauri::command]
async fn open_tutorial_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectSnapshot, String> {
    use tauri::Manager;
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?;
    let (root, snapshot) = run_blocking("Tutorial project creation", move || {
        let parent = documents.join("Lattice Tutorials");
        std::fs::create_dir_all(&parent)
            .map_err(|error| format!("Could not create Lattice Tutorials folder: {error}"))?;
        let root = project::create_tutorial(&parent)?;
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    set_root(&state, root).await?;
    Ok(snapshot)
}

/// Fresh blank folder under Documents/Lattice Shares for joining a share.
/// Does not modify whatever project the guest had open before.
#[tauri::command]
async fn create_collab_join_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    room: String,
    project_name: Option<String>,
) -> Result<ProjectSnapshot, String> {
    use tauri::Manager;
    let room = room.trim();
    if room.is_empty() {
        return Err("A share room is required.".to_string());
    }
    let safe_room: String = room
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let safe_title: String = project_name
        .unwrap_or_else(|| "Shared project".to_string())
        .trim()
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == ' ' || *ch == '-' || *ch == '_')
        .take(48)
        .collect::<String>()
        .trim_matches([' ', '-', '_'])
        .to_string();
    let safe_title = if safe_title.is_empty() {
        "Shared project".to_string()
    } else {
        safe_title
    };
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?;
    let (root, snapshot) = run_blocking("Shared workspace creation", move || {
        let parent = documents.join("Lattice Shares");
        std::fs::create_dir_all(&parent)
            .map_err(|error| format!("Could not create Lattice Shares folder: {error}"))?;
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let name = format!("{safe_title} — Shared {safe_room}-{stamp}");
        let root = project::create_blank(&parent, &name)?;
        // Each join materializes a full local copy here; it's only a convenience
        // backup, so keep the most-recent handful and delete older ones.
        prune_old_share_workspaces(&parent, &root, MAX_SHARE_WORKSPACES);
        let snapshot = project::open(&root)?;
        Ok((root, snapshot))
    })
    .await?;
    set_root(&state, root).await?;
    Ok(snapshot)
}

/// How many joined-share workspaces to retain under Documents/Lattice Shares.
const MAX_SHARE_WORKSPACES: usize = 8;

/// Keep the `keep` most-recently-modified joined-share folders under `parent`
/// (always keeping `current`), deleting older ones. Best-effort: any failure to
/// enumerate or remove a stale copy is ignored so it never blocks joining.
fn prune_old_share_workspaces(parent: &std::path::Path, current: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut workspaces: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy();
            if !name.starts_with("share-") && !name.contains(" — Shared ") {
                return None;
            }
            if project::read_manifest(&path).ok()?.venue != "shared" {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, path))
        })
        .collect();
    if workspaces.len() <= keep {
        return;
    }
    // Newest first, so everything past `keep` is the oldest.
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.0));
    for (_, path) in workspaces.into_iter().skip(keep) {
        if path == current {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[tauri::command]
async fn initial_project(
    state: tauri::State<'_, AppState>,
) -> Result<Option<ProjectSnapshot>, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone();
    run_blocking("Initial project load", move || {
        root.map(|path| project::open(&path)).transpose()
    })
    .await
}

#[tauri::command]
async fn open_project(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    set_root(&state, PathBuf::from(&snapshot.root)).await?;
    Ok(snapshot)
}

#[tauri::command]
async fn import_project_zip(
    state: tauri::State<'_, AppState>,
    zip_path: String,
    parent: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project import", move || {
        project::import_project_zip(Path::new(&zip_path), Path::new(&parent))
    })
    .await?;
    set_root(&state, PathBuf::from(&snapshot.root)).await?;
    Ok(snapshot)
}

#[tauri::command]
async fn export_project_zip(
    state: tauri::State<'_, AppState>,
    zip_path: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Project export", move || {
        project::export_project_zip(&root, Path::new(&zip_path))
    })
    .await
}

#[tauri::command]
async fn stat_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<project::ProjectFileStat, String> {
    let root = current_root(&state)?;
    run_blocking("Project file status", move || {
        project::stat_file(&root, &path)
    })
    .await
}

#[tauri::command]
async fn refresh_project(state: tauri::State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::open(&root))
        .await
        .map_err(|error| format!("Project refresh stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn collab_project_inventory_v2(
    state: tauri::State<'_, AppState>,
) -> Result<project::CollabProjectInventoryV2, String> {
    let root = current_root(&state)?;
    run_blocking("Collaboration project inventory", move || {
        project::collab_project_inventory_v2(&root)
    })
    .await
}

#[tauri::command]
async fn read_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
    project_root: Option<String>,
) -> Result<String, String> {
    let _lease = if project_root.is_some() {
        Some(state.overleaf_sync_lease.read().await)
    } else {
        None
    };
    let root = current_root(&state)?;
    if project_root
        .as_deref()
        .is_some_and(|expected| root != Path::new(expected))
    {
        return Err("The project changed before the file could be read.".to_string());
    }
    run_blocking("Project file read", move || {
        project::read_file(&root, &path)
    })
    .await
}

#[tauri::command]
async fn write_project_file(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the file could be written.".to_string())?;
    run_blocking("Project file write", move || {
        let transaction =
            project::apply_transaction(&root, &format!("Edit {path}"), vec![(path, content)])?;
        Ok(transaction.map(|record| record.id).unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn list_citation_keys(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::citation_keys(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_citations(state: tauri::State<'_, AppState>) -> Result<Vec<CitationInfo>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::citations(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<ResolvedCitation>, String> {
    let root = current_root(&state)?;
    run_blocking("Bibliography read", move || {
        project::read_bib_entry(&root, &key)
    })
    .await
}

#[tauri::command]
async fn save_bib_entry(
    state: tauri::State<'_, AppState>,
    key: String,
    bibtex: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Bibliography save", move || {
        project::save_bib_entry(&root, &key, &bibtex)
    })
    .await
}

#[tauri::command]
async fn list_references(state: tauri::State<'_, AppState>) -> Result<Vec<ReferenceInfo>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::references(&root))
        .await
        .map_err(|error| format!("Reference scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_unused_symbols(state: tauri::State<'_, AppState>) -> Result<UnusedSymbols, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::unused_symbols(&root))
        .await
        .map_err(|error| format!("Symbol scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_todos(state: tauri::State<'_, AppState>) -> Result<Vec<TodoHit>, String> {
    let root = current_root(&state)?;
    run_blocking("TODO scan", move || project::list_todos(&root)).await
}

#[tauri::command]
async fn count_project_words(state: tauri::State<'_, AppState>) -> Result<WordCount, String> {
    let root = current_root(&state)?;
    run_blocking("Word count", move || texcount::count_project(&root)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn update_project_manifest(
    state: tauri::State<'_, AppState>,
    engine: Option<String>,
    default_root: Option<String>,
    trusted: Option<bool>,
    word_budget: Option<u32>,
    page_budget: Option<u32>,
    clear_word_budget: Option<bool>,
    clear_page_budget: Option<bool>,
) -> Result<ProjectManifest, String> {
    let words = if clear_word_budget.unwrap_or(false) {
        Some(None)
    } else {
        word_budget.map(Some)
    };
    let pages = if clear_page_budget.unwrap_or(false) {
        Some(None)
    } else {
        page_budget.map(Some)
    };
    let root = current_root(&state)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, engine, default_root, trusted, words, pages, None)
    })
    .await
}

#[tauri::command]
async fn set_project_spelling_words(
    state: tauri::State<'_, AppState>,
    words: Vec<String>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state)?;
    run_blocking("Project dictionary update", move || {
        project::update_manifest_settings(&root, None, None, None, None, None, Some(words))
    })
    .await
}

#[tauri::command]
async fn add_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
    name: Option<String>,
    make_default: Option<bool>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state)?;
    run_blocking("Root document update", move || {
        project::add_root_document(&root, &path, name, make_default.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn remove_root_document(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state)?;
    run_blocking("Root document update", move || {
        project::remove_root_document(&root, &path)
    })
    .await
}

#[tauri::command]
async fn preview_replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, String> {
    let root = current_root(&state)?;
    run_blocking("Replace preview", move || {
        project::preview_replace_in_project(
            &root,
            &query,
            paths,
            match_case.unwrap_or(true),
            use_regex.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn replace_in_project(
    state: tauri::State<'_, AppState>,
    query: String,
    replacement: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    let root = current_root(&state)?;
    run_blocking("Project replace", move || {
        project::replace_in_project(
            &root,
            &query,
            &replacement,
            paths,
            match_case.unwrap_or(true),
            use_regex.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn find_label_occurrences(
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state)?;
    run_blocking("Label search", move || {
        project::find_label_occurrences(&root, &label)
    })
    .await
}

#[tauri::command]
async fn find_citation_occurrences(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state)?;
    run_blocking("Citation search", move || {
        project::find_citation_occurrences(&root, &key)
    })
    .await
}

#[tauri::command]
async fn rename_label(
    state: tauri::State<'_, AppState>,
    old_label: String,
    new_label: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state)?;
    run_blocking("Label rename", move || {
        project::rename_label(&root, &old_label, &new_label)
    })
    .await
}

#[tauri::command]
async fn rename_citation_key(
    state: tauri::State<'_, AppState>,
    old_key: String,
    new_key: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state)?;
    run_blocking("Citation rename", move || {
        project::rename_citation_key(&root, &old_key, &new_key)
    })
    .await
}

#[tauri::command]
async fn search_project(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = project::search_files(&root, &query)?;
        results.extend(papers::search_papers(&root, &query)?);
        Ok(results)
    })
    .await
    .map_err(|error| format!("Project search stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn create_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let _mutation = state.structural_mutation.lock().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the file could be created.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::create_entry(&root, &path, &kind))
        .await
        .map_err(|error| format!("File creation stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn delete_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    project_root: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let _mutation = state.structural_mutation.lock().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the file could be deleted.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::delete_entry(&root, &path))
        .await
        .map_err(|error| format!("File deletion stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn rename_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    new_name: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let _mutation = state.structural_mutation.lock().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the file could be renamed.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::rename_entry(&root, &path, &new_name))
        .await
        .map_err(|error| format!("File rename stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn move_project_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    target_directory: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let _mutation = state.structural_mutation.lock().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the file could be moved.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        project::move_entry(&root, &path, &target_directory)
    })
    .await
    .map_err(|error| format!("File move stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_project_assets(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the assets could be imported.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_assets(&root, &paths, &target_directory)
    })
    .await
    .map_err(|error| format!("Asset import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_agent_composer_files(
    paths: Vec<String>,
) -> Result<Vec<project::AgentComposerFile>, String> {
    tauri::async_runtime::spawn_blocking(move || project::read_agent_composer_files(&paths))
        .await
        .map_err(|error| format!("Reading dropped files stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_project_files(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<project::ImportedProjectFile>, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the files could be imported.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_files(&root, &paths, &target_directory)
    })
    .await
    .map_err(|error| format!("File import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_project_sources(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the sources could be imported.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_sources(&root, &paths, &target_directory)
    })
    .await
    .map_err(|error| format!("Source import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn import_clipboard_image(
    state: tauri::State<'_, AppState>,
    target_directory: String,
    file_name: String,
    base64_data: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the image could be imported.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        project::import_image_bytes(&root, &target_directory, &file_name, &base64_data)
    })
    .await
    .map_err(|error| format!("Image import stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn resolve_citation_query(query: String) -> Result<ResolvedCitation, String> {
    run_blocking("Citation lookup", move || {
        project::resolve_citation_query(&query)
    })
    .await
}

#[tauri::command]
async fn read_project_asset(
    state: tauri::State<'_, AppState>,
    path: String,
    project_root: Option<String>,
) -> Result<AssetPreview, String> {
    let _lease = if project_root.is_some() {
        Some(state.overleaf_sync_lease.read().await)
    } else {
        None
    };
    let root = current_root(&state)?;
    if project_root
        .as_deref()
        .is_some_and(|expected| root != Path::new(expected))
    {
        return Err("The project changed before the asset could be read.".to_string());
    }
    run_blocking("Project asset read", move || {
        project::read_asset(&root, &path)
    })
    .await
}

#[tauri::command]
async fn write_project_bytes(
    state: tauri::State<'_, AppState>,
    path: String,
    base64_data: String,
    project_root: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the asset could be written.".to_string())?;
    run_blocking("Project asset write", move || {
        project::write_bytes(&root, &path, &base64_data)
    })
    .await
}

#[tauri::command]
async fn prepare_latex_figure(
    state: tauri::State<'_, AppState>,
    path: String,
    project_root: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &project_root)
        .map_err(|_| "The project changed before the figure could be prepared.".to_string())?;
    run_blocking("Figure preparation", move || {
        project::prepare_latex_figure(&root, &path)
    })
    .await
}

#[tauri::command]
async fn build_project(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
    project_root: String,
) -> Result<BuildResult, String> {
    let root = current_root(&state)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before its build could start.".to_string());
    }
    let force = force.unwrap_or(false);
    let active = state.active_build.clone();
    tauri::async_runtime::spawn_blocking(move || latex::build(&root, force, &active))
        .await
        .map_err(|error| format!("The LaTeX build task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn abort_build(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    latex::abort(&state.active_build)
}

#[tauri::command]
async fn clean_project(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::clean(&root))
        .await
        .map_err(|error| format!("The LaTeX clean task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_doctor(state: tauri::State<'_, AppState>) -> Result<DoctorReport, String> {
    let root = state.root.lock().ok().and_then(|guard| guard.clone());
    run_blocking("Doctor check", move || Ok(doctor::run(root.as_deref()))).await
}

#[tauri::command]
async fn texlab_diagnostics(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
) -> Result<Vec<models::Diagnostic>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.diagnostics(&root, &path, &text)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_completion(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Vec<TexlabCompletionItem>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.completion(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_hover(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabHover>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.hover(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn texlab_definition(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabLocation>, String> {
    let root = current_root(&state)?;
    let pool = Arc::clone(&state.texlab);
    tauri::async_runtime::spawn_blocking(move || {
        let mut pool = pool
            .lock()
            .map_err(|_| "TexLab state is unavailable.".to_string())?;
        pool.definition(&root, &path, &text, line, character)
    })
    .await
    .map_err(|error| format!("The TexLab task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn format_latex(
    state: tauri::State<'_, AppState>,
    path: String,
    text: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Document formatting", move || {
        format_latex::format_document(&root, &path, &text)
    })
    .await
}

#[tauri::command]
async fn search_openalex(
    query: String,
    precise: Option<bool>,
) -> Result<Vec<OpenAlexWork>, String> {
    let precise = precise.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || openalex::search_works(&query, precise, 1))
        .await
        .map_err(|error| format!("The OpenAlex task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn search_literature(
    query: String,
    precise: Option<bool>,
    page: Option<u32>,
) -> Result<LiteraturePage, String> {
    let precise = precise.unwrap_or(false);
    let page = page.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || literature::search(&query, precise, page))
        .await
        .map_err(|error| format!("The literature search task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn git_status(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|error| format!("Git status stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn git_diff(
    state: tauri::State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let root = current_root(&state)?;
    run_blocking("Git diff", move || git::diff(&root, &path, staged)).await
}

#[tauri::command]
async fn git_stage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git stage", move || git::stage(&root, &paths)).await
}

#[tauri::command]
async fn git_unstage(state: tauri::State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git unstage", move || git::unstage(&root, &paths)).await
}

#[tauri::command]
async fn git_commit(state: tauri::State<'_, AppState>, message: String) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Git commit", move || git::commit(&root, &message)).await
}

#[tauri::command]
async fn git_init(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    run_blocking("Git initialization", move || git::init(&root)).await
}

#[tauri::command]
async fn git_set_remote(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    url: String,
) -> Result<GitStatus, String> {
    let root = current_root(&state)?;
    run_blocking("Git remote update", move || {
        git::set_remote(&root, name.as_deref().unwrap_or("origin"), &url)
    })
    .await
}

#[tauri::command]
async fn git_push(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git push", move || git::push(&root)).await
}

#[tauri::command]
async fn git_pull(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git pull", move || git::pull(&root)).await
}

#[tauri::command]
async fn git_fetch(state: tauri::State<'_, AppState>) -> Result<GitRemoteResult, String> {
    let root = current_root(&state)?;
    run_blocking("Git fetch", move || git::fetch(&root)).await
}

#[tauri::command]
async fn git_log(
    state: tauri::State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<models::GitLogEntry>, String> {
    let root = current_root(&state)?;
    run_blocking("Git history", move || {
        git::log(&root, limit.unwrap_or(200) as usize)
    })
    .await
}

#[tauri::command]
async fn git_show_diff(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<models::GitFileDiff, String> {
    let root = current_root(&state)?;
    run_blocking("Git revision diff", move || {
        git::show_diff(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_file(
    state: tauri::State<'_, AppState>,
    rev: String,
    path: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Git file restore", move || {
        git::restore_file(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_project(
    state: tauri::State<'_, AppState>,
    rev: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Git project restore", move || {
        git::restore_project(&root, &rev)
    })
    .await
}

#[tauri::command]
async fn git_auto_commit(
    state: tauri::State<'_, AppState>,
    message: String,
    author: Option<String>,
    project_root: Option<String>,
) -> Result<Option<String>, String> {
    let _lease = if project_root.is_some() {
        Some(state.overleaf_sync_lease.read().await)
    } else {
        None
    };
    let root = current_root(&state)?;
    if project_root
        .as_deref()
        .is_some_and(|expected| root != Path::new(expected))
    {
        return Err("The project changed before the version could be recorded.".to_string());
    }
    run_blocking("Git automatic commit", move || {
        git::auto_commit(&root, &message, author.as_deref())
    })
    .await
}

// ---- Overleaf bridge -------------------------------------------------------

const OVERLEAF_LOGIN_WINDOW: &str = "overleaf-login";

fn overleaf_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve the app config folder: {error}"))
}

/// Folder containing the rotating `lattice.log` files written by tauri-plugin-log.
/// Created on demand so "Open log folder" works even before the first write.
#[tauri::command]
fn get_app_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Could not resolve the log folder: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the log folder: {error}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn overleaf_status(app: tauri::AppHandle) -> Result<overleaf::OverleafStatus, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf status", move || overleaf::session_status(&config)).await
}

/// Open Overleaf's own login page in a dedicated window. The user signs in
/// exactly as they would in a browser (including SSO); `overleaf_poll_login`
/// then captures the session cookie — no manual copying for the common case.
#[tauri::command]
fn overleaf_begin_login(app: tauri::AppHandle, host: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url = format!("{host}/login")
        .parse()
        .map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    tauri::WebviewWindowBuilder::new(
        &app,
        OVERLEAF_LOGIN_WINDOW,
        tauri::WebviewUrl::External(url),
    )
    .title("Sign in to Overleaf")
    .inner_size(1040.0, 780.0)
    .build()
    .map_err(|error| format!("Could not open the Overleaf sign-in window: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn overleaf_poll_login(
    app: tauri::AppHandle,
    host: Option<String>,
) -> Result<overleaf::OverleafLoginPoll, String> {
    let Some(window) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) else {
        return Ok(overleaf::OverleafLoginPoll::cancelled());
    };
    let host = overleaf::normalize_host(host.as_deref().unwrap_or(""));
    let url: tauri::Url = host
        .parse()
        .map_err(|error| format!("Invalid Overleaf host: {error}"))?;
    let target_host = url.host_str().unwrap_or_default().to_string();
    // Read the whole jar and match domains ourselves: wry's `cookies_for_url`
    // compares cookie domain and URL host for equality, so a `.overleaf.com`
    // cookie never matches `www.overleaf.com` and sign-in appears to hang.
    let cookies = window.cookies().unwrap_or_default();
    let matching = cookies
        .iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| overleaf::cookie_domain_matches(domain, &target_host))
        })
        .collect::<Vec<_>>();
    let names = matching
        .iter()
        .map(|cookie| cookie.name().to_string())
        .collect::<Vec<_>>();
    if !overleaf::has_session_cookie(&names) {
        return Ok(overleaf::OverleafLoginPoll::pending());
    }
    let header = matching
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let config = overleaf_config_dir(&app)?;
    let validated = tauri::async_runtime::spawn_blocking(move || {
        overleaf::store_session_cookie(&config, &host, &header)
    })
    .await
    .map_err(|error| format!("The Overleaf login task stopped unexpectedly: {error}"))?;
    match validated {
        // A session cookie exists before the user finishes signing in (even
        // anonymous visitors get one), so a rejected cookie usually just means
        // "not yet" — keep polling, but hand the reason back so the UI can stop
        // spinning silently if it never resolves.
        Err(reason) => Ok(overleaf::OverleafLoginPoll::pending_with(reason)),
        Ok(session) => {
            let _ = window.close();
            Ok(overleaf::OverleafLoginPoll::connected(session))
        }
    }
}

#[tauri::command]
async fn overleaf_store_cookie(
    app: tauri::AppHandle,
    host: String,
    cookie: String,
) -> Result<overleaf::OverleafStatus, String> {
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf sign-in", move || {
        overleaf::store_session_cookie(&config, &host, &cookie)
    })
    .await
}

#[tauri::command]
async fn overleaf_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLEAF_LOGIN_WINDOW) {
        let _ = window.close();
    }
    // The live channel authenticates with the session being thrown away.
    shutdown_realtime(&state);
    let config = overleaf_config_dir(&app)?;
    run_blocking("Overleaf disconnect", move || overleaf::disconnect(&config)).await
}

#[tauri::command]
async fn overleaf_list_projects(
    app: tauri::AppHandle,
) -> Result<Vec<overleaf::OverleafProject>, String> {
    let config = overleaf_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::list_projects(&config))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Where Overleaf projects are downloaded to.
fn overleaf_projects_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Could not resolve Documents folder: {error}"))?;
    let parent = documents.join("Overleaf Projects");
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Could not create the Overleaf Projects folder: {error}"))?;
    Ok(parent)
}

/// What opening this project would do, so the app can ask before it acts.
#[tauri::command]
async fn overleaf_clone_target(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
) -> Result<overleaf::CloneTarget, String> {
    let parent = overleaf_projects_dir(&app)?;
    run_blocking("Overleaf project location", move || {
        overleaf::clone_target(&project_id, &name, &parent)
    })
    .await
}

#[tauri::command]
async fn overleaf_clone_project(
    app: tauri::AppHandle,
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
    let root = tauri::async_runtime::spawn_blocking(move || {
        if adopt.unwrap_or(false) {
            let target = overleaf::clone_target(&project_id, &name, &parent)?;
            if target.kind == "occupied" {
                return overleaf::adopt_project(
                    &config,
                    &project_id,
                    &name,
                    std::path::Path::new(&target.path),
                    access_level.as_deref(),
                );
            }
        }
        overleaf::clone_project(
            &config,
            &project_id,
            &name,
            &parent,
            access_level.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("The Overleaf download stopped unexpectedly: {error}"))??;
    // Cloned projects start version tracking immediately so the Versions
    // timeline can show what each future sync changed.
    let _ = git::init(&root);
    // Downloading and opening are separate phases. The picker opens this root
    // through `open_project` only after the download succeeds, so a failed
    // open can never leave the backend on B while the UI restores A.
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
async fn overleaf_link(
    state: tauri::State<'_, AppState>,
) -> Result<Option<overleaf::OverleafLink>, String> {
    let root = current_root(&state)?;
    run_blocking("Overleaf project link", move || {
        overleaf::project_link(&root)
    })
    .await
}

// ---- Overleaf realtime editing ---------------------------------------------

fn realtime_client(
    state: &tauri::State<'_, AppState>,
) -> Result<Arc<overleaf_rt::RealtimeClient>, String> {
    let root = current_root(state)?;
    let realtime = state
        .realtime
        .lock()
        .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
    if realtime.root.as_ref() != Some(&root) {
        return Err("The Overleaf live connection belongs to a different project.".to_string());
    }
    realtime
        .client
        .clone()
        .ok_or_else(|| "Not connected to Overleaf's live editing channel.".to_string())
}

/// Open the live editing channel for the current project.
///
/// Every event the channel produces is forwarded to the web UI as
/// `overleaf-realtime`, which is where documents, chat and comments all arrive.
#[tauri::command]
async fn overleaf_rt_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before Overleaf could connect.".to_string());
    }
    let config_root = root.clone();
    let (host, cookie, project_id, user_id) = tauri::async_runtime::spawn_blocking(move || {
        overleaf::realtime_config(&config, &config_root)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))??;

    // Project loading and credential reads are asynchronous. A connection
    // requested for A must not become the newest request after the UI has
    // already opened B.
    if current_root(&state)? != root {
        return Err("The project changed before Overleaf could connect.".to_string());
    }

    // Claim a generation before the network await. Compare the root while
    // still holding its guard, then take realtime in the same root→realtime
    // order as `set_root`. Otherwise a switch to B can land in the gap after a
    // successful check for A and let A become the newest live connection.
    let (generation, previous) = {
        let current = state
            .root
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?;
        if current.as_ref() != Some(&root) {
            return Err("The project changed before Overleaf could connect.".to_string());
        }
        let mut realtime = state
            .realtime
            .lock()
            .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
        realtime.begin(root.clone())
    };
    if let Some(previous) = previous {
        previous.shutdown();
    }

    use tauri::Emitter;
    let emitter = app.clone();
    let event_state = Arc::clone(&state.realtime);
    let event_root = root.clone();
    let connecting = overleaf_rt::RealtimeClient::connect(
        overleaf_rt::RealtimeConfig {
            user_id,
            host,
            cookie,
            project_id,
        },
        move |event| {
            let current = event_state
                .lock()
                .is_ok_and(|realtime| realtime.owns(generation, &event_root));
            if current {
                let _ = emitter.emit("overleaf-realtime", event);
            }
        },
    )
    .await;
    let client = match connecting {
        Ok(client) => client,
        Err(error) => {
            if let Ok(mut realtime) = state.realtime.lock() {
                if realtime.owns(generation, &root) {
                    realtime.cancel(Some(&root));
                }
            }
            return Err(error);
        }
    };
    // Answering with the project tree, rather than only emitting it, is what
    // makes live editing reliable: the app can start the moment this returns
    // instead of depending on an event that may have been emitted before its
    // listener was registered.
    let joined = serde_json::json!({
        "publicId": client.public_id(),
        "rootFolderId": client.project().root_folder_id,
        "docs": client.project().docs,
        "entities": client.project().entities,
        "userId": client.project().user_id,
        "trackChanges": client.project().track_changes,
        // Without this the app read `undefined` and overwrote whatever the
        // projectJoined event had already established: a reviewer was treated
        // as a writer, so their first keystroke went out as a plain edit, the
        // server refused it, and live editing died on the spot.
        "permission": client.project().permission,
    });
    let client = Arc::new(client);
    let still_current = current_root(&state).is_ok_and(|current| current == root);
    let installed = if still_current {
        let mut realtime = state
            .realtime
            .lock()
            .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
        if realtime.owns(generation, &root) {
            realtime.client = Some(Arc::clone(&client));
            true
        } else {
            false
        }
    } else {
        false
    };
    if !installed {
        client.shutdown();
        return Err("A newer Overleaf connection replaced this one.".to_string());
    }
    Ok(joined)
}

/// Close the live channel if one is open. Safe to call when there is none.
fn shutdown_realtime(state: &tauri::State<'_, AppState>) {
    let previous = state
        .realtime
        .lock()
        .ok()
        .and_then(|mut realtime| realtime.cancel(None));
    if let Some(previous) = previous {
        previous.shutdown();
    }
}

#[tauri::command]
fn overleaf_rt_disconnect(
    state: tauri::State<'_, AppState>,
    project_root: Option<String>,
) -> Result<(), String> {
    let previous = {
        let mut realtime = state
            .realtime
            .lock()
            .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
        realtime.cancel(project_root.as_deref().map(Path::new))
    };
    if let Some(previous) = previous {
        previous.shutdown();
    }
    Ok(())
}

/// Our own id on the channel, or null when not connected. The server echoes
/// our updates back, and this is how the app tells them from someone else's.
#[tauri::command]
fn overleaf_rt_connected(state: tauri::State<'_, AppState>) -> Option<String> {
    realtime_client(&state)
        .ok()
        .map(|client| client.public_id())
}

/// Subscribe to a document; returns its current text and version.
///
/// `fromVersion` asks the server to replay what happened while we were away
/// instead of only handing back the current text, which is what lets work that
/// never reached it survive coming back to a file.
#[tauri::command]
async fn overleaf_rt_join_doc(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    from_version: Option<i64>,
) -> Result<overleaf_rt::JoinedDoc, String> {
    let _lease = state.overleaf_sync_lease.write().await;
    let root = scoped_root(&state, &project_root)?;
    let client = realtime_client(&state)?;
    let path = client
        .project()
        .docs
        .iter()
        .find(|doc| doc.id == doc_id)
        .map(|doc| doc.path.clone())
        .ok_or_else(|| "Overleaf did not report that document in this project.".to_string())?;
    let previous_path = {
        let mut realtime = state
            .realtime
            .lock()
            .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
        if realtime.root.as_ref() != Some(&root)
            || !realtime
                .client
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &client))
        {
            return Err("The Overleaf project changed before the document joined.".to_string());
        }
        realtime.joined_paths.insert(doc_id.clone(), path)
    };
    match client.join_doc(&doc_id, from_version).await {
        Ok(joined) => Ok(joined),
        Err(error) => {
            if let Ok(mut realtime) = state.realtime.lock() {
                if realtime
                    .client
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &client))
                {
                    if let Some(previous_path) = previous_path {
                        realtime.joined_paths.insert(doc_id.clone(), previous_path);
                    } else {
                        realtime.joined_paths.remove(&doc_id);
                    }
                }
            }
            Err(error)
        }
    }
}

/// Everyone currently in the Overleaf project, ourselves included.
#[tauri::command]
async fn overleaf_rt_connected_users(
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<Vec<overleaf_rt::PresenceUser>, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?.connected_users().await
}

/// Publish our caret, which is also what makes us visible to everyone else.
#[tauri::command]
async fn overleaf_rt_update_position(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    row: i64,
    column: i64,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?
        .update_position(&doc_id, row, column)
        .await
}

#[tauri::command]
async fn overleaf_rt_leave_doc(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.write().await;
    scoped_root(&state, &project_root)?;
    let client = realtime_client(&state)?;
    client.leave_doc(&doc_id).await?;
    if let Ok(mut realtime) = state.realtime.lock() {
        if realtime
            .client
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &client))
        {
            realtime.joined_paths.remove(&doc_id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn overleaf_rt_send_ops(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?
        .send_ops(&doc_id, version, ops)
        .await
}

/// Anchor a comment thread to a span of the open document.
#[tauri::command]
async fn overleaf_rt_send_comment(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    version: i64,
    position: i64,
    quote: String,
    thread_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?
        .send_comment(&doc_id, version, position, &quote, &thread_id)
        .await
}

#[tauri::command]
async fn overleaf_chat_messages(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    limit: Option<u32>,
) -> Result<Vec<overleaf::OverleafMessage>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    let limit = limit.unwrap_or(80);
    tauri::async_runtime::spawn_blocking(move || overleaf::chat_messages(&config, &root, limit))
        .await
        .map_err(|error| format!("The Overleaf chat task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_send_chat_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    content: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::send_chat_message(&config, &root, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf chat task stopped unexpectedly: {error}"))?
}

/// Paths the realtime channel is editing right now. Syncing skips them: the
/// channel is already converging both copies, and a REST upload of the same
/// text would reach collaborators as an out-of-band overwrite.
fn live_paths(live: Option<Vec<String>>) -> std::collections::BTreeSet<String> {
    live.unwrap_or_default().into_iter().collect()
}

/// Record what Overleaf says this account may do to the linked project.
#[tauri::command]
async fn overleaf_set_permission(
    state: tauri::State<'_, AppState>,
    project_root: String,
    permission: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let root = current_root(&state)?;
    // The realtime result is scoped to the project that was connected. An
    // invoke can cross a UI project switch before this handler is scheduled;
    // never write the previous project's role into the newly active project.
    if root != Path::new(&project_root) {
        return Ok(());
    }
    run_blocking("Overleaf permission update", move || {
        overleaf::set_permission(&root, &permission)
    })
    .await
}

// ---- Overleaf's own history ----------------------------------------------

#[tauri::command]
async fn overleaf_history_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    before: Option<i64>,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    let (updates, next) = tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_updates(&config, &root, before, count.unwrap_or(20))
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))??;
    Ok(serde_json::json!({ "updates": updates, "nextBefore": next }))
}

#[tauri::command]
async fn overleaf_history_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    path: String,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_diff(&config, &root, &path, from, to)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_files(&config, &root, from, to))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_labels(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<Vec<overleaf::OverleafLabel>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_labels(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

/// Roll one file back, or the whole project when `path` is absent.
#[tauri::command]
async fn overleaf_history_revert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    version: i64,
    path: Option<String>,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_revert(&config, &root, version, path.as_deref())
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_restore_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    version: i64,
    path: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_restore_file(&config, &root, version, &path)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_add_label(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    version: i64,
    comment: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_add_label(&config, &root, version, &comment)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_delete_label(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    label_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::history_delete_label(&config, &root, &label_id)
    })
    .await
    .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

/// Accept tracked changes, turning the suggested text into ordinary text.
#[tauri::command]
async fn overleaf_accept_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    change_ids: Vec<String>,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::accept_changes(&config, &root, &doc_id, &change_ids)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Reject tracked changes by undoing them through the editing channel.
#[tauri::command]
async fn overleaf_reject_changes(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    version: i64,
    changes: Vec<overleaf_rt::TrackedChange>,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?
        .reject_changes(&doc_id, version, &changes)
        .await
}

/// Send an edit as a suggestion rather than applying it outright.
#[tauri::command]
async fn overleaf_rt_send_tracked_ops(
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    scoped_root(&state, &project_root)?;
    realtime_client(&state)?
        .send_tracked_ops(&doc_id, version, ops)
        .await
}

/// Who wrote the suggestions in this project.
#[tauri::command]
async fn overleaf_change_authors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::change_authors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Turn suggestions on or off for the accounts named in `on_for`.
#[tauri::command]
async fn overleaf_set_track_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    on_for: serde_json::Value,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::set_track_changes(&config, &root, on_for)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Create a document on Overleaf, so a file made here exists for everyone.
#[tauri::command]
async fn overleaf_create_doc(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    parent_folder_id: String,
    name: String,
) -> Result<String, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::create_doc(&config, &root, &parent_folder_id, &name)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Delete a document, file or folder on Overleaf.
#[tauri::command]
async fn overleaf_delete_entity(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    kind: String,
    entity_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before the Overleaf item could be removed.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_entity(&config, &root, &kind, &entity_id)
    })
    .await
    .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_threads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<Vec<overleaf::OverleafThread>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::threads(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

/// What is anchored in one document right now, without re-joining it.
#[tauri::command]
async fn overleaf_doc_ranges(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
) -> Result<overleaf::DocRanges, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::doc_ranges(&config, &root, &doc_id))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Where every comment in the project is anchored, whatever file it is in.
#[tauri::command]
async fn overleaf_comment_anchors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<Vec<overleaf::OverleafCommentAnchor>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::comment_anchors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_edit_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    thread_id: String,
    message_id: String,
    content: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::edit_message(&config, &root, &thread_id, &message_id, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_delete_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    thread_id: String,
    message_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_message(&config, &root, &thread_id, &message_id)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_reply_to_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    thread_id: String,
    content: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::reply_to_thread(&config, &root, &thread_id, &content)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_resolve_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    thread_id: String,
    resolved: bool,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::resolve_thread(&config, &root, &doc_id, &thread_id, resolved)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_delete_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    doc_id: String,
    thread_id: String,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::delete_thread(&config, &root, &doc_id, &thread_id)
    })
    .await
    .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

/// Dry run: what a sync would change, without writing or uploading anything.
#[tauri::command]
async fn overleaf_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafPreview, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    let live = live_paths(live);
    tauri::async_runtime::spawn_blocking(move || overleaf::preview(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf comparison stopped unexpectedly: {error}"))?
}

/// Stop or restart syncing for the open project.
#[tauri::command]
async fn overleaf_set_paused(
    state: tauri::State<'_, AppState>,
    project_root: String,
    paused: bool,
) -> Result<(), String> {
    let _lease = state.overleaf_sync_lease.write().await;
    let root = scoped_root(&state, &project_root)?;
    if paused {
        // A socket left open would keep delivering edits, chat and presence
        // for a project the user just asked us to leave alone.
        shutdown_realtime(&state);
    }
    run_blocking("Overleaf sync setting", move || {
        overleaf::set_paused(&root, paused)
    })
    .await
}

#[tauri::command]
async fn overleaf_probe(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<overleaf::OverleafProbe, String> {
    let _lease = state.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::probe(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf check stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_root: String,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafSyncResult, String> {
    let _lease = state.overleaf_sync_lease.write().await;
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before Overleaf sync could start.".to_string());
    }
    let mut live = live_paths(live);
    if let Ok(realtime) = state.realtime.lock() {
        realtime.extend_joined_paths(&root, &mut live);
    }
    tauri::async_runtime::spawn_blocking(move || overleaf::sync(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf sync stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_pdf_annotations(state: tauri::State<'_, AppState>) -> Result<Vec<PdfMark>, String> {
    let root = current_root(&state)?;
    run_blocking("PDF annotation read", move || {
        project::read_pdf_marks(&root)
    })
    .await
}

#[tauri::command]
async fn save_pdf_annotations(
    state: tauri::State<'_, AppState>,
    annotations: Vec<PdfMark>,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("PDF annotation save", move || {
        project::write_pdf_marks(&root, annotations)
    })
    .await
}

#[tauri::command]
async fn list_editor_comments(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EditorComment>, String> {
    let root = current_root(&state)?;
    run_blocking("Editor comment read", move || {
        project::read_editor_comments(&root)
    })
    .await
}

#[tauri::command]
async fn save_editor_comments(
    state: tauri::State<'_, AppState>,
    comments: Vec<EditorComment>,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("Editor comment save", move || {
        project::write_editor_comments(&root, comments)
    })
    .await
}

#[tauri::command]
async fn read_compiled_pdf(
    state: tauri::State<'_, AppState>,
    project_root: String,
) -> Result<tauri::ipc::Response, String> {
    let root = current_root(&state)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before its PDF could be loaded.".to_string());
    }
    let bytes = run_blocking("Compiled PDF read", move || latex::read_compiled_pdf(&root)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn save_compiled_pdf(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let destination = request
        .headers()
        .get("x-pdf-destination")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Choose where to save the PDF.".to_string())?;
    let path = String::from_utf8(
        STANDARD
            .decode(destination)
            .map_err(|error| format!("The PDF destination is invalid: {error}"))?,
    )
    .map_err(|error| format!("The PDF destination is invalid: {error}"))?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("The PDF contents were not sent as binary data.".to_string()),
    };
    run_blocking("Compiled PDF save", move || {
        latex::save_pdf(Path::new(&path), &bytes)
    })
    .await
}

#[tauri::command]
async fn synctex_edit(
    state: tauri::State<'_, AppState>,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexTarget, String> {
    let root = current_root(&state)?;
    run_blocking("SyncTeX lookup", move || {
        latex::inverse_search(&root, page, x, y)
    })
    .await
}

#[tauri::command]
async fn synctex_view(
    state: tauri::State<'_, AppState>,
    path: String,
    line: u32,
    column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || latex::forward_search(&root, &path, line, column))
        .await
        .map_err(|error| format!("The SyncTeX lookup stopped unexpectedly: {error}"))?
}

/// Announce a literature pipeline stage to the window. Best-effort: a stage
/// the frontend never hears about only degrades the status line, never the
/// import itself.
fn emit_paper_progress(app: &tauri::AppHandle, stage: &str) {
    use tauri::Emitter;
    let _ = app.emit("paper-import-progress", stage);
}

#[tauri::command]
async fn import_reference(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: String,
) -> Result<ImportResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        papers::import_reference_with_progress(&root, &input, &|stage| {
            emit_paper_progress(&app, stage);
        })
    })
    .await
    .map_err(|error| format!("The paper import task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn fetch_paper(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        papers::fetch_paper_with_progress(&root, &arxiv_id, &|stage| {
            emit_paper_progress(&app, stage);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_web_reference(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::fetch_web_reference(&root, &url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upgrade_bibliography(
    state: tauri::State<'_, AppState>,
    dry_run: Option<bool>,
) -> Result<papers::UpgradeResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        papers::upgrade_bibliography(&root, dry_run.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_reference(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<papers::RemoveResult, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::remove_reference(&root, &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_papers(state: tauri::State<'_, AppState>) -> Result<Vec<PaperSummary>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::list_papers(&root))
        .await
        .map_err(|error| format!("Paper scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_paper(state: tauri::State<'_, AppState>, arxiv_id: String) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("Paper read", move || papers::read_paper(&root, &arxiv_id)).await
}

#[tauri::command]
async fn read_paper_blog_local(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    let root = current_root(&state)?;
    run_blocking("Paper overview read", move || {
        papers::read_paper_blog_local(&root, &arxiv_id)
    })
    .await
}

#[tauri::command]
async fn read_paper_blog(
    state: tauri::State<'_, AppState>,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    // May reach the network (lazy backfill), so keep it off the main thread.
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || papers::read_paper_blog(&root, &arxiv_id))
        .await
        .map_err(|error| format!("The paper overview task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    let root = current_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || project::history(&root))
        .await
        .map_err(|error| format!("History scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn get_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<TransactionRecord, String> {
    let root = current_root(&state)?;
    run_blocking("History entry read", move || {
        project::get_history_entry(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn revert_transaction(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("History revert", move || {
        let record = project::revert(&root, &transaction_id)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn revert_history_file(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
    path: String,
) -> Result<String, String> {
    let root = current_root(&state)?;
    run_blocking("History file revert", move || {
        let record = project::revert_file(&root, &transaction_id, &path)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn delete_history_entry(
    state: tauri::State<'_, AppState>,
    transaction_id: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    run_blocking("History deletion", move || {
        project::delete_history(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn start_tex_install(kind: String) -> Result<(), String> {
    run_blocking("TeX installer launch", move || {
        tex_setup::start_tex_install(&kind)
    })
    .await
}

/// Keep native resize backing surfaces in sync with the web app theme.
#[tauri::command]
fn set_window_background(app: tauri::AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        macos_window::apply_window_background(&window, dark);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, dark);
        Ok(())
    }
}

#[tauri::command]
fn align_traffic_lights(
    app: tauri::AppHandle,
    center_from_top: f64,
) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        Ok(macos_window::align_traffic_lights_to(
            &window,
            center_from_top,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, center_from_top);
        Ok(None)
    }
}

#[tauri::command]
async fn sample_screen_color(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        macos_window::sample_screen_color(&app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(None)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Literature operations requested by the agent through the same domain code
/// used by the app's own interface.
///
/// The agent runs in a sidecar process and cannot call into the app, so the
/// app offers a private JSON dispatcher through its own executable. Keeping
/// search, fetch, cite, upgrade, removal, and the library listing here avoids
/// a second TypeScript implementation drifting from the UI.
///
/// Returns true when this was a CLI invocation and the process should exit.
/// Must run before anything touches Tauri or AppKit.
#[derive(serde::Deserialize)]
#[serde(tag = "tool", content = "params", rename_all = "snake_case")]
enum LiteratureRequest {
    SearchLiterature {
        query: String,
        #[serde(default)]
        precise: bool,
        #[serde(default)]
        page: u32,
    },
    FetchPaper {
        #[serde(rename = "arxivId")]
        arxiv_id: String,
    },
    ListPapers {},
    SearchLibrary {
        query: String,
    },
    FetchWebReference {
        url: String,
    },
    Cite {
        query: String,
    },
    UpgradeBibliography {
        #[serde(rename = "dryRun", default)]
        dry_run: bool,
    },
    RemoveReference {
        key: String,
    },
}

fn run_cli() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("literature") {
        return false;
    }
    let Some(root) = std::env::var_os("LATTICE_PROJECT_ROOT").filter(|v| !v.is_empty()) else {
        eprintln!("LATTICE_PROJECT_ROOT is not set.");
        std::process::exit(2);
    };
    let raw = args.collect::<Vec<_>>().join(" ");
    let request: LiteratureRequest = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Invalid literature request: {error}");
            std::process::exit(2)
        }
    };
    let root = std::path::Path::new(&root);
    let result = match request {
        LiteratureRequest::SearchLiterature {
            query,
            precise,
            page,
        } => literature::search(&query, precise, page)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        LiteratureRequest::FetchPaper { arxiv_id } => papers::fetch_paper(root, &arxiv_id)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        // Wrapped in objects: the gateway rejects a bare JSON array as a
        // response envelope.
        LiteratureRequest::ListPapers {} => {
            papers::list_library(root).map(|papers| serde_json::json!({ "papers": papers }))
        }
        LiteratureRequest::SearchLibrary { query } => papers::search_library(root, &query)
            .map(|results| serde_json::json!({ "results": results })),
        LiteratureRequest::FetchWebReference { url } => papers::fetch_web_reference(root, &url)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        LiteratureRequest::Cite { query } => {
            papers::import_reference_with_history(root, &query, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        LiteratureRequest::UpgradeBibliography { dry_run } => {
            papers::upgrade_bibliography_with_history(root, dry_run, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        LiteratureRequest::RemoveReference { key } => {
            papers::remove_reference_with_history(root, &key, papers::HistoryMode::Defer)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
    };
    match result {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(0);
        }
        Err(reason) => {
            eprintln!("{reason}");
            std::process::exit(1);
        }
    }
}

pub fn run() {
    if run_cli() {
        return;
    }
    // Panics after the log plugin installs its logger land in the log file;
    // earlier ones are dropped silently by the `log` crate, which is fine.
    std::panic::set_hook(Box::new(|info| {
        log::error!(target: "lattice::panic", "{info}");
    }));
    let app = tauri::Builder::default()
        // Registered first so init-time logs from the other plugins are captured.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lattice".to_string()),
                    }),
                    #[cfg(debug_assertions)]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .max_file_size(2 * 1024 * 1024)
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update (checks GitHub Releases, verifies with the updater key).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Remember the window's size + position across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            log::info!(target: "lattice::app", "Lattice {} starting", app.package_info().version);
            app.manage(AppState::from_environment());
            app.manage(synara::SynaraRuntime::new(app)?);
            synara::prewarm(app.handle().clone());
            // After an update changed a tool pin, this rebuilds the uvx
            // environment now instead of during the user's first import.
            tauri::async_runtime::spawn_blocking(commands::prewarm_literature_tools);
            #[cfg(target_os = "macos")]
            {
                macos_window::clear_launch_quarantine();
                if let Some(window) = app.get_webview_window("main") {
                    macos_window::install_traffic_light_alignment(&window);
                    macos_window::apply_window_background(&window, false);
                }
                macos_window::install_magnify_monitor(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            link_preview::link_preview,
            collab_credentials::put_collab_credential,
            collab_credentials::get_collab_credential,
            collab_credentials::delete_collab_credential,
            create_project,
            open_tutorial_project,
            get_app_log_dir,
            create_collab_join_workspace,
            initial_project,
            open_project,
            import_project_zip,
            export_project_zip,
            refresh_project,
            collab_project_inventory_v2,
            read_project_file,
            stat_project_file,
            write_project_file,
            list_citation_keys,
            list_citations,
            read_bib_entry,
            save_bib_entry,
            list_references,
            list_unused_symbols,
            list_todos,
            count_project_words,
            update_project_manifest,
            set_project_spelling_words,
            add_root_document,
            remove_root_document,
            preview_replace_in_project,
            replace_in_project,
            find_label_occurrences,
            find_citation_occurrences,
            rename_label,
            rename_citation_key,
            search_project,
            create_project_entry,
            delete_project_entry,
            rename_project_entry,
            move_project_entry,
            import_project_assets,
            import_project_files,
            import_project_sources,
            read_agent_composer_files,
            import_clipboard_image,
            resolve_citation_query,
            read_project_asset,
            write_project_bytes,
            prepare_latex_figure,
            build_project,
            abort_build,
            clean_project,
            run_doctor,
            texlab_diagnostics,
            texlab_completion,
            texlab_hover,
            texlab_definition,
            format_latex,
            search_openalex,
            search_literature,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_init,
            git_set_remote,
            git_push,
            git_pull,
            git_fetch,
            git_log,
            git_show_diff,
            git_restore_file,
            git_restore_project,
            git_auto_commit,
            overleaf_status,
            overleaf_begin_login,
            overleaf_poll_login,
            overleaf_store_cookie,
            overleaf_disconnect,
            overleaf_list_projects,
            overleaf_clone_project,
            overleaf_link,
            overleaf_probe,
            overleaf_rt_connect,
            overleaf_rt_disconnect,
            overleaf_rt_connected,
            overleaf_rt_join_doc,
            overleaf_rt_leave_doc,
            overleaf_rt_send_ops,
            overleaf_rt_send_comment,
            overleaf_rt_connected_users,
            overleaf_rt_update_position,
            overleaf_chat_messages,
            overleaf_send_chat_message,
            overleaf_set_permission,
            overleaf_history_updates,
            overleaf_history_diff,
            overleaf_history_files,
            overleaf_history_labels,
            overleaf_history_revert,
            overleaf_history_restore_file,
            overleaf_history_add_label,
            overleaf_history_delete_label,
            overleaf_accept_changes,
            overleaf_reject_changes,
            overleaf_rt_send_tracked_ops,
            overleaf_change_authors,
            overleaf_set_track_changes,
            overleaf_create_doc,
            overleaf_delete_entity,
            overleaf_threads,
            overleaf_comment_anchors,
            overleaf_doc_ranges,
            overleaf_edit_message,
            overleaf_delete_message,
            overleaf_reply_to_thread,
            overleaf_resolve_thread,
            overleaf_delete_thread,
            overleaf_preview,
            overleaf_clone_target,
            overleaf_set_paused,
            overleaf_sync,
            list_pdf_annotations,
            save_pdf_annotations,
            list_editor_comments,
            save_editor_comments,
            read_compiled_pdf,
            save_compiled_pdf,
            synctex_edit,
            synctex_view,
            import_reference,
            fetch_paper,
            fetch_web_reference,
            upgrade_bibliography,
            remove_reference,
            list_papers,
            read_paper,
            read_paper_blog,
            read_paper_blog_local,
            list_history,
            get_history_entry,
            revert_transaction,
            revert_history_file,
            delete_history_entry,
            start_tex_install,
            set_window_background,
            align_traffic_lights,
            sample_screen_color,
            synara::synara_runtime_status,
            synara::synara_ensure_ready,
            synara::synara_open_skills_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<synara::SynaraRuntime>().shutdown();
        }
    });
}

#[cfg(test)]
mod literature_cli_tests {
    use super::LiteratureRequest;

    /// The gateway always sends a params object, even for tools without
    /// arguments — the empty-struct variant must accept `{}` (a unit variant
    /// would reject it).
    #[test]
    fn parses_the_argumentless_list_papers_request() {
        let request: LiteratureRequest =
            serde_json::from_str(r#"{"tool":"list_papers","params":{}}"#).unwrap();
        assert!(matches!(request, LiteratureRequest::ListPapers {}));
    }

    #[test]
    fn parses_the_search_library_request() {
        let request: LiteratureRequest =
            serde_json::from_str(r#"{"tool":"search_library","params":{"query":"attention"}}"#)
                .unwrap();
        assert!(matches!(
            request,
            LiteratureRequest::SearchLibrary { query } if query == "attention"
        ));
    }
}
