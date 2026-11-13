//! What a click or Enter fetches (`use-paper-actions.ts`,
//! `use-reference-import.ts`): a paper with text opens; one known only by
//! its arXiv id or cited page downloads first, the box saying which stage
//! it is on with Cancel; an identifier the library does not hold is
//! imported, the pending row naming its stages. Cancel forgets the request
//! at once, so whatever the backend answers later is ignored.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{App, AppContext as _, Context, Window};
use lattice_core::papers::{self as core_papers, HistoryMode, PaperSummary};
use lattice_i18n::t;

use super::{
    FETCHED_LINGER, FetchState, Importing, PapersEvent, PapersPanel, model,
    model::{LineHit, RecentImport, ReferenceKind, paper_key},
};
use crate::notices;

impl PapersPanel {
    /// The paper the library already holds for an id typed in the box.
    pub(crate) fn duplicate(&self, cx: &App) -> Option<&PaperSummary> {
        let query = self.query(cx);
        match model::reference_kind(&query) {
            Some(ReferenceKind::Arxiv | ReferenceKind::Doi) => {
                model::find_in_library(&self.papers, &model::identity_of_input(&query))
            }
            _ => None,
        }
    }

    /// Enter: add an identifier the library does not hold, open the one it
    /// does; a title only searches, so Enter runs the full-text pass now.
    pub(super) fn enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.fetching.busy() {
            return;
        }
        match model::reference_kind(&self.query(cx)) {
            Some(ReferenceKind::Title) | None => self.search_now(cx),
            Some(_) => self.add(window, cx),
        }
    }

    /// The add row's action: open (or download) the paper the library
    /// holds, else import what the box holds.
    pub(crate) fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(duplicate) = self.duplicate(cx).cloned() {
            self.activate(&duplicate, None, window, cx);
            return;
        }
        let query = self.query(cx).trim().to_string();
        if query.is_empty() || self.importing.is_some() {
            return;
        }
        self.import(query, cx);
    }

    /// Import `input` as the box's Enter would, for Discover literature's
    /// Add; false when another import holds the pipeline.
    pub(crate) fn import_id(&mut self, input: String, cx: &mut Context<Self>) -> bool {
        if self.importing.is_some() || self.batch.running {
            return false;
        }
        self.import(input, cx);
        self.importing.is_some()
    }

    fn import(&mut self, query: String, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let (stages, mut stage_events) = mpsc::unbounded::<String>();
        let job_cancel = cancel.clone();
        let input = query.clone();
        let job = cx.background_spawn(async move {
            let progress = |stage: &str| {
                stages.unbounded_send(stage.to_string()).ok();
            };
            core_papers::import_reference(
                &root,
                &input,
                HistoryMode::Record,
                &progress,
                &job_cancel,
            )
        });
        let task = cx.spawn(async move |this, cx| {
            let mut job = std::pin::pin!(job);
            let result = loop {
                match futures::future::select(job.as_mut(), stage_events.next()).await {
                    futures::future::Either::Left((result, _)) => break result,
                    futures::future::Either::Right((Some(stage), _)) => {
                        this.update(cx, |this, cx| {
                            if let Some(importing) = &mut this.importing {
                                importing.stage = Some(stage);
                                importing.started = Instant::now();
                                cx.notify();
                            }
                        })
                        .ok();
                    }
                    futures::future::Either::Right((None, _)) => break job.await,
                }
            };
            this.update(cx, |this, cx| this.imported(query, result, cx))
                .ok();
        });
        self.importing = Some(Importing {
            label: self.query(cx).trim().to_string(),
            stage: None,
            started: Instant::now(),
            cancel,
            _task: task,
        });
        cx.notify();
    }

    fn imported(
        &mut self,
        query: String,
        result: Result<core_papers::ImportResult, String>,
        cx: &mut Context<Self>,
    ) {
        let cancelled = self
            .importing
            .take()
            .is_some_and(|importing| importing.cancel.load(Ordering::Acquire));
        match result {
            Ok(imported) => {
                // The row says it was added, with its key to copy, in place
                // of a toast; a search for what was typed keeps it first.
                if let Some(key) = &imported.citation_key {
                    self.just_added.insert(key.clone());
                }
                if !imported.arxiv_id.is_empty() {
                    self.just_added.insert(imported.arxiv_id.clone());
                }
                self.recent = Some(RecentImport {
                    query,
                    citation_key: imported.citation_key.clone(),
                    arxiv_id: imported.arxiv_id.clone(),
                });
                self.scroll
                    .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
                if let Some(error) = imported.fetch_error.filter(|_| !imported.cancelled) {
                    notices::show(
                        notices::Notice::new(
                            lattice_ui::components::ToastLevel::Info,
                            t!("Citation added without full text"),
                        )
                        .detail(error),
                        cx,
                    );
                }
            }
            Err(_) if cancelled => {}
            Err(error) => notices::error(t!("Could not add the paper"), error, cx),
        }
        self.reload(cx);
        cx.notify();
    }

    pub(crate) fn cancel_import(&mut self, cx: &mut Context<Self>) {
        if let Some(importing) = &self.importing {
            importing.cancel.store(true, Ordering::Release);
        }
        cx.notify();
    }

    /// How far the pending row's or the box's hairline has got: estimated
    /// motion over each stage, never 100% (`paperImportProgressAt`).
    pub(crate) fn progress(&self) -> Option<f32> {
        let (stage, started) = if let Some(importing) = &self.importing {
            (importing.stage.as_deref(), importing.started)
        } else if self.fetching.busy() {
            (self.fetching.stage.as_deref(), self.fetching.started?)
        } else {
            return None;
        };
        Some(model::progress_at(stage, started.elapsed()))
    }

    /// Open a paper with text (at a matched line), or download one that has
    /// none yet; a cited page with nothing to download opens in the browser.
    pub(crate) fn activate(
        &mut self,
        paper: &PaperSummary,
        hit: Option<&LineHit>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = paper_key(paper);
        if self.fetching.states.get(&key) == Some(&FetchState::Loading) {
            return;
        }
        if model::readable(paper) {
            // A matched line opens the text's source there; the paper
            // itself opens in its reader.
            cx.emit(match hit {
                Some(hit) => PapersEvent::Open {
                    path: hit.path.clone(),
                    line: Some(hit.line),
                },
                None => PapersEvent::Read(Box::new(paper.clone())),
            });
        } else if model::can_download(paper) {
            self.fetch(paper.clone(), cx);
        } else if let Some(url) = paper.url.as_deref() {
            cx.open_url(url);
        }
    }

    fn fetch(&mut self, paper: PaperSummary, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let key = paper_key(&paper);
        let cancel = Arc::new(AtomicBool::new(false));
        let (stages, mut stage_events) = mpsc::unbounded::<String>();
        let job_cancel = cancel.clone();
        // Two fetchable shapes: an arXiv id and a cited webpage; both return
        // the same bundle.
        let arxiv = !paper.arxiv_id.is_empty() && !paper.arxiv_id.starts_with("web-");
        let requested = if arxiv {
            paper.arxiv_id.clone()
        } else {
            paper.url.clone().unwrap_or_default()
        };
        let job = cx.background_spawn(async move {
            let progress = |stage: &str| {
                stages.unbounded_send(stage.to_string()).ok();
            };
            if arxiv {
                core_papers::fetch_paper(&root, &requested, &progress, &job_cancel)
            } else {
                core_papers::fetch_web_reference(&root, &requested, &job_cancel)
            }
        });
        let fetch_key = key.clone();
        let task = cx.spawn(async move |this, cx| {
            let mut job = std::pin::pin!(job);
            let result = loop {
                match futures::future::select(job.as_mut(), stage_events.next()).await {
                    futures::future::Either::Left((result, _)) => break result,
                    futures::future::Either::Right((Some(stage), _)) => {
                        this.update(cx, |this, cx| {
                            this.fetching.stage = Some(stage);
                            this.fetching.started = Some(Instant::now());
                            cx.notify();
                        })
                        .ok();
                    }
                    futures::future::Either::Right((None, _)) => break job.await,
                }
            };
            this.update(cx, |this, cx| this.fetched(fetch_key, result, cx))
                .ok();
        });
        self.fetching
            .states
            .insert(key.clone(), FetchState::Loading);
        self.fetching.cancels.insert(key, cancel);
        self.fetching.stage = None;
        self.fetching.started = Some(Instant::now());
        self.fetching.tasks.push(task);
        cx.notify();
    }

    fn fetched(
        &mut self,
        key: String,
        result: Result<core_papers::FetchResult, String>,
        cx: &mut Context<Self>,
    ) {
        // Cancel forgets the download at once; what it answers later is
        // ignored.
        let Some(cancel) = self.fetching.cancels.remove(&key) else {
            return;
        };
        if cancel.load(Ordering::Acquire) {
            return;
        }
        match result {
            Ok(fetched) => {
                self.fetching
                    .states
                    .insert(key.clone(), FetchState::Fetched);
                // The full text when the converter left one, else the overview.
                let path = Some(fetched.paper_path.clone())
                    .filter(|path| !path.is_empty())
                    .or(fetched.blog_path.clone());
                // The listed record predates the download: it opens with the
                // texts the download left.
                let listed = self.papers.iter().find(|paper| paper_key(paper) == key);
                match (listed, path) {
                    (Some(paper), Some(_)) => {
                        let mut paper = paper.clone();
                        paper.arxiv_id = fetched.arxiv_id.clone();
                        paper.has_full_text = !fetched.paper_path.is_empty();
                        paper.has_blog = fetched.blog_path.is_some();
                        cx.emit(PapersEvent::Read(Box::new(paper)));
                    }
                    (None, Some(path)) => cx.emit(PapersEvent::Open { path, line: None }),
                    (_, None) => {}
                }
                self._settle = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(FETCHED_LINGER).await;
                    this.update(cx, |this, cx| {
                        if this.fetching.states.get(&key) == Some(&FetchState::Fetched) {
                            this.fetching.states.remove(&key);
                            cx.notify();
                        }
                    })
                    .ok();
                }));
                self.reload(cx);
            }
            Err(error) => {
                self.fetching.states.remove(&key);
                notices::error(t!("Could not download the paper"), error, cx);
            }
        }
        if !self.fetching.busy() {
            self.fetching.stage = None;
            self.fetching.started = None;
            self.fetching.tasks.clear();
        }
        cx.notify();
    }

    /// Stop the downloads under way: each paper is left as it was, ready to
    /// download again.
    pub(crate) fn cancel_fetches(&mut self, cx: &mut Context<Self>) {
        for cancel in self.fetching.cancels.values() {
            cancel.store(true, Ordering::Release);
        }
        self.fetching.cancels.clear();
        self.fetching
            .states
            .retain(|_, state| *state != FetchState::Loading);
        self.fetching.stage = None;
        self.fetching.started = None;
        self.fetching.tasks.clear();
        cx.notify();
    }
}
