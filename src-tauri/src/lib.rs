mod alphaxiv;
mod browser_host;
mod chromium;
mod citation_health;
mod collab_credentials;
mod commands;
mod doctor;
mod firecrawl;
mod format_latex;
mod fs_watch;
mod fts;
mod git;
mod harper;
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
mod semantic_search;
mod synara;
mod tex_setup;
mod texcount;
mod texlab;
mod xlsx;

use base64::{engine::general_purpose::STANDARD, Engine};
use models::{
    AssetPreview, BuildResult, CitationInfo, DoctorReport, EditorComment, GitDiff, GitRemoteResult,
    GitStatus, HistoryItem, ImportResult, LiteraturePage, OpenAlexWork, PaperSummary, PdfMark,
    PdfSyncTarget, ProjectManifest, ProjectSearchResult, ProjectSnapshot, ReferenceInfo,
    RenameSymbolResult, ReplacePreview, ReplaceResult, ResolvedCitation, SymbolOccurrence,
    SyncTexTarget, TexlabCompletionItem, TexlabHover, TexlabLocation, TodoHit, TransactionRecord,
    UnusedSymbols, WordCount,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;

const OVERLEAF_FULL_SYNC_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(7);

fn overleaf_full_sync_delay(
    previous: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
) -> std::time::Duration {
    previous
        .map(|started| (started + OVERLEAF_FULL_SYNC_MIN_GAP).saturating_duration_since(now))
        .unwrap_or_default()
}

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
        ensure_expected_project_root, overleaf_full_sync_delay, project,
        prune_old_share_workspaces, OverleafRealtimeState,
    };
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    #[test]
    fn full_overleaf_syncs_cannot_exhaust_the_download_allowance() {
        let now = tokio::time::Instant::now();

        assert!(overleaf_full_sync_delay(None, now).is_zero());
        assert_eq!(
            overleaf_full_sync_delay(Some(now - std::time::Duration::from_secs(3)), now),
            std::time::Duration::from_secs(4)
        );
        assert!(
            overleaf_full_sync_delay(Some(now - std::time::Duration::from_secs(7)), now).is_zero()
        );
    }

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
    fn each_window_keeps_its_own_project() {
        let state = super::AppState::from_environment();
        let a = PathBuf::from("/project/a");
        let b = PathBuf::from("/project/b");

        state.bind_window("main", a.clone()).unwrap();
        state.bind_window("project-1", b.clone()).unwrap();

        assert_eq!(state.root_for("main").unwrap(), Some(a));
        assert_eq!(state.root_for("project-1").unwrap(), Some(b));
        assert_eq!(state.root_for("project-2").unwrap(), None);
    }

    #[test]
    fn a_project_already_open_is_found_by_the_window_showing_it() {
        let state = super::AppState::from_environment();
        let a = PathBuf::from("/project/a");
        state.bind_window("project-1", a.clone()).unwrap();

        // This is what makes "open in a new window" raise the existing window
        // instead of putting one project in two.
        assert_eq!(state.window_showing(&a).as_deref(), Some("project-1"));
        assert_eq!(state.window_showing(Path::new("/project/b")), None);
    }

    #[test]
    fn one_project_resources_are_shared_and_two_projects_are_not() {
        let state = super::AppState::from_environment();
        let a = Path::new("/project/a");
        let b = Path::new("/project/b");

        // A second window building project B must not be able to abort the
        // build project A already has running.
        assert!(Arc::ptr_eq(
            &state.project(a).active_build,
            &state.project(a).active_build
        ));
        assert!(!Arc::ptr_eq(
            &state.project(a).active_build,
            &state.project(b).active_build
        ));
    }

    #[test]
    fn closing_a_window_releases_its_project_and_retires_its_resources() {
        let state = super::AppState::from_environment();
        let a = PathBuf::from("/project/a");
        let b = PathBuf::from("/project/b");
        state.bind_window("project-1", a.clone()).unwrap();
        state.bind_window("project-2", b.clone()).unwrap();
        let kept = state.project(&b);
        state.project(&a);

        state.release_window("project-1");
        state.retire_unused_projects();

        assert_eq!(state.root_for("project-1").unwrap(), None);
        // The closed window's project is gone; the surviving window keeps the
        // very same resources rather than a rebuilt set.
        assert!(!state.projects.lock().unwrap().contains_key(&a));
        assert!(Arc::ptr_eq(&state.project(&b), &kept));
    }

    #[test]
    fn a_mismatched_request_cannot_grow_the_project_map_forever() {
        let state = super::AppState::from_environment();
        state
            .bind_window("main", PathBuf::from("/project/a"))
            .unwrap();
        state.project(Path::new("/project/a"));
        // A command takes the named project's lease before checking the window
        // still has it open, so a stale request creates an entry for a project
        // nobody has. It must not survive the next window event, while the
        // project a window really has open must.
        state.project(Path::new("/project/gone"));

        state.retire_unused_projects();

        let projects = state.projects.lock().unwrap();
        assert!(projects.contains_key(Path::new("/project/a")));
        assert!(!projects.contains_key(Path::new("/project/gone")));
    }

    #[cfg(unix)]
    #[test]
    fn closing_the_last_window_on_a_project_stops_its_build() {
        use std::os::unix::process::CommandExt;
        // A process this test owns, in its own group: abort signals a whole
        // process group, so a made-up pid would be some other program's.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn a stand-in build");
        let state = super::AppState::from_environment();
        let root = PathBuf::from("/project/building");
        state.bind_window("project-1", root.clone()).unwrap();
        super::latex::begin_for_test(&state.project(&root).active_build, child.id()).unwrap();

        state.release_window("project-1");
        state.retire_unused_projects();

        let stopped = (0..100).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            matches!(child.try_wait(), Ok(Some(_)))
        });
        let _ = child.kill();
        // Without this, latexmk keeps compiling into a project no window has
        // open, with nothing left holding a handle to stop it.
        assert!(stopped, "the build outlived the window that started it");
    }

    #[test]
    fn a_window_instruction_is_handed_over_exactly_once() {
        let state = super::AppState::from_environment();
        state.set_pending_action("project-1", "join".to_string());

        assert_eq!(
            state.take_pending_action("project-1").as_deref(),
            Some("join")
        );
        // A reload of that window must not rejoin the room a second time, and
        // no other window may pick the instruction up.
        assert_eq!(state.take_pending_action("project-1"), None);
        assert_eq!(state.take_pending_action("project-2"), None);
    }

    #[test]
    fn closing_a_window_discards_an_instruction_it_never_took() {
        let state = super::AppState::from_environment();
        state.set_pending_action("project-1", "join".to_string());

        state.release_window("project-1");

        // Left behind, it would be handed to whichever window reuses the label.
        assert_eq!(state.take_pending_action("project-1"), None);
    }

    #[test]
    fn window_labels_reuse_the_lowest_free_slot() {
        let taken = ["project-1", "project-3"];
        let is_taken = |label: &str| taken.contains(&label);

        // Stable labels are what let the window-state plugin restore the size
        // and position the writer gave that slot.
        assert_eq!(super::next_project_window_label(is_taken), "project-2");
        assert_eq!(super::next_project_window_label(|_| false), "project-1");
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

/// Label Tauri gives the window declared in tauri.conf.json.
const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_HOST_ARG: &str = "--browser-host";

fn browser_host_launch() -> bool {
    std::env::args_os().any(|argument| argument == BROWSER_HOST_ARG)
}

struct AppState {
    /// The project each window is looking at.
    ///
    /// Every window is an independent workspace, so there is deliberately no
    /// process-wide "current project": a command must resolve against the
    /// project of the window that sent it. Reading a single global here is what
    /// made a second window impossible — it would reinterpret window A's next
    /// file write against whichever project window B had opened last.
    roots: Mutex<HashMap<String, PathBuf>>,
    /// Resources owned by an open project rather than by the process.
    projects: Mutex<HashMap<PathBuf, Arc<ProjectResources>>>,
    /// Process-wide backstop for Overleaf's ten-project-downloads-per-minute
    /// limit. Frontend instances also debounce, but Chromium reloads, multiple
    /// windows, and different projects still share the same account allowance.
    overleaf_sync_started: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    /// One-shot instruction left for a window that is being opened, taken by
    /// that window once during startup.
    ///
    /// Joining a share has to hand the new window something the project on
    /// disk cannot say: that it should connect to the room now. Routing it
    /// through here rather than shared storage means it cannot be read twice,
    /// cannot be picked up by the wrong window, and dies with the window.
    pending_actions: Mutex<HashMap<String, String>>,
}

/// State that belongs to one project.
///
/// These were process-wide singletons, which is invisible while a single window
/// can only show one project at a time. With two windows open it is not: one
/// window's build would inherit the other's latexmk pid, one window's LaTeX
/// language server would be torn down by the other's file, and connecting one
/// window to Overleaf would cancel the other's connection.
#[derive(Default)]
struct ProjectResources {
    active_build: latex::ActiveBuild,
    texlab: Arc<Mutex<texlab::TexlabPool>>,
    /// Opt-in, on-device semantic index. The model never sees network I/O and
    /// the worker is cancelled when this project no longer belongs to a window.
    semantic_search: Arc<semantic_search::SemanticSearch>,
    /// Live connection to Overleaf's editing channel, when one is open.
    realtime: Arc<Mutex<OverleafRealtimeState>>,
    /// Serializes a whole ZIP sync against document join/leave and outgoing
    /// realtime mutations, closing the ownership-snapshot race.
    overleaf_sync_lease: Arc<tokio::sync::RwLock<()>>,
    /// Serializes project-wide create/delete/rename/move catalog mutations.
    structural_mutation: Arc<tokio::sync::Mutex<()>>,
    /// Filesystem watcher feeding `project-fs-changed` events; replaces the
    /// frontend's 2-second refresh poll. Dropped with the project's resources
    /// when the last window showing it closes.
    fs_watcher: Mutex<Option<fs_watch::ProjectWatcher>>,
}

impl AppState {
    fn from_environment() -> Self {
        let mut roots = HashMap::new();
        // LATTICE_PROJECT belongs to the window the app opens with; a window
        // created later is told its project when it is built.
        if let Some(root) = std::env::var_os("LATTICE_PROJECT")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .and_then(|path| path.canonicalize().ok())
        {
            roots.insert(MAIN_WINDOW_LABEL.to_string(), root);
        }
        Self {
            roots: Mutex::new(roots),
            projects: Mutex::new(HashMap::new()),
            overleaf_sync_started: tokio::sync::Mutex::new(None),
            pending_actions: Mutex::new(HashMap::new()),
        }
    }

    /// Resources of the project a request names, created on first use.
    ///
    /// Deliberately keyed by the project the *caller* named rather than by
    /// whatever the window currently shows: a command takes this project's
    /// lease first and only then checks the window still has it open, so a
    /// project switch racing the request is caught by that check instead of
    /// slipping between it and the work.
    fn project(&self, root: &Path) -> Arc<ProjectResources> {
        let mut projects = match self.projects.lock() {
            Ok(projects) => projects,
            // The map holds only Arc handles, so a thread that panicked while
            // holding this lock cannot have left it half-written.
            Err(poisoned) => poisoned.into_inner(),
        };
        Arc::clone(projects.entry(root.to_path_buf()).or_default())
    }

    /// Forget projects no window has open, shutting down what they still hold.
    ///
    /// A mismatched request creates an entry before its project check fails, so
    /// without this the map would keep an entry for every path ever named.
    fn retire_unused_projects(&self) {
        let live: std::collections::HashSet<PathBuf> = match self.roots.lock() {
            Ok(roots) => roots.values().cloned().collect(),
            Err(_) => return,
        };
        let mut projects = match self.projects.lock() {
            Ok(projects) => projects,
            Err(poisoned) => poisoned.into_inner(),
        };
        projects.retain(|root, resources| {
            if live.contains(root) {
                return true;
            }
            // A build outlives the window that started it otherwise: latexmk
            // keeps compiling into a project nobody has open, and nothing is
            // left watching for it to finish or holding a handle to stop it.
            let _ = latex::abort(&resources.active_build);
            if let Ok(mut pool) = resources.texlab.lock() {
                pool.reset();
            }
            resources.semantic_search.cancel();
            let client = resources
                .realtime
                .lock()
                .ok()
                .and_then(|mut realtime| realtime.cancel(None));
            if let Some(client) = client {
                client.shutdown();
            }
            false
        });
    }

    fn root_for(&self, label: &str) -> Result<Option<PathBuf>, String> {
        Ok(self
            .roots
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .get(label)
            .cloned())
    }

    /// Bind a window to a project before it loads, so the window's own startup
    /// request already resolves against it.
    fn bind_window(&self, label: &str, root: PathBuf) -> Result<(), String> {
        self.roots
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?
            .insert(label.to_string(), root);
        Ok(())
    }

    /// Drop a closed window's binding. Without this the map grows for the life
    /// of the process and a recycled label would inherit a stale project.
    fn release_window(&self, label: &str) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.remove(label);
        }
        // A window that closed before startup finished never took its
        // instruction; leaving it would hand it to whoever reuses the label.
        if let Ok(mut pending) = self.pending_actions.lock() {
            pending.remove(label);
        }
    }

    fn set_pending_action(&self, label: &str, action: String) {
        if let Ok(mut pending) = self.pending_actions.lock() {
            pending.insert(label.to_string(), action);
        }
    }

    fn take_pending_action(&self, label: &str) -> Option<String> {
        self.pending_actions.lock().ok()?.remove(label)
    }

    /// The window currently showing `root`, if any.
    fn window_showing(&self, root: &Path) -> Option<String> {
        let roots = self.roots.lock().ok()?;
        roots
            .iter()
            .find(|(_, open)| open.as_path() == root)
            .map(|(label, _)| label.clone())
    }
}

