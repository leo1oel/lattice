//! Add papers (`add-papers-sheet.tsx`): one sheet for adding many at once.
//! Paste anything (DOIs, arXiv ids, links, titles or BibTeX, one per line or
//! a whole .bib) and each reference becomes a card, looked up as it lands
//! (`project::resolve_citation_query`, three at a time). What the library
//! already holds is set aside, a title that matches more than one record
//! waits for a choice, and nothing is written until the writer adds; then
//! the Papers panel imports each in turn (`batch.rs`) and the sheet can
//! close while the writer keeps writing. It reads the box once typing
//! pauses (450 ms), so a half-typed DOI is not looked up letter by letter.

use lattice_i18n::t;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, Subscription,
    Task, Window,
};
use gpui_kit::component::input::{InputEvent, TextareaState};
use lattice_core::{models::ResolvedCitation, papers::PaperSummary};

use super::{
    PapersPanel,
    batch::BatchRequest,
    model::{self, PastedReference, ReferenceKind},
};

mod view;

/// What a paste looks like: one of each kind the box reads. Identifiers and
/// BibTeX read the same in every locale, and so does a cited title.
const PASTE_EXAMPLE: &str = "10.1038/s41586-021-03819-2\narXiv:1706.03762\nhttps://aclanthology.org/…\nAttention is all you need\n@article{…}";
/// Lookups run a few at a time: a pasted .bib of titles must not fire a
/// hundred requests at once.
const LOOKUPS_AT_ONCE: usize = 3;
const SETTLE: Duration = Duration::from_millis(450);

pub enum AddPapersEvent {
    /// Enter a reference by hand, in its own sheet.
    EnterManually,
    Dismiss,
}

enum Lookup {
    Done(Box<ResolvedCitation>),
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Resolving,
    New,
    Duplicate,
    Choose,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    All,
    New,
    Duplicate,
    Choose,
}

impl Tab {
    pub fn label(self) -> &'static str {
        match self {
            Tab::All => t!("All"),
            Tab::New => t!("New"),
            Tab::Duplicate => t!("Already in Papers"),
            Tab::Choose => t!("Several matches"),
        }
    }

    fn keeps(self, state: RowState) -> bool {
        match self {
            Tab::All => true,
            Tab::New => state == RowState::New,
            Tab::Duplicate => state == RowState::Duplicate,
            Tab::Choose => state == RowState::Choose,
        }
    }
}

/// A reference's card: what it is, what happens to it, and what the import
/// is given once the writer adds.
#[derive(Clone)]
pub struct Row {
    pub reference: PastedReference,
    pub state: RowState,
    pub title: String,
    pub byline: String,
    /// The citation key of the paper already in the library.
    pub existing_key: Option<String>,
    pub candidates: Vec<ResolvedCitation>,
    pub import_input: Option<String>,
    pub error: Option<String>,
}

