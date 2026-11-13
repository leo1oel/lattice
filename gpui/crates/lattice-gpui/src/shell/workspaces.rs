//! The writer's named workspaces, shared by every project and window, and
//! each project's own saved layout (`src/trellis/trellis-workspaces.ts`).
//!
//! A workspace is a saved arrangement: only "+", Save to workspace,
//! Duplicate and Rename write one. Entering it loads that arrangement into
//! the project, whose layout is its own from then on and shows a dot while
//! it differs from the workspace. Each project remembers the workspace it
//! was last in, its layout (with the preset it was left in, if any), and
//! where its documents stood in each workspace it visited.
//!
//! Both live as JSON in the app's state directory: `workspaces.json`, and
//! `layouts/<hash of the project's path>.json`. `LATTICE_GPUI_STATE_DIR`
//! moves the directory; set empty it keeps everything in memory, as a
//! scripted run does unless it names a directory, so a run never reads or
//! changes the writer's own layouts.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use gpui::{App, Global};
use serde::{Deserialize, Serialize};

use trellis::model::LayoutDocument;

use super::trellis_layout::{ActiveFocus, ActivePreset, DocumentPlaces, LAYOUT_VERSION};

/// Long enough for a word or two, short enough for a titlebar tab.
pub const NAME_MAX: usize = 24;
/// Workspaces with a shortcut (⌘1 to ⌘9).
pub const WITH_SHORTCUT: usize = 9;
const DEFAULT_NAME: &str = "Workspace";
/// v2: arrangements are Trellis documents. A v1 library's arrangements
/// (GPUI Kit's dock) are dropped on reading, its names and ids kept.
const LIBRARY_VERSION: u32 = 2;

/// `name` with a default name put as `base`, keeping its number; any other
/// name as it is. The default name and "+"'s numbered ones ("Workspace 2"…)
/// are stored in English and shown in the interface language, so they
/// follow a change of language while a name the writer gave stays as given;
/// the Tauri app's Chinese default names ("工作区", the former "布局") read
/// as the default too (`asDefault` in `src/trellis/trellis-workspaces.ts`).
fn as_default(name: &str, base: &str) -> String {
    let number = [DEFAULT_NAME, "工作区", "布局"]
        .iter()
        .find_map(|default| name.strip_prefix(default));
    match number {
        Some("") => base.to_string(),
        Some(rest) => match rest.strip_prefix(' ') {
            Some(digits)
                if !digits.starts_with('0')
                    && digits.parse::<u64>().is_ok_and(|n| n >= 2)
                    && digits.bytes().all(|b| b.is_ascii_digit()) =>
            {
                format!("{base} {digits}")
            }
            _ => name.to_string(),
        },
        None => name.to_string(),
    }
}

/// A workspace's name as the titlebar, the Panels menu and the palette show
/// it.
pub fn shown_name(name: &str) -> String {
    as_default(name, lattice_i18n::t!("Workspace"))
}

/// A workspace's name as the library keeps it.
fn stored_name(name: &str) -> String {
    as_default(name, DEFAULT_NAME)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// `None` until the workspace is first used: the default layout.
    pub arrangement: Option<LayoutDocument>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Library {
    version: u32,
    workspaces: Vec<Workspace>,
    #[serde(default)]
    recent: Option<String>,
    /// The number the next workspace's id takes, kept so a deleted
    /// workspace's id is never handed out again.
    #[serde(default)]
    next_id: u64,
    /// Whether focus mode shows the PDF beside the documents: the writer's
    /// last choice, in every project (`loadFocusPdf`).
    #[serde(default)]
    focus_pdf: bool,
}

/// A workspace as a v1 library saved it: its arrangement unreadable now.
#[derive(Deserialize)]
struct LegacyWorkspace {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct LegacyLibrary {
    version: u32,
    workspaces: Vec<LegacyWorkspace>,
    #[serde(default)]
    recent: Option<String>,
    #[serde(default)]
    next_id: u64,
}

/// What a project remembers about its layout.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectLayout {
    #[serde(default)]
    pub version: u32,
    /// The project's path, for whoever reads the file.
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// The layout on screen when the project was left.
    #[serde(default)]
    pub document: Option<LayoutDocument>,
    /// The preset it was left in, over the writer's own layout.
    #[serde(default)]
    pub preset: Option<ActivePreset>,
    /// Focus mode, when it was left in it.
    #[serde(default)]
    pub focus: Option<ActiveFocus>,
    /// Where each document sat in each workspace, by workspace id.
    #[serde(default)]
    pub places: BTreeMap<String, DocumentPlaces>,
}

/// Why a rename was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameError {
    Empty,
    Taken,
}

