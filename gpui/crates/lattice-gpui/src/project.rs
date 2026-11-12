//! The open project, on lattice-core: what opening the folder found (its
//! manifest and file tree), the watcher that reports changes made to it, its
//! build handle, and how current the shown PDF is.
//!
//! Everything here is the Tauri app's own backend (`../src-tauri/lattice-core`):
//! opening adopts a folder Lattice did not create exactly as the Tauri app
//! does (a `.research/` folder, the build-output ignores), so both apps open
//! the same folders.

use std::path::{Path, PathBuf};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{AppContext as _, AsyncApp, Context, Entity, EventEmitter, Task};
use lattice_core::{
    fs_watch::{self, ProjectWatcher},
    latex::ActiveBuild,
    models::{FileNode, ProjectManifest},
    project::{self, TreeView},
};

/// What the watcher or an operation here changed.
pub enum ProjectEvent {
    /// The tree was scanned again.
    TreeChanged,
    /// Files changed on disk, project-relative; `None` when the watcher could
    /// not say which (anything may have changed).
    FilesChanged(Option<Vec<String>>),
    /// The manifest changed (a new main document).
    ManifestChanged,
}

pub struct Project {
    root: PathBuf,
    manifest: ProjectManifest,
    files: Vec<FileNode>,
    /// The tree shows dotfiles and build output (Show hidden files).
    show_hidden: bool,
    active_build: ActiveBuild,
    /// Bumped by every save here, as the Tauri app's build pipeline counts
    /// them (`markInputsChanged`); a build records the revision it started
    /// from, so a jump to the PDF can tell whether the PDF is older than the
    /// sources (`compiled_is_current`).
    input_revision: u64,
    /// The last build that left a PDF: the revision it started from, the
    /// document it compiled, and whether that was a one-off (a standalone
    /// figure) rather than the main document.
    compiled: Option<Compiled>,
    _watcher: Option<ProjectWatcher>,
    _watch_task: Option<Task<()>>,
    _scan: Option<Task<()>>,
}

impl EventEmitter<ProjectEvent> for Project {}

impl Project {
    /// Open `root` with lattice-core on a background thread.
    pub fn open(
        root: PathBuf,
        cx: &mut AsyncApp,
    ) -> Task<Result<project_snapshot::Opened, String>> {
        cx.background_spawn(async move {
            let snapshot = project::open(&root)?;
            Ok(project_snapshot::Opened {
                root: PathBuf::from(snapshot.root),
                manifest: snapshot.manifest,
                files: snapshot.files,
            })
        })
    }