pub struct AddPapers {
    papers: Entity<PapersPanel>,
    text: Entity<TextareaState>,
    /// The box as it was when typing last paused.
    settled: String,
    references: Vec<PastedReference>,
    lookups: HashMap<String, Lookup>,
    pending: HashSet<String>,
    /// The record the writer chose for a title that matched several, by row.
    chosen: HashMap<String, usize>,
    /// The row whose candidates are open, and the one highlighted there.
    pub(super) choosing: Option<(String, usize)>,
    pub(super) tab: Tab,
    /// The Zotero library, browsed in place of the paste box.
    pub(super) zotero: Option<Entity<super::zotero::ZoteroBrowser>>,
    focus: FocusHandle,
    _settle: Option<Task<()>>,
    _lookups: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<AddPapersEvent> for AddPapers {}

impl AddPapers {
    pub fn new(
        papers: Entity<PapersPanel>,
        seed: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(PASTE_EXAMPLE)
                .default_value(seed.clone())
        });
        let typed = cx.subscribe_in(&text, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::Change) {
                this.typed(cx);
            }
        });
        let refresh = cx.observe(&papers, |_, _, cx| cx.notify());
        let mut this = Self {
            papers,
            text,
            settled: String::new(),
            references: Vec::new(),
            lookups: HashMap::new(),
            pending: HashSet::new(),
            chosen: HashMap::new(),
            choosing: None,
            tab: Tab::default(),
            zotero: None,
            focus: cx.focus_handle(),
            _settle: None,
            _lookups: Vec::new(),
            _subscriptions: vec![typed, refresh],
        };
        this.settle(seed, cx);
        this
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.text.update(cx, |text, cx| text.focus(window, cx));
    }

    fn typed(&mut self, cx: &mut Context<Self>) {
        let text = self.text.read(cx).value().to_string();
        self._settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            this.update(cx, |this, cx| this.settle(text, cx)).ok();
        }));
    }

    fn settle(&mut self, text: String, cx: &mut Context<Self>) {
        if text == self.settled && !self.references.is_empty() {
            return;
        }
        self.references = model::parse_pasted_references(&text);
        self.settled = text;
        self.look_up(cx);
        cx.notify();
    }

    /// Look up what still needs it, a few at a time; each answer starts the
    /// next.
    fn look_up(&mut self, cx: &mut Context<Self>) {
        let waiting: Vec<PastedReference> = self
            .rows(cx)
            .into_iter()
            .filter(|row| {
                row.state == RowState::Resolving && !self.pending.contains(&row.reference.id)
            })
            .map(|row| row.reference)
            .collect();
        let room = LOOKUPS_AT_ONCE.saturating_sub(self.pending.len());
        for reference in waiting.into_iter().take(room) {
            self.pending.insert(reference.id.clone());
            let input = reference.input.clone();
            let lookup = cx.background_spawn(async move {
                lattice_core::project::resolve_citation_query(&input)
            });
            let id = reference.id.clone();
            self._lookups.push(cx.spawn(async move |this, cx| {
                let found = lookup.await;
                this.update(cx, |this, cx| {
                    this.pending.remove(&id);
                    this.lookups.insert(
                        id,
                        match found {
                            Ok(resolved) => Lookup::Done(Box::new(resolved)),
                            Err(error) => Lookup::Failed(error),
                        },
                    );
                    this.look_up(cx);
                    cx.notify();
                })
                .ok();
            }));
        }
    }

    fn library<'a>(&self, cx: &'a App) -> &'a [PaperSummary] {
        &self.papers.read(cx).papers
    }

    /// Every reference's card, from what the box holds, what the lookups
    /// answered and what the library already has.
    pub(super) fn rows(&self, cx: &App) -> Vec<Row> {
        let library = self.library(cx);
        self.references
            .iter()
            .map(|reference| {
                let from_library = |paper: &PaperSummary| Row {
                    reference: reference.clone(),
                    state: RowState::Duplicate,
                    title: paper.title.clone(),
                    byline: model::byline_of([
                        model::short_authors(paper).as_deref().unwrap_or(""),
                        paper.year.as_deref().unwrap_or(""),
                    ]),
                    existing_key: paper.citation_key.clone(),
                    candidates: Vec::new(),
                    import_input: None,
                    error: None,
                };
                let row = |state, title: String, byline: String| Row {
                    reference: reference.clone(),
                    state,
                    title,
                    byline,
                    existing_key: None,
                    candidates: Vec::new(),
                    import_input: None,
                    error: None,
                };
                if let Some(record) = &reference.record {
                    if let Some(existing) = model::find_in_library(library, &record.identity) {
                        return from_library(existing);
                    }
                    return Row {
                        import_input: Some(reference.input.clone()),
                        ..row(RowState::New, record.title.clone(), record.byline.clone())
                    };
                }
                // An identifier the library already holds needs no lookup.
                if reference.kind != ReferenceKind::Title {
                    if let Some(known) =
                        model::find_in_library(library, &model::identity_of_input(&reference.input))
                    {
                        return from_library(known);
                    }
                }
                match self.lookups.get(&reference.id) {
                    None => row(
                        RowState::Resolving,
                        reference.label.clone(),
                        t!("Looking up…").into(),
                    ),
                    Some(Lookup::Failed(error)) => Row {
                        error: Some(error.clone()),
                        ..row(
                            RowState::Failed,
                            reference.label.clone(),
                            t!("Couldn't find this one").into(),
                        )
                    },
                    Some(Lookup::Done(resolved)) => {
                        let candidates = resolved.candidates.clone();
                        let pick = self
                            .chosen
                            .get(&reference.id)
                            .and_then(|at| candidates.get(*at));
                        if !candidates.is_empty() && pick.is_none() {
                            let byline = if candidates.len() == 1 {
                                t!("One record matches").to_string()
                            } else {
                                t!("{0} records match", candidates.len())
                            };
                            return Row {
                                candidates,
                                ..row(RowState::Choose, reference.label.clone(), byline)
                            };
                        }
                        let chosen = pick.unwrap_or(resolved);
                        let record = model::record_of_resolved(chosen);
                        if let Some(existing) = model::find_in_library(library, &record.identity) {
                            return from_library(existing);
                        }
                        // An identifier imports as itself, so the pipeline
                        // can still fetch its full text; a title imports as
                        // the record it resolved to, never as a second search
                        // that could land on another work.
                        let import_input =
                            if reference.kind == ReferenceKind::Title || pick.is_some() {
                                chosen.bibtex.clone()
                            } else {
                                reference.input.clone()
                            };
                        let title = if record.title.is_empty() {
                            reference.label.clone()
                        } else {
                            record.title.clone()
                        };
                        Row {
                            candidates,
                            import_input: Some(import_input),
                            ..row(RowState::New, title, record.byline)
                        }
                    }
                }
            })
            .collect()
    }

    pub(super) fn shown(&self, rows: &[Row]) -> Vec<Row> {
        rows.iter()
            .filter(|row| self.tab.keeps(row.state))
            .cloned()
            .collect()
    }

    pub(super) fn set_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        self.tab = tab;
        cx.notify();
    }

    pub(super) fn open_candidates(&mut self, id: &str, cx: &mut Context<Self>) {
        self.choosing = match &self.choosing {
            Some((open, _)) if open == id => None,
            _ => Some((id.to_string(), self.chosen.get(id).copied().unwrap_or(0))),
        };
        cx.notify();
    }

    pub(super) fn highlight_candidate(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some((_, at)) = &mut self.choosing {
            *at = index;
            cx.notify();
        }
    }

    pub(super) fn use_candidate(&mut self, cx: &mut Context<Self>) {
        if let Some((id, index)) = self.choosing.take() {
            self.chosen.insert(id, index);
        }
        cx.notify();
    }

    /// Add every new reference, as a batch the Papers panel imports.
    pub(super) fn add(&mut self, cx: &mut Context<Self>) {
        let requests: Vec<BatchRequest> = self
            .rows(cx)
            .into_iter()
            .filter(|row| row.state == RowState::New)
            .filter_map(|row| {
                Some(BatchRequest {
                    id: row.reference.id.clone(),
                    input: row.import_input?,
                    label: row.title,
                    zotero: None,
                })
            })
            .collect();
        self.papers
            .update(cx, |papers, cx| papers.run_batch(requests, cx));
    }

    /// The Zotero library, in place of the paste box; its ticked papers go
    /// to the same queue, each with its PDF and annotations.
    pub fn open_zotero(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use super::zotero::{ZoteroBrowser, ZoteroBrowserEvent};
        let papers = self.papers.clone();
        let browser = cx.new(|cx| ZoteroBrowser::new(papers, window, cx));
        let events = cx.subscribe(&browser, |this, _, event: &ZoteroBrowserEvent, cx| {
            match event {
                ZoteroBrowserEvent::Add {
                    papers,
                    library,
                    data_dir,
                } => {
                    let requests: Vec<BatchRequest> = papers
                        .iter()
                        .map(|paper| {
                            let item = &library.items[paper.item];
                            BatchRequest {
                                id: format!("zotero:{}", paper.citation_key),
                                input: item.bibtex.clone(),
                                label: paper.title.clone(),
                                zotero: Some(super::batch::ZoteroExtras {
                                    pdf: paper.pdf.clone(),
                                    existing: paper
                                        .existing
                                        .as_ref()
                                        .and_then(|existing| existing.citation_key.clone()),
                                    annotations: (paper.annotations > 0).then(|| item.key.clone()),
                                    data_dir: data_dir.clone(),
                                }),
                            }
                        })
                        .collect();
                    this.papers
                        .update(cx, |papers, cx| papers.run_batch(requests, cx));
                    this.zotero = None;
                }
                ZoteroBrowserEvent::Back => this.zotero = None,
            }
            cx.notify();
        });
        self._subscriptions.push(events);
        self.zotero = Some(browser);
        cx.notify();
    }

    /// The Zotero browser, while it stands in place of the paste box.
    pub fn zotero(&self) -> Option<&Entity<super::zotero::ZoteroBrowser>> {
        self.zotero.as_ref()
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        self.papers.update(cx, |papers, cx| papers.stop_batch(cx));
    }

    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        self.papers.update(cx, |papers, cx| papers.clear_batch(cx));
        cx.emit(AddPapersEvent::Dismiss);
    }

    /// Whether closing would lose what was pasted.
    pub(super) fn dirty(&self, cx: &App) -> bool {
        let ticked = self
            .zotero
            .as_ref()
            .is_some_and(|zotero| zotero.read(cx).ticked_count(cx) > 0);
        (!self.text.read(cx).value().trim().is_empty() || ticked)
            && self.papers.read(cx).batch.items.is_empty()
    }

    /// The cards' titles and states, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn row_states(&self, cx: &App) -> Vec<(String, RowState)> {
        self.rows(cx)
            .into_iter()
            .map(|row| (row.title, row.state))
            .collect()
    }

    /// Close without adding, as Cancel does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn cancel(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.close(cx);
    }

    /// Paste `text` as a writer would, read at once, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn paste(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.text.update(cx, |state, cx| {
            state.set_value(text.to_string(), window, cx)
        });
        self.settle(text.to_string(), cx);
    }
}

impl Focusable for AddPapers {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
