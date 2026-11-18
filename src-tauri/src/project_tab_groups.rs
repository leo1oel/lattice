//! Desktop project tabs survive app relaunch, using the same window labels
//! that the window-state plugin uses for geometry.

use crate::app_state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Manager, Runtime, State, Window};

const SESSION_FILE: &str = "project-tab-groups.json";
const VERSION: u32 = 1;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTab {
    root: PathBuf,
    name: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTabGroup {
    active_root: Option<PathBuf>,
    projects: Vec<ProjectTab>,
}

#[derive(Serialize, Deserialize)]
struct Session {
    version: u32,
    groups: BTreeMap<String, ProjectTabGroup>,
}

impl Default for Session {
    fn default() -> Self {
        Self { version: VERSION, groups: BTreeMap::new() }
    }
}

impl Session {
    fn read(path: &Path) -> io::Result<Option<Self>> {
        match fs::read(path) {
            Ok(bytes) => {
                let session: Self = serde_json::from_slice(&bytes)?;
                if session.version != VERSION {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        "Unknown project tab session version",
                    ));
                }
                Ok(Some(session))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, serde_json::to_vec(self)?)?;
        fs::rename(temporary, path)
    }

    fn prune(&mut self, mut workspace_root: impl FnMut(&Path) -> Option<PathBuf>) {
        self.groups.retain(|label, group| {
            if !crate::is_workspace_window(label) {
                return false;
            }
            let active = group.active_root.as_deref().and_then(&mut workspace_root);
            let mut roots = HashSet::new();
            group.projects.retain_mut(|project| {
                let Some(root) = workspace_root(&project.root) else { return false };
                if !roots.insert(root.clone()) {
                    return false;
                }
                project.root = root;
                true
            });
            group.active_root = active.filter(|root| roots.contains(root));
            !group.projects.is_empty()
        });
        // Reserve saved selections first. A window that loses its selection
        // may choose a dormant tab but must not take another saved selection.
        let mut active = HashSet::new();
        for group in self.groups.values_mut() {
            if let Some(root) = group.active_root.take() {
                if active.insert(root.clone()) {
                    group.active_root = Some(root);
                }
            }
        }
        self.groups.retain(|_, group| {
            if group.active_root.is_none() {
                let Some(next) = group.projects.iter().find(|tab| active.insert(tab.root.clone()))
                else {
                    return false;
                };
                group.active_root = Some(next.root.clone());
            }
            true
        });
    }
}

#[derive(Default)]
struct StateOnDisk {
    session: Session,
    /// A writer explicitly closed the last window. A fresh session can use
    /// the recent-project fallback; an explicitly empty one starts on Welcome.
    explicitly_empty: bool,
    /// An explicit close that has passed the save-before-close gate. App
    /// shutdown also destroys windows, but keeps their entries for relaunch.
    closing: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct ProjectTabGroups {
    path: Option<PathBuf>,
    state: Mutex<StateOnDisk>,
}

impl ProjectTabGroups {
    pub fn load(app_data: &Path) -> Self {
        let path = app_data.join(SESSION_FILE);
        let saved = Session::read(&path).unwrap_or_else(|error| {
            log::warn!(target: "lattice::app", "Could not read the project tabs from last launch: {error}");
            None
        });
        let explicitly_empty = saved.as_ref().is_some_and(|session| session.groups.is_empty());
        let mut session = saved.unwrap_or_default();
        session.prune(|path| {
            if !path.is_absolute() {
                return None;
            }
            crate::project::folder_root(path).ok()
        });
        Self {
            path: Some(path),
            state: Mutex::new(StateOnDisk { session, explicitly_empty, ..Default::default() }),
        }
    }