/// A deleted workspace, and where it stood, for Undo.
#[derive(Clone, Debug)]
pub struct Removed {
    pub workspace: Workspace,
    pub index: usize,
}

/// The library and the projects' layouts, for the whole app.
pub struct Workspaces {
    dir: Option<PathBuf>,
    library: Library,
    projects: BTreeMap<PathBuf, ProjectLayout>,
}

impl Global for Workspaces {}

impl Workspaces {
    /// Load the library from the state directory, once per app.
    pub fn init(scripted: bool, cx: &mut App) {
        cx.set_global(Workspaces::load(state_dir(scripted)));
    }

    pub fn global(cx: &App) -> &Workspaces {
        cx.global::<Workspaces>()
    }

    pub fn update<R>(cx: &mut App, f: impl FnOnce(&mut Workspaces) -> R) -> R {
        let result = f(cx.global_mut::<Workspaces>());
        cx.global::<Workspaces>().persist_library();
        result
    }

    pub fn load(dir: Option<PathBuf>) -> Workspaces {
        let mut library = dir
            .as_ref()
            .and_then(|dir| {
                let path = dir.join("workspaces.json");
                legacy_library(&path).or_else(|| {
                    read_json(&path, |library: &Library| {
                        library.version == LIBRARY_VERSION && !library.workspaces.is_empty()
                    })
                })
            })
            .unwrap_or_else(|| Library {
                version: LIBRARY_VERSION,
                workspaces: vec![Workspace {
                    id: "ws-1".into(),
                    name: DEFAULT_NAME.into(),
                    arrangement: None,
                }],
                recent: None,
                next_id: 0,
                focus_pdf: false,
            });
        let in_use = library
            .workspaces
            .iter()
            .filter_map(|workspace| workspace.id.strip_prefix("ws-")?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        library.next_id = library.next_id.max(in_use + 1);
        for workspace in &mut library.workspaces {
            workspace.name = stored_name(&workspace.name);
        }
        Workspaces {
            dir,
            library,
            projects: BTreeMap::new(),
        }
    }

    fn persist_library(&self) {
        let Some(dir) = &self.dir else {
            return;
        };
        if let Err(error) = write_json(&dir.join("workspaces.json"), &self.library) {
            log::warn!("could not save the workspaces: {error:#}");
        }
    }

    /// The workspaces, in the writer's order.
    pub fn list(&self) -> &[Workspace] {
        &self.library.workspaces
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.library.workspaces.iter().find(|entry| entry.id == id)
    }

    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.library
            .workspaces
            .iter()
            .position(|entry| entry.id == id)
    }

    /// The workspace last entered in any project, where a project without
    /// one of its own starts.
    pub fn recent(&self) -> String {
        self.library
            .recent
            .as_ref()
            .filter(|id| self.get(id).is_some())
            .cloned()
            .unwrap_or_else(|| self.library.workspaces[0].id.clone())
    }

    pub fn note_used(&mut self, id: &str) {
        if self.get(id).is_some() {
            self.library.recent = Some(id.to_string());
        }
    }

    /// The workspace's arrangement from now on; false when it is gone.
    pub fn set_arrangement(&mut self, id: &str, arrangement: LayoutDocument) -> bool {
        match self
            .library
            .workspaces
            .iter_mut()
            .find(|entry| entry.id == id)
        {
            Some(entry) => {
                entry.arrangement = Some(arrangement);
                true
            }
            None => false,
        }
    }

    /// Whether `name` is free: no other workspace has it, ignoring case.
    pub fn name_free(&self, name: &str, except: Option<&str>) -> bool {
        let name = stored_name(name.trim()).to_lowercase();
        !self
            .library
            .workspaces
            .iter()
            .any(|entry| Some(entry.id.as_str()) != except && entry.name.to_lowercase() == name)
    }