    pub fn new(opened: project_snapshot::Opened, cx: &mut Context<Self>) -> Self {
        let project_snapshot::Opened {
            root,
            manifest,
            files,
        } = opened;
        let (events, mut received) = mpsc::unbounded::<Option<Vec<String>>>();
        // The watcher's thread reports through this sink; each report names
        // the project-relative paths it saw, or none for "anything".
        let watch_root = root.to_string_lossy().into_owned();
        let sink = move |event: &str, payload: serde_json::Value| {
            if event != "project-fs-changed" || payload["root"] != watch_root.as_str() {
                return;
            }
            let paths = payload["paths"].as_array().map(|paths| {
                paths
                    .iter()
                    .filter_map(|path| path.as_str().map(str::to_string))
                    .collect()
            });
            events.unbounded_send(paths).ok();
        };
        let watcher = match fs_watch::spawn(sink, root.clone()) {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                log::warn!("the project watcher did not start: {error}");
                None
            }
        };
        let watch_task = cx.spawn(async move |this, cx| {
            while let Some(paths) = received.next().await {
                let alive = this
                    .update(cx, |this, cx| this.files_changed(paths, cx))
                    .is_ok();
                if !alive {
                    break;
                }
            }
        });
        Self {
            root,
            manifest,
            files,
            show_hidden: false,
            active_build: ActiveBuild::default(),
            input_revision: 0,
            compiled: None,
            _watcher: watcher,
            _watch_task: Some(watch_task),
            _scan: None,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &ProjectManifest {
        &self.manifest
    }

    pub fn files(&self) -> &[FileNode] {
        &self.files
    }

    pub fn active_build(&self) -> &ActiveBuild {
        &self.active_build
    }

    pub fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    pub fn set_show_hidden(&mut self, show: bool, cx: &mut Context<Self>) {
        if self.show_hidden != show {
            self.show_hidden = show;
            self.rescan(cx);
        }
    }

    /// The main document's project-relative path, as Build compiles it.
    pub fn main_document(&self) -> Option<&str> {
        let documents = &self.manifest.root_documents;
        documents
            .iter()
            .find(|document| document.is_default)
            .or_else(|| documents.first())
            .map(|document| document.path.as_str())
    }

    /// Where the main document's PDF is, built or not.
    pub fn main_pdf(&self) -> Option<PathBuf> {
        project::default_root_pdf(&self.manifest).map(|pdf| self.root.join(pdf))
    }

    pub fn input_revision(&self) -> u64 {
        self.input_revision
    }

    /// The PDF on screen was built from the sources as they are now, and of
    /// the document a build would compile from `open_document` (the file in
    /// front, project-relative), as the Tauri app's `compiledIsCurrent` asks.
    pub fn compiled_is_current(&self, open_document: Option<&str>) -> bool {
        let Some(compiled) = &self.compiled else {
            return false;
        };
        if compiled.revision != self.input_revision {
            return false;
        }
        // A one-off build answers for that file alone.
        if compiled.one_off {
            return open_document == Some(compiled.document.as_str());
        }
        self.main_document()
            .is_none_or(|main| compiled.document.is_empty() || main == compiled.document)
    }

    /// A build that started at `revision` left a PDF of `document`.
    pub fn record_compiled(&mut self, revision: u64, document: String, one_off: bool) {
        self.compiled = Some(Compiled {
            revision,
            document,
            one_off,
        });
    }

    /// The sources changed (a save here): the PDF is older than them.
    pub fn mark_inputs_changed(&mut self) {
        self.input_revision += 1;
    }

    fn files_changed(&mut self, paths: Option<Vec<String>>, cx: &mut Context<Self>) {
        self.rescan(cx);
        cx.emit(ProjectEvent::FilesChanged(paths));
    }

    /// Scan the tree again, off the main thread.
    pub fn rescan(&mut self, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let view = if self.show_hidden {
            TreeView::ProjectWithHidden
        } else {
            TreeView::Project
        };
        let scanned = cx.background_spawn(async move { project::scan_tree(&root, view) });
        self._scan = Some(cx.spawn(async move |this, cx| {
            let files = scanned.await;
            this.update(cx, |this, cx| match files {
                Ok(files) => {
                    this.files = files;
                    cx.emit(ProjectEvent::TreeChanged);
                    cx.notify();
                }
                Err(error) => log::warn!("could not scan the project: {error}"),
            })
            .ok();
        }));
    }

    /// A rename, move or delete went through lattice-core, which rewrites
    /// the manifest when it names what changed (a main document, the primary
    /// bibliography): read it and the tree again.
    pub fn entries_changed(&mut self, cx: &mut Context<Self>) {
        self.reload_manifest(cx);
        self.rescan(cx);
    }

    /// Make `path` the document Build compiles (Set as main document).
    pub fn choose_main_document(&mut self, path: String, cx: &mut Context<Self>) -> Task<()> {
        let root = self.root.clone();
        let chosen =
            cx.background_spawn(async move { project::choose_root_document(&root, &path) });
        cx.spawn(async move |this, cx| {
            let manifest = chosen.await;
            this.update(cx, |this, cx| match manifest {
                Ok(manifest) => {
                    this.manifest = manifest;
                    cx.emit(ProjectEvent::ManifestChanged);
                    cx.notify();
                }
                Err(error) => crate::notices::error("Could not set the main document", error, cx),
            })
            .ok();
        })
    }

    /// Read the manifest again (a build may have adopted a document).
    pub fn reload_manifest(&mut self, cx: &mut Context<Self>) {
        match project::read_manifest(&self.root) {
            Ok(manifest) => {
                self.manifest = manifest;
                cx.emit(ProjectEvent::ManifestChanged);
                cx.notify();
            }
            Err(error) => log::warn!("could not read the project manifest: {error}"),
        }
    }
}

struct Compiled {
    revision: u64,
    document: String,
    one_off: bool,
}

/// `path` relative to `root`, with forward slashes; `None` outside it.
pub fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

pub mod project_snapshot {
    use std::path::PathBuf;

    use lattice_core::models::{FileNode, ProjectManifest};

    /// What opening a folder found, before it becomes a [`super::Project`].
    pub struct Opened {
        pub root: PathBuf,
        pub manifest: ProjectManifest,
        pub files: Vec<FileNode>,
    }
}

/// Open `root` and make its entity, or say why it would not open.
pub async fn open(root: PathBuf, cx: &mut AsyncApp) -> Result<Entity<Project>, String> {
    let opened = Project::open(root, cx).await?;
    Ok(cx.new(|cx| Project::new(opened, cx)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_use_forward_slashes_and_stay_inside() {
        let root = Path::new("/projects/paper");
        assert_eq!(
            relative_path(root, &root.join("chapters").join("intro.tex")).as_deref(),
            Some("chapters/intro.tex")
        );
        assert_eq!(relative_path(root, root), None);
        assert_eq!(relative_path(root, Path::new("/elsewhere/main.tex")), None);
    }
}
