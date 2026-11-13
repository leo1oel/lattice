//! The Papers panel, as the Tauri app has it (`src/project/paper-library.tsx`
//! and its parts, `.papers-section` and `.paper-*` in
//! `src/styles/app-shell.css`): one box that searches the library and adds
//! what it does not hold, over the list of what the project's bibliography
//! cites.
//!
//! - The library is lattice-core's (`papers::list_papers`), read when the
//!   project opens and again after a change on disk settles, an import, a
//!   download or a removal; the venues come from the project's citation
//!   index, and where the manuscript cites each key from
//!   `project::citation_usages`, so the uses count and the cited filters
//!   say nothing until that scan lands.
//! - Typing filters by the papers' metadata at once and, 120 ms later, asks
//!   the full-text index (`papers::search_library_text`) for the papers
//!   their saved text matched, with their best lines; a pass that runs past
//!   400 ms says so above the list, and one that fails says the list holds
//!   metadata matches only.
//! - The toolbar counts what is shown, filters, sorts and groups
//!   (`toolbar.rs`); each row is drawn in `row.rs`; a wide panel shows the
//!   selected paper's inspector beside the list (`inspector.rs`).
//! - A click opens a paper with text (its reading file, at a matched line
//!   when a search hit was chosen), or downloads one that has none yet, the
//!   box showing the download's stage and a Cancel.
//! - Enter adds an arXiv id, DOI, URL or BibTeX entry the library does not
//!   hold (`papers::import_reference`), the pending row naming its stages; a
//!   known id says where it already is instead.
//!
//! Its hover is the app's fluid hover: one fill gliding between rows, never
//! on the open paper's row; its scrollbar is Lattice's.

use lattice_i18n::t;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use gpui::{
    App, AppContext as _, ClipboardItem, Context, Entity, EventEmitter, FocusHandle, Focusable,
    ScrollHandle, SharedString, Subscription, Task, Window,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::{InputEvent, InputState},
};
use lattice_core::papers::{self as core_papers, PaperSummary};

use crate::project::{Project, ProjectEvent};

pub mod add_sheet;
pub mod audit;
mod batch;
pub mod bib_editor;
mod downloads;
mod field;
mod inspector;
pub mod literature;
pub mod model;
pub mod reader;
mod removal;
mod row;
mod search;
mod toolbar;
mod view;

use model::{Facts, Filter, Group, RecentImport, Sort, TextMatch, paper_key};

/// How long typing pauses before the full-text pass runs (`usePaperTextSearch`).
const TEXT_SEARCH_DEBOUNCE: Duration = Duration::from_millis(120);
/// A full-text pass this long under way says so (`SEARCHING_NOTICE_MS`).
const SEARCHING_NOTICE: Duration = Duration::from_millis(400);
/// How long a burst of changes on disk settles before the library is read
/// again.
const RELOAD_SETTLE: Duration = Duration::from_millis(300);
/// How long a finished download keeps its row's glyph as "just fetched".
const FETCHED_LINGER: Duration = Duration::from_millis(1100);
/// The width of the list and inspector together from which a selected paper
/// shows its inspector, and the list becomes a table (`INSPECTOR_MIN_WIDTH`).
pub const WIDE: f32 = 860.;

/// What the panel asks the shell to do.
pub enum PapersEvent {
    /// Open a reading file of the project (project-relative), at a line.
    Open { path: String, line: Option<u32> },
    /// Read a saved paper in its reader (its full text, else its overview).
    Read(PaperSummary),
    /// Open Add papers, seeded with what the box holds.
    AddPapers(String),
    /// Search the literature for a title the library does not hold.
    SearchLiterature(String),
    /// Check the bibliography's references.
    CheckReferences,
}

/// What a stage id of the literature pipeline is doing, in words; an id it
/// does not know reads as working rather than as nothing.
pub fn stage_label(stage: Option<&str>) -> &'static str {
    match stage {
        Some("resolving") => t!("Resolving citation metadata…"),
        Some("fulltext") => t!("Downloading full text and figures…"),
        Some("overview") => t!("Fetching the paper overview…"),
        _ => t!("Working…"),
    }
}

/// Whether the library has been read: until then an empty list is not an
/// empty library.
#[derive(Clone, Debug, PartialEq)]
pub enum Load {
    Loading,
    Ready,
    Failed(String),
}

/// How far the full-text pass has got with the current query.
#[derive(Clone, Debug, PartialEq)]
pub enum TextSearch {
    /// No query.
    Idle,
    /// Under way, too briefly to say.
    Pending,
    /// Under way long enough to say so.
    Searching,
    /// It failed: the list holds metadata matches only.
    Failed(String),
    Done,
}

