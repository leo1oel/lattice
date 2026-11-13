//! Discover literature (`literature-discovery-panel.tsx`): a drawer that
//! searches OpenAlex and alphaXiv through lattice-core (`literature::search`)
//! and lists what it found as Papers lists the library, each result opening
//! its preview (the abstract, or the passage alphaXiv matched, then who,
//! where from and which id) in place. A result with an arXiv id adds to
//! Papers in one click; any result can be added as a citation only, through
//! Add papers. The same work from both sources, or on two pages, is shown
//! once. Ten show at first and ten more as a scroll brings the list's end
//! near (or Load more is pressed); a deeper page is fetched only once those
//! run out.

use lattice_i18n::t;
use std::collections::HashSet;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollHandle,
    Subscription, Task, Window,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::models::LiteratureHit;

use super::{PapersPanel, model::base_arxiv_id};

mod view;

const INITIAL_VISIBLE: usize = 10;
const REVEAL_STEP: usize = 10;

pub enum LiteratureEvent {
    Dismiss,
    /// Add a citation for a result, through Add papers.
    AddCitation(String),
}

/// Identity across pages and sources, so the same paper is shown once.
fn dedup_key(hit: &LiteratureHit) -> String {
    match &hit.arxiv_id {
        Some(id) => base_arxiv_id(id).to_string(),
        None => hit.doi.clone().unwrap_or_else(|| hit.title.clone()),
    }
}

pub(super) fn hit_key(hit: &LiteratureHit) -> String {
    format!(
        "{}:{}",
        hit.source,
        hit.arxiv_id
            .as_deref()
            .or(hit.doi.as_deref())
            .unwrap_or(&hit.title)
    )
}

/// The search the results on screen came from: Load more pages this one,
/// never an edited but unsubmitted box.
#[derive(Clone, PartialEq, Eq)]
struct Searched {
    query: String,
    precise: bool,
}

