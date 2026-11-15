//! What a click or Enter fetches (`use-paper-actions.ts`,
//! `use-reference-import.ts`): a paper with text opens; one known only by
//! its arXiv id or cited page downloads first, the box saying which stage
//! it is on with Cancel; an identifier the library does not hold is
//! imported, the pending row naming its stages. Cancel forgets the request
//! at once, so whatever the backend answers later is ignored, and a download
//! opens its paper only while it is still the writer's latest navigation.

use std::{
    path::PathBuf,
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

/// What an import says when it lands (`ImportNotices`): Discover
/// literature's says everything; the box's and a reviewed title's settle as
/// a "Just added" row, so only what that row cannot say is said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Notices {
    All,
    Problems,
}

/// What an import came to (`use-reference-import.ts`). The box's own adds
/// settle as a "Just added" row with the key to copy, so with
/// `Notices::Problems` only a cancellation, a duplicate or a missing full
/// text still needs saying.
fn import_notice(imported: &core_papers::ImportResult, notices: Notices) -> Option<String> {
    let quiet = notices == Notices::Problems
        && !imported.cancelled
        && !imported.already_imported
        && imported.fetch_error.is_none();
    if quiet {
        return None;
    }
    let command = imported
        .citation_key
        .as_deref()
        .map(|key| format!("\\cite{{{key}}}"));
    let title = &imported.title;
    let full_text = !imported.paper_path.is_empty();
    Some(match (imported.cancelled, imported.already_imported, command) {
        (true, _, Some(command)) if full_text => t!(
            "Cancellation arrived after “{0}” was added — cite it with {citationCommand}; its full text had already finished importing.",
            title
        )
        .replace("{citationCommand}", &command),
        (true, _, Some(command)) => t!(
            "Import cancelled. “{0}” remains in the bibliography — cite it with {citationCommand}; full-text enrichment stopped.",
            title
        )
        .replace("{citationCommand}", &command),
        (true, _, None) if full_text => t!(
            "Paper import cancelled before changing the bibliography; the downloaded full text remains available."
        )
        .to_string(),
        (true, _, None) => t!("Paper import cancelled before making changes.").to_string(),
        (false, true, Some(command)) => t!(
            "“{title}” is already in Papers — cite it with {citationCommand}.",
            title = title,
            citationCommand = command
        ),
        (false, true, None) => t!("“{title}” is already in Papers.", title = title),
        (false, false, command) => added_notice(imported, command),
    })
}

