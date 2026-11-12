//! One open file: Zed's editor over a local buffer, behind Lattice's editor
//! adapter (`lattice-editor`), with Zed's buffer search bar and Lattice's
//! status bar, as a dock panel. Its tab strip carries the build chip. A TeX
//! source gets the LaTeX extensions: citation and reference cards, command,
//! citation and label completion, and TexLab's diagnostics.
//!
//! The file is kept in step with disk the way the Tauri app's open documents
//! keep theirs (`src/app/use-document-save.ts`, `use-document-autosave.ts`,
//! `use-document-disk-sync.ts`, `vanished-file.ts`):
//!
//! - It saves after a pause in typing (1.2 s, and a build follows), when the
//!   writer leaves the editor and when its tab closes, one save at a time.
//! - A save goes through lattice-core's editor transaction with the text the
//!   buffer grew from (`saved_text`) as its base, so an edit made outside
//!   Lattice since then is merged in rather than written over, with conflict
//!   markers where both touched the same lines; the merge comes back into the
//!   buffer when nothing was typed meanwhile.
//! - Every 2.5 s, and whenever the project watcher names the file, the file
//!   on disk is compared with the version last seen: another version reloads
//!   a clean buffer, and leaves an edited one to merge on its next save.
//! - A file that leaves its path is followed when it was moved, its tab
//!   closed when it was deleted with nothing unsaved, and its edits held when
//!   it was deleted with some, until the writer recreates it, saves them
//!   elsewhere or closes the tab.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result};
use editor::{Editor, EditorEvent, SelectionEffects, ToPoint as _, scroll::Autoscroll};
use futures::{channel::oneshot, future::Shared};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Task, Window, div, prelude::*,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::PopupMenu,
};
use language::{Buffer, BufferEvent, Point};
use lattice_core::project::{self as core_project, ProjectFileStat};
use lattice_editor::{
    LatticeEditor, LatticeEditorEvent,
    latex::{self, diagnostics::TexlabDiagnostics},
};
use lattice_ui::ActiveLattice as _;
use search::{BufferSearchBar, buffer_search::DivRegistrar};
use workspace::ToolbarItemView as _;
use zed_actions::buffer_search::Deploy;

mod disk_sync;
mod save;

use disk_sync::vanished_key;
use save::normalize_breaks;

use crate::{
    build_panel::BuildPanel,
    editor_status,
    project::Project,
    shell::{Build, ForwardSync, ToggleVimMode},
};

/// How often the open file is checked for an edit made behind the editor.
const DISK_POLL: Duration = Duration::from_millis(2500);
/// What the panel tells the shell.
pub enum EditorPanelEvent {
    /// A save wrote the file: the PDF is older than the sources now.
    Saved,
    /// A save just wrote the file, from a pause in typing or from leaving
    /// the editor: build now, unattended.
    SavedForBuild,
    /// An edit made outside Lattice was loaded into the clean buffer.
    DiskEdit,
    /// The file was deleted outside Lattice with nothing unsaved: close the tab.
    Close,
    /// Open the project-relative `path` at the 1-based `line` (a hover
    /// card's Go to entry, a reference card's title).
    OpenLocation { path: String, line: u32 },
}

/// The last write's outcome, for the status bar's save slot.
#[derive(Clone, Debug, PartialEq)]
pub enum SaveStatus {
    Saved,
    Saving,
    Failed(SharedString),
}

/// What is known of the file on disk.
#[derive(Clone, Debug)]
enum DiskVersion {
    /// Not seen yet: the next check records what it finds.
    Unknown,
    /// After a save here: the next check reads the file whatever it finds,
    /// so an outside write landing just after the save is not mistaken for it.
    Unread,
    Seen(ProjectFileStat),
}

/// The file left its path holding unsaved edits: saves hold until the writer
/// chooses.
struct Vanished {
    /// The writer chose Recreate: the next save writes the file anew.
    recreate: bool,
}