fn current_root(
    state: &tauri::State<'_, AppState>,
    window: &tauri::Window,
) -> Result<PathBuf, String> {
    state
        .root_for(window.label())?
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
fn scoped_root(
    state: &tauri::State<'_, AppState>,
    window: &tauri::Window,
    project_root: &str,
) -> Result<PathBuf, String> {
    ensure_expected_project_root(current_root(state, window)?, project_root)
}

async fn set_root(
    state: &tauri::State<'_, AppState>,
    window: &tauri::Window,
    root: PathBuf,
) -> Result<(), String> {
    // Everything below is scoped to the project this window is leaving, so a
    // switch in one window never disturbs another window's build, language
    // server or Overleaf connection.
    let Some(leaving) = state.root_for(window.label())? else {
        // Nothing open in this window yet: no in-flight work to wait for.
        state.bind_window(window.label(), root)?;
        return Ok(());
    };
    let leaving = state.project(&leaving);
    // A root switch must wait for a ZIP sync or a root-scoped Overleaf
    // mutation to finish. The UI invalidates its old generation immediately,
    // while this lease ensures the backend cannot reinterpret a request for A
    // against B halfway through it.
    let _lease = leaving.overleaf_sync_lease.write().await;
    // Keep root switching in the same lock order as root-scoped structural
    // commands: Overleaf lease, then catalog mutation lock.
    let _mutation = leaving.structural_mutation.lock().await;
    if let Ok(mut pool) = leaving.texlab.lock() {
        pool.reset();
    }
    // Hold the project root while invalidating realtime under the same lock
    // order used by connect. This makes "claim generation for A" and "switch
    // to B" mutually exclusive rather than two checks with a gap between.
    let mut roots = state
        .roots
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?;
    let previous = leaving
        .realtime
        .lock()
        .map_err(|_| "The Overleaf connection is unavailable.".to_string())?
        .cancel(None);
    roots.insert(window.label().to_string(), root);
    drop(roots);
    if let Some(previous) = previous {
        previous.shutdown();
    }
    state.retire_unused_projects();
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

/// Create a project on disk. Which window shows it is a separate decision the
/// caller makes with `open_project` or `open_project_window` — binding it here
/// would take the calling window's project away before it could open the new
/// one somewhere else.
#[tauri::command]
async fn create_project(
    parent: String,
    name: String,
    venue: Option<String>,
) -> Result<ProjectSnapshot, String> {
    let venue = project::Venue::parse(venue.as_deref().unwrap_or("neurips"))?;
    run_blocking("Project creation", move || {
        let root = if venue == project::Venue::Neurips {
            project::create(Path::new(&parent), &name)?
        } else {
            project::create_with_venue(Path::new(&parent), &name, venue)?
        };
        project::open(&root)
    })
    .await
}

#[tauri::command]
async fn open_tutorial_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
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
    set_root(&state, &window, root).await?;
    Ok(snapshot)
}

/// Fresh blank folder under Documents/Lattice Shares for joining a share.
/// Does not modify whatever project the guest had open before.
#[tauri::command]
async fn create_collab_join_workspace(
    app: tauri::AppHandle,
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
    let (_root, snapshot) = run_blocking("Shared workspace creation", move || {
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
    window: tauri::Window,
) -> Result<Option<ProjectSnapshot>, String> {
    // Both the window the app launches with (bound from LATTICE_PROJECT) and a
    // window opened for a specific project (bound before it loads) find their
    // project here, so the frontend startup path is the same for either.
    let root = state.root_for(window.label())?;
    run_blocking("Initial project load", move || {
        root.map(|path| project::open(&path)).transpose()
    })
    .await
}

#[tauri::command]
async fn open_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
) -> Result<ProjectSnapshot, String> {
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    let root = PathBuf::from(&snapshot.root);
    if let Some(label) = state.window_showing(&root) {
        if label != window.label() {
            return Err(
                "This project is already open in another Lattice window. Open it in the browser from that window instead."
                    .to_string(),
            );
        }
    }
    set_root(&state, &window, root).await?;
    Ok(snapshot)
}

/// What `open_project_window` did, so the caller can tell "opened" from
/// "the project was already open over there".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedProjectWindow {
    label: String,
    /// True when an existing window was raised instead of a new one created.
    focused_existing: bool,
}

/// Take the one-shot instruction left for this window, if any.
#[tauri::command]
fn take_pending_window_action(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Option<String> {
    state.take_pending_action(window.label())
}

/// Pick a free `project-N` label.
///
/// Reusing the lowest free index rather than a running counter keeps the label
/// stable across close-and-reopen, which is what lets the window-state plugin
/// restore the size and position the writer last gave that slot.
fn next_project_window_label(is_taken: impl Fn(&str) -> bool) -> String {
    (1..)
        .map(|index| format!("project-{index}"))
        .find(|label| !is_taken(label))
        .expect("an unused window label always exists")
}

fn build_project_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::WebviewWindow, String> {
    let builder = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title("Lattice")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1222.0, 680.0)
        .background_color(tauri::window::Color(0xF7, 0xF7, 0xF6, 0xFF));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let created = builder
        .build()
        .map_err(|error| format!("Could not open a new Lattice window: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        macos_window::install_traffic_light_alignment(&created);
        macos_window::apply_window_background(&created, false);
    }
    Ok(created)
}

/// Open a project in a window of its own.
///
/// A project may only be open in one window at a time. Two windows on one
/// project would run separate builds into the same output directory, hold two
/// LaTeX language servers over the same files, and each believe its own view of
/// the file tree was current — so a request for a project that is already open
/// raises that window instead of duplicating it.
#[tauri::command]
async fn open_project_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    browser: tauri::State<'_, browser_host::BrowserHost>,
    path: String,
    pending: Option<String>,
) -> Result<OpenedProjectWindow, String> {
    // Opened here, before any window exists, so a project that cannot be read
    // reports the failure into the window the writer is looking at rather than
    // flashing up a broken new one.
    let snapshot = run_blocking("Project opening", move || project::open(Path::new(&path))).await?;
    let root = PathBuf::from(&snapshot.root);

    if let Some(label) = state.window_showing(&root) {
        if label.starts_with("browser-") {
            if browser.reopen_window(&app, &label)? {
                return Ok(OpenedProjectWindow {
                    label,
                    focused_existing: true,
                });
            }
        } else if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            // The window is already up, so it will not run startup again. The
            // caller is told nothing was opened and acts on the instruction
            // itself rather than having it silently dropped here.
            return Ok(OpenedProjectWindow {
                label,
                focused_existing: true,
            });
        }
        // The binding outlived its window. Drop it and open a fresh one.
        state.release_window(&label);
    }

    if window.label().starts_with("browser-") {
        let label = browser.open_project(&app, &state, root, pending)?;
        return Ok(OpenedProjectWindow {
            label,
            focused_existing: false,
        });
    }

    let label = next_project_window_label(|label| app.get_webview_window(label).is_some());
    // Bound before the window is built: the new window asks for its project
    // and its instruction during startup, and both must already resolve.
    state.bind_window(&label, root)?;
    if let Some(pending) = pending {
        state.set_pending_action(&label, pending);
    }
    match build_project_window(&app, &label) {
        Ok(created) => {
            let _ = created.set_focus();
            Ok(OpenedProjectWindow {
                label,
                focused_existing: false,
            })
        }
        Err(error) => {
            state.release_window(&label);
            state.retire_unused_projects();
            Err(format!("Could not open a new window: {error}"))
        }
    }
}