/// A plain add, said in full: whether its full text came, and why not.
fn added_notice(imported: &core_papers::ImportResult, command: Option<String>) -> String {
    let title = &imported.title;
    let note = imported
        .fetch_error
        .as_deref()
        .and_then(super::batch::failure_line);
    let said = match (imported.arxiv_id.is_empty(), note, &command) {
        (false, Some(note), Some(_)) => t!(
            "Added “{title}” to the bibliography — cite it with {citationCommand}. The full text could not be downloaded: {fetchNote}"
        )
        .replace("{fetchNote}", &note),
        (false, Some(note), None) => t!(
            "Added “{title}” to the bibliography. The full text could not be downloaded: {fetchNote}"
        )
        .replace("{fetchNote}", &note),
        (false, None, Some(_)) => t!("Imported “{title}” — cite it with {citationCommand}.").into(),
        (false, None, None) => t!("Imported “{title}”.").into(),
        (true, _, Some(_)) => t!(
            "Added “{title}” to the bibliography — cite it with {citationCommand}. No full text to open."
        )
        .into(),
        (true, _, None) => t!("Added “{title}” to the bibliography. No full text to open.").into(),
    };
    said.replace("{title}", title)
        .replace("{citationCommand}", command.as_deref().unwrap_or(""))
}

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
        if query.is_empty() || self.importing.is_some() || self.batch.running {
            return;
        }
        // A title is looked up first: one record imports as it was found,
        // never a second search that could pick another work; several, or
        // one with no entry, go to Add reference for review.
        let review = model::reference_kind(&query) == Some(ReferenceKind::Title);
        // Each add from the box starts a fresh "Just added" set
        // (`startBatch`); Discover literature's adds leave it be.
        self.just_added.clear();
        self.import(query.clone(), query, review, Notices::Problems, cx);
    }

    /// Import `input` for Discover literature's Add, saying what came of it
    /// in a notice rather than as a "Just added" row; the import's ticket,
    /// whose outcome `import_outcome` reports, or none when another import
    /// holds the pipeline.
    pub(crate) fn import_id(&mut self, input: String, cx: &mut Context<Self>) -> Option<u64> {
        if self.importing.is_some() || self.batch.running {
            return None;
        }
        self.import(input.clone(), input, false, Notices::All, cx);
        self.importing.as_ref().map(|importing| importing.ticket)
    }

    /// Whether the import `ticket` added its paper (it came back with a
    /// citation key); none while it runs, or for another import.
    pub(crate) fn import_outcome(&self, ticket: u64) -> Option<bool> {
        self.last_import
            .filter(|(landed, _)| *landed == ticket)
            .map(|(_, added)| added)
    }

    /// Import an entry Add reference saved from a title the box looked up,
    /// its pending row named by `label` (`importReference` with its
    /// `label`); false when another import holds the pipeline.
    pub(crate) fn import_entry(
        &mut self,
        bibtex: String,
        label: String,
        cite: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.importing.is_some() || self.batch.running {
            return false;
        }
        self.import(bibtex, label, false, Notices::Problems, cx);
        self.cite_ticket = self
            .importing
            .as_ref()
            .filter(|_| cite)
            .map(|importing| importing.ticket);
        self.importing.is_some()
    }

    fn import(
        &mut self,
        query: String,
        label: String,
        review: bool,
        notices: Notices,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.import_tickets += 1;
        let ticket = self.import_tickets;
        let cancel = Arc::new(AtomicBool::new(false));
        let (stages, mut stage_events) = mpsc::unbounded::<String>();
        let job_cancel = cancel.clone();
        let input = query.clone();
        let import_root = root.clone();
        // Whether to save the full text too, as the writer last chose.
        let full_text = crate::settings::paper_full_text(cx);
        let job = cx.background_spawn(async move {
            let progress = |stage: &str| {
                stages.unbounded_send(stage.to_string()).ok();
            };
            let input = if review {
                progress("resolving");
                let resolved = lattice_core::project::resolve_citation_query(&input)?;
                if !resolved.candidates.is_empty() || resolved.bibtex.trim().is_empty() {
                    return Ok(Err(Box::new(resolved)));
                }
                resolved.bibtex
            } else {
                input
            };
            core_papers::import_reference(
                &root,
                &input,
                HistoryMode::Record,
                full_text,
                &progress,
                &job_cancel,
            )
            .map(Ok)
        });
        let task = cx.spawn(async move |this, cx| {
            let mut job = std::pin::pin!(job);
            let result = loop {
                match futures::future::select(job.as_mut(), stage_events.next()).await {
                    futures::future::Either::Left((result, _)) => break result,
                    futures::future::Either::Right((Some(stage), _)) => {
                        this.update(cx, |this, cx| {
                            if let Some(importing) = &mut this.importing {
                                if stage == "fulltext" {
                                    importing.full_text = core_papers::FullText::Save;
                                }
                                model::next_stage(
                                    &mut importing.stage,
                                    &mut importing.started,
                                    &mut importing.from,
                                    stage,
                                );
                                cx.notify();
                            }
                        })
                        .ok();
                    }
                    futures::future::Either::Right((None, _)) => break job.await,
                }
            };
            this.update(cx, |this, cx| match result {
                Ok(Err(resolved)) => this.review(query, resolved, cx),
                Ok(Ok(imported)) => this.imported(query, import_root, Ok(imported), notices, cx),
                Err(error) => this.imported(query, import_root, Err(error), notices, cx),
            })
            .ok();
        });
        self.importing = Some(Importing {
            label,
            ticket,
            stage: None,
            full_text,
            started: Instant::now(),
            from: 0.,
            cancel,
            _task: task,
        });
        cx.notify();
    }

    /// The title's lookup found several works, or one without an entry:
    /// Add reference shows them, the title in its lookup, unless the writer
    /// cancelled.
    fn review(
        &mut self,
        query: String,
        resolved: Box<lattice_core::models::ResolvedCitation>,
        cx: &mut Context<Self>,
    ) {
        let importing = self.importing.take();
        self.last_import = importing
            .as_ref()
            .map(|importing| (importing.ticket, false));
        let cancelled = importing.is_some_and(|importing| importing.cancel.load(Ordering::Acquire));
        if !cancelled {
            cx.emit(PapersEvent::Review { query, resolved });
        }
        cx.notify();
    }

    fn imported(
        &mut self,
        query: String,
        root: PathBuf,
        result: Result<core_papers::ImportResult, String>,
        notices: Notices,
        cx: &mut Context<Self>,
    ) {
        let importing = self.importing.take();
        let added = result
            .as_ref()
            .is_ok_and(|imported| imported.citation_key.is_some());
        self.last_import = importing
            .as_ref()
            .map(|importing| (importing.ticket, added));
        let ticket = importing.as_ref().map(|importing| importing.ticket);
        let cancelled = importing.is_some_and(|importing| importing.cancel.load(Ordering::Acquire));
        let cite = ticket.is_some() && self.cite_ticket == ticket;
        if cite {
            self.cite_ticket = None;
        }
        match result {
            Ok(imported) => {
                if cite
                    && !imported.cancelled
                    && let Some(key) = imported.citation_key.clone()
                {
                    cx.emit(PapersEvent::Cite(key));
                }
                // The row says it was added, with its key to copy, in place
                // of a toast; a search for what was typed keeps it first. A
                // paper the library held, or an import cancelled, is no new
                // row: a notice says what came of it instead. Discover
                // literature's add is no row either: its notice says it all.
                if notices == Notices::Problems && !imported.cancelled && !imported.already_imported
                {
                    if let Some(key) = &imported.citation_key {
                        self.just_added.insert(key.clone());
                    }
                    if !imported.arxiv_id.is_empty() {
                        self.just_added.insert(imported.arxiv_id.clone());
                    }
                }
                if let Some(said) = import_notice(&imported, notices) {
                    let mut notice = crate::notices::Notice::new(
                        lattice_ui::components::ToastLevel::Info,
                        t!("Papers"),
                    )
                    .detail(said);
                    // A paper cited before keeps its old entry; offer to
                    // bring it up to date.
                    if let Some(key) = imported
                        .citation_key
                        .clone()
                        .filter(|_| imported.already_imported && !imported.cancelled)
                    {
                        let view = cx.entity().downgrade();
                        notice = notice.action(crate::notices::NoticeAction::new(
                            t!("Refresh entry"),
                            move |_, cx| {
                                view.update(cx, |_, cx| {
                                    cx.emit(PapersEvent::RefreshEntry {
                                        root: root.clone(),
                                        key: key.clone(),
                                    })
                                })
                                .ok();
                            },
                        ));
                    }
                    crate::notices::show(notice, cx);
                }
                self.recent = Some(RecentImport {
                    query,
                    citation_key: imported.citation_key.clone(),
                    arxiv_id: imported.arxiv_id.clone(),
                });
                self.scroll
                    .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
            }
            Err(_) if cancelled => {}
            // Missing paper tools fail every import alike: offer the install.
            Err(error) if error.contains(super::audit::PAPER_TOOLS_MISSING) => {
                cx.emit(PapersEvent::MissingPaperTools(error))
            }
            Err(error) => crate::notices::error(t!("Could not add the paper"), error, cx),
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
        let (stage, started, from) = if let Some(importing) = &self.importing {
            (
                importing.stage.as_deref(),
                importing.started,
                importing.from,
            )
        } else if self.fetching.busy() {
            let fetching = &self.fetching;
            (fetching.stage.as_deref(), fetching.started?, fetching.from)
        } else {
            return None;
        };
        Some(model::progress_at(from, stage, started.elapsed()))
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
        // A paper chosen is a navigation of its own: a download still on
        // its way from an earlier click no longer opens its paper.
        self.navigations += 1;
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
        } else if let Some(url) = model::link_url(paper) {
            // Only a web address: a shared bibliography's `file://` or
            // `smb://` url would have the system launch what it names.
            model::open_link(&url, cx);
        }
    }

    fn fetch(&mut self, paper: PaperSummary, cx: &mut Context<Self>) {
        let key = paper_key(&paper);
        let Some(root) = self.root.clone() else {
            cx.emit(crate::shell::PaperFetched { key, failed: false });
            return;
        };
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
        // The download opens its paper only if nothing was opened since
        // (`claim()`, `opening.isCurrent()`).
        let claim = self.navigations;
        let task = cx.spawn(async move |this, cx| {
            let mut job = std::pin::pin!(job);
            let result = loop {
                match futures::future::select(job.as_mut(), stage_events.next()).await {
                    futures::future::Either::Left((result, _)) => break result,
                    futures::future::Either::Right((Some(stage), _)) => {
                        this.update(cx, |this, cx| {
                            let fetching = &mut this.fetching;
                            let started = fetching.started.get_or_insert_with(Instant::now);
                            model::next_stage(
                                &mut fetching.stage,
                                started,
                                &mut fetching.from,
                                stage,
                            );
                            cx.notify();
                        })
                        .ok();
                    }
                    futures::future::Either::Right((None, _)) => break job.await,
                }
            };
            this.update(cx, |this, cx| this.fetched(fetch_key, claim, result, cx))
                .ok();
        });
        if !self.fetching.busy() {
            self.fetching.stage = None;
            self.fetching.started = Some(Instant::now());
            self.fetching.from = 0.;
        }
        self.fetching
            .states
            .insert(key.clone(), FetchState::Loading);
        self.fetching.cancels.insert(key, cancel);
        self.fetching.tasks.push(task);
        cx.notify();
    }

    fn fetched(
        &mut self,
        key: String,
        claim: u64,
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
        cx.emit(crate::shell::PaperFetched {
            key: key.clone(),
            failed: result.is_err(),
        });
        let page = self.fetching.pages.remove(&key);
        match result {
            Ok(fetched) => {
                self.fetching.fallbacks.remove(&key);
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
                let path = path.filter(|_| self.navigations == claim);
                match (listed, path) {
                    (Some(paper), Some(_)) => {
                        let mut paper = paper.clone();
                        paper.arxiv_id = fetched.arxiv_id.clone();
                        paper.has_full_text = !fetched.paper_path.is_empty();
                        paper.has_blog = fetched.blog_path.is_some();
                        let paper = Box::new(paper);
                        cx.emit(match page {
                            Some(page) => PapersEvent::ReadAt { paper, page },
                            None => PapersEvent::Read(paper),
                        });
                    }
                    (None, Some(path)) => cx.emit(PapersEvent::Open { path, line: None }),
                    (_, None) => {}
                }
                let linger_key = key.clone();
                let linger = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(FETCHED_LINGER).await;
                    this.update(cx, |this, cx| {
                        if this.fetching.states.get(&key) == Some(&FetchState::Fetched) {
                            this.fetching.states.remove(&key);
                            cx.notify();
                        }
                    })
                    .ok();
                });
                self.fetching.lingers.insert(linger_key, linger);
                self.reload(cx);
            }
            Err(error) => {
                self.fetching.states.remove(&key);
                notices::error(t!("Could not download the paper"), error, cx);
                // A citation card's Open paper reads the cited source in the
                // browser instead, unless something was opened since.
                if let Some(url) = self.fetching.fallbacks.remove(&key)
                    && self.navigations == claim
                {
                    cx.open_url(&url);
                }
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
        for (key, cancel) in &self.fetching.cancels {
            cancel.store(true, Ordering::Release);
            cx.emit(crate::shell::PaperFetched {
                key: key.clone(),
                failed: false,
            });
        }
        self.fetching.cancels.clear();
        self.fetching.fallbacks.clear();
        self.fetching.pages.clear();
        self.fetching
            .states
            .retain(|_, state| *state != FetchState::Loading);
        self.fetching.stage = None;
        self.fetching.started = None;
        self.fetching.tasks.clear();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(edit: impl FnOnce(&mut core_papers::ImportResult)) -> core_papers::ImportResult {
        let mut result = core_papers::ImportResult {
            arxiv_id: String::new(),
            title: "Attention".into(),
            paper_path: String::new(),
            citation_key: Some("vaswani2017".into()),
            citation_output: String::new(),
            already_imported: false,
            fetch_error: None,
            cancelled: false,
        };
        edit(&mut result);
        result
    }

    #[test]
    fn a_held_or_cancelled_import_says_so_and_a_plain_add_leaves_it_to_its_row() {
        let notice = |result: &core_papers::ImportResult| import_notice(result, Notices::Problems);
        assert_eq!(notice(&result(|_| {})), None);
        assert_eq!(
            notice(&result(|r| r.already_imported = true)).as_deref(),
            Some("“Attention” is already in Papers — cite it with \\cite{vaswani2017}.")
        );
        assert_eq!(
            notice(&result(|r| {
                r.cancelled = true;
                r.citation_key = None;
            }))
            .as_deref(),
            Some("Paper import cancelled before making changes.")
        );
        assert_eq!(
            notice(&result(|r| r.cancelled = true)).as_deref(),
            Some(
                "Import cancelled. “Attention” remains in the bibliography — cite it with \\cite{vaswani2017}; full-text enrichment stopped."
            )
        );
    }

    /// Discover literature's adds say everything (`notices: "all"`), worded
    /// as `importReference` words them.
    #[test]
    fn a_discover_add_says_what_it_added_and_whether_its_text_came() {
        let all = |result: &core_papers::ImportResult| import_notice(result, Notices::All);
        let arxiv = |r: &mut core_papers::ImportResult| r.arxiv_id = "1706.03762".into();
        assert_eq!(
            all(&result(arxiv)).as_deref(),
            Some("Imported “Attention” — cite it with \\cite{vaswani2017}.")
        );
        assert_eq!(
            all(&result(|r| {
                arxiv(r);
                r.fetch_error = Some("Traceback\nError: network unreachable\n".into());
            }))
            .as_deref(),
            Some(
                "Added “Attention” to the bibliography — cite it with \\cite{vaswani2017}. The full text could not be downloaded: network unreachable"
            )
        );
        assert_eq!(
            all(&result(|r| r.citation_key = None)).as_deref(),
            Some("Added “Attention” to the bibliography. No full text to open.")
        );
        // A held paper says so whichever the notices.
        assert_eq!(
            all(&result(|r| r.already_imported = true)).as_deref(),
            Some("“Attention” is already in Papers — cite it with \\cite{vaswani2017}.")
        );
    }
}