pub struct Literature {
    papers: Entity<PapersPanel>,
    input: Entity<InputState>,
    pub(super) precise: bool,
    pub(super) results: Vec<LiteratureHit>,
    pub(super) visible: usize,
    pub(super) has_more: bool,
    pub(super) loading: bool,
    pub(super) loading_more: bool,
    pub(super) error: Option<String>,
    pub(super) notice: Option<String>,
    pub(super) shown_query: String,
    /// The result whose preview is open; one at a time.
    pub(super) open: Option<String>,
    /// The result being added to Papers.
    pub(super) busy: Option<String>,
    just_imported: HashSet<String>,
    searched: Option<Searched>,
    page: u32,
    seen: HashSet<String>,
    pub(super) scroll: ScrollHandle,
    /// Where the results end in the window, as last painted.
    pub(super) list_end: std::rc::Rc<std::cell::Cell<f32>>,
    focus: FocusHandle,
    _search: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<LiteratureEvent> for Literature {}

impl Literature {
    pub fn new(
        papers: Entity<PapersPanel>,
        query: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx)
                .placeholder(t!("Attention Is All You Need, diffusion, …"));
            state.set_value(query.clone(), window, cx);
            state
        });
        let enter = cx.subscribe_in(&input, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.search(cx);
            }
        });
        let refresh = cx.observe(&papers, |_, _, cx| cx.notify());
        let mut this = Self {
            papers,
            input,
            precise: true,
            results: Vec::new(),
            visible: INITIAL_VISIBLE,
            has_more: false,
            loading: false,
            loading_more: false,
            error: None,
            notice: None,
            shown_query: String::new(),
            open: None,
            busy: None,
            just_imported: HashSet::new(),
            searched: None,
            page: 0,
            seen: HashSet::new(),
            scroll: ScrollHandle::new(),
            list_end: Default::default(),
            focus: cx.focus_handle(),
            _search: None,
            _subscriptions: vec![enter, refresh],
        };
        // A query handed over from the Papers box is searched as it opens.
        if !query.trim().is_empty() {
            this.search(cx);
        }
        this
    }

    pub(super) fn input(&self) -> &Entity<InputState> {
        &self.input
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    fn fresh(&mut self, hits: Vec<LiteratureHit>) -> Vec<LiteratureHit> {
        hits.into_iter()
            .filter(|hit| self.seen.insert(dedup_key(hit)))
            .collect()
    }

    pub(super) fn search(&mut self, cx: &mut Context<Self>) {
        let query = self.input.read(cx).value().trim().to_string();
        if query.is_empty() {
            return;
        }
        let searched = Searched {
            query: query.clone(),
            precise: self.precise,
        };
        self.loading = true;
        self.error = None;
        self.notice = None;
        self.page = 0;
        self.seen.clear();
        self.searched = Some(searched.clone());
        let precise = self.precise;
        let page = cx
            .background_spawn(async move { lattice_core::literature::search(&query, precise, 0) });
        self._search = Some(cx.spawn(async move |this, cx| {
            let page = page.await;
            this.update(cx, |this, cx| {
                if this.searched.as_ref() != Some(&searched) {
                    return;
                }
                this.loading = false;
                this.open = None;
                this.visible = INITIAL_VISIBLE;
                match page {
                    Ok(page) => {
                        this.results = this.fresh(page.hits);
                        this.has_more = page.has_more;
                        this.shown_query = searched.query.clone();
                        if this.results.is_empty() {
                            this.notice = Some(
                                t!("No hits. Try broader terms or turn off precise mode.").into(),
                            );
                        }
                    }
                    Err(error) => {
                        this.results.clear();
                        this.has_more = false;
                        this.error = Some(error);
                    }
                }
                this.scroll
                    .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Reveal results already fetched first; only once they run out, fetch
    /// the next page of the search on screen.
    pub(super) fn load_more(&mut self, cx: &mut Context<Self>) {
        if self.visible < self.results.len() {
            self.visible = (self.visible + REVEAL_STEP).min(self.results.len());
            cx.notify();
            return;
        }
        let Some(searched) = self
            .searched
            .clone()
            .filter(|_| self.has_more && !self.loading_more)
        else {
            return;
        };
        self.loading_more = true;
        let next = self.page + 1;
        let (query, precise) = (searched.query.clone(), searched.precise);
        let page =
            cx.background_spawn(
                async move { lattice_core::literature::search(&query, precise, next) },
            );
        self._search = Some(cx.spawn(async move |this, cx| {
            let page = page.await;
            this.update(cx, |this, cx| {
                this.loading_more = false;
                // A new search started while this page was on its way: its
                // results belong to the old query.
                if this.searched.as_ref() != Some(&searched) {
                    return;
                }
                match page {
                    Ok(page) => {
                        this.page = next;
                        let fresh = this.fresh(page.hits);
                        this.results.extend(fresh);
                        this.has_more = page.has_more;
                        this.visible += REVEAL_STEP;
                    }
                    Err(error) => {
                        this.error = Some(error);
                        this.has_more = false;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn set_precise(&mut self, precise: bool, cx: &mut Context<Self>) {
        self.precise = precise;
        cx.notify();
    }

    pub(super) fn toggle(&mut self, key: String, cx: &mut Context<Self>) {
        self.open = if self.open.as_ref() == Some(&key) {
            None
        } else {
            Some(key)
        };
        cx.notify();
    }

    /// Whether Papers already holds the work.
    pub(super) fn imported(&self, hit: &LiteratureHit, cx: &App) -> bool {
        let Some(id) = hit.arxiv_id.as_deref() else {
            return false;
        };
        let base = base_arxiv_id(id);
        self.just_imported.contains(base)
            || self
                .papers
                .read(cx)
                .papers
                .iter()
                .any(|paper| base_arxiv_id(&paper.arxiv_id).eq_ignore_ascii_case(base))
    }

    /// Add the result to Papers by its arXiv id; one at a time.
    pub(super) fn add(&mut self, hit: &LiteratureHit, cx: &mut Context<Self>) {
        let (Some(id), None) = (hit.arxiv_id.clone(), self.busy.as_ref()) else {
            return;
        };
        let started = self
            .papers
            .update(cx, |papers, cx| papers.import_id(format!("arXiv:{id}"), cx));
        if started {
            self.busy = Some(hit_key(hit));
            self.just_imported.insert(base_arxiv_id(&id).to_string());
        }
        cx.notify();
    }

    /// The import the drawer started has finished.
    pub(super) fn settle_busy(&mut self, cx: &App) {
        if self.busy.is_some() && self.papers.read(cx).importing.is_none() {
            self.busy = None;
        }
    }

    pub(super) fn add_citation(&mut self, hit: &LiteratureHit, cx: &mut Context<Self>) {
        let seed = hit.doi.clone().unwrap_or_else(|| hit.title.clone());
        cx.emit(LiteratureEvent::AddCitation(seed));
    }

    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(LiteratureEvent::Dismiss);
    }
}

impl Focusable for Literature {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
