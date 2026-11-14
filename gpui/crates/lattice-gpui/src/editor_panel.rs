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
    Subscription, Task, Window, div,
};
use gpui_kit::component::dock::{BasePanel, PanelEvent};
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

mod buffer_counts;
mod disk_sync;
mod markdown_view;
mod outline_panel;
pub mod outline_rail;
pub mod rail_outline;
mod save;
mod source_chrome;
mod spelling;
mod strip;
mod structured_view;
pub mod views;

use disk_sync::vanished_key;
use outline_rail::OutlineRail;
use save::normalize_breaks;
pub use views::DocumentView;
use views::DocumentViews;

gpui::actions!(
    lattice_document,
    [
        /// Show an HTML file's source ("Edit").
        ViewSource,
        /// Show an HTML file's source beside its preview.
        ViewSplit,
        /// Show an HTML file's preview alone.
        ViewPreview,
    ]
);

use crate::{build_panel::BuildPanel, editor_status, project::Project};
use buffer_counts::TODO_SETTLE;

/// How often the open file is checked for an edit made behind the editor.
const DISK_POLL: Duration = Duration::from_millis(2500);
gpui::actions!(
    lattice_editor_panel,
    [
        /// A .tex file's Source view (the only one the preview has).
        ShowSourceView,
        /// A .tex file's Visual view: not in the GPUI preview yet.
        ShowVisualView,
    ]
);