/// Move a browser-hosted project back into an ordinary desktop window. The
/// browser relay is retired only after this command's response has crossed the
/// bridge, so the caller never hangs waiting on a socket we just closed.
#[tauri::command]
fn return_to_desktop(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    browser: tauri::State<'_, browser_host::BrowserHost>,
    window: tauri::Window,
) -> Result<String, String> {
    if !window.label().starts_with("browser-") {
        return Err("This workspace is already open in the desktop app.".to_string());
    }
    if browser.has_bundled_chromium(window.label())? {
        // The fixed Chromium build already owns this workspace and is merely
        // parked while the system-browser peer is connected. Resume that same
        // renderer instead of creating a slower WebKit desktop window.
        browser.return_to_desktop(&app, window.label(), true)?;
        return Ok(window.label().to_string());
    }
    let root = current_root(&state, &window)?;
    let label = next_project_window_label(|label| app.get_webview_window(label).is_some());
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| format!("Could not show Lattice in the Dock: {error}"))?;
    state.bind_window(&label, root)?;
    let desktop = match build_project_window(&app, &label) {
        Ok(window) => window,
        Err(reason) => {
            state.release_window(&label);
            state.retire_unused_projects();
            return Err(reason);
        }
    };
    if let Err(reason) = browser.return_to_desktop(&app, window.label(), false) {
        let _ = desktop.destroy();
        state.release_window(&label);
        state.retire_unused_projects();
        return Err(reason);
    }
    let _ = desktop.set_focus();
    Ok(label)
}

/// Unpack a project from a ZIP. As with `create_project`, placing it in a
/// window is the caller's separate decision.
#[tauri::command]
async fn import_project_zip(zip_path: String, parent: String) -> Result<ProjectSnapshot, String> {
    run_blocking("Project import", move || {
        project::import_project_zip(Path::new(&zip_path), Path::new(&parent))
    })
    .await
}

#[tauri::command]
async fn export_project_zip(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    zip_path: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project export", move || {
        project::export_project_zip(&root, Path::new(&zip_path))
    })
    .await
}

#[tauri::command]
async fn stat_project_file(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
) -> Result<project::ProjectFileStat, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project file status", move || {
        project::stat_file(&root, &path)
    })
    .await
}

#[tauri::command]
async fn refresh_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<ProjectSnapshot, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::open(&root))
        .await
        .map_err(|error| format!("Project refresh stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn collab_project_inventory_v2(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<project::CollabProjectInventoryV2, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Collaboration project inventory", move || {
        project::collab_project_inventory_v2(&root)
    })
    .await
}

#[tauri::command]
async fn read_project_file(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    project_root: Option<String>,
) -> Result<String, String> {
    // Only a caller that pinned a project takes its lease; an unpinned read is
    // a best-effort convenience and must not queue behind a sync.
    let project = project_root
        .as_deref()
        .map(|root| state.project(Path::new(root)));
    let _lease = match &project {
        Some(project) => Some(project.overleaf_sync_lease.read().await),
        None => None,
    };
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    path: String,
    content: String,
    project_root: String,
    base_content: Option<String>,
) -> Result<project::EditorWriteResult, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the file could be written.".to_string())?;
    run_blocking("Project file write", move || {
        project::apply_editor_transaction(&root, path, content, base_content)
    })
    .await
}

#[tauri::command]
async fn list_citation_keys(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::citation_keys(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_citations(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<CitationInfo>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::citations(&root))
        .await
        .map_err(|error| format!("Citation scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_bib_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    key: String,
) -> Result<Option<ResolvedCitation>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Bibliography read", move || {
        project::read_bib_entry(&root, &key)
    })
    .await
}

