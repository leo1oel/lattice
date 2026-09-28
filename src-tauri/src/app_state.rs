//! Which project each window shows, and the resources an open project owns.

use crate::ipc::overleaf_realtime::OverleafRealtimeState;
use crate::{fs_watch, latex, semantic_search, texlab, MAIN_WINDOW_LABEL};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokio::sync::{OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard};

pub(crate) struct AppState {
    /// The project each window is looking at.
    ///
    /// There is deliberately no process-wide "current project": a command
    /// resolves against the project of the window that sent it, or window A's
    /// next file write would land in whichever project window B opened last.
    pub(crate) roots: Mutex<HashMap<String, PathBuf>>,
    /// Resources owned by an open project rather than by the process.
    projects: Mutex<HashMap<PathBuf, Arc<ProjectResources>>>,
    /// Process-wide backstop for Overleaf's ten-project-downloads-per-minute
    /// limit. Frontend instances also debounce, but Chromium reloads, multiple
    /// windows, and different projects still share the same account allowance.
    pub(crate) overleaf_sync_started: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    /// One-shot instruction left for a window that is being opened, taken by
    /// that window once during startup.
    ///
    /// Joining a share has to hand the new window something the project on
    /// disk cannot say: that it should connect to the room now. Routing it
    /// through here rather than shared storage means it cannot be read twice,
    /// cannot be picked up by the wrong window, and dies with the window.
    pending_actions: Mutex<HashMap<String, String>>,
    /// One import per window. The request id prevents a late Cancel click from
    /// stopping the next import after the UI has already moved on.
    pub(crate) paper_imports: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

/// State that belongs to one project, not the process: with two windows open,
/// one window's build would otherwise inherit the other's latexmk pid, one
/// window's LaTeX language server would be torn down by the other's file, and
/// connecting one window to Overleaf would cancel the other's connection.
#[derive(Default)]
pub(crate) struct ProjectResources {
    pub(crate) active_build: latex::ActiveBuild,
    pub(crate) texlab: Arc<Mutex<texlab::TexlabPool>>,
    /// Opt-in, on-device semantic index. The model never sees network I/O and
    /// the worker is cancelled when this project no longer belongs to a window.
    pub(crate) semantic_search: Arc<semantic_search::SemanticSearch>,
    /// Live connection to Overleaf's editing channel, when one is open.
    pub(crate) realtime: Arc<Mutex<OverleafRealtimeState>>,
    /// Serializes a whole ZIP sync against document join/leave and outgoing
    /// realtime mutations, closing the ownership-snapshot race.
    overleaf_sync_lease: Arc<tokio::sync::RwLock<()>>,
    /// Serializes project-wide create/delete/rename/move catalog mutations.
    structural_mutation: Arc<tokio::sync::Mutex<()>>,
    /// Filesystem watcher feeding `project-fs-changed` events. Dropped with the
    /// project's resources when the last window showing it closes.
    pub(crate) fs_watcher: Mutex<Option<fs_watch::ProjectWatcher>>,
}

/// How a command is serialized against the rest of its project's work.
#[derive(Clone, Copy)]
pub(crate) enum Lease {
    /// File writes and Overleaf traffic: they wait out a full sync, a document
    /// join or a project switch, but run beside each other.
    Shared,
    /// Full syncs, document joins and leaves, publishing, pausing, renames:
    /// nothing else that touches the project runs meanwhile.
    Exclusive,
}

/// Locks a command holds on the project it named until its work is done.
pub(crate) struct ProjectLease {
    pub(crate) project: Arc<ProjectResources>,
    _shared: Option<OwnedRwLockReadGuard<()>>,
    _exclusive: Option<OwnedRwLockWriteGuard<()>>,
    _structural: Option<OwnedMutexGuard<()>>,
}

impl AppState {
    pub(crate) fn from_environment() -> Self {
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
            projects: Mutex::default(),
            overleaf_sync_started: tokio::sync::Mutex::new(None),
            pending_actions: Mutex::default(),
            paper_imports: Mutex::default(),
        }
    }