/// Why a .tex file's Visual view cannot be chosen here.
pub const VISUAL_NOT_PORTED: &str = "Visual: not in the GPUI preview yet";

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
    /// The caret moved to another line.
    CaretLine,
    /// The editor took focus: it is the one the reader works in now.
    Focused,
    /// Open the project-relative `path` (a link followed in a Markdown file's
    /// visual editor).
    OpenFile { path: String },
    /// An outline rail row: open `path` at the 1-based `line`, then show
    /// the same place in the PDF.
    OutlineJump { path: String, line: u32 },
    /// The buffer's text changed: what the live preview follows.
    Edited,
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
    /// The spell check, for a `.tex`, `.md` or `.txt` file (`spelling`).
    spelling: Option<Entity<lattice_editor::latex::spelling::Spelling>>,
    _spelling_events: Option<Subscription>,
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
    /// The TODO markers in the buffer as of the last pause in typing, for
    /// the status bar's counter (`status_counters`); `None` for a file
    /// counted from the disk scan alone.
    buffer_todos: Option<usize>,
    /// The status bar's width as last drawn, which decides what it folds
    /// (`editor_status::StatusFolds`).
    status_width: std::rc::Rc<std::cell::Cell<Option<gpui::Pixels>>>,
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
    /// An HTML file's Edit, Split and Preview views; `None` for a file
    /// that is only ever its source.
    views: Option<DocumentViews>,
    /// A board, spreadsheet or Open Slide deck: its island in place of the
    /// editor (`crate::structured`).
    structured: Option<Entity<crate::structured::StructuredDocument>>,
    /// A closing tab waits for its page to hand over its edits.
    page_flushed: Option<oneshot::Sender<()>>,
    /// Which side of a Markdown file's Split moved last, and when: `true` for
    /// the source (`markdown_view.rs`).
    markdown_led: Option<(bool, std::time::Instant)>,
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
    /// The outline rail on a `.tex` file's right edge, and the editor's
    /// width as last drawn, which decides whether it has room.
    rail: Option<Entity<OutlineRail>>,
    editor_width: std::rc::Rc<std::cell::Cell<Option<gpui::Pixels>>>,
    _autosave: Option<Task<()>>,
    _count: Option<Task<()>>,
    _todos: Option<Task<()>>,
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
        // A Markdown file's inline text and fenced blocks are injections,
        // resolved through the registry; a buffer moved to `.md` needs it too.
        let registry = lattice_editor::markdown::registry(cx);
        buffer.update(cx, |buffer, cx| {
            buffer.set_language_registry(registry);
            buffer.set_language(language, cx);
        });
        let languaged = started.elapsed();
        let lattice = cx.new(|cx| LatticeEditor::new(buffer.clone(), window, cx));
        let editor = lattice.read(cx).editor().clone();
        let tex = latex::is_tex_source(&path);
        lattice.update(cx, |lattice, cx| {
            lattice.set_fold_source(tex.then(latex::folding::source), cx)
        });
        let rail = tex
            .then(|| Self::new_rail(&lattice, &project, relative.clone(), saved_text.clone(), cx));
        let diagnostics = latex::is_tex_source(&path)
            .then(|| attach_latex(&lattice, &project, relative.clone(), cx));
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
        let counters = crate::status_counters::project_counters(cx);
        let subscriptions = vec![
            // The status bar's counters land after the project's scan.
            cx.observe(&counters, |_, _, cx| cx.notify()),
            // The tab shows whether the file has unsaved edits; an edit
            // arms the autosave.
            cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| match event {
                BufferEvent::Edited { .. } => {
                    cx.emit(EditorPanelEvent::Edited);
                    this.schedule_autosave(cx);
                    this.scan_todos(TODO_SETTLE, cx);
                    this.views_source_changed(cx);
                    this.structured_source_changed(cx);
                }
                BufferEvent::DirtyChanged | BufferEvent::Saved => cx.notify(),
                _ => {}
            }),
            // The build chip in this panel's strip follows the build, and
            // TexLab reads each finished build's log (for the document it has
            // open, or the one the writer is in).
            cx.observe(&build, |this, build, cx| {
                let builds = build.read(cx).builds();
                if builds != this.builds_seen {
                    this.builds_seen = builds;
                    if let Some(rail) = &this.rail {
                        rail.update(cx, |rail, cx| rail.build_finished(cx));
                    }
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
                        let line = head.row + 1;
                        let moved = this.cursor.0 != line;
                        this.cursor = (line, column);
                        if moved {
                            cx.emit(EditorPanelEvent::CaretLine);
                        }
                        cx.notify();
                    }
                    EditorEvent::Focused => {
                        if let Some(diagnostics) = &this.diagnostics {
                            diagnostics
                                .update(cx, |diagnostics, cx| diagnostics.set_focused(true, cx));
                        }
                        cx.emit(EditorPanelEvent::Focused);
                    }
                    // A Markdown file's Split: the visual editor follows.
                    EditorEvent::ScrollPositionChanged { .. } => this.markdown_source_scrolled(cx),
                    // Leaving the editor saves at once, as the Tauri app does.
                    EditorEvent::Blurred => {
                        if let Some(diagnostics) = &this.diagnostics {
                            diagnostics
                                .update(cx, |diagnostics, cx| diagnostics.set_focused(false, cx));
                        }
                        this.leave(cx)
                    }
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
                if let crate::project::ProjectEvent::FilesChanged(paths) = event {
                    if paths
                        .as_ref()
                        .is_none_or(|paths| paths.iter().any(|path| *path == this.relative))
                    {
                        this.check_disk(cx);
                    }
                    this.structured_files_changed(paths.as_deref(), cx);
                    // An image the HTML preview shows may be among them.
                    if paths
                        .as_ref()
                        .is_none_or(|paths| paths.iter().any(|path| *path != this.relative))
                    {
                        this.views_assets_changed(cx);
                    }
                }
                // The project's dictionary or ignores may have changed.
                if matches!(event, crate::project::ProjectEvent::ManifestChanged) {
                    this.refresh_spelling(cx);
                }
            }),
            // Check spelling turned on or off.
            cx.observe_global::<crate::settings::AppSettings>(|this, cx| this.refresh_spelling(cx)),
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
        let views = views::has_views(&path).then(|| DocumentViews::new(&path, cx));
        let mut this = Self {
            project,
            path,
            relative,
            buffer,
            lattice,
            editor,
            diagnostics,
            spelling: None,
            _spelling_events: None,
            builds_seen,
            search_bar,
            search_visible: false,
            build,
            cursor: (1, 1),
            words: None,
            buffer_todos: None,
            status_width: Default::default(),
            saved_text,
            last_file_id: stat
                .as_ref()
                .map(|stat| stat.file_id.clone())
                .unwrap_or_default(),
            disk: stat.map_or(DiskVersion::Unknown, DiskVersion::Seen),
            vanished: None,
            looking_for_file: false,
            closed: false,
            views,
            structured: None,
            page_flushed: None,
            markdown_led: None,
            status: SaveStatus::Saved,
            save_queue: None,
            saves_pending: 0,
            save_generation: 0,
            writing: None,
            rail,
            editor_width: Default::default(),
            _autosave: None,
            _count: None,
            _todos: None,
            _poll: poll,
            _subscriptions: subscriptions,
        };
        this.count_words(cx);
        this.scan_todos(Duration::ZERO, cx);
        this.offer_view_switch(cx);
        // An HTML file opening in Preview or Split has its preview at once;
        // its page is built when the tab is first shown.
        this.ensure_preview(window, cx);
        this.attach_structured(window, cx);
        this.attach_spelling(cx);
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

    /// The file's text as last loaded or saved: what is on disk, as far as
    /// this editor knows.
    pub fn saved_text(&self) -> &str {
        &self.saved_text
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

    pub(crate) fn status_width(&self) -> &std::rc::Rc<std::cell::Cell<Option<gpui::Pixels>>> {
        &self.status_width
    }

    pub(crate) fn buffer_todos(&self) -> Option<usize> {
        self.buffer_todos
    }

    /// The folder of the project the file belongs to.
    pub(crate) fn project_root(&self, cx: &App) -> PathBuf {
        self.project.read(cx).root().to_path_buf()
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
        } else if latex::is_tex_source(&self.path) {
            self.diagnostics = Some(attach_latex(
                &self.lattice,
                &self.project,
                relative.clone(),
                cx,
            ));
        }
        if let Some(document) = self
            .structured
            .clone()
            .or_else(|| self.markdown_document().cloned())
        {
            let relative = relative.clone();
            document.update(cx, |document, cx| document.moved_to(relative, cx));
        }
        let left = std::mem::replace(&mut self.relative, relative);
        crate::status_counters::set_buffer(root.clone(), left, None, cx);
        self.scan_todos(Duration::ZERO, cx);
        // The spell check follows the file, or starts once it is prose.
        match &self.spelling {
            Some(spelling) => {
                let relative = self.relative.clone();
                spelling.update(cx, |spelling, cx| spelling.set_path(relative, cx));
            }
            None => self.attach_spelling(cx),
        }
        self.disk = DiskVersion::Unread;
        let language = latex::language_for_path(&self.path, cx);
        self.buffer
            .update(cx, |buffer, cx| buffer.set_language(language, cx));
        let tex = latex::is_tex_source(&self.path);
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_fold_source(tex.then(latex::folding::source), cx)
        });
        match (&self.rail, tex) {
            (Some(rail), true) => {
                let path = self.relative.clone();
                let source = self.buffer.read(cx).text();
                rail.update(cx, |rail, cx| rail.set_source(path, source, cx));
            }
            (Some(_), false) => self.rail = None,
            (None, true) => {
                let source = self.buffer.read(cx).text();
                self.rail = Some(Self::new_rail(
                    &self.lattice,
                    &self.project,
                    self.relative.clone(),
                    source,
                    cx,
                ));
            }
            (None, false) => {}
        }
        self.offer_view_switch(cx);
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

    /// Put the cursor at the start of the 1-based `line` and scroll it to the
    /// middle of the editor.
    pub fn go_to_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        // Markdown's Preview is its visual editor, which takes the jump.
        if let Some(document) = self.jumps_in_preview() {
            document.update(cx, |document, cx| document.reveal_line(line, cx));
            if let Some(focus) = document.read(cx).focus_handle(cx) {
                window.focus(&focus, cx);
            }
            return;
        }
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
    /// The editor's, except while an HTML file shows only its preview.
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if let Some(focus) = self
            .structured
            .as_ref()
            .and_then(|document| document.read(cx).focus_handle(cx))
        {
            return focus;
        }
        match self.views.as_ref() {
            Some(views) if views.view() == DocumentView::Preview => views
                .preview()
                .and_then(|preview| preview.focus_handle(cx))
                .unwrap_or_else(|| self.editor.focus_handle(cx)),
            _ => self.editor.focus_handle(cx),
        }
    }
}