#[tauri::command]
async fn save_bib_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    key: String,
    bibtex: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Bibliography save", move || {
        project::save_bib_entry(&root, &key, &bibtex)
    })
    .await
}

#[tauri::command]
async fn list_references(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<ReferenceInfo>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::references(&root))
        .await
        .map_err(|error| format!("Reference scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_unused_symbols(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<UnusedSymbols, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::unused_symbols(&root))
        .await
        .map_err(|error| format!("Symbol scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_todos(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<TodoHit>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("TODO scan", move || project::list_todos(&root)).await
}

#[tauri::command]
async fn count_project_words(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<WordCount, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Word count", move || texcount::count_project(&root)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn update_project_manifest(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
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
    let root = current_root(&state, &window)?;
    run_blocking("Project settings update", move || {
        project::update_manifest_settings(&root, engine, default_root, trusted, words, pages, None)
    })
    .await
}

#[tauri::command]
async fn set_project_spelling_words(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    words: Vec<String>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Project dictionary update", move || {
        project::update_manifest_settings(&root, None, None, None, None, None, Some(words))
    })
    .await
}

#[tauri::command]
async fn add_root_document(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    name: Option<String>,
    make_default: Option<bool>,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Root document update", move || {
        project::add_root_document(&root, &path, name, make_default.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn remove_root_document(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
) -> Result<ProjectManifest, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Root document update", move || {
        project::remove_root_document(&root, &path)
    })
    .await
}

#[tauri::command]
async fn preview_replace_in_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    query: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, String> {
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    query: String,
    replacement: String,
    paths: Option<Vec<String>>,
    match_case: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplaceResult, String> {
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    label: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Label search", move || {
        project::find_label_occurrences(&root, &label)
    })
    .await
}

#[tauri::command]
async fn find_citation_occurrences(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    key: String,
) -> Result<Vec<SymbolOccurrence>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Citation search", move || {
        project::find_citation_occurrences(&root, &key)
    })
    .await
}

#[tauri::command]
async fn rename_label(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    old_label: String,
    new_label: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Label rename", move || {
        project::rename_label(&root, &old_label, &new_label)
    })
    .await
}

#[tauri::command]
async fn rename_citation_key(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    old_key: String,
    new_key: String,
) -> Result<RenameSymbolResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Citation rename", move || {
        project::rename_citation_key(&root, &old_key, &new_key)
    })
    .await
}

#[tauri::command]
async fn search_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = project::search_files(&root, &query)?;
        results.extend(papers::search_library(&root, &query)?);
        Ok(results)
    })
    .await
    .map_err(|error| format!("Project search stopped unexpectedly: {error}"))?
}

fn semantic_search_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve the local cache folder: {error}"))?
        .join("semantic-search")
        .join("embeddings-v1.sqlite3"))
}

#[tauri::command]
fn semantic_search_start_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<semantic_search::SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let search = Arc::clone(&state.project(&root).semantic_search);
    semantic_search::start_index(Arc::clone(&search), root, semantic_search_cache_path(&app)?);
    Ok(search.status())
}

#[tauri::command]
fn semantic_search_status(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<semantic_search::SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    Ok(state.project(&root).semantic_search.status())
}

#[tauri::command]
fn semantic_search_cancel(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<semantic_search::SemanticSearchStatus, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    Ok(state.project(&root).semantic_search.cancel())
}

#[tauri::command]
async fn semantic_search_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    query: String,
) -> Result<semantic_search::SemanticSearchResponse, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let search = Arc::clone(&state.project(&root).semantic_search);
    let response =
        tauri::async_runtime::spawn_blocking(move || semantic_search::search(&search, &query))
            .await
            .map_err(|error| format!("Local semantic search stopped unexpectedly: {error}"))?;
    scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before local semantic search finished.".to_string())?;
    Ok(response)
}

#[tauri::command]
async fn create_project_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    kind: String,
    project_root: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let _mutation = project.structural_mutation.lock().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the file could be created.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::create_entry(&root, &path, &kind))
        .await
        .map_err(|error| format!("File creation stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn delete_project_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    project_root: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let _mutation = project.structural_mutation.lock().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the file could be deleted.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::delete_entry(&root, &path))
        .await
        .map_err(|error| format!("File deletion stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn rename_project_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    new_name: String,
    project_root: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let _mutation = project.structural_mutation.lock().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the file could be renamed.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || project::rename_entry(&root, &path, &new_name))
        .await
        .map_err(|error| format!("File rename stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn move_project_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    target_directory: String,
    project_root: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let _mutation = project.structural_mutation.lock().await;
    let root = scoped_root(&state, &window, &project_root)
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
    window: tauri::Window,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
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
    window: tauri::Window,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<project::ImportedProjectFile>, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
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
    window: tauri::Window,
    paths: Vec<String>,
    target_directory: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
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
    window: tauri::Window,
    target_directory: String,
    file_name: String,
    base64_data: String,
    project_root: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
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
    window: tauri::Window,
    path: String,
    project_root: Option<String>,
) -> Result<AssetPreview, String> {
    // Only a caller that pinned a project takes its lease; an unpinned read is
    // a best-effort convenience and must not queue behind a sync.
    let project = project_root
        .as_deref()
        .map(|root| state.project(Path::new(root)));
    let _lease = match &project {
        Some(project) => Some(project.overleaf_sync_lease.read().await),
        None => None,
    };
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    path: String,
    base64_data: String,
    project_root: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the asset could be written.".to_string())?;
    run_blocking("Project asset write", move || {
        project::write_bytes(&root, &path, &base64_data)
    })
    .await
}

#[tauri::command]
async fn prepare_latex_figure(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    project_root: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = scoped_root(&state, &window, &project_root)
        .map_err(|_| "The project changed before the figure could be prepared.".to_string())?;
    run_blocking("Figure preparation", move || {
        project::prepare_latex_figure(&root, &path)
    })
    .await
}

#[tauri::command]
async fn build_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    force: Option<bool>,
    project_root: String,
    document_path: Option<String>,
) -> Result<BuildResult, String> {
    let root = current_root(&state, &window)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before its build could start.".to_string());
    }
    let force = force.unwrap_or(false);
    let active = state.project(&root).active_build.clone();
    tauri::async_runtime::spawn_blocking(move || {
        latex::build(&root, force, &active, document_path.as_deref())
    })
    .await
    .map_err(|error| format!("The LaTeX build task stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn abort_build(state: tauri::State<'_, AppState>, window: tauri::Window) -> Result<bool, String> {
    // Stops this window's build. Sharing one handle meant Stop in either window
    // killed whichever latexmk had started most recently.
    let root = current_root(&state, &window)?;
    latex::abort(&state.project(&root).active_build)
}

#[tauri::command]
async fn clean_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || latex::clean(&root))
        .await
        .map_err(|error| format!("The LaTeX clean task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_doctor(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<DoctorReport, String> {
    // Reports on the window's own project, and still runs the environment
    // checks when that window has nothing open yet.
    let root = state.root_for(window.label()).ok().flatten();
    run_blocking("Doctor check", move || Ok(doctor::run(root.as_deref()))).await
}

#[tauri::command]
fn watch_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    let resources = state.project(&root);
    let mut watcher = match resources.fs_watcher.lock() {
        Ok(watcher) => watcher,
        Err(poisoned) => poisoned.into_inner(),
    };
    if watcher.is_some() {
        return Ok(());
    }
    *watcher = Some(fs_watch::spawn(app, root)?);
    Ok(())
}

#[tauri::command]
async fn harper_lint(
    text: String,
    project_words: Vec<String>,
) -> Result<Vec<harper::HarperLintOut>, String> {
    // Pure text in/out — no project state. spawn_blocking keeps the multi-
    // hundred-millisecond lint pass off the async reactor and (unlike the
    // old in-webview WASM path) off the UI thread entirely.
    run_blocking("harper_lint", move || {
        Ok(harper::lint(&text, &project_words))
    })
    .await
}

#[tauri::command]
async fn texlab_diagnostics(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    text: String,
) -> Result<Vec<models::Diagnostic>, String> {
    let root = current_root(&state, &window)?;
    let pool = Arc::clone(&state.project(&root).texlab);
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
    window: tauri::Window,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Vec<TexlabCompletionItem>, String> {
    let root = current_root(&state, &window)?;
    let pool = Arc::clone(&state.project(&root).texlab);
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
    window: tauri::Window,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabHover>, String> {
    let root = current_root(&state, &window)?;
    let pool = Arc::clone(&state.project(&root).texlab);
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
    window: tauri::Window,
    path: String,
    text: String,
    line: u32,
    character: u32,
) -> Result<Option<TexlabLocation>, String> {
    let root = current_root(&state, &window)?;
    let pool = Arc::clone(&state.project(&root).texlab);
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
    window: tauri::Window,
    path: String,
    text: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
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
async fn git_status(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<GitStatus, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || git::status(&root))
        .await
        .map_err(|error| format!("Git status stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn git_diff(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git diff", move || git::diff(&root, &path, staged)).await
}

#[tauri::command]
async fn git_stage(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git stage", move || git::stage(&root, &paths)).await
}

#[tauri::command]
async fn git_unstage(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git unstage", move || git::unstage(&root, &paths)).await
}

#[tauri::command]
async fn git_commit(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    message: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git commit", move || git::commit(&root, &message)).await
}

#[tauri::command]
async fn git_init(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<GitStatus, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git initialization", move || git::init(&root)).await
}

#[tauri::command]
async fn git_set_remote(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    name: Option<String>,
    url: String,
) -> Result<GitStatus, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git remote update", move || {
        git::set_remote(&root, name.as_deref().unwrap_or("origin"), &url)
    })
    .await
}

#[tauri::command]
async fn git_push(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<GitRemoteResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git push", move || git::push(&root)).await
}

#[tauri::command]
async fn git_pull(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<GitRemoteResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git pull", move || git::pull(&root)).await
}

#[tauri::command]
async fn git_fetch(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<GitRemoteResult, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git fetch", move || git::fetch(&root)).await
}

#[tauri::command]
async fn git_log(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    limit: Option<u32>,
) -> Result<Vec<models::GitLogEntry>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git history", move || {
        git::log(&root, limit.unwrap_or(200) as usize)
    })
    .await
}