    fn with<T>(&self, work: impl FnOnce(&mut StateOnDisk) -> T) -> T {
        work(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    fn write(&self, session: &Session) {
        if let Some(path) = &self.path {
            if let Err(error) = session.write(path) {
                log::warn!(target: "lattice::app", "Could not save the project tabs: {error}");
            }
        }
    }

    pub fn roots(&self) -> Vec<(String, PathBuf)> {
        self.with(|state| {
            state
                .session
                .groups
                .iter()
                .filter_map(|(label, group)| {
                    group.active_root.as_ref().map(|root| (label.clone(), root.clone()))
                })
                .collect()
        })
    }

    fn group(&self, label: &str) -> Option<ProjectTabGroup> {
        self.with(|state| {
            state.session.groups.get(label).cloned().or_else(|| {
                state
                    .explicitly_empty
                    .then(|| ProjectTabGroup { active_root: None, projects: Vec::new() })
            })
        })
    }

    fn record(&self, label: &str, group: ProjectTabGroup) {
        if self.path.is_none() {
            return;
        }
        self.with(|state| {
            if state.closing.contains(label) || state.session.groups.get(label) == Some(&group) {
                return;
            }
            state.explicitly_empty = false;
            state.session.groups.insert(label.to_owned(), group);
            self.write(&state.session);
        });
    }

    /// Commit the membership change on the host before either page can quit
    /// or try to open its next tab. The pages still publish their final state.
    pub fn transfer(
        &self, source: &str, destination: Option<&str>, root: &Path, name: &str,
        before: Option<&Path>,
    ) {
        if self.path.is_none() {
            return;
        }
        self.with(|state| {
            let groups = &mut state.session.groups;
            if let Some(group) = groups.get_mut(source) {
                if let Some(index) = group.projects.iter().position(|tab| tab.root == root) {
                    group.projects.remove(index);
                    if group.active_root.as_deref() == Some(root) {
                        group.active_root = group
                            .projects
                            .get(index)
                            .or_else(|| {
                                index.checked_sub(1).and_then(|index| group.projects.get(index))
                            })
                            .map(|tab| tab.root.clone());
                    }
                    if group.projects.is_empty() {
                        groups.remove(source);
                    }
                }
            }
            if let Some(destination) = destination {
                let group = groups
                    .entry(destination.to_owned())
                    .or_insert_with(|| ProjectTabGroup { active_root: None, projects: Vec::new() });
                let tab = ProjectTab { root: root.to_path_buf(), name: name.to_owned() };
                match group.projects.iter().position(|tab| tab.root == root) {
                    Some(index) if before == Some(root) => group.projects[index] = tab,
                    existing => {
                        if let Some(index) = existing {
                            group.projects.remove(index);
                        }
                        let index = before
                            .and_then(|before| {
                                group.projects.iter().position(|tab| tab.root == before)
                            })
                            .unwrap_or(group.projects.len());
                        group.projects.insert(index, tab);
                    }
                }
                group.active_root = Some(root.to_path_buf());
            }
            state.explicitly_empty = groups.is_empty();
            self.write(&state.session);
        });
    }

    fn closing(&self, label: &str) {
        self.with(|state| state.closing.insert(label.to_owned()));
    }

    pub fn destroyed(&self, label: &str) {
        self.with(|state| {
            if state.closing.remove(label) && state.session.groups.remove(label).is_some() {
                state.explicitly_empty = state.session.groups.is_empty();
                self.write(&state.session);
            }
        });
    }
}

/// Bind all restored selections before creating their webviews. A page's
/// initial-project request can then only open the root assigned to its label.
pub(crate) fn restore_windows(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let roots = app.state::<ProjectTabGroups>().roots();
    if roots.is_empty() {
        return false;
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log::warn!(target: "lattice::app", "Could not show Lattice in the Dock: {error}");
        return false;
    }
    for (label, root) in &roots {
        if state.bind_window(label, root.clone()).is_err() {
            return false;
        }
    }
    let mut first = None;
    for (label, _) in roots {
        match crate::workspace_window(app, &label, label == crate::MAIN_WINDOW_LABEL) {
            Ok(window) => {
                first.get_or_insert(window);
            }
            Err(error) => {
                state.abandon_window(&label);
                log::warn!(target: "lattice::app", "Could not reopen Lattice workspace {label}: {error}");
            }
        }
    }
    if let Some(window) = first {
        let _ = window.set_focus();
        true
    } else {
        false
    }
}

pub(crate) fn note_close<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if crate::is_workspace_window(label) {
        if let Some(groups) = app.try_state::<ProjectTabGroups>() {
            groups.closing(label);
        }
    }
}

#[tauri::command]
pub(crate) fn load_project_tab_group(
    window: Window, groups: State<'_, ProjectTabGroups>,
) -> Option<ProjectTabGroup> {
    crate::is_workspace_window(window.label()).then(|| groups.group(window.label())).flatten()
}

#[tauri::command]
pub(crate) async fn save_project_tab_group(
    window: Window, app: State<'_, AppState>, groups: State<'_, ProjectTabGroups>,
    group: ProjectTabGroup,
) -> Result<(), String> {
    if !crate::is_workspace_window(window.label()) {
        return Ok(());
    }
    // An earlier selection may reach the host after a later switch or while
    // the source of a transferred tab has no active binding. Keep newer state.
    let roots = app.roots()?;
    if group.active_root.as_ref().is_some_and(|active| {
        roots.get(window.label()) == Some(active)
            && group.projects.iter().any(|tab| tab.root == *active)
    }) {
        groups.record(window.label(), group);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn project(parent: &TempDir, name: &str) -> PathBuf {
        let root = parent.join(name);
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn group(active: &Path, projects: &[&Path]) -> ProjectTabGroup {
        ProjectTabGroup {
            active_root: Some(active.to_path_buf()),
            projects: projects
                .iter()
                .map(|root| ProjectTab {
                    root: root.to_path_buf(),
                    name: root.file_name().unwrap().to_string_lossy().into_owned(),
                })
                .collect(),
        }
    }

    #[test]
    fn quit_keeps_each_window_and_deliberate_close_removes_it() {
        let path = TempDir::new("project-tab-session");
        let a = project(&path, "a");
        let b = project(&path, "b");
        let c = project(&path, "c");
        let groups = ProjectTabGroups::load(path.as_ref());
        assert!(groups.group("main").is_none(), "a fresh app can reopen the most recent folder");
        groups.record("main", group(&b, &[&a, &b]));
        groups.record("project-2", group(&c, &[&c]));
        groups.destroyed("main");
        groups.destroyed("project-2");

        let groups = ProjectTabGroups::load(path.as_ref());
        assert_eq!(groups.roots(), [("main".into(), b.clone()), ("project-2".into(), c.clone())]);
        assert!(groups.group("main") == Some(group(&b, &[&a, &b])));
        groups.closing("project-2");
        groups.destroyed("project-2");
        assert_eq!(ProjectTabGroups::load(path.as_ref()).roots(), [("main".into(), b.clone())]);
        groups.closing("main");
        groups.destroyed("main");
        let empty = ProjectTabGroups::load(path.as_ref());
        assert!(empty.roots().is_empty());
        assert!(empty.group("main").is_some_and(|group| group.active_root.is_none()));
    }

    #[test]
    fn missing_tabs_fall_back_without_stealing_another_windows_active_root() {
        let path = TempDir::new("project-tab-missing");
        let a = project(&path, "a");
        let b = project(&path, "b");
        let c = project(&path, "c");
        let missing = path.join("disconnected-drive");
        let groups = ProjectTabGroups::load(path.as_ref());
        groups.record("main", group(&missing, &[&missing, &c, &a]));
        groups.record("project-2", group(&c, &[&c, &b]));
        groups.record("project-3", group(&missing, &[&missing]));

        let restored = ProjectTabGroups::load(path.as_ref());
        assert_eq!(restored.roots(), [("main".into(), a.clone()), ("project-2".into(), c.clone())]);
        assert!(restored.group("main") == Some(group(&a, &[&c, &a])));
        assert!(restored.group("project-2") == Some(group(&c, &[&c, &b])));
        assert!(restored.group("project-3").is_none());
    }

    #[test]
    fn a_completed_transfer_recovers_both_windows_before_the_pages_acknowledge() {
        let path = TempDir::new("project-tab-transfer");
        let a = project(&path, "a");
        let b = project(&path, "b");
        let c = project(&path, "c");
        let d = project(&path, "d");
        let groups = ProjectTabGroups::load(path.as_ref());
        groups.record("main", group(&a, &[&a, &b]));
        groups.record("project-1", group(&d, &[&c, &d]));
        groups.transfer("main", Some("project-1"), &a, "a", Some(&d));

        let restored = ProjectTabGroups::load(path.as_ref());
        assert!(restored.group("main") == Some(group(&b, &[&b])));
        assert!(restored.group("project-1") == Some(group(&a, &[&c, &a, &d])));
        restored.transfer("main", Some("project-1"), &b, "b", None);
        let restored_again = ProjectTabGroups::load(path.as_ref());
        assert!(restored_again.group("main").is_none());
        assert!(restored_again.group("project-1") == Some(group(&b, &[&c, &a, &d, &b])));
    }

    #[test]
    fn a_destination_destroyed_during_transfer_is_not_recreated() {
        let path = TempDir::new("project-tab-transfer-close");
        let a = project(&path, "a");
        let b = project(&path, "b");
        let c = project(&path, "c");
        let groups = ProjectTabGroups::load(path.as_ref());
        groups.record("main", group(&a, &[&a, &b]));
        groups.record("project-1", group(&c, &[&c]));
        groups.closing("project-1");
        groups.destroyed("project-1");
        groups.transfer("main", None, &a, "a", None);

        let restored = ProjectTabGroups::load(path.as_ref());
        assert!(restored.group("main") == Some(group(&b, &[&b])));
        assert!(restored.group("project-1").is_none());
    }
}