pub struct EditorPanel {
    project: Entity<Project>,
    path: PathBuf,
    /// `path` within the project, as lattice-core names it.
    relative: String,
    buffer: Entity<Buffer>,
    /// The adapter over Zed's editor, and the editor itself.
    lattice: Entity<LatticeEditor>,
    editor: Entity<Editor>,
    /// TexLab's diagnostics, for a `.tex` file.
    diagnostics: Option<Entity<TexlabDiagnostics>>,
    /// Builds seen finishing; each one has TexLab read the new log.
    builds_seen: usize,
    search_bar: Entity<BufferSearchBar>,
    search_visible: bool,
    build: Entity<BuildPanel>,
    /// The caret's line and column, 1-based, for the status bar.
    cursor: (u32, u32),
    /// The file's word count as of opening or the last save; counted off the
    /// main thread.
    words: Option<usize>,
    /// The text the buffer grew from, as of the last load or save, with "\n"
    /// line breaks: the base the next save merges against.
    saved_text: String,
    disk: DiskVersion,
    /// The file last seen at the path, to find it once it is gone.
    last_file_id: String,
    vanished: Option<Vanished>,
    looking_for_file: bool,
    /// Its tab was closed (the file went from disk): it stops checking it.
    closed: bool,
    status: SaveStatus,
    /// Saves run one at a time; this settles when the last one queued has.
    save_queue: Option<Shared<Task<()>>>,
    /// Saves and reloads in flight, which the disk check waits out.
    saves_pending: usize,
    /// Bumped by every save, so a disk read that raced one is dropped.
    save_generation: u64,
    /// The write under way off the main thread until its result is taken
    /// in: it settles with the text it sent once that is on disk.
    writing: Option<Shared<oneshot::Receiver<Option<String>>>>,
    _autosave: Option<Task<()>>,
    _count: Option<Task<()>>,
    _poll: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl EditorPanel {
    /// Read `path` and open it in a new editor.
    pub fn open(
        path: PathBuf,
        project: Entity<Project>,
        build: Entity<BuildPanel>,
        window: &mut Window,
        cx: &mut App,
    ) -> Result<Entity<Self>> {
        let root = project.read(cx).root().to_path_buf();
        let relative = crate::project::relative_path(&root, &path)
            .with_context(|| format!("{} is not in the project folder", path.display()))?;
        // lattice-core's read refuses binary files, files over its size
        // limit and other encodings, with the Tauri app's messages.
        let text = core_project::read_file(&root, &relative).map_err(anyhow::Error::msg)?;
        let stat = core_project::stat_file(&root, &relative).ok();
        Ok(cx.new(|cx| Self::new(path, relative, text, stat, project, build, window, cx)))
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        path: PathBuf,
        relative: String,
        text: String,
        stat: Option<ProjectFileStat>,
        project: Entity<Project>,
        build: Entity<BuildPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let started = std::time::Instant::now();
        let language = latex::language_for_path(&path, cx);
        let saved_text = normalize_breaks(&text);
        let buffer = cx.new(|cx| Buffer::local(text, cx));
        let buffered = started.elapsed();
        buffer.update(cx, |buffer, cx| buffer.set_language(language, cx));
        let languaged = started.elapsed();
        let tex = latex::is_tex_source(&path);
        let index = project.read(cx).index().clone();
        let lattice = cx.new(|cx| {
            let mut lattice = LatticeEditor::new(buffer.clone(), window, cx);
            if tex {
                latex::attach(&mut lattice, &index);
            }
            lattice
        });
        let editor = lattice.read(cx).editor().clone();
        let diagnostics = tex.then(|| {
            let texlab = project.read(cx).texlab().clone();
            TexlabDiagnostics::attach(&lattice, texlab, relative.clone(), cx)
        });
        log::debug!(
            "opened {}: buffer {buffered:?}, language {languaged:?}, editor {:?}",
            path.display(),
            started.elapsed()
        );
        let search_bar = cx.new(|cx| {
            let mut bar = BufferSearchBar::new(None, window, cx);
            bar.set_active_pane_item(Some(&editor), window, cx);
            bar
        });
        let subscriptions = vec![
            // The tab shows whether the file has unsaved edits; an edit
            // arms the autosave.
            cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| match event {
                BufferEvent::Edited { .. } => this.schedule_autosave(cx),
                BufferEvent::DirtyChanged | BufferEvent::Saved => cx.notify(),
                _ => {}
            }),
            // The build chip in this panel's strip follows the build, and
            // TexLab reads each finished build's log.
            cx.observe(&build, |this, build, cx| {
                let builds = build.read(cx).builds();
                if builds != this.builds_seen {
                    this.builds_seen = builds;
                    if let Some(diagnostics) = &this.diagnostics {
                        diagnostics.update(cx, |diagnostics, cx| diagnostics.resync(cx));
                    }
                }
                cx.notify();
            }),
            cx.subscribe(
                &lattice,
                |_, _, event: &LatticeEditorEvent, cx| match event {
                    LatticeEditorEvent::OpenLocation { path, line } => {
                        cx.emit(EditorPanelEvent::OpenLocation {
                            path: path.clone(),
                            line: *line,
                        })
                    }
                },
            ),
            cx.subscribe(
                &editor,
                |this, editor, event: &EditorEvent, cx| match event {
                    EditorEvent::SelectionsChanged { .. } => {
                        let editor = editor.read(cx);
                        let snapshot = editor.buffer().read(cx).snapshot(cx);
                        let head = editor.selections.newest_anchor().head().to_point(&snapshot);
                        let line_start = Point::new(head.row, 0);
                        let column =
                            editor_status::caret_column(snapshot.text_for_range(line_start..head));
                        this.cursor = (head.row + 1, column);
                        cx.notify();
                    }
                    // Leaving the editor saves at once, as the Tauri app does.
                    EditorEvent::Blurred => this.leave(cx),
                    _ => {}
                },
            ),
            cx.subscribe(&search_bar, |this, _, event, cx| {
                if matches!(event, search::buffer_search::Event::Dismissed) {
                    this.search_visible = false;
                    cx.notify();
                }
            }),
            // The watcher names the file: check it now rather than at the
            // next poll.
            cx.subscribe(&project, |this, _, event, cx| {
                if let crate::project::ProjectEvent::FilesChanged(paths) = event
                    && paths
                        .as_ref()
                        .is_none_or(|paths| paths.iter().any(|path| *path == this.relative))
                {
                    this.check_disk(cx);
                }
            }),
        ];
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(DISK_POLL).await;
                if this.update(cx, |this, cx| this.check_disk(cx)).is_err() {
                    break;
                }
            }
        });
        let builds_seen = build.read(cx).builds();
        let mut this = Self {
            project,
            path,
            relative,
            buffer,
            lattice,
            editor,
            diagnostics,
            builds_seen,
            search_bar,
            search_visible: false,
            build,
            cursor: (1, 1),
            words: None,
            saved_text,
            last_file_id: stat
                .as_ref()
                .map(|stat| stat.file_id.clone())
                .unwrap_or_default(),
            disk: stat.map_or(DiskVersion::Unknown, DiskVersion::Seen),
            vanished: None,
            looking_for_file: false,
            closed: false,
            status: SaveStatus::Saved,
            save_queue: None,
            saves_pending: 0,
            save_generation: 0,
            writing: None,
            _autosave: None,
            _count: None,
            _poll: poll,
            _subscriptions: subscriptions,
        };
        this.count_words(cx);
        this
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The file within its project, as lattice-core names it.
    pub fn relative(&self) -> &str {
        &self.relative
    }

    pub fn editor(&self) -> &Entity<Editor> {
        &self.editor
    }

    /// The adapter the LaTeX extensions decorate the editor through.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn lattice_editor(&self) -> &Entity<LatticeEditor> {
        &self.lattice
    }

    /// TexLab's diagnostics for this file, when it is a `.tex` source.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn texlab_diagnostics(&self) -> Option<&Entity<TexlabDiagnostics>> {
        self.diagnostics.as_ref()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn search_bar(&self) -> &Entity<BufferSearchBar> {
        &self.search_bar
    }

    pub fn is_dirty(&self, cx: &App) -> bool {
        self.buffer.read(cx).is_dirty()
    }

    pub(crate) fn cursor(&self) -> (u32, u32) {
        self.cursor
    }

    pub(crate) fn words(&self) -> Option<usize> {
        self.words
    }

    pub(crate) fn save_status(&self) -> &SaveStatus {
        &self.status
    }

    /// The file was renamed or moved within the project (by the tree, or
    /// outside Lattice): the tab, its buffer and its history follow it.
    pub fn moved_to(&mut self, relative: String, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        self.path = root.join(&relative);
        if let Some(diagnostics) = &self.diagnostics {
            let relative = relative.clone();
            diagnostics.update(cx, |diagnostics, cx| diagnostics.set_path(relative, cx));
        }
        self.relative = relative;
        self.disk = DiskVersion::Unread;
        let language = latex::language_for_path(&self.path, cx);
        self.buffer
            .update(cx, |buffer, cx| buffer.set_language(language, cx));
        cx.notify();
    }

    /// Its file was deleted in Lattice: closing its tab discards what it
    /// holds.
    pub fn file_deleted(&mut self) {
        self.closed = true;
    }

    /// Take `text` as both the buffer and what it was saved as, keeping the
    /// caret where the text allows: a move rewrote the file's asset paths.
    pub fn accept_written(&mut self, text: String, cx: &mut Context<Self>) {
        self.disk = DiskVersion::Unread;
        self.replace_text(normalize_breaks(&text), cx);
    }

    /// Recount the words from the buffer's text, off the main thread.
    fn count_words(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).as_rope().clone();
        let counted = cx.background_spawn(async move { editor_status::count_words(&text) });
        self._count = Some(cx.spawn(async move |this, cx| {
            let words = counted.await;
            this.update(cx, |this, cx| {
                this.words = Some(words);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Put the cursor at the start of the 1-based `line` and scroll it to the
    /// middle of the editor.
    pub fn go_to_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        let point = Point::new(line.saturating_sub(1), 0);
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([point..point]),
            );
        });
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    fn deploy_search(&mut self, action: &Deploy, window: &mut Window, cx: &mut Context<Self>) {
        self.search_visible = true;
        self.search_bar.update(cx, |bar, cx| {
            bar.deploy(action, None, window, cx);
        });
        cx.notify();
    }
}

impl EventEmitter<PanelEvent> for EditorPanel {}
impl EventEmitter<EditorPanelEvent> for EditorPanel {}

impl Focusable for EditorPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl BasePanel for EditorPanel {
    fn panel_name(&self) -> &'static str {
        "EditorPanel"
    }

    fn on_removed(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.flush(cx);
    }
}

