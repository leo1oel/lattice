//! The History tool panel, ported from the Tauri app's `HistoryDrawer`
//! (`src/history/history-drawer.tsx`), `useGitVersions`
//! (`use-git-versions.ts`) and the versions toolbar and states
//! (`versions-timeline.tsx`), docked in the workspace as a Trellis tool
//! panel the way the Tauri app docks the drawer (`ResizableDrawer` in a
//! tool host, `trellis.css`): on the input surface, its content 14px in, no
//! header of its own (the panel's tab names it and closes it).
//!
//! What it holds: the views (Everything, Versions, Activity) and Compare…,
//! Save version and the refresh; then the timeline, Lattice's own activity
//! and the project's git versions interleaved by time and grouped by day;
//! a row opened in place to read its changes; and, in place of all that,
//! the comparison of two versions (`compare.rs`).
//!
//! The work is lattice-core's, on the background executor: `project::history`
//! and `get_history_entry`, `revert` and `delete_history` for the activity,
//! and `git::{status, log, init, auto_commit, show_diff, restore_file,
//! restore_project}` for the versions. A restore saves the current state as
//! a version first (lattice-core does), and is asked about first, as the
//! Tauri app asks. The versions are read again when the project's files
//! change (the watcher), when the window comes forward, and every 30 s while
//! the panel is on screen.

use std::{collections::HashSet, path::PathBuf, rc::Rc, time::Duration};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollHandle,
    SharedString, Subscription, Task, Window,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::InputState,
};
use lattice_core::{
    git::{GitFileDiff, GitLogEntry},
    project::{HistoryItem, TransactionRecord},
};
use lattice_i18n::t;

use super::{
    compare::CompareView,
    diff_view::{FileChange, LoadedDiff},
    prose::{ProsePassage, is_prose_file, prose_passages},
    timeline::{ActivityFilter, HistoryView},
};
use crate::project::{Project, ProjectEvent};

mod actions;

/// What the panel asks of the window.
pub enum HistoryEvent {
    /// Open a project file, at a line when given.
    OpenFile { path: String, line: Option<u32> },
}

impl EventEmitter<HistoryEvent> for HistoryPanel {}
impl EventEmitter<PanelEvent> for HistoryPanel {}

/// How many versions the log reads at first, and how many more each "older" asks for.
pub const LOG_PAGE: usize = 100;
/// How often the versions are read again while the panel is on screen.
const POLL: Duration = Duration::from_secs(30);
/// How long a burst of file changes settles before the history is read again.
const SETTLE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Loading,
    /// No git on this machine.
    Unavailable,
    /// The project is not a repository: version tracking is off.
    NoRepo,
    Ready,
    /// lattice-core's git could not be asked at all.
    Error,
}

/// The project's git versions and what is being done to them.
/// Whether Git is there, then the project's log when it is a repository.
type VersionsRead = Result<(bool, Option<Result<Vec<GitLogEntry>, String>>), String>;

pub struct Versions {
    pub phase: Phase,
    pub entries: Vec<GitLogEntry>,
    /// The last read or action's failure, said where the versions are.
    pub error: String,
    /// An action (save, restore, start tracking) is under way.
    pub busy: bool,
    pub refreshing: bool,
    pub has_older: bool,
    limit: usize,
    seq: u64,
}

impl Versions {
    fn new() -> Self {
        Self {
            phase: Phase::Loading,
            entries: Vec::new(),
            error: String::new(),
            busy: false,
            refreshing: false,
            has_older: false,
            limit: LOG_PAGE,
            seq: 0,
        }
    }
}

/// One keyed load at a time (`useLatestLoad`): a later load or a clear makes
/// an earlier answer stale, so a slow answer for the previous row never
/// replaces the current one.
pub struct Latest<T> {
    pub key: Option<String>,
    pub value: Option<T>,
    pub error: String,
    pub loading: bool,
    generation: u64,
}

impl<T> Default for Latest<T> {
    fn default() -> Self {
        Self {
            key: None,
            value: None,
            error: String::new(),
            loading: false,
            generation: 0,
        }
    }
}