/// A download's glyph on its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchState {
    Loading,
    Fetched,
}

/// The import under way, in a row of its own under the box.
pub struct Importing {
    /// What was given: the pending row names it by this.
    pub label: String,
    pub stage: Option<String>,
    /// When the stage began: the hairline's estimate runs per stage.
    started: Instant,
    cancel: Arc<AtomicBool>,
    _task: Task<()>,
}

/// The downloads under way, and the stage the last one reported.
#[derive(Default)]
pub struct Fetching {
    pub states: HashMap<String, FetchState>,
    pub stage: Option<String>,
    started: Option<Instant>,
    cancels: HashMap<String, Arc<AtomicBool>>,
    tasks: Vec<Task<()>>,
}

impl Fetching {
    pub fn busy(&self) -> bool {
        self.states
            .values()
            .any(|state| *state == FetchState::Loading)
    }
}

pub struct PapersPanel {
    project: Option<Entity<Project>>,
    root: Option<PathBuf>,
    pub(crate) papers: Vec<PaperSummary>,
    pub(crate) load: Load,
    pub(crate) facts: Facts,
    /// Counts the scans of the manuscript's citations, for views that read
    /// them too (a `.bib` file's visual form).
    pub(crate) usage_revision: u64,
    input: Entity<InputState>,
    /// The query the text hits answer, and the hits by search identity.
    text_query: String,
    pub(crate) text_hits: HashMap<String, TextMatch>,
    pub(crate) text_search: TextSearch,
    text_generation: u64,
    text_task: Option<Task<()>>,
    /// Papers whose hits show beyond the first three.
    pub(crate) expanded_hits: HashSet<String>,
    pub(crate) sort: Sort,
    pub(crate) filter: Filter,
    pub(crate) group: Group,
    /// The paper selected in a wide panel, shown in the inspector.
    pub(crate) selected: Option<String>,
    /// The paper whose reading file is the open document.
    pub(crate) active: Option<String>,
    pub(crate) fetching: Fetching,
    pub(crate) importing: Option<Importing>,
    pub(crate) recent: Option<RecentImport>,
    /// Citation keys or arXiv ids this window just added.
    pub(crate) just_added: HashSet<String>,
    /// The panel's own width, learned while it is laid out.
    pub(crate) width: f32,
    pub(crate) scroll: ScrollHandle,
    /// Add papers' batch, which outlives the sheet.
    pub(crate) batch: batch::Batch,
    /// The selected papers' abstracts, read for the inspector.
    abstracts: inspector::Abstracts,
    focus_handle: FocusHandle,
    load_generation: u64,
    _load: Option<Task<()>>,
    _uses: Option<Task<()>>,
    _settle: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PanelEvent> for PapersPanel {}
impl EventEmitter<PapersEvent> for PapersPanel {}

impl PapersPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search or add papers")));
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.query_changed(cx),
                InputEvent::PressEnter { .. } => this.enter(window, cx),
                _ => {}
            });
        Self {
            project: None,
            root: None,
            papers: Vec::new(),
            load: Load::Loading,
            facts: Facts::default(),
            usage_revision: 0,
            input,
            text_query: String::new(),
            text_hits: HashMap::new(),
            text_search: TextSearch::Idle,
            text_generation: 0,
            text_task: None,
            expanded_hits: HashSet::new(),
            sort: Sort::default(),
            filter: Filter::default(),
            group: Group::default(),
            selected: None,
            active: None,
            fetching: Fetching::default(),
            importing: None,
            recent: None,
            just_added: HashSet::new(),
            width: 0.,
            scroll: ScrollHandle::new(),
            batch: batch::Batch::default(),
            abstracts: inspector::Abstracts::default(),
            focus_handle: cx.focus_handle(),
            load_generation: 0,
            _load: None,
            _uses: None,
            _settle: None,
            _subscriptions: vec![subscription],
        }
    }

    pub fn set_project(&mut self, project: Entity<Project>, cx: &mut Context<Self>) {
        let root = project.read(cx).root().to_path_buf();
        let index = project.read(cx).index().clone();
        self._subscriptions.truncate(1);
        self._subscriptions
            .push(cx.subscribe(&project, |this, _, event, cx| match event {
                ProjectEvent::FilesChanged(_) | ProjectEvent::ManifestChanged => {
                    this.reload_soon(cx)
                }
                ProjectEvent::TreeChanged | ProjectEvent::GitChanged => {}
            }));
        // The venues are the bibliography's, which the index reads.
        self._subscriptions
            .push(cx.observe(&index, |this, _, cx| this.read_venues(cx)));
        self.project = Some(project);
        self.root = Some(root);
        self.papers.clear();
        self.load = Load::Loading;
        self.facts = Facts::default();
        self.text_hits.clear();
        self.text_query.clear();
        self.text_search = TextSearch::Idle;
        self.selected = None;
        self.active = None;
        self.recent = None;
        self.just_added.clear();
        self.expanded_hits.clear();
        self.abstracts = inspector::Abstracts::default();
        self.cancel_fetches(cx);
        if let Some(importing) = self.importing.take() {
            importing.cancel.store(true, Ordering::Release);
        }
        self.read_venues(cx);
        self.reload(cx);
        self.query_changed(cx);
    }

    pub fn query(&self, cx: &App) -> String {
        self.input.read(cx).value().to_string()
    }

    pub(crate) fn input(&self) -> &Entity<InputState> {
        &self.input
    }

    /// The paper whose reading file is open in the editor in front, whose
    /// row is drawn as the open one.
    pub fn set_active_path(&mut self, path: Option<&str>, cx: &mut Context<Self>) {
        let active = path.and_then(|path| {
            let id = path.strip_prefix(".research/papers/")?.split('/').next()?;
            self.papers
                .iter()
                .find(|paper| paper.arxiv_id == id)
                .map(paper_key)
        });
        if self.active != active {
            self.active = active;
            cx.notify();
        }
    }

    fn read_venues(&mut self, cx: &mut Context<Self>) {
        let Some(project) = &self.project else {
            return;
        };
        let index = project.read(cx).index().read(cx);
        self.facts.venues = index
            .citations()
            .iter()
            .map(|citation| (citation.key.clone(), citation.venue.trim().to_string()))
            .collect();
        cx.notify();
    }

    fn reload_soon(&mut self, cx: &mut Context<Self>) {
        self._settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RELOAD_SETTLE).await;
            this.update(cx, |this, cx| this.reload(cx)).ok();
        }));
    }

    /// Read the library and the manuscript's citations again; a read that
    /// finishes after a newer one started is dropped.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.load_generation += 1;
        let generation = self.load_generation;
        let list_root = root.clone();
        let listing = cx.background_spawn(async move {
            let listed = core_papers::list_papers(&list_root);
            // Every import, download and removal ends in a listing: the
            // search after it should not wait for the index.
            if listed.is_ok() {
                core_papers::refresh_search_index(&list_root);
            }
            listed
        });
        self._load = Some(cx.spawn(async move |this, cx| {
            let listed = listing.await;
            this.update(cx, |this, cx| {
                if this.load_generation != generation {
                    return;
                }
                match listed {
                    Ok(papers) => {
                        this.papers = papers;
                        this.load = Load::Ready;
                    }
                    Err(error) => this.load = Load::Failed(error),
                }
                this.prune_selection();
                cx.notify();
            })
            .ok();
        }));
        let scan =
            cx.background_spawn(async move { lattice_core::project::citation_usages(&root) });
        self._uses = Some(cx.spawn(async move |this, cx| {
            let usages = scan.await;
            this.update(cx, |this, cx| {
                if this.load_generation != generation {
                    return;
                }
                this.facts.uses = usages.ok().map(Facts::group_uses);
                this.usage_revision += 1;
                cx.notify();
            })
            .ok();
        }));
    }

    fn prune_selection(&mut self) {
        if let Some(selected) = &self.selected
            && !self
                .papers
                .iter()
                .any(|paper| &paper_key(paper) == selected)
        {
            self.selected = None;
        }
    }

    // Search.

    // What the box adds.

    // A paper's actions.

    pub(crate) fn copy(&self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    pub(crate) fn reveal(&self, paper: &PaperSummary, cx: &mut Context<Self>) {
        if let Some(root) = &self.root {
            cx.reveal_path(&root.join(reading_path(paper)));
        }
    }

    pub fn open_add_sheet(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let seed = self.query(cx).trim().to_string();
        cx.emit(PapersEvent::AddPapers(seed));
    }

    pub(crate) fn search_literature(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let query = self.query(cx).trim().to_string();
        cx.emit(PapersEvent::SearchLiterature(query));
    }

    // Toolbar.

    pub(crate) fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    pub(crate) fn set_sort(&mut self, sort: Sort, cx: &mut Context<Self>) {
        self.sort = sort;
        cx.notify();
    }

    pub(crate) fn set_group(&mut self, group: Group, cx: &mut Context<Self>) {
        self.group = group;
        cx.notify();
    }

    /// Whether the manuscript's citations have been scanned, which the
    /// cited filters and sort need.
    pub(crate) fn uses_known(&self) -> bool {
        self.facts.uses.is_some()
    }

    /// The filter in force: a filter that needs the manuscript's citations
    /// waits for their scan.
    pub(crate) fn shown_filter(&self) -> Filter {
        if !self.uses_known() && self.filter.needs_uses() {
            Filter::All
        } else {
            self.filter
        }
    }

    pub(crate) fn wide(&self) -> bool {
        self.width >= WIDE
    }

    pub(crate) fn select(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        if self.selected != key {
            self.selected = key;
            cx.notify();
        }
    }

    /// The papers in the order the list shows them, after the search and
    /// the filter.
    pub(crate) fn shown<'a>(&'a self, cx: &App) -> Vec<&'a PaperSummary> {
        let query = self.query(cx);
        let empty = HashMap::new();
        let hits = self.current_hits(cx).unwrap_or(&empty);
        let filter = self.shown_filter();
        model::rank(
            &self.papers,
            &query,
            hits,
            self.recent.as_ref(),
            self.sort,
            &self.facts,
        )
        .into_iter()
        .filter(|paper| filter.keeps(paper, &self.facts))
        .collect()
    }

    /// The papers shown, by key, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn shown_titles(&self, cx: &App) -> Vec<String> {
        self.shown(cx)
            .into_iter()
            .map(|paper| paper.title.clone())
            .collect()
    }

    /// Type `text` into the box, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn type_query(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
        self.query_changed(cx);
    }

    /// Whether the library has been read and the text pass has answered.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn settled(&self, cx: &App) -> bool {
        self.load == Load::Ready
            && self.uses_known()
            && matches!(self.text_search, TextSearch::Idle | TextSearch::Done)
            && (self.query(cx).trim().is_empty() || self.current_hits(cx).is_some())
    }

    /// The open paper's key, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn active_key(&self) -> Option<String> {
        self.active.clone()
    }

    /// Open the paper titled `title` as a click on its row does, for a
    /// scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn open_titled(
        &mut self,
        title: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(paper) = self
            .papers
            .iter()
            .find(|paper| paper.title == title)
            .cloned()
        else {
            return false;
        };
        self.activate(&paper, None, window, cx);
        true
    }
}