    /// `base`, or the first of "base 2", "base 3"… that no workspace has.
    pub fn unique_name(&self, base: &str) -> String {
        let base = clip(base.trim());
        let base = if base.is_empty() {
            DEFAULT_NAME.to_string()
        } else {
            stored_name(&base)
        };
        if self.name_free(&base, None) {
            return base;
        }
        (2..)
            .map(|count| {
                let suffix = format!(" {count}");
                let room = NAME_MAX.saturating_sub(suffix.chars().count());
                format!("{}{suffix}", clip_to(&base, room).trim_end())
            })
            .find(|name| self.name_free(name, None))
            .unwrap_or(base)
    }

    fn new_id(&mut self) -> String {
        loop {
            let id = format!("ws-{}", self.library.next_id);
            self.library.next_id += 1;
            if self.get(&id).is_none() {
                return id;
            }
        }
    }

    /// Add a workspace with a free name after `after` (else last).
    pub fn add(
        &mut self,
        name: &str,
        arrangement: Option<LayoutDocument>,
        after: Option<&str>,
    ) -> String {
        let id = self.new_id();
        let name = self.unique_name(name);
        let at = after
            .and_then(|after| self.index_of(after))
            .map(|ix| ix + 1)
            .unwrap_or(self.library.workspaces.len());
        self.library.workspaces.insert(
            at,
            Workspace {
                id: id.clone(),
                name,
                arrangement,
            },
        );
        id
    }

    /// A copy of `id` right after it, named "<name> copy".
    pub fn duplicate(&mut self, id: &str) -> Option<String> {
        let source = self.get(id)?.clone();
        Some(self.add(
            &lattice_i18n::t!("{name} copy", name = shown_name(&source.name)),
            source.arrangement,
            Some(id),
        ))
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), RenameError> {
        let name = stored_name(&clip(name.trim()));
        if name.is_empty() {
            return Err(RenameError::Empty);
        }
        if !self.name_free(&name, Some(id)) {
            return Err(RenameError::Taken);
        }
        if let Some(entry) = self.library.workspaces.iter_mut().find(|e| e.id == id) {
            entry.name = name;
        }
        Ok(())
    }

    /// Move `id` to position `index`.
    pub fn move_to(&mut self, id: &str, index: usize) {
        let Some(from) = self.index_of(id) else {
            return;
        };
        let to = index.min(self.library.workspaces.len() - 1);
        if from != to {
            let entry = self.library.workspaces.remove(from);
            self.library.workspaces.insert(to, entry);
        }
    }

    /// Remove `id`, never the last one.
    pub fn remove(&mut self, id: &str) -> Option<Removed> {
        if self.library.workspaces.len() < 2 {
            return None;
        }
        let index = self.index_of(id)?;
        let workspace = self.library.workspaces.remove(index);
        Some(Removed { workspace, index })
    }

    /// Put a removed workspace back where it was, its name made free again.
    pub fn restore(&mut self, removed: Removed) {
        if self.get(&removed.workspace.id).is_some() {
            return;
        }
        let mut workspace = removed.workspace;
        workspace.name = self.unique_name(&workspace.name);
        let at = removed.index.min(self.library.workspaces.len());
        self.library.workspaces.insert(at, workspace);
    }

    /// Whether focus mode shows the PDF beside the documents.
    pub fn focus_pdf(&self) -> bool {
        self.library.focus_pdf
    }

    pub fn set_focus_pdf(&mut self, pdf: bool) {
        self.library.focus_pdf = pdf;
    }

    /// What `root` remembers, as saved.
    pub fn project(&mut self, root: &Path) -> ProjectLayout {
        if let Some(layout) = self.projects.get(root) {
            return layout.clone();
        }
        let layout = self
            .dir
            .as_ref()
            .and_then(|dir| {
                let path = project_file(dir, root);
                // A layout from before Trellis documents (v1) keeps only its
                // workspace, and starts again from that workspace's own
                // arrangement; the next save replaces it.
                if read_version(&path) == Some(1) {
                    return legacy_project(&path);
                }
                read_json(&path, |layout: &ProjectLayout| {
                    layout.version == LAYOUT_VERSION
                })
            })
            .unwrap_or_default();
        self.projects.insert(root.to_path_buf(), layout.clone());
        layout
    }