#[tauri::command]
async fn git_show_diff(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    rev: String,
    path: String,
) -> Result<models::GitFileDiff, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git revision diff", move || {
        git::show_diff(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_file(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    rev: String,
    path: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git file restore", move || {
        git::restore_file(&root, &rev, &path)
    })
    .await
}

#[tauri::command]
async fn git_restore_project(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    rev: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Git project restore", move || {
        git::restore_project(&root, &rev)
    })
    .await
}

#[tauri::command]
async fn git_auto_commit(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    message: String,
    author: Option<String>,
    project_root: Option<String>,
) -> Result<Option<String>, String> {
    // Only a caller that pinned a project takes its lease; an unpinned read is
    // a best-effort convenience and must not queue behind a sync.
    let project = project_root
        .as_deref()
        .map(|root| state.project(Path::new(root)));
    let _lease = match &project {
        Some(project) => Some(project.overleaf_sync_lease.read().await),
        None => None,
    };
    let root = current_root(&state, &window)?;
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

/// Open only Lattice's log directory from the privileged side. Granting the
/// WebView opener:allow-open-path would let compromised frontend code launch
/// any local path through its registered application.
#[tauri::command]
fn open_app_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Could not resolve the log folder: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the log folder: {error}"))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("Could not open the log folder: {error}"))
}

/// Hand the current workspace to a browser tab while this installed app keeps
/// every native capability behind a loopback-only, token-authenticated bridge.
#[tauri::command]
fn open_in_browser(
    app: tauri::AppHandle,
    browser: tauri::State<'_, browser_host::BrowserHost>,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<String, String> {
    let project_root = state.root_for(window.label())?;
    // Fail before changing login startup when another process owns the fixed
    // entry. The setting should not look enabled after an unsuccessful open.
    browser.start(&app, false)?;
    // Opening the fixed browser entry opts into its defining behavior: after
    // the next login, a windowless Lattice process keeps the bookmarked local
    // address available without making the writer open the desktop UI first.
    let access_was_enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("Could not read the browser access setting: {error}"))?;
    if !access_was_enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("Could not keep browser access ready after login: {error}"))?;
    }
    let resident_was_present = app.get_window(browser_host::SERVICE_WINDOW_LABEL).is_some();
    if let Err(reason) = browser.keep_resident(&app) {
        if !access_was_enabled {
            let _ = app.autolaunch().disable();
        }
        return Err(reason);
    }
    match browser.open(&app, window.label(), project_root) {
        Ok(url) => Ok(url),
        Err(reason) => {
            if !resident_was_present {
                browser.stop_resident(&app);
            }
            if !access_was_enabled {
                let _ = app.autolaunch().disable();
            }
            Err(reason)
        }
    }
}

/// Open the bundled-Chromium workspace in the user's default browser without
/// tearing down its desktop surface. The browser host parks that surface while
/// the external tab is connected and restores it when the tab closes.
#[tauri::command]
fn open_in_system_browser(
    app: tauri::AppHandle,
    browser: tauri::State<'_, browser_host::BrowserHost>,
    window: tauri::Window,
) -> Result<(), String> {
    if browser.open_in_system_browser(&app, window.label())? {
        Ok(())
    } else {
        Err("This Lattice workspace is no longer available.".to_string())
    }
}

#[tauri::command]
fn browser_access_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("Could not read the browser access setting: {error}"))
}

#[tauri::command]
fn set_browser_access_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|error| format!("Could not update browser access: {error}"))?;
    let browser = app.state::<browser_host::BrowserHost>();
    if enabled {
        browser.keep_resident(&app)
    } else {
        // Packaged Chromium is still the running desktop application after its
        // last window closes on macOS. Its small native owner must stay alive
        // until the user explicitly quits so the Dock can reopen it and the
        // loopback browser address does not disappear.
        if !app.state::<chromium::ChromiumRuntime>().is_running() {
            browser.stop_resident(&app);
        }
        Ok(())
    }
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
    shutdown_all_realtime(&state);
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

/// Publish the currently open local project to a new Overleaf project, then
/// keep this same folder as its synchronized working copy.
#[tauri::command]
async fn overleaf_publish_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    project_name: String,
) -> Result<overleaf::OverleafLink, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.write().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::publish_project(&config, &root, &project_name)
    })
    .await
    .map_err(|error| format!("The Overleaf upload stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_link(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Option<overleaf::OverleafLink>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Overleaf project link", move || {
        overleaf::project_link(&root)
    })
    .await
}

// ---- Overleaf realtime editing ---------------------------------------------