/// A readable paper's reading file, from the project root: its full text,
/// else its overview.
pub fn reading_path(paper: &PaperSummary) -> String {
    let file = if paper.has_full_text {
        "paper.md"
    } else {
        "blog.md"
    };
    format!(".research/papers/{}/{file}", paper.arxiv_id)
}

impl Focusable for PapersPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for PapersPanel {
    fn panel_name(&self) -> &'static str {
        "PapersPanel"
    }

    /// Its tab's X takes it off screen, as the Tauri app's does; the Panels
    /// menu brings it back.
    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for PapersPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Papers").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        t!("Papers")
    }

    /// The strip's tools before ⋯, as the Tauri app's Papers panel has them
    /// (`trellis-panel-actions.tsx`): Discover literature, Add papers and
    /// Check references, each a 28px square on the panel's chrome with the
    /// tab's corners, a hairline apart.
    fn title_suffix(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<impl gpui::IntoElement> {
        use gpui::{ParentElement as _, Styled as _};
        use lattice_ui::{
            Icon,
            components::{IconButton, Surface, TAB_RADIUS},
        };
        let tool = |id: &'static str,
                    icon: Icon,
                    label: &'static str,
                    event: fn(&mut Self, &mut Window, &mut Context<Self>),
                    cx: &mut Context<Self>| {
            IconButton::new(id, icon)
                .radius(TAB_RADIUS)
                .surface(Surface::Chrome)
                .tooltip(label)
                .on_click(cx.listener(move |this, _, window, cx| event(this, window, cx)))
        };
        Some(
            gpui::div()
                .flex()
                .items_center()
                .gap(gpui::px(1.))
                .child(tool(
                    "papers-discover",
                    Icon::BOOK_OPEN,
                    t!("Discover literature"),
                    |_, _, cx| cx.emit(PapersEvent::SearchLiterature(String::new())),
                    cx,
                ))
                .child(tool(
                    "papers-add-sheet",
                    Icon::BOOK_MARKED,
                    t!("Add papers"),
                    |this, window, cx| this.open_add_sheet(window, cx),
                    cx,
                ))
                .child(tool(
                    "papers-check",
                    Icon::CLIPBOARD_CHECK,
                    t!("Check references"),
                    |_, _, cx| cx.emit(PapersEvent::CheckReferences),
                    cx,
                )),
        )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