    pub fn save_project(&mut self, root: &Path, mut layout: ProjectLayout) {
        layout.version = LAYOUT_VERSION;
        layout.root = root.to_string_lossy().into_owned();
        if self.projects.get(root) == Some(&layout) {
            return;
        }
        if let Some(dir) = &self.dir
            && let Err(error) = write_json(&project_file(dir, root), &layout)
        {
            log::warn!("could not save the layout of {}: {error:#}", root.display());
        }
        self.projects.insert(root.to_path_buf(), layout);
    }
}

/// ⌘1 to ⌘9 for the first nine workspaces.
pub fn shortcut_label(index: usize) -> Option<String> {
    (index < WITH_SHORTCUT).then(|| format!("{}{}", crate::shell::commands::MOD_LABEL, index + 1))
}

fn clip(name: &str) -> String {
    clip_to(name, NAME_MAX)
}

fn clip_to(name: &str, chars: usize) -> String {
    name.chars().take(chars).collect()
}

/// The state directory, or none for a run that keeps everything in memory.
pub(crate) fn state_dir(scripted: bool) -> Option<PathBuf> {
    match std::env::var_os("LATTICE_GPUI_STATE_DIR") {
        Some(dir) if dir.is_empty() => None,
        Some(dir) => Some(PathBuf::from(dir)),
        None if scripted => None,
        None => dirs::data_dir().map(|dir| dir.join("lattice-gpui")),
    }
}

/// A project's file: named by a hash of its path, which is stable across
/// runs (FNV-1a), so no path's characters reach the file name.
fn project_file(dir: &Path, root: &Path) -> PathBuf {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in root.to_string_lossy().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    dir.join("layouts").join(format!("{hash:016x}.json"))
}

/// The `version` a JSON file at `path` names, if it reads.
fn read_version(path: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("version")?
        .as_u64()
}

/// A v1 library (GPUI Kit's arrangements) as a v2 one: the workspaces'
/// names, ids and order kept, each arrangement left to the default.
fn legacy_library(path: &Path) -> Option<Library> {
    if read_version(path) != Some(1) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let legacy: LegacyLibrary = serde_json::from_str(&text).ok()?;
    (legacy.version == 1 && !legacy.workspaces.is_empty()).then(|| Library {
        version: LIBRARY_VERSION,
        workspaces: legacy
            .workspaces
            .into_iter()
            .map(|entry| Workspace {
                id: entry.id,
                name: entry.name,
                arrangement: None,
            })
            .collect(),
        recent: legacy.recent,
        next_id: legacy.next_id,
        focus_pdf: false,
    })
}

/// A v1 project layout (GPUI Kit's arrangement) as a v2 one: its workspace
/// kept, the rest left to the default.
fn legacy_project(path: &Path) -> Option<ProjectLayout> {
    let text = std::fs::read_to_string(path).ok()?;
    let legacy: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(ProjectLayout {
        version: LAYOUT_VERSION,
        workspace: legacy
            .get("workspace")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        ..ProjectLayout::default()
    })
}

/// The value saved at `path`. A file this build cannot read (`usable`
/// refuses it, or it does not parse) is moved aside to `<name>.unreadable`
/// before the caller falls back, so the next save does not overwrite it.
fn read_json<T: serde::de::DeserializeOwned>(
    path: &Path,
    usable: impl Fn(&T) -> bool,
) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<T>(&text) {
        Ok(value) if usable(&value) => return Some(value),
        Ok(_) => log::warn!("{} is from another version of Lattice", path.display()),
        Err(error) => log::warn!("{} does not parse: {error}", path.display()),
    }
    let aside = path.with_extension("json.unreadable");
    match std::fs::rename(path, &aside) {
        Ok(()) => log::warn!("moved it aside to {}", aside.display()),
        Err(error) => log::warn!("could not move {} aside: {error}", path.display()),
    }
    None
}