impl<T> Latest<T> {
    /// Start a load of `key`; the returned generation settles it.
    pub fn start(&mut self, key: String) -> u64 {
        self.generation += 1;
        self.key = Some(key);
        self.value = None;
        self.error.clear();
        self.loading = true;
        self.generation
    }

    /// Start reading `key` again behind what is shown.
    pub fn revalidate(&mut self, key: String) -> u64 {
        if self.key.as_deref() != Some(&key) {
            return self.start(key);
        }
        self.generation += 1;
        self.generation
    }

    /// Settle the load `generation` started, unless a later one has.
    pub fn settle(&mut self, generation: u64, result: Result<T, String>) -> bool {
        if generation != self.generation {
            return false;
        }
        self.loading = false;
        match result {
            Ok(value) => {
                self.value = Some(value);
                self.error.clear();
            }
            Err(error) => self.error = error,
        }
        true
    }

    pub fn clear(&mut self) {
        self.generation += 1;
        *self = Self {
            generation: self.generation,
            ..Self::default()
        };
    }

    pub fn is(&self, key: &str) -> bool {
        self.key.as_deref() == Some(key)
    }
}

/// An opened activity entry: its files' diffs.
pub struct OpenedEntry {
    pub id: String,
    pub diffs: Vec<LoadedDiff>,
    /// The file the multi-file view is on.
    pub active: usize,
    pub scroll: ScrollHandle,
}

/// A version's file, read: its two sides, its source diff, and its changed
/// passages when it reads as prose and is not too large to.
pub struct VersionFile {
    pub diff: GitFileDiff,
    pub loaded: Option<LoadedDiff>,
    pub passages: Option<Vec<ProsePassage>>,
}

/// An opened version: the file being read and how.
pub struct OpenedVersion {
    pub hash: String,
    /// Compared with the files as they are now.
    pub compare: bool,
    pub active_path: Option<String>,
    pub all_files: bool,
    pub diff: Latest<VersionFile>,
    /// Source rather than Text.
    pub source: bool,
    pub current: usize,
}

pub struct HistoryPanel {
    focus_handle: FocusHandle,
    pub(super) project: Option<Entity<Project>>,
    pub(super) root: Option<PathBuf>,
    _project_subscription: Option<Subscription>,
    pub(super) view: HistoryView,
    user_picked_view: bool,
    pub(super) filter: ActivityFilter,
    pub(super) comparing: Option<Entity<CompareView>>,
    pub(super) expanded: Option<String>,
    /// The open row, when it was opened to compare with now.
    pub(super) compare_key: Option<String>,
    pub(super) open_folds: HashSet<String>,
    pub(super) activity: Vec<HistoryItem>,
    pub(super) activity_error: Option<String>,
    pub(super) entry: Latest<OpenedEntry>,
    pub(super) versions: Versions,
    pub(super) opened: Option<OpenedVersion>,
    /// The field a version's name is typed in, while it is open.
    pub(super) save_field: Option<(Entity<InputState>, Subscription)>,
    pub(super) scroll: ScrollHandle,
    /// The panel's width at its last paint, for its narrow rules.
    pub(super) width: Rc<std::cell::Cell<gpui::Pixels>>,
    settle: Option<Task<()>>,
    _poll: Task<()>,
}