fn realtime_client(
    state: &tauri::State<'_, AppState>,
    window: &tauri::Window,
) -> Result<Arc<overleaf_rt::RealtimeClient>, String> {
    let root = current_root(state, window)?;
    let project = state.project(&root);
    let realtime = project
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
    window: tauri::Window,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state, &window)?;
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
    if current_root(&state, &window)? != root {
        return Err("The project changed before Overleaf could connect.".to_string());
    }

    // Claim a generation before the network await. Compare the root while
    // still holding its guard, then take realtime in the same root→realtime
    // order as `set_root`. Otherwise a switch to B can land in the gap after a
    // successful check for A and let A become the newest live connection.
    let project = state.project(&root);
    let (generation, previous) = {
        let roots = state
            .roots
            .lock()
            .map_err(|_| "Project state is unavailable.".to_string())?;
        if roots.get(window.label()) != Some(&root) {
            return Err("The project changed before Overleaf could connect.".to_string());
        }
        let mut realtime = project
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
    let emit_label = window.label().to_string();
    let event_state = Arc::clone(&state.project(&root).realtime);
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
                let _ = emitter.emit_to(emit_label.as_str(), "overleaf-realtime", event);
            }
        },
    )
    .await;
    let client = match connecting {
        Ok(client) => client,
        Err(error) => {
            if let Ok(mut realtime) = project.realtime.lock() {
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
    let still_current = current_root(&state, &window).is_ok_and(|current| current == root);
    let installed = if still_current {
        let mut realtime = project
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
    // `joinProject` is the only source for the root folder id required by the
    // REST uploader. Persist it before this command returns: the frontend marks
    // the channel live on return, and its first automatic sync may start in the
    // same render. The project lease serializes this write with any manual sync
    // that was already under way.
    let root_folder_id = client.project().root_folder_id.clone();
    let permission = client.project().permission.as_str().to_string();
    let _lease = project.overleaf_sync_lease.write().await;
    if current_root(&state, &window)? != root {
        return Err("The project changed before Overleaf could finish connecting.".to_string());
    }
    let metadata_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        overleaf::set_realtime_metadata(&metadata_root, &root_folder_id, &permission)
    })
    .await
    .map_err(|error| format!("The Overleaf metadata update stopped unexpectedly: {error}"))??;
    Ok(joined)
}

/// Close the live channel if one is open. Safe to call when there is none.
fn shutdown_realtime(project: &ProjectResources) {
    let previous = project
        .realtime
        .lock()
        .ok()
        .and_then(|mut realtime| realtime.cancel(None));
    if let Some(previous) = previous {
        previous.shutdown();
    }
}

/// Close every project's live channel.
///
/// Only for signing out: the Overleaf session is shared by every window, so
/// throwing it away has to take down the connections that authenticate with it,
/// not just the one belonging to whichever window asked.
fn shutdown_all_realtime(state: &tauri::State<'_, AppState>) {
    let projects: Vec<Arc<ProjectResources>> = match state.projects.lock() {
        Ok(projects) => projects.values().cloned().collect(),
        Err(poisoned) => poisoned.into_inner().values().cloned().collect(),
    };
    for project in projects {
        shutdown_realtime(&project);
    }
}

#[tauri::command]
fn overleaf_rt_disconnect(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: Option<String>,
) -> Result<(), String> {
    // A stale React cleanup names the project it was watching; anything else
    // means "disconnect the window I am in". Either way the cancel is addressed
    // to one project, so a second window's connection is left alone.
    let root = match project_root.as_deref() {
        Some(named) => PathBuf::from(named),
        None => match state.root_for(window.label())? {
            Some(root) => root,
            None => return Ok(()),
        },
    };
    let project = state.project(&root);
    let previous = {
        let mut realtime = project
            .realtime
            .lock()
            .map_err(|_| "The Overleaf connection is unavailable.".to_string())?;
        realtime.cancel(Some(&root))
    };
    if let Some(previous) = previous {
        previous.shutdown();
    }
    Ok(())
}

/// Our own id on the channel, or null when not connected. The server echoes
/// our updates back, and this is how the app tells them from someone else's.
#[tauri::command]
fn overleaf_rt_connected(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Option<String> {
    realtime_client(&state, &window)
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    from_version: Option<i64>,
) -> Result<overleaf_rt::JoinedDoc, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.write().await;
    let root = scoped_root(&state, &window, &project_root)?;
    let client = realtime_client(&state, &window)?;
    let path = client
        .project()
        .docs
        .iter()
        .find(|doc| doc.id == doc_id)
        .map(|doc| doc.path.clone())
        .ok_or_else(|| "Overleaf did not report that document in this project.".to_string())?;
    let previous_path = {
        let mut realtime = project
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
            if let Ok(mut realtime) = project.realtime.lock() {
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
    window: tauri::Window,
    project_root: String,
) -> Result<Vec<overleaf_rt::PresenceUser>, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?.connected_users().await
}

/// Publish our caret, which is also what makes us visible to everyone else.
#[tauri::command]
async fn overleaf_rt_update_position(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    row: i64,
    column: i64,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?
        .update_position(&doc_id, row, column)
        .await
}

#[tauri::command]
async fn overleaf_rt_leave_doc(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    doc_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.write().await;
    scoped_root(&state, &window, &project_root)?;
    let client = realtime_client(&state, &window)?;
    client.leave_doc(&doc_id).await?;
    if let Ok(mut realtime) = project.realtime.lock() {
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?
        .send_ops(&doc_id, version, ops)
        .await
}

/// Anchor a comment thread to a span of the open document.
// Overleaf's comment payload decides these arguments, and `window` on top of
// them is what scopes the call to one window's project. Grouping them into a
// struct would only move the same fields behind an extra IPC type.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn overleaf_rt_send_comment(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    version: i64,
    position: i64,
    quote: String,
    thread_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?
        .send_comment(&doc_id, version, position, &quote, &thread_id)
        .await
}

#[tauri::command]
async fn overleaf_chat_messages(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    limit: Option<u32>,
) -> Result<Vec<overleaf::OverleafMessage>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    let limit = limit.unwrap_or(80);
    tauri::async_runtime::spawn_blocking(move || overleaf::chat_messages(&config, &root, limit))
        .await
        .map_err(|error| format!("The Overleaf chat task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_send_chat_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    content: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    permission: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    project_root: String,
    before: Option<i64>,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    path: String,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    from: i64,
    to: i64,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_files(&config, &root, from, to))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_history_labels(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<Vec<overleaf::OverleafLabel>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::history_labels(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf history stopped unexpectedly: {error}"))?
}

/// Roll one file back, or the whole project when `path` is absent.
#[tauri::command]
async fn overleaf_history_revert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    version: i64,
    path: Option<String>,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    version: i64,
    path: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    version: i64,
    comment: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    label_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    change_ids: Vec<String>,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    version: i64,
    changes: Vec<overleaf_rt::TrackedChange>,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?
        .reject_changes(&doc_id, version, &changes)
        .await
}

/// Send an edit as a suggestion rather than applying it outright.
#[tauri::command]
async fn overleaf_rt_send_tracked_ops(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    version: i64,
    ops: Vec<overleaf_rt::OtOp>,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    scoped_root(&state, &window, &project_root)?;
    realtime_client(&state, &window)?
        .send_tracked_ops(&doc_id, version, ops)
        .await
}

/// Who wrote the suggestions in this project.
#[tauri::command]
async fn overleaf_change_authors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::change_authors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Turn suggestions on or off for the accounts named in `on_for`.
#[tauri::command]
async fn overleaf_set_track_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    on_for: serde_json::Value,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    parent_folder_id: String,
    name: String,
) -> Result<String, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    kind: String,
    entity_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state, &window)?;
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
    window: tauri::Window,
    project_root: String,
) -> Result<Vec<overleaf::OverleafThread>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::threads(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

/// What is anchored in one document right now, without re-joining it.
#[tauri::command]
async fn overleaf_doc_ranges(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    doc_id: String,
) -> Result<overleaf::DocRanges, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::doc_ranges(&config, &root, &doc_id))
        .await
        .map_err(|error| format!("The Overleaf task stopped unexpectedly: {error}"))?
}