impl BasePanel for EditorPanel {
    fn panel_name(&self) -> &'static str {
        "EditorPanel"
    }

    fn on_added_to(
        &mut self,
        _: gpui::WeakEntity<gpui_kit::component::dock::TabGroup>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.offer_view_switch(cx);
    }

    fn on_removed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.views_shown(false, window, cx);
        // A structured document's page hands over its edits first.
        if !self.close_structured(cx) {
            self.flush(cx);
        }
        let root = self.project_root(cx);
        crate::status_counters::set_buffer(root, self.relative.clone(), None, cx);
        let panel = gpui_kit::component::dock::PanelId::from(cx.entity_id());
        lattice_ui::dock::set_spare_tools(panel, None, cx);
        lattice_ui::dock::set_icon_saving(panel, None, cx);
    }

    /// An HTML file's preview is shown only while its tab is the displayed one.
    fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.views_shown(active, window, cx);
        self.structured_shown(active, cx);
    }
}

impl Render for EditorPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Zed's search bar registers its key handlers on whatever element
        // hosts it; in Zed that is a pane, here it is this panel.
        // A board, sheet or deck fills its panel alone: no status bar.
        if let Some(document) = self.structured.clone() {
            return div()
                .key_context("LatticeEditor")
                .size_full()
                .flex()
                .flex_col()
                .child(div().flex_1().min_h_0().child(document))
                .child(crate::paint_probe::probe())
                .into_any_element();
        }
        let palette = cx.palette().clone();
        let status: AnyElement = editor_status::status_bar(self, cx).into_any_element();
        let search = self.search_visible.then(|| {
            div()
                .px_2()
                .py_1()
                .border_b_1()
                .border_color(palette.line)
                .child(self.search_bar.clone())
        });
        let editor = div()
            .size_full()
            .flex()
            .flex_col()
            .children(search)
            .child(self.render_source(window, cx))
            .into_any_element();
        let body = self.render_views(editor, status, cx);
        let mut registrar =
            DivRegistrar::new(|this: &Self, _, _| Some(this.search_bar.clone()), cx);
        BufferSearchBar::register(&mut registrar);
        registrar
            .into_div()
            .key_context("LatticeEditor")
            .on_action(cx.listener(Self::deploy_search))
            .on_action(cx.listener(|this, _: &ViewSource, window, cx| {
                this.set_document_view(DocumentView::Source, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ViewSplit, window, cx| {
                this.set_document_view(DocumentView::Split, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ViewPreview, window, cx| {
                this.set_document_view(DocumentView::Preview, window, cx)
            }))
            .size_full()
            .flex()
            .flex_col()
            .child(div().flex_1().min_h_0().child(body))
            .child(crate::paint_probe::probe())
            .into_any_element()
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Put the LaTeX extensions that read the project on `lattice` (cards and
/// completion), and TexLab's diagnostics for the file at `relative`.
fn attach_latex(
    lattice: &Entity<LatticeEditor>,
    project: &Entity<Project>,
    relative: String,
    cx: &mut App,
) -> Entity<TexlabDiagnostics> {
    let index = project.read(cx).index().clone();
    lattice.update(cx, |lattice, _| latex::attach(lattice, &index));
    let texlab = project.read(cx).texlab().clone();
    TexlabDiagnostics::attach(lattice, texlab, relative, cx)
}