    pub(crate) fn roots(&self) -> Result<MutexGuard<'_, HashMap<String, PathBuf>>, String> {
        self.roots.lock().map_err(|_| "Project state is unavailable.".to_string())
    }

    /// Resources of the project a request names, created on first use.
    ///
    /// Deliberately keyed by the project the *caller* named rather than by
    /// whatever the window currently shows: a command takes this project's
    /// lease first and only then checks the window still has it open, so a
    /// project switch racing the request is caught by that check instead of
    /// slipping between it and the work.
    pub(crate) fn project(&self, root: &Path) -> Arc<ProjectResources> {
        // The map holds only Arc handles, so a thread that panicked while
        // holding this lock cannot have left it half-written.
        let mut projects = self.projects.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(projects.entry(root.to_path_buf()).or_default())
    }

    /// Take the named project's Overleaf sync lease.
    pub(crate) async fn lease(&self, project_root: impl AsRef<Path>, lease: Lease) -> ProjectLease {
        ProjectLease::take(self.project(project_root.as_ref()), lease).await
    }

    /// The sync lease plus the lock serializing create/delete/rename/move, in
    /// the same order `set_root` takes them.
    pub(crate) async fn structural_lease(
        &self, project_root: impl AsRef<Path>, lease: Lease,
    ) -> ProjectLease {
        let mut held = self.lease(project_root, lease).await;
        held._structural = Some(Arc::clone(&held.project.structural_mutation).lock_owned().await);
        held
    }

    /// Forget projects no window has open, shutting down what they still hold.
    ///
    /// A mismatched request creates an entry before its project check fails, so
    /// without this the map would keep an entry for every path ever named.
    pub(crate) fn retire_unused_projects(&self) {
        let live: HashSet<PathBuf> = match self.roots.lock() {
            Ok(roots) => roots.values().cloned().collect(),
            Err(_) => return,
        };
        let mut projects = self.projects.lock().unwrap_or_else(PoisonError::into_inner);
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
            resources.shutdown_realtime();
            false
        });
    }

    /// Close every project's live channel.
    ///
    /// Only for signing out: the Overleaf session is shared by every window, so
    /// throwing it away has to take down the connections that authenticate with it,
    /// not just the one belonging to whichever window asked.
    pub(crate) fn shutdown_all_realtime(&self) {
        let projects: Vec<_> = self
            .projects
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for project in projects {
            project.shutdown_realtime();
        }
    }

    pub(crate) fn root_for(&self, label: &str) -> Result<Option<PathBuf>, String> {
        Ok(self.roots()?.get(label).cloned())
    }

    /// Bind a window to a project before it loads, so the window's own startup
    /// request already resolves against it.
    pub(crate) fn bind_window(&self, label: &str, root: PathBuf) -> Result<(), String> {
        self.roots()?.insert(label.to_string(), root);
        Ok(())
    }

    /// Drop a closed window's binding. Without this the map grows for the life
    /// of the process and a recycled label would inherit a stale project.
    pub(crate) fn release_window(&self, label: &str) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.remove(label);
        }
        // A window that closed before startup finished never took its
        // instruction; leaving it would hand it to whoever reuses the label.
        if let Ok(mut pending) = self.pending_actions.lock() {
            pending.remove(label);
        }
    }

    /// Release a window whose creation failed and drop what only it held.
    pub(crate) fn abandon_window(&self, label: &str) {
        self.release_window(label);
        self.retire_unused_projects();
    }

    pub(crate) fn set_pending_action(&self, label: &str, action: String) {
        if let Ok(mut pending) = self.pending_actions.lock() {
            pending.insert(label.to_string(), action);
        }
    }

    pub(crate) fn take_pending_action(&self, label: &str) -> Option<String> {
        self.pending_actions.lock().ok()?.remove(label)
    }

    /// The window currently showing `root`, if any.
    pub(crate) fn window_showing(&self, root: &Path) -> Option<String> {
        let roots = self.roots.lock().ok()?;
        roots.iter().find(|(_, open)| open.as_path() == root).map(|(label, _)| label.clone())
    }

    /// Point a window at another project.
    ///
    /// Everything torn down here is scoped to the project the window is
    /// leaving, so a switch in one window never disturbs another window's
    /// build, language server or Overleaf connection.
    pub(crate) async fn set_root(&self, label: &str, root: PathBuf) -> Result<(), String> {
        let Some(leaving) = self.root_for(label)? else {
            // Nothing open in this window yet: no in-flight work to wait for.
            return self.bind_window(label, root);
        };
        // A root switch must wait for a ZIP sync or a root-scoped Overleaf
        // mutation to finish. The UI invalidates its old generation immediately,
        // while this lease ensures the backend cannot reinterpret a request for A
        // against B halfway through it. Root-scoped structural commands take the
        // same locks in the same order: Overleaf lease, then catalog mutation.
        let lease = self.structural_lease(&leaving, Lease::Exclusive).await;
        let leaving = &lease.project;
        if let Ok(mut pool) = leaving.texlab.lock() {
            pool.reset();
        }
        // Hold the project root while invalidating realtime under the same lock
        // order used by connect. This makes "claim generation for A" and "switch
        // to B" mutually exclusive rather than two checks with a gap between.
        let mut roots = self.roots()?;
        let previous = leaving.realtime()?.cancel(None);
        roots.insert(label.to_string(), root);
        drop(roots);
        if let Some(previous) = previous {
            previous.shutdown();
        }
        self.retire_unused_projects();
        Ok(())
    }
}