/// Where every comment in the project is anchored, whatever file it is in.
#[tauri::command]
async fn overleaf_comment_anchors(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<Vec<overleaf::OverleafCommentAnchor>, String> {
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::comment_anchors(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf comment task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_edit_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    thread_id: String,
    message_id: String,
    content: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    thread_id: String,
    message_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    thread_id: String,
    content: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    thread_id: String,
    resolved: bool,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    doc_id: String,
    thread_id: String,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
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
    window: tauri::Window,
    project_root: String,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafPreview, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    let live = live_paths(live);
    tauri::async_runtime::spawn_blocking(move || overleaf::preview(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf comparison stopped unexpectedly: {error}"))?
}

/// Stop or restart syncing for the open project.
#[tauri::command]
async fn overleaf_set_paused(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    paused: bool,
) -> Result<(), String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.write().await;
    let root = scoped_root(&state, &window, &project_root)?;
    if paused {
        // A socket left open would keep delivering edits, chat and presence
        // for a project the user just asked us to leave alone.
        shutdown_realtime(&project);
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
    window: tauri::Window,
    project_root: String,
) -> Result<overleaf::OverleafProbe, String> {
    let project = state.project(Path::new(&project_root));
    let _lease = project.overleaf_sync_lease.read().await;
    let config = overleaf_config_dir(&app)?;
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || overleaf::probe(&config, &root))
        .await
        .map_err(|error| format!("The Overleaf check stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn overleaf_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
    live: Option<Vec<String>>,
) -> Result<overleaf::OverleafSyncResult, String> {
    let project = state.project(Path::new(&project_root));
    // Hold this guard until the write lease is ours. That admits only one
    // waiter at a time while document-level realtime work continues during
    // the cooldown, then records the actual full-download start.
    let mut previous_sync = state.overleaf_sync_started.lock().await;
    let delay = overleaf_full_sync_delay(*previous_sync, tokio::time::Instant::now());
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let _lease = project.overleaf_sync_lease.write().await;
    *previous_sync = Some(tokio::time::Instant::now());
    drop(previous_sync);
    let config = overleaf_config_dir(&app)?;
    let root = current_root(&state, &window)?;
    if root != Path::new(&project_root) {
        return Err("The project changed before Overleaf sync could start.".to_string());
    }
    let mut live = live_paths(live);
    if let Ok(realtime) = project.realtime.lock() {
        realtime.extend_joined_paths(&root, &mut live);
    }
    tauri::async_runtime::spawn_blocking(move || overleaf::sync(&config, &root, &live))
        .await
        .map_err(|error| format!("The Overleaf sync stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_pdf_annotations(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<PdfMark>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("PDF annotation read", move || {
        project::read_pdf_marks(&root)
    })
    .await
}

#[tauri::command]
async fn save_pdf_annotations(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    annotations: Vec<PdfMark>,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("PDF annotation save", move || {
        project::write_pdf_marks(&root, annotations)
    })
    .await
}

#[tauri::command]
async fn list_editor_comments(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<EditorComment>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Editor comment read", move || {
        project::read_editor_comments(&root)
    })
    .await
}

#[tauri::command]
async fn save_editor_comments(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    comments: Vec<EditorComment>,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Editor comment save", move || {
        project::write_editor_comments(&root, comments)
    })
    .await
}

#[tauri::command]
async fn read_compiled_pdf(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    project_root: String,
) -> Result<tauri::ipc::Response, String> {
    let root = current_root(&state, &window)?;
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
async fn save_xlsx(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let destination = request
        .headers()
        .get("x-xlsx-destination")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Choose where to export the Excel workbook.".to_string())?;
    let path = String::from_utf8(
        STANDARD
            .decode(destination)
            .map_err(|error| format!("The Excel destination is invalid: {error}"))?,
    )
    .map_err(|error| format!("The Excel destination is invalid: {error}"))?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("The Excel workbook was not sent as binary data.".to_string()),
    };
    run_blocking("Excel workbook save", move || {
        xlsx::save_xlsx(Path::new(&path), &bytes)
    })
    .await
}

#[tauri::command]
async fn synctex_edit(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexTarget, String> {
    let root = current_root(&state, &window)?;
    run_blocking("SyncTeX lookup", move || {
        latex::inverse_search(&root, page, x, y)
    })
    .await
}

#[tauri::command]
async fn synctex_view(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    path: String,
    line: u32,
    column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || latex::forward_search(&root, &path, line, column))
        .await
        .map_err(|error| format!("The SyncTeX lookup stopped unexpectedly: {error}"))?
}

/// Announce a literature pipeline stage to the window. Best-effort: a stage
/// the frontend never hears about only degrades the status line, never the
/// import itself.
fn emit_paper_progress(app: &tauri::AppHandle, window_label: &str, stage: &str) {
    use tauri::Emitter;
    // Addressed to the window that started the import. Broadcasting made a
    // second window narrate progress for a paper it was not importing.
    let _ = app.emit_to(window_label, "paper-import-progress", stage);
}

#[tauri::command]
async fn import_reference(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    input: String,
) -> Result<ImportResult, String> {
    let root = current_root(&state, &window)?;
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        papers::import_reference_with_progress(&root, &input, &|stage| {
            emit_paper_progress(&app, &window_label, stage);
        })
    })
    .await
    .map_err(|error| format!("The paper import task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn fetch_paper(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    arxiv_id: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state, &window)?;
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        papers::fetch_paper_with_progress(&root, &arxiv_id, &|stage| {
            emit_paper_progress(&app, &window_label, stage);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_web_reference(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    url: String,
) -> Result<papers::FetchResult, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || papers::fetch_web_reference(&root, &url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upgrade_bibliography(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    dry_run: Option<bool>,
) -> Result<papers::UpgradeResult, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        papers::upgrade_bibliography(&root, dry_run.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_reference(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    key: String,
    citation_mode: Option<String>,
    project_root: String,
) -> Result<papers::RemoveResult, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    tauri::async_runtime::spawn_blocking(move || match citation_mode.as_deref() {
        Some("preview") => papers::preview_reference_removal(&root, &key),
        Some("keep") => papers::remove_reference_keeping_citations(&root, &key),
        Some("remove") => papers::remove_reference_and_citations(&root, &key),
        Some(_) => Err("Choose whether to keep or remove manuscript citations.".to_string()),
        None => papers::remove_reference(&root, &key),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_papers(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<PaperSummary>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || papers::list_papers(&root))
        .await
        .map_err(|error| format!("Paper scan stopped unexpectedly: {error}"))?
}

fn paper_pdf_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join("paper-pdfs"))
        .map_err(|error| format!("Could not resolve the paper PDF cache: {error}"))
}

#[tauri::command]
async fn read_cached_paper_pdf(
    app: tauri::AppHandle,
    arxiv_id: String,
) -> Result<tauri::ipc::Response, String> {
    let cache_dir = paper_pdf_cache_dir(&app)?;
    let bytes = run_blocking("Cached paper PDF read", move || {
        papers::read_cached_pdf(&cache_dir, &arxiv_id)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn cache_paper_pdf(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let encoded_id = request
        .headers()
        .get("x-arxiv-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "The paper PDF has no arXiv id.".to_string())?;
    let arxiv_id = String::from_utf8(
        STANDARD
            .decode(encoded_id)
            .map_err(|error| format!("The arXiv id is invalid: {error}"))?,
    )
    .map_err(|error| format!("The arXiv id is invalid: {error}"))?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("The PDF contents were not sent as binary data.".to_string()),
    };
    let cache_dir = paper_pdf_cache_dir(&app)?;
    run_blocking("Paper PDF cache write", move || {
        papers::cache_pdf(&cache_dir, &arxiv_id, &bytes)
    })
    .await
}

#[tauri::command]
async fn search_paper_library(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || papers::search_library(&root, &query))
        .await
        .map_err(|error| format!("Paper library search stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn read_paper(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    arxiv_id: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Paper read", move || papers::read_paper(&root, &arxiv_id)).await
}

#[tauri::command]
async fn read_paper_blog_local(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Paper overview read", move || {
        papers::read_paper_blog_local(&root, &arxiv_id)
    })
    .await
}

#[tauri::command]
async fn read_paper_blog(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    arxiv_id: String,
) -> Result<Option<String>, String> {
    // May reach the network (lazy backfill), so keep it off the main thread.
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || papers::read_paper_blog(&root, &arxiv_id))
        .await
        .map_err(|error| format!("The paper overview task stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn list_history(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<HistoryItem>, String> {
    let root = current_root(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || project::history(&root))
        .await
        .map_err(|error| format!("History scan stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn get_history_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    transaction_id: String,
) -> Result<TransactionRecord, String> {
    let root = current_root(&state, &window)?;
    run_blocking("History entry read", move || {
        project::get_history_entry(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn revert_transaction(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    transaction_id: String,
    project_root: Option<String>,
) -> Result<String, String> {
    let root = match project_root {
        Some(project_root) => scoped_root(&state, &window, &project_root)?,
        None => current_root(&state, &window)?,
    };
    run_blocking("History revert", move || {
        let record = project::revert(&root, &transaction_id)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn revert_history_file(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    transaction_id: String,
    path: String,
) -> Result<String, String> {
    let root = current_root(&state, &window)?;
    run_blocking("History file revert", move || {
        let record = project::revert_file(&root, &transaction_id, &path)?;
        Ok(record.id)
    })
    .await
}

#[tauri::command]
async fn delete_history_entry(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    transaction_id: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("History deletion", move || {
        project::delete_history(&root, &transaction_id)
    })
    .await
}

#[tauri::command]
async fn start_tex_install(
    mode: tex_setup::TexInstallMode,
    on_progress: tauri::ipc::Channel<tex_setup::TexInstallProgress>,
) -> Result<(), String> {
    run_blocking("TeX installer launch", move || {
        tex_setup::start_tex_install(mode, on_progress)
    })
    .await
}

#[tauri::command]
async fn start_tex_dependency_install(missing_file: String) -> Result<(), String> {
    run_blocking("TeX package installer launch", move || {
        tex_setup::start_tex_dependency_install(&missing_file)
    })
    .await
}

/// Keep native resize backing surfaces in sync with the web app theme.
#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_window::apply_window_background(&window, dark);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, dark);
        Ok(())
    }
}

/// Print the invoking native webview. Browser-hosted workspaces use the
/// visible browser's print API instead, because this command would target the
/// hidden bridge webview rather than the user's document.
#[tauri::command]
async fn print_webview(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        macos_window::print_webview(&window).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Native printing is not available on this platform.".to_string())
    }
}

#[tauri::command]
fn align_traffic_lights(
    window: tauri::WebviewWindow,
    center_from_top: f64,
) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        // The window that measured its own titlebar, not "main" — a second
        // window used to move the first window's buttons and never its own.
        Ok(macos_window::align_traffic_lights_to(
            &window,
            center_from_top,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, center_from_top);
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

fn show_desktop_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| format!("Could not show Lattice in the Dock: {error}"))?;

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window
            .show()
            .map_err(|error| format!("Could not show the Lattice window: {error}"))?;
        let _ = window.set_focus();
        return Ok(());
    }

    let builder =
        tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, tauri::WebviewUrl::default())
            .title("Lattice")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1222.0, 680.0)
            .background_color(tauri::window::Color(0xF7, 0xF7, 0xF6, 0xFF));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder
        .build()
        .map_err(|error| format!("Could not create the Lattice window: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        macos_window::install_traffic_light_alignment(&window);
        macos_window::apply_window_background(&window, false);
    }
    let _ = window.set_focus();
    Ok(())
}

fn shutdown_child_runtimes(app: &tauri::AppHandle) {
    app.state::<chromium::ChromiumRuntime>().shutdown();
    app.state::<synara::SynaraRuntime>().shutdown();
}

/// Finish an installed update without relying on an event-loop restart
/// request forwarded through the browser bridge. The direct main-thread path
/// is why this command cannot return on success: it replaces this process.
#[tauri::command]
fn restart_after_update(app: tauri::AppHandle) -> Result<(), String> {
    let restarting = app.clone();
    app.run_on_main_thread(move || {
        shutdown_child_runtimes(&restarting);
        restarting.restart();
    })
    .map_err(|error| format!("Could not schedule the updated Lattice app to restart: {error}"))
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
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(BROWSER_HOST_ARG)
                .build(),
        )
        // Remember the window's size + position across launches.
        // The browser bridge is deliberately hidden. The plugin's default
        // restore path shows every newly created dynamic window, even when its
        // builder says `visible(false)`, so bridge windows must stay outside
        // this lifecycle entirely.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| {
                    !label.starts_with("browser-") && label != browser_host::SERVICE_WINDOW_LABEL
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(is_focused) = event {
                macos_window::set_window_focused(window.label(), *is_focused);
            }
            // A closed window's project must stop being anyone's project, or
            // its LaTeX language server and Overleaf socket outlive the window
            // and a later window reusing the label inherits a stale binding.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                macos_window::clear_pdf_copy_text(window.label());
                let state = window.state::<AppState>();
                state.release_window(window.label());
                let browser = window.state::<browser_host::BrowserHost>();
                browser.activate_source(window.label(), &state);
                browser.hide_desktop_shell_if_browser_only(window.app_handle());
                state.retire_unused_projects();
            }
        })
        .setup(|app| {
            log::info!(target: "lattice::app", "Lattice {} starting", app.package_info().version);
            app.manage(AppState::from_environment());
            app.manage(browser_host::BrowserHost::default());
            app.manage(chromium::ChromiumRuntime::default());
            app.manage(synara::SynaraRuntime::new(app)?);
            let background = browser_host_launch();
            let chromium_packaged = !background
                && app
                    .state::<chromium::ChromiumRuntime>()
                    .is_packaged(app.handle());
            let browser_start = app
                .state::<browser_host::BrowserHost>()
                .start(app.handle(), chromium_packaged);
            let chromium_ready = chromium_packaged && browser_start.is_ok();
            if let Err(reason) = &browser_start {
                if background {
                    return Err(std::io::Error::other(reason.clone()).into());
                }
                // WK can operate without the optional loopback service. Do
                // not launch Chromium after a bind failure: it could attach to
                // whichever process owns the fixed port instead of this native
                // owner, so this exceptional launch falls back to WK instead.
                log::warn!(target: "lattice::browser", "{reason}");
            }
            let access_enabled = background || app.autolaunch().is_enabled().unwrap_or(false);
            if access_enabled || chromium_ready {
                app.state::<browser_host::BrowserHost>()
                    .keep_resident(app.handle())
                    .map_err(std::io::Error::other)?;
            }
            // After an update changed a tool pin, this rebuilds the uvx
            // environment now instead of during the user's first import.
            tauri::async_runtime::spawn_blocking(commands::prewarm_literature_tools);
            #[cfg(target_os = "macos")]
            {
                macos_window::clear_launch_quarantine();
                macos_window::install_magnify_monitor(app.handle().clone());
                macos_window::install_copy_shortcut_monitor(app.handle().clone());
            }
            if background || chromium_ready {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.destroy();
                }
                #[cfg(target_os = "macos")]
                app.handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
                if chromium_ready {
                    app.state::<chromium::ChromiumRuntime>()
                        .launch(app.handle())
                        .map_err(std::io::Error::other)?;
                }
            } else {
                show_desktop_window(app.handle()).map_err(std::io::Error::other)?;
                #[cfg(target_os = "macos")]
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    macos_window::install_traffic_light_alignment(&window);
                    macos_window::apply_window_background(&window, false);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restart_after_update,
            link_preview::link_preview,
            collab_credentials::put_collab_credential,
            collab_credentials::get_collab_credential,
            collab_credentials::delete_collab_credential,
            create_project,
            open_tutorial_project,
            get_app_log_dir,
            open_app_log_dir,
            open_in_browser,
            open_in_system_browser,
            return_to_desktop,
            browser_access_enabled,
            set_browser_access_enabled,
            browser_host::browser_dialog_open,
            browser_host::browser_dialog_save,
            create_collab_join_workspace,
            initial_project,
            open_project,
            open_project_window,
            take_pending_window_action,
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
            semantic_search_start_index,
            semantic_search_status,
            semantic_search_cancel,
            semantic_search_project,
            create_project_entry,
            delete_project_entry,
            rename_project_entry,
            move_project_entry,
            import_project_assets,
            import_project_files,
            import_project_sources,
            read_agent_composer_files,
            import_clipboard_image,
            macos_window::set_pdf_copy_text,
            resolve_citation_query,
            read_project_asset,
            write_project_bytes,
            prepare_latex_figure,
            build_project,
            abort_build,
            clean_project,
            run_doctor,
            harper_lint,
            watch_project,
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
            overleaf_publish_project,
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
            save_xlsx,
            synctex_edit,
            synctex_view,
            import_reference,
            fetch_paper,
            fetch_web_reference,
            upgrade_bibliography,
            remove_reference,
            list_papers,
            read_cached_paper_pdf,
            cache_paper_pdf,
            search_paper_library,
            read_paper,
            read_paper_blog,
            read_paper_blog_local,
            list_history,
            get_history_entry,
            revert_transaction,
            revert_history_file,
            delete_history_entry,
            start_tex_install,
            start_tex_dependency_install,
            set_window_background,
            print_webview,
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
            shutdown_child_runtimes(app_handle);
        }
        #[cfg(target_os = "macos")]
        if matches!(
            event,
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            }
        ) {
            let browser = app_handle.state::<browser_host::BrowserHost>();
            match browser.reopen_entry(app_handle) {
                Ok(true) => {}
                Ok(false) => {
                    let chromium = app_handle.state::<chromium::ChromiumRuntime>();
                    let opened = chromium
                        .open_url("http://127.0.0.1:18452/")
                        .unwrap_or_else(|reason| {
                            log::error!(target: "lattice::chromium", "could not reopen Lattice: {reason}");
                            false
                        });
                    if !opened {
                        if let Err(reason) = show_desktop_window(app_handle) {
                            log::error!(target: "lattice::app", "could not reopen Lattice: {reason}");
                        }
                    }
                }
                Err(reason) => {
                    log::error!(target: "lattice::browser", "could not reopen browser entry: {reason}");
                }
            }
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