/// Written whole beside the target, then moved over it, so a crash mid-write
/// leaves the old file.
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_name_in_another_language_is_the_stored_default() {
        let mut workspaces = Workspaces::load(None);
        let second = workspaces.add("", None, None);
        assert_eq!(workspaces.get(&second).unwrap().name, "Workspace 2");
        assert_eq!(
            workspaces.rename(&second, "工作区"),
            Err(RenameError::Taken)
        );
        assert_eq!(workspaces.rename(&second, "工作区 2"), Ok(()));
        assert_eq!(workspaces.get(&second).unwrap().name, "Workspace 2");
        assert_eq!(workspaces.unique_name("布局"), "Workspace 3");
    }

    fn library() -> Workspaces {
        Workspaces::load(None)
    }

    #[test]
    fn a_new_library_has_one_default_workspace() {
        let library = library();
        assert_eq!(library.list().len(), 1);
        assert_eq!(library.list()[0].name, "Workspace");
        assert_eq!(library.recent(), library.list()[0].id);
    }

    #[test]
    fn plus_numbers_the_default_name() {
        let mut library = library();
        let second = library.add("Workspace", None, None);
        let third = library.add("workspace", None, None);
        assert_eq!(library.get(&second).unwrap().name, "Workspace 2");
        // A name the writer typed keeps its case; it is free only when no
        // other has it in any case.
        assert_eq!(library.get(&third).unwrap().name, "workspace 3");
    }

    #[test]
    fn a_name_is_free_ignoring_case_and_never_empty() {
        let mut library = library();
        let id = library.add("Reading", None, None);
        let first = library.list()[0].id.clone();
        assert_eq!(
            library.rename(&first, "  reading "),
            Err(RenameError::Taken)
        );
        assert_eq!(library.rename(&first, "   "), Err(RenameError::Empty));
        assert_eq!(library.rename(&id, "READING"), Ok(()));
        assert_eq!(library.get(&id).unwrap().name, "READING");
    }

    #[test]
    fn names_are_clipped_to_fit_a_titlebar_tab() {
        let mut library = library();
        let id = library.add(&"x".repeat(40), None, None);
        assert_eq!(library.get(&id).unwrap().name.chars().count(), NAME_MAX);
        let again = library.add(&"x".repeat(40), None, None);
        let name = &library.get(&again).unwrap().name;
        assert_eq!(name.chars().count(), NAME_MAX);
        assert!(name.ends_with(" 2"));
    }

    #[test]
    fn the_last_workspace_stays_and_a_deleted_one_comes_back() {
        let mut library = library();
        let first = library.list()[0].id.clone();
        assert!(library.remove(&first).is_none());
        let second = library.add("Writing", None, None);
        let removed = library.remove(&first).unwrap();
        assert_eq!(library.list().len(), 1);
        library.restore(removed);
        assert_eq!(library.list()[0].id, first);
        assert_eq!(library.list()[1].id, second);
    }

    #[test]
    fn duplicate_lands_after_its_source_and_moves_reorder() {
        let mut library = library();
        let first = library.list()[0].id.clone();
        library.add("Other", None, None);
        let copy = library.duplicate(&first).unwrap();
        assert_eq!(library.index_of(&copy), Some(1));
        assert_eq!(library.get(&copy).unwrap().name, "Workspace copy");
        library.move_to(&copy, 9);
        assert_eq!(library.index_of(&copy), Some(2));
    }

    #[test]
    fn layouts_persist_in_the_state_directory() {
        let dir = std::env::temp_dir().join(format!("lattice-gpui-ws-test-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let root = PathBuf::from("/projects/paper");
        {
            let mut library = Workspaces::load(Some(dir.clone()));
            let id = library.add("Writing", None, None);
            library.persist_library();
            library.save_project(
                &root,
                ProjectLayout {
                    workspace: Some(id),
                    ..ProjectLayout::default()
                },
            );
        }
        let mut library = Workspaces::load(Some(dir.clone()));
        assert_eq!(library.list()[1].name, "Writing");
        assert_eq!(
            library.project(&root).workspace.as_deref(),
            Some(library.list()[1].id.as_str())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_files_are_kept_aside_instead_of_overwritten() {
        let dir = std::env::temp_dir().join(format!(
            "lattice-gpui-ws-unreadable-test-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("layouts")).unwrap();
        let root = PathBuf::from("/projects/paper");
        let library_text = r#"{"version": 1, "workspaces": [{"id": "ws-1", "#;
        let layout_text = r#"{"version": 99, "workspace": "ws-1"}"#;
        std::fs::write(dir.join("workspaces.json"), library_text).unwrap();
        std::fs::write(project_file(&dir, &root), layout_text).unwrap();
        let mut library = Workspaces::load(Some(dir.clone()));
        assert_eq!(library.list().len(), 1);
        library.persist_library();
        assert_eq!(library.project(&root), ProjectLayout::default());
        library.save_project(&root, ProjectLayout::default());
        let library_aside = std::fs::read_to_string(dir.join("workspaces.json.unreadable"));
        let layout_aside =
            std::fs::read_to_string(project_file(&dir, &root).with_extension("json.unreadable"));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(library_aside.unwrap(), library_text);
        assert_eq!(layout_aside.unwrap(), layout_text);
    }

    #[test]
    fn a_deleted_workspace_id_is_not_handed_out_after_a_restart() {
        let dir =
            std::env::temp_dir().join(format!("lattice-gpui-ws-id-test-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let deleted = {
            let mut library = Workspaces::load(Some(dir.clone()));
            library.add("Writing", None, None);
            let last = library.add("Reading", None, None);
            library.remove(&last).unwrap();
            library.persist_library();
            last
        };
        let mut library = Workspaces::load(Some(dir.clone()));
        let added = library.add("Drafts", None, None);
        assert_ne!(added, deleted);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-gpui-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn the_preset_and_focus_mode_persist_with_the_layout_per_project() {
        use crate::shell::trellis_layout::{Preset, default_layout};
        let dir = temp("ws-preset-test");
        let own = default_layout();
        {
            let mut library = Workspaces::load(Some(dir.clone()));
            library.save_project(
                Path::new("/a"),
                ProjectLayout {
                    document: Some(own.clone()),
                    preset: Some(ActivePreset {
                        preset: Preset::Reading,
                        previous: own.clone(),
                        supplied: vec!["papers".into()],
                    }),
                    ..ProjectLayout::default()
                },
            );
            library.save_project(
                Path::new("/b"),
                ProjectLayout {
                    document: Some(own.clone()),
                    focus: Some(ActiveFocus {
                        previous: own.clone(),
                        supplied: vec![],
                        pdf: true,
                    }),
                    ..ProjectLayout::default()
                },
            );
            library.set_focus_pdf(true);
            library.persist_library();
        }
        let mut library = Workspaces::load(Some(dir.clone()));
        let a = library.project(Path::new("/a"));
        let b = library.project(Path::new("/b"));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            a.preset.as_ref().map(|active| active.preset),
            Some(Preset::Reading)
        );
        assert_eq!(a.preset.unwrap().supplied, ["papers"]);
        assert!(a.focus.is_none());
        assert!(b.preset.is_none());
        assert!(b.focus.is_some_and(|focus| focus.pdf));
        assert_eq!(b.document, Some(own));
        assert!(library.focus_pdf());
    }

    #[test]
    fn a_library_from_before_trellis_keeps_its_workspaces_names() {
        let dir = temp("ws-legacy-test");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"version": 1, "workspaces": [
            {"id": "ws-1", "name": "Workspace", "arrangement": {"center": {"kind": "tabs", "views": [], "active": 0}}},
            {"id": "ws-4", "name": "Reading", "arrangement": null}
        ], "recent": "ws-4", "next_id": 5}"#;
        std::fs::write(dir.join("workspaces.json"), legacy).unwrap();
        let mut library = Workspaces::load(Some(dir.clone()));
        let names: Vec<String> = library
            .list()
            .iter()
            .map(|entry| entry.name.clone())
            .collect();
        assert_eq!(names, ["Workspace", "Reading"]);
        assert!(
            library
                .list()
                .iter()
                .all(|entry| entry.arrangement.is_none())
        );
        assert_eq!(library.recent(), "ws-4");
        assert_eq!(library.add("Drafts", None, None), "ws-5");
        // A project layout saved before Trellis reopens in its own workspace,
        // its GPUI Kit arrangement and places dropped.
        let root = PathBuf::from("/projects/paper");
        std::fs::create_dir_all(dir.join("layouts")).unwrap();
        std::fs::write(
            project_file(&dir, &root),
            r#"{"version": 1, "root": "/projects/paper", "workspace": "ws-1",
                "arrangement": {"center": {"kind": "tabs", "views": [], "active": 0}},
                "places": {"ws-1": {"main.tex": 3}}}"#,
        )
        .unwrap();
        let layout = library.project(&root);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(layout.workspace.as_deref(), Some("ws-1"));
        assert_eq!(layout.document, None);
        assert_eq!(layout.preset, None);
        assert!(layout.places.is_empty());
    }
}