impl Panel for EditorPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(file_name(&self.path).into())
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = file_name(&self.path);
        if self.is_dirty(cx) {
            format!("{name} •")
        } else {
            name
        }
    }

    /// The build chip, at the strip's trailing end as the app puts it.
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        Some(editor_status::build_chip(&self.build, cx))
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        menu.menu("Build", Box::new(Build))
            .menu("Reveal cursor in PDF", Box::new(ForwardSync))
            .menu("Find", Box::new(Deploy::find()))
            .separator()
            .menu_with_check(
                "Vim mode",
                crate::app::vim_mode_enabled(cx),
                Box::new(ToggleVimMode),
            )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for EditorPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Zed's search bar registers its key handlers on whatever element
        // hosts it; in Zed that is a pane, here it is this panel.
        let palette = cx.palette().clone();
        let status: AnyElement = editor_status::status_bar(self, cx).into_any_element();
        let mut registrar =
            DivRegistrar::new(|this: &Self, _, _| Some(this.search_bar.clone()), cx);
        BufferSearchBar::register(&mut registrar);
        registrar
            .into_div()
            .key_context("LatticeEditor")
            .on_action(cx.listener(Self::deploy_search))
            .size_full()
            .flex()
            .flex_col()
            .when(self.search_visible, |panel| {
                panel.child(
                    div()
                        .px_2()
                        .py_1()
                        .border_b_1()
                        .border_color(palette.line)
                        .child(self.search_bar.clone()),
                )
            })
            .child(div().flex_1().min_h_0().child(self.lattice.clone()))
            .child(status)
            .child(crate::paint_probe::probe())
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