impl HistoryPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Git commits can arrive while the watcher misses them (another app
        // committing); read them again now and then while on screen, and
        // when the window comes forward.
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let Ok(()) = this.update(cx, |this, cx| {
                    if this.root.is_some() && !this.versions.busy {
                        this.load_versions(cx);
                    }
                }) else {
                    break;
                };
            }
        });
        cx.observe_window_activation(window, |this, window, cx| {
            if window.is_window_active() && this.root.is_some() {
                this.reload(cx);
            }
        })
        .detach();
        Self {
            focus_handle: cx.focus_handle(),
            project: None,
            root: None,
            _project_subscription: None,
            view: HistoryView::Everything,
            user_picked_view: false,
            filter: ActivityFilter::All,
            comparing: None,
            expanded: None,
            compare_key: None,
            open_folds: HashSet::new(),
            activity: Vec::new(),
            activity_error: None,
            entry: Latest::default(),
            versions: Versions::new(),
            opened: None,
            save_field: None,
            scroll: ScrollHandle::new(),
            width: Rc::new(std::cell::Cell::new(gpui::px(460.))),
            settle: None,
            _poll: poll,
        }
    }

    /// The project the history is of; another project starts afresh.
    pub fn set_project(&mut self, project: Entity<Project>, cx: &mut Context<Self>) {
        let root = project.read(cx).root().to_path_buf();
        self._project_subscription = Some(cx.subscribe(&project, |this, _, event, cx| {
            match event {
                ProjectEvent::FilesChanged(paths) => {
                    // The history's own records and the build's output are
                    // not changes to the project's files.
                    let ours = paths.as_ref().is_some_and(|paths| {
                        paths
                            .iter()
                            .all(|path| path.starts_with(".research/") || path.starts_with(".git/"))
                    });
                    if !ours
                        || paths.as_ref().is_some_and(|paths| {
                            paths
                                .iter()
                                .any(|path| path.starts_with(".research/history"))
                        })
                    {
                        this.settle_then_reload(cx);
                    }
                }
                ProjectEvent::GitChanged => this.settle_then_reload(cx),
                ProjectEvent::TreeChanged | ProjectEvent::ManifestChanged => {}
            }
        }));
        let same = self.root.as_deref() == Some(root.as_path());
        self.project = Some(project);
        self.root = Some(root);
        if !same {
            self.view = if self.user_picked_view {
                self.view
            } else {
                HistoryView::Everything
            };
            self.comparing = None;
            self.expanded = None;
            self.compare_key = None;
            self.open_folds.clear();
            self.activity.clear();
            self.entry.clear();
            self.opened = None;
            self.save_field = None;
            self.versions = Versions::new();
        }
        self.reload(cx);
    }

    /// The document the project builds: what a comparison opens first and
    /// what the PDF with changes marks.
    pub(super) fn root_document(&self, cx: &App) -> Option<String> {
        self.project
            .as_ref()
            .and_then(|project| project.read(cx).main_document().map(str::to_string))
    }

    fn settle_then_reload(&mut self, cx: &mut Context<Self>) {
        self.settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            this.update(cx, |this, cx| this.reload(cx)).ok();
        }));
    }

    /// Read the activity and the versions again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.load_activity(cx);
        self.load_versions(cx);
    }

    fn load_activity(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let read = cx
            .background_executor()
            .spawn(async move { lattice_core::project::history(&root) });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(items) => {
                        this.activity = items;
                        this.activity_error = None;
                    }
                    Err(error) => this.activity_error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Read the git status and log together (`useGitVersions.load`).
    pub(super) fn load_versions(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.versions.seq += 1;
        let seq = self.versions.seq;
        let limit = self.versions.limit;
        self.versions.refreshing = true;
        cx.notify();
        let read = cx.background_executor().spawn(async move {
            let status = lattice_core::git::status(&root)?;
            if !status.available || !status.repository {
                return Ok((status.available, None));
            }
            Ok((true, Some(lattice_core::git::log(&root, limit))))
        });
        cx.spawn(async move |this, cx| {
            let result: VersionsRead = read.await;
            this.update(cx, |this, cx| {
                if seq != this.versions.seq {
                    return;
                }
                let versions = &mut this.versions;
                versions.refreshing = false;
                match result {
                    Ok((available, None)) => {
                        versions.phase = if available {
                            Phase::NoRepo
                        } else {
                            Phase::Unavailable
                        };
                        versions.entries.clear();
                    }
                    Ok((_, Some(Ok(entries)))) => {
                        versions.has_older = entries.len() >= limit;
                        versions.entries = entries;
                        versions.error.clear();
                        versions.phase = Phase::Ready;
                    }
                    Ok((_, Some(Err(error)))) => {
                        versions.error = error;
                        versions.phase = Phase::Ready;
                    }
                    Err(error) => {
                        versions.error = error;
                        versions.phase = Phase::Error;
                        // Git cannot be asked at all: the whole stream keeps
                        // the panel useful, unless a view was chosen.
                        if !this.user_picked_view && this.view == HistoryView::Versions {
                            this.view = HistoryView::Everything;
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Read the next page of older versions as well.
    pub(super) fn load_older(&mut self, cx: &mut Context<Self>) {
        self.versions.limit += LOG_PAGE;
        self.load_versions(cx);
    }

    pub(super) fn select_view(&mut self, view: HistoryView, cx: &mut Context<Self>) {
        self.user_picked_view = true;
        self.view = view;
        cx.notify();
    }

    pub(super) fn set_filter(&mut self, filter: ActivityFilter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    /// Open a row to read its changes; again closes it.
    pub(crate) fn toggle_row(&mut self, key: String, cx: &mut Context<Self>) {
        self.compare_key = None;
        let opening = self.expanded.as_deref() != Some(&key);
        self.expanded = opening.then_some(key.clone());
        self.opened = None;
        if opening && let Some(hash) = key.strip_prefix("version:") {
            self.opened = Some(OpenedVersion::new(hash, false));
        }
        cx.notify();
    }

    /// Open `key` compared with now; asked again while it is, close it.
    pub(super) fn compare_row(&mut self, key: String, cx: &mut Context<Self>) {
        let closing =
            self.expanded.as_deref() == Some(&key) && self.compare_key.as_deref() == Some(&key);
        self.expanded = (!closing).then_some(key.clone());
        self.compare_key = (!closing).then_some(key.clone());
        self.opened = (!closing)
            .then(|| {
                key.strip_prefix("version:")
                    .map(|hash| OpenedVersion::new(hash, true))
            })
            .flatten();
        cx.notify();
    }

    pub(super) fn toggle_fold(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.open_folds.remove(&key) {
            self.open_folds.insert(key);
        }
        cx.notify();
    }

    /// Open an activity entry and read its changes.
    pub(super) fn toggle_activity(&mut self, item: &HistoryItem, cx: &mut Context<Self>) {
        self.compare_key = None;
        self.opened = None;
        let key = super::timeline::activity_key(&item.id);
        let opening = self.expanded.as_deref() != Some(&key);
        self.expanded = opening.then_some(key);
        if !opening || item.kind == "agent-checkpoint" {
            self.entry.clear();
            cx.notify();
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        let id = item.id.clone();
        let generation = self.entry.start(id.clone());
        cx.notify();
        let read = cx
            .background_executor()
            .spawn(async move { lattice_core::project::get_history_entry(&root, &id) });
        cx.spawn(async move |this, cx| {
            let result: Result<TransactionRecord, String> = read.await;
            this.update(cx, |this, cx| {
                let opened = result.map(|record| OpenedEntry {
                    id: record.id.clone(),
                    diffs: record
                        .changes
                        .into_iter()
                        .map(|change| {
                            LoadedDiff::new(
                                FileChange {
                                    path: change.path,
                                    before: change.before,
                                    after: change.after,
                                },
                                cx,
                            )
                        })
                        .collect(),
                    active: 0,
                    scroll: ScrollHandle::new(),
                });
                if this.entry.settle(generation, opened) {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Read the file `path` of the opened version (or compared with now);
    /// the open file again closes it.
    pub(crate) fn open_version_file(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(opened) = &mut self.opened else {
            return;
        };
        if opened.active_path.as_deref() == Some(&path) {
            opened.active_path = None;
            opened.diff.clear();
            cx.notify();
            return;
        }
        opened.active_path = Some(path.clone());
        opened.source = false;
        opened.current = 0;
        let (hash, compare) = (opened.hash.clone(), opened.compare);
        let generation = opened.diff.start(format!("{hash}:{path}"));
        cx.notify();
        let file = path.clone();
        let read = cx.background_executor().spawn(async move {
            let at_version = lattice_core::git::show_diff(&root, &hash, &file)?;
            let diff = if compare {
                // Compared with now: the file as this version left it,
                // against the file on disk (none once deleted).
                let now = lattice_core::project::read_file(&root, &file).ok();
                GitFileDiff {
                    before: at_version.after,
                    after: now,
                    binary: at_version.binary,
                }
            } else {
                at_version
            };
            let passages = (!diff.binary && is_prose_file(&file)).then(|| {
                prose_passages(
                    diff.before.as_deref().unwrap_or(""),
                    diff.after.as_deref().unwrap_or(""),
                )
            });
            Ok((diff, passages.flatten()))
        });
        cx.spawn(async move |this, cx| {
            let result: Result<(GitFileDiff, Option<Vec<ProsePassage>>), String> = read.await;
            this.update(cx, |this, cx| {
                let result = result.map(|(diff, passages)| {
                    let loaded = (!diff.binary).then(|| {
                        LoadedDiff::new(
                            FileChange {
                                path: path.clone(),
                                before: diff.before.clone(),
                                after: diff.after.clone(),
                            },
                            cx,
                        )
                    });
                    VersionFile {
                        diff,
                        loaded,
                        passages,
                    }
                });
                if let Some(opened) = &mut this.opened
                    && opened.diff.settle(generation, result)
                {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn open_file(&mut self, path: String, line: Option<u32>, cx: &mut Context<Self>) {
        cx.emit(HistoryEvent::OpenFile { path, line });
    }

    /// Compare any two versions in place of the timeline.
    pub(crate) fn start_comparing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let _ = window;
        let panel = cx.entity();
        let root_document = self.root_document(cx);
        let (project, logged, has_older, width) = (
            self.project.clone(),
            self.versions.entries.clone(),
            self.versions.has_older,
            self.width.clone(),
        );
        let view = cx.new(|cx| {
            CompareView::new(
                panel,
                project,
                logged,
                has_older,
                width,
                root,
                root_document,
                cx,
            )
        });
        self.comparing = Some(view);
        self.scroll
            .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        cx.notify();
    }

    pub(crate) fn stop_comparing(&mut self, cx: &mut Context<Self>) {
        self.comparing = None;
        cx.notify();
    }

    /// The versions' messages, newest first, for a scenario.
    pub fn version_messages(&self) -> Vec<String> {
        self.versions
            .entries
            .iter()
            .map(|entry| entry.message.clone())
            .collect()
    }

    pub fn newest_version_hash(&self) -> Option<String> {
        self.versions
            .entries
            .first()
            .map(|entry| entry.hash.clone())
    }

    /// Open the newest version and its file `path`, as a click on its row
    /// and then its chip would; whether there was a version to open.
    pub fn open_newest_version_file_for_scenario(
        &mut self,
        path: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(hash) = self.newest_version_hash() else {
            return false;
        };
        let key = super::timeline::version_key(&hash);
        if self.expanded.as_deref() != Some(key.as_str()) {
            self.toggle_row(key, cx);
        }
        self.open_version_file(path.to_string(), cx);
        true
    }

    /// How many passages the opened version's file reads as, once read.
    pub fn opened_passages(&self) -> Option<usize> {
        self.opened
            .as_ref()?
            .diff
            .value
            .as_ref()?
            .passages
            .as_ref()
            .map(Vec::len)
    }

    /// How many versions the timeline holds, for a scenario.
    pub fn versions_shown(&self) -> usize {
        if self.versions.phase == Phase::Ready {
            self.versions.entries.len()
        } else {
            0
        }
    }

    /// Whether the comparison shows its file's changes, for a scenario.
    pub fn comparison_loaded(&self, cx: &App) -> bool {
        self.comparing
            .as_ref()
            .is_some_and(|compare| compare.read(cx).file_loaded())
    }

    /// Whether the panel is narrower than the history container's 300px.
    pub(super) fn narrow(&self) -> bool {
        self.width.get() < gpui::px(300.)
    }
}

impl OpenedVersion {
    fn new(hash: &str, compare: bool) -> Self {
        Self {
            hash: hash.to_string(),
            compare,
            active_path: None,
            all_files: false,
            diff: Latest::default(),
            source: false,
            current: 0,
        }
    }
}

impl Focusable for HistoryPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for HistoryPanel {
    fn panel_name(&self) -> &'static str {
        "HistoryPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for HistoryPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("History").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        t!("History")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