impl ProjectLease {
    pub(crate) async fn take(project: Arc<ProjectResources>, lease: Lease) -> Self {
        let sync = Arc::clone(&project.overleaf_sync_lease);
        let (shared, exclusive) = match lease {
            Lease::Shared => (Some(sync.read_owned().await), None),
            Lease::Exclusive => (None, Some(sync.write_owned().await)),
        };
        Self { project, _shared: shared, _exclusive: exclusive, _structural: None }
    }
}

impl ProjectResources {
    pub(crate) fn realtime(&self) -> Result<MutexGuard<'_, OverleafRealtimeState>, String> {
        self.realtime.lock().map_err(|_| "The Overleaf connection is unavailable.".to_string())
    }

    /// Close the live channel if one is open. Safe to call when there is none.
    pub(crate) fn shutdown_realtime(&self) {
        let previous = self.realtime.lock().ok().and_then(|mut realtime| realtime.cancel(None));
        if let Some(previous) = previous {
            previous.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    #[test]
    fn each_window_keeps_its_own_project() {
        let state = AppState::from_environment();
        let (a, b) = (PathBuf::from("/project/a"), PathBuf::from("/project/b"));
        state.bind_window("main", a.clone()).unwrap();
        state.bind_window("project-1", b.clone()).unwrap();

        assert_eq!(state.root_for("main").unwrap(), Some(a));
        assert_eq!(state.root_for("project-1").unwrap(), Some(b.clone()));
        assert_eq!(state.root_for("project-2").unwrap(), None);
        // This is what makes "open in a new window" raise the existing window
        // instead of putting one project in two.
        assert_eq!(state.window_showing(&b).as_deref(), Some("project-1"));
        assert_eq!(state.window_showing(Path::new("/project/c")), None);
    }

    #[test]
    fn one_project_resources_are_shared_and_two_projects_are_not() {
        let state = AppState::from_environment();
        let a = Path::new("/project/a");
        let b = Path::new("/project/b");

        // A second window building project B must not be able to abort the
        // build project A already has running.
        assert!(Arc::ptr_eq(&state.project(a).active_build, &state.project(a).active_build));
        assert!(!Arc::ptr_eq(&state.project(a).active_build, &state.project(b).active_build));
    }

    #[test]
    fn closing_a_window_releases_its_project_and_retires_its_resources() {
        let state = AppState::from_environment();
        let (a, b, gone) = (Path::new("/project/a"), Path::new("/project/b"), "/project/gone");
        state.bind_window("project-1", a.to_path_buf()).unwrap();
        state.bind_window("project-2", b.to_path_buf()).unwrap();
        let kept = state.project(b);
        state.project(a);
        // A command takes the named project's lease before checking the window
        // still has it open, so a stale request creates an entry for a project
        // nobody has. The map must not keep it forever.
        state.project(Path::new(gone));

        state.release_window("project-1");
        state.retire_unused_projects();

        assert_eq!(state.root_for("project-1").unwrap(), None);
        for retired in [a, Path::new(gone)] {
            assert!(!state.projects.lock().unwrap().contains_key(retired), "{retired:?}");
        }
        // The surviving window keeps the very same resources, not a rebuilt set.
        assert!(Arc::ptr_eq(&state.project(b), &kept));
    }

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
        let state = AppState::from_environment();
        let root = PathBuf::from("/project/building");
        state.bind_window("project-1", root.clone()).unwrap();
        crate::latex::begin_for_test(&state.project(&root).active_build, child.id()).unwrap();

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
        let state = AppState::from_environment();
        state.set_pending_action("project-1", "join".to_string());
        state.set_pending_action("project-2", "join".to_string());

        assert_eq!(state.take_pending_action("project-1").as_deref(), Some("join"));
        // A reload of that window must not rejoin the room a second time, and
        // no other window may pick the instruction up.
        assert_eq!(state.take_pending_action("project-1"), None);
        assert_eq!(state.take_pending_action("project-3"), None);
        // A closed window's untaken instruction would otherwise be handed to
        // whichever window reuses the label.
        state.release_window("project-2");
        assert_eq!(state.take_pending_action("project-2"), None);
    }
}
