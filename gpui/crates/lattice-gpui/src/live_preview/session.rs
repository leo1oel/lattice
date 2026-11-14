//! One project's rtex session, as the window sees it
//! (`src/live-preview/live-preview-session.ts`): what is sent to rtex, what
//! rtex reported back, and the state the PDF's layer draws from.
//!
//! Every change to a project file reaches rtex through one ordered queue:
//! the open file's text as the writer types, and the files the watcher
//! reports (an Overleaf pull, the agent, another editor) read from disk. A
//! disk read that a newer change overtook is dropped, and rtex's own source
//! revisions order what comes back, so a late result never paints over newer
//! text.
//!
//! The normal latexmk build is untouched. The build pipeline tells this
//! session which revision of the files each build compiled
//! (`build_started`, `base_shown`), so edits the PDF on screen already holds
//! stop being painted.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{AppContext as _, Context, Task};
use lattice_core::{
    host::{Closed, StreamBody},
    live_preview,
};

use super::{
    LivePreview, LivePreviewEvent,
    fonts::{FontStore, ImageStore},
    model::{Dirty, LayoutInput, PageSource, PreviewModel},
    protocol::{self, Command, DisplayList, LayoutUpdate, Message, ParagraphUpdate, Reply},
    source_sync::SourceSync,
};
use crate::pdf::PdfEngine;

mod loading;

/// Where the session is. `Starting`: rtex is loading the preamble.
/// `FirstLayout`: typesetting the whole document for the first time.
/// `Live`: paragraphs follow typing. `Paused`: rtex could not load the
/// preamble for live typing; whole-document passes still run. `Error`: rtex
/// stopped, or its first pass failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    FirstLayout,
    Live,
    Paused,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub phase: Phase,
    /// A whole-document pass is catching up with the text: page breaks and
    /// what follows an edit may move.
    pub layout_pending: bool,
    /// rtex's words when it stopped or failed.
    pub detail: Option<String>,
    /// A quiet build is bringing the full PDF up to date: running, or its
    /// PDF loading.
    pub rebuilding: bool,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            phase: Phase::Starting,
            layout_pending: false,
            detail: None,
            rebuilding: false,
        }
    }
}

/// rtex's fallback PDF of one layout, open in PDFium: rtex deletes the file
/// two layouts later.
pub struct Fallback {
    pub layout_version: u64,
    pub doc: crate::pdf::DocId,
    pub generation: u64,
}

/// A command awaiting its reply, with its index among the text changes.
struct Awaiting {
    index: Option<usize>,
}

pub struct Session {
    pub(super) id: u64,
    pub(super) root: PathBuf,
    rtex: Arc<Mutex<live_preview::Session>>,
    build_dir: PathBuf,
    engine: Option<Arc<PdfEngine>>,
    pub model: PreviewModel,
    pub fonts: FontStore,
    pub images: ImageStore,
    sync: SourceSync,
    pub snapshot: Snapshot,
    /// How many of each event and reply rtex sent, for the e2e scenario.
    pub received: HashMap<String, u64>,

    // ---- The command queue, and the revision each command left rtex at.
    queue: Vec<Command>,
    sending: bool,
    awaiting: VecDeque<Awaiting>,
    /// How many text changes (edit, set_document) have been queued.
    changes: usize,
    /// rtex's source revision after each text change, by index; -1 is
    /// before the first.
    revisions: HashMap<i64, u64>,
    /// The newest revision rtex acknowledged.
    latest_revision: u64,
    /// Text changes up to this index are on disk.
    disk_index: usize,
    /// A base PDF on screen whose revision is still in the queue.
    pending_base: Option<usize>,
    /// The newest revision whose pagination no layout or build has caught
    /// up with yet.
    awaiting_since: Option<u64>,
    /// A base PDF the viewer is still loading, built as of its token.
    next_base: Option<Option<usize>>,
    quiet_build: bool,
    quiet_base: bool,

    // ---- Disk reads: a counter per file, so a read a newer change
    // overtook is dropped.
    file_generation: HashMap<String, u64>,
    active_path: Option<String>,
    editor_dirty: bool,

    pub fallback: Option<Fallback>,
    generation: Option<u64>,
    base_pages: Option<u32>,
    fonts_loading: HashSet<String>,
    images_loading: HashSet<String>,
    _events: Task<()>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// The files rtex reads as source: the document's .tex files.
pub fn is_tex(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".tex")
}

impl Session {
    /// Start rtex on `main` in `root`, off the main thread; `tex_files` are
    /// the project's .tex files, whose text on disk is what rtex reads of
    /// them now.
    pub fn start(
        root: PathBuf,
        main: String,
        tex_files: Vec<String>,
        cx: &mut Context<LivePreview>,
    ) -> Task<Result<(), String>> {
        let (sender, mut events) = mpsc::unbounded::<String>();
        let sink = Arc::new(move |body: StreamBody| match body {
            StreamBody::Json(line) => sender.unbounded_send(line).map_err(|_| Closed),
            StreamBody::Raw(_) => Ok(()),
        });
        let engine = PdfEngine::global(cx).ok();
        cx.spawn(async move |this, cx| {
            let started = cx
                .background_spawn({
                    let root = root.clone();
                    async move { live_preview::Session::start(&root, &main, sink) }
                })
                .await?;
            let build_dir = started.build_dir().to_path_buf();
            let rtex = Arc::new(Mutex::new(started));
            let reader = cx.spawn({
                let this = this.clone();
                async move |cx| {
                    while let Some(line) = events.next().await {
                        let mut lines = vec![line];
                        while let Ok(line) = events.try_recv() {
                            lines.push(line);
                        }
                        let alive = this
                            .update(cx, |this, cx| {
                                for line in &lines {
                                    this.receive(line, cx);
                                }
                            })
                            .is_ok();
                        if !alive {
                            return;
                        }
                    }
                }
            });
            let (id, reads) = this
                .update(cx, |this, cx| {
                    let mut session = Session {
                        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                        root: root.clone(),
                        rtex,
                        build_dir,
                        engine,
                        model: PreviewModel::default(),
                        fonts: FontStore::default(),
                        images: ImageStore::default(),
                        sync: SourceSync::default(),
                        snapshot: Snapshot::default(),
                        received: HashMap::new(),
                        queue: Vec::new(),
                        sending: false,
                        awaiting: VecDeque::new(),
                        changes: 0,
                        revisions: HashMap::new(),
                        latest_revision: 0,
                        disk_index: 0,
                        pending_base: None,
                        awaiting_since: None,
                        next_base: None,
                        quiet_build: false,
                        quiet_base: false,
                        file_generation: HashMap::new(),
                        active_path: None,
                        editor_dirty: false,
                        fallback: None,
                        generation: None,
                        base_pages: None,
                        fonts_loading: HashSet::new(),
                        images_loading: HashSet::new(),
                        _events: reader,
                    };
                    // First in the queue, ahead of any edit: the revision rtex
                    // loaded the files at, which the base PDF was built from.
                    session.enqueue(vec![Command::Status]);
                    let id = session.id;
                    let reads: Vec<(String, u64)> = tex_files
                        .into_iter()
                        .filter(|path| is_tex(path))
                        .map(|path| {
                            let generation =
                                session.file_generation.get(&path).copied().unwrap_or(0);
                            (path, generation)
                        })
                        .collect();
                    this.session_started(session, cx);
                    (id, reads)
                })
                .map_err(|_| "The window closed.".to_string())?;
            this.update(cx, |this, cx| this.flush(cx)).ok();
            // What rtex reads of each file now, so a watcher report that
            // names files without changing them sends rtex nothing.
            for (path, generation) in reads {
                let file = root.join(&path);
                let text = cx
                    .background_spawn(async move { std::fs::read_to_string(file).ok() })
                    .await;
                let Some(text) = text else { continue };
                this.update(cx, |this, _| {
                    if let Some(session) = this.session_with(id)
                        && session.file_generation.get(&path).copied().unwrap_or(0) == generation
                    {
                        session.sync.seed(&path, text);
                    }
                })
                .ok();
            }
            Ok(())
        })
    }

    /// Ask rtex to stop; the processes end on their own thread.
    pub fn stop(&mut self, engine_close: bool) {
        if engine_close && let (Some(engine), Some(fallback)) = (&self.engine, self.fallback.take())
        {
            engine.close(fallback.doc);
        }
    }

    pub fn rtex(&self) -> &Arc<Mutex<live_preview::Session>> {
        &self.rtex
    }

    pub fn engine(&self) -> Option<&Arc<PdfEngine>> {
        self.engine.as_ref()
    }

    // ---- What the app reports ---------------------------------------------

    /// The open file's text, as the editor holds it, and as it is on disk.
    pub fn note_text(&mut self, path: &str, text: &str, saved: &str) {
        if !is_tex(path) {
            return;
        }
        if self.active_path.as_deref() != Some(path) {
            self.active_path = Some(path.to_string());
            // A file switched in replaces whatever rtex last read of it.
            self.bump_file(path);
        }
        self.editor_dirty = text != saved;
        let commands = self.sync.update(path, text, saved);
        if !commands.is_empty() {
            self.enqueue(commands);
        }
    }

    /// The files the watcher reports changed (`None`: anything may have),
    /// with their generation to check once read.
    pub fn files_to_read(&mut self, paths: Vec<String>) -> Vec<(String, u64)> {
        let active = self.active_path.clone();
        paths
            .into_iter()
            .filter(|path| is_tex(path) && active.as_deref() != Some(path.as_str()))
            .map(|path| {
                let generation = self.bump_file(&path);
                (path, generation)
            })
            .collect()
    }

    /// A file the watcher reported, as read from disk.
    pub fn file_read(&mut self, path: &str, generation: u64, text: &str) {
        if self.file_generation.get(path) != Some(&generation)
            || self.active_path.as_deref() == Some(path)
        {
            return;
        }
        let Some(command) = self.sync.replace(path, text) else {
            return;
        };
        self.enqueue(vec![command]);
        // What the watcher saw is on disk, and so on the next build's pages,
        // unless the open file holds edits the build will not see.
        if !self.editor_dirty {
            self.disk_index = self.changes;
        }
    }

    /// The editor wrote the open file: everything sent so far is on disk.
    pub fn note_saved(&mut self) {
        self.editor_dirty = false;
        self.disk_index = self.changes;
    }

    /// A latexmk pass starts reading the files: the token `base_shown` takes
    /// when its PDF is shown.
    pub fn build_started(&mut self, quiet: bool, cx: &mut Context<LivePreview>) -> usize {
        self.quiet_build = quiet;
        self.refresh_rebuilding(cx);
        self.disk_index
    }

    /// The build, and every pass it queued, ended.
    pub fn build_finished(&mut self, cx: &mut Context<LivePreview>) {
        self.quiet_build = false;
        self.refresh_rebuilding(cx);
    }

    /// A new base PDF is loading into the viewer, built from the files as
    /// of `token`; it takes over once the viewer shows it (`base_promoted`),
    /// so the edits stay painted over the old one until then.
    pub fn base_loading(
        &mut self,
        token: Option<usize>,
        quiet: bool,
        cx: &mut Context<LivePreview>,
    ) {
        self.next_base = Some(token);
        self.quiet_base = quiet;
        self.refresh_rebuilding(cx);
    }

    /// The viewer now shows the PDF `base_loading` announced.
    pub fn base_promoted(&mut self, cx: &mut Context<LivePreview>) {
        let token = self.next_base.take().flatten();
        self.quiet_base = false;
        self.refresh_rebuilding(cx);
        if let Some(token) = token {
            self.base_shown(Some(token), cx);
        }
    }

    /// The base PDF on screen is built from the files as of `token`
    /// (`None`: unknown).
    pub fn base_shown(&mut self, token: Option<usize>, cx: &mut Context<LivePreview>) {
        if let Some(token) = token {
            match self.revision_at(token) {
                None => self.pending_base = Some(token),
                Some(revision) => self.apply_base(revision, cx),
            }
        }
        mark(cx, Dirty::All);
    }

    /// The page count of the base PDF, once PDFium has opened it.
    pub fn base_page_count(&mut self, pages: Option<u32>, cx: &mut Context<LivePreview>) {
        if self.base_pages == pages {
            return;
        }
        self.base_pages = pages;
        self.refresh_pending(cx);
    }

    /// A live paragraph cannot be drawn exactly: say the layout is catching
    /// up with it.
    pub fn wait_for_layout(&mut self, cx: &mut Context<LivePreview>) {
        self.await_layout(None, cx);
    }

    // ---- What the layer reads -----------------------------------------------

    /// Whether `page` (1-based) needs a layer at all: every other page is the
    /// viewer's alone.
    pub fn wants(&self, page: u32) -> bool {
        !matches!(self.model.page_source(page), PageSource::Base)
            || !self.model.overlays_on(page).is_empty()
            || !self.model.hidden_lines(page).is_empty()
    }

    // ---- Internals ------------------------------------------------------------

    fn bump_file(&mut self, path: &str) -> u64 {
        let generation = self.file_generation.entry(path.to_string()).or_insert(0);
        *generation += 1;
        *generation
    }

    fn enqueue(&mut self, commands: Vec<Command>) {
        for command in commands {
            let counts = command.changes_text();
            self.awaiting.push_back(Awaiting {
                index: counts.then_some(self.changes),
            });
            if counts {
                self.changes += 1;
            }
            self.queue.push(command);
        }
    }

    /// The commands queued and not yet sent; `None` while a batch is being
    /// written.
    pub(super) fn take_batch(&mut self) -> Option<Vec<String>> {
        if self.sending || self.queue.is_empty() {
            return None;
        }
        self.sending = true;
        Some(self.queue.drain(..).map(|command| command.line()).collect())
    }

    pub(super) fn batch_written(
        &mut self,
        result: Result<(), String>,
        cx: &mut Context<LivePreview>,
    ) {
        self.sending = false;
        if let Err(error) = result {
            self.queue.clear();
            self.update_snapshot(cx, |snapshot| {
                snapshot.phase = Phase::Error;
                snapshot.detail = Some(error);
            });
        }
    }

    fn revision_at(&self, index: usize) -> Option<u64> {
        self.revisions.get(&(index as i64 - 1)).copied()
    }

    fn apply_base(&mut self, revision: u64, cx: &mut Context<LivePreview>) {
        self.pending_base = None;
        self.model.set_base(revision);
        // rtex lays out again only when pagination moved, so its last layout
        // can be older than the PDF now on screen; the rows a live paragraph
        // clears come from that layout, so ask for one that matches the PDF.
        if self
            .model
            .layout_revision
            .is_some_and(|layout| layout < revision)
        {
            self.enqueue(vec![Command::RequestLayout]);
        }
        // The build laid out what the layout was awaited for.
        if self.awaiting_since.is_some_and(|since| revision >= since) {
            self.awaiting_since = None;
        }
        self.refresh_pending(cx);
    }

    /// Pagination is behind the text as of `revision` (the newest change
    /// when unknown): until a layout or a build includes it, what follows an
    /// edit may sit where it was.
    fn await_layout(&mut self, revision: Option<u64>, cx: &mut Context<LivePreview>) {
        let revision = revision.unwrap_or(self.latest_revision);
        self.awaiting_since = Some(self.awaiting_since.unwrap_or(revision).max(revision));
        self.refresh_pending(cx);
    }

    fn refresh_rebuilding(&mut self, cx: &mut Context<LivePreview>) {
        let rebuilding = self.quiet_build || self.quiet_base;
        self.update_snapshot(cx, |snapshot| snapshot.rebuilding = rebuilding);
    }

    fn refresh_pending(&mut self, cx: &mut Context<LivePreview>) {
        let pending = self.awaiting_since.is_some() || self.model.pages_disagree(self.base_pages);
        self.update_snapshot(cx, |snapshot| snapshot.layout_pending = pending);
    }

    fn update_snapshot(
        &mut self,
        cx: &mut Context<LivePreview>,
        change: impl FnOnce(&mut Snapshot),
    ) {
        let mut next = self.snapshot.clone();
        change(&mut next);
        if next != self.snapshot {
            self.snapshot = next;
            cx.emit(LivePreviewEvent::Changed);
            cx.notify();
        }
    }

    pub(super) fn receive_message(&mut self, message: Message, cx: &mut Context<LivePreview>) {
        let kind = match &message {
            Message::Reply(Reply::Edit(_)) => "reply:edit".to_string(),
            Message::Reply(Reply::Status { .. }) => "reply:status".to_string(),
            Message::Reply(Reply::Other(reply)) => format!("reply:{reply}"),
            Message::EngineState { .. } => "EngineState".into(),
            Message::Layout(_) => "LayoutUpdate".into(),
            Message::Paragraph(_) => "ParagraphUpdate".into(),
            Message::BackgroundScheduled => "BackgroundScheduled".into(),
            Message::SessionExited { .. } => "SessionExited".into(),
            Message::OtherEvent(event) => event.clone(),
        };
        *self.received.entry(kind).or_default() += 1;
        match message {
            Message::Reply(reply) => self.on_reply(reply, cx),
            Message::EngineState {
                engine_generation,
                state,
                reason,
            } => {
                if self
                    .generation
                    .is_some_and(|generation| generation != engine_generation)
                {
                    mark(cx, self.model.drop_overlays(None));
                }
                self.generation = Some(engine_generation);
                match state.as_str() {
                    "Failed" => self.update_snapshot(cx, |snapshot| {
                        snapshot.phase = Phase::Paused;
                        snapshot.detail = reason;
                    }),
                    "Ready" => {
                        let phase = if self.model.has_layout() {
                            Phase::Live
                        } else {
                            Phase::FirstLayout
                        };
                        self.update_snapshot(cx, |snapshot| {
                            snapshot.phase = phase;
                            snapshot.detail = None;
                        });
                    }
                    "Starting" if self.model.has_layout() => self.await_layout(None, cx),
                    _ => {}
                }
            }
            Message::Layout(layout) => self.on_layout(*layout, cx),
            Message::Paragraph(paragraph) => self.on_paragraph(*paragraph, cx),
            Message::BackgroundScheduled => self.await_layout(None, cx),
            Message::SessionExited { stderr } => {
                self.update_snapshot(cx, |snapshot| {
                    snapshot.phase = Phase::Error;
                    snapshot.detail = (!stderr.trim().is_empty()).then_some(stderr);
                });
                mark(cx, self.model.drop_overlays(None));
            }
            Message::OtherEvent(_) => {}
        }
    }

    fn on_reply(&mut self, reply: Reply, cx: &mut Context<LivePreview>) {
        let sent = self.awaiting.pop_front();
        match reply {
            Reply::Status { source_revision } => {
                // The revision before any change of ours: the files the base
                // PDF was built from.
                if !self.revisions.contains_key(&-1) {
                    self.revisions.insert(-1, source_revision);
                    self.model.base_revision = source_revision;
                    self.latest_revision = self.latest_revision.max(source_revision);
                    if self.pending_base == Some(0) {
                        self.apply_base(source_revision, cx);
                    }
                }
            }
            Reply::Other(_) => {
                // A refused edit (rtex does not know the file) leaves its
                // revision where it was.
                if let Some(index) = sent.and_then(|sent| sent.index) {
                    let latest = self.latest_revision;
                    self.record_revision(index, latest, cx);
                }
            }
            Reply::Edit(result) => {
                if let Some(index) = sent.and_then(|sent| sent.index) {
                    self.record_revision(index, result.source_revision, cx);
                }
                if !result.outcome.removed.is_empty() {
                    mark(cx, self.model.drop_overlays(Some(&result.outcome.removed)));
                }
                if result.routed != "fast" {
                    self.await_layout(Some(result.source_revision), cx);
                }
            }
        }
    }

    fn record_revision(&mut self, index: usize, revision: u64, cx: &mut Context<LivePreview>) {
        self.revisions.insert(index as i64, revision);
        // A build reads its token within seconds; a few thousand changes is
        // ample.
        self.revisions.remove(&(index as i64 - 4096));
        self.latest_revision = self.latest_revision.max(revision);
        if self.pending_base == Some(index + 1) {
            self.apply_base(revision, cx);
            mark(cx, Dirty::All);
        }
    }

    fn on_layout(&mut self, event: LayoutUpdate, cx: &mut Context<LivePreview>) {
        if matches!(event.compile, protocol::CompileStatus::Failed) {
            // rtex keeps the previous layout; before the first one there is
            // nothing to show.
            if !self.model.has_layout() {
                self.update_snapshot(cx, |snapshot| {
                    snapshot.phase = Phase::Error;
                    snapshot.detail = None;
                });
            }
            return;
        }
        let layout_version = event.versions.layout_version;
        if let Some(file) = &event.pdf_fallback {
            self.load_fallback(file.clone(), layout_version, cx);
        }
        let changed: Vec<u32> = event.pages_changed.iter().map(|page| page.page).collect();
        let dirty = self.model.apply_layout(LayoutInput {
            pages: event.pages_changed,
            pages_total: event.pages_total,
            placements: event.placements,
            revision: event.versions.source_revision,
            layout_version,
            has_fallback: event.pdf_fallback.is_some(),
        });
        // Only the pages drawn from the display list need its fonts and
        // images: most pages stay the PDF's, and a paper's figures run to
        // tens of MB.
        let lists: Vec<Arc<DisplayList>> = changed
            .into_iter()
            .filter_map(|page| match self.model.page_source(page) {
                PageSource::DisplayList(update) => Some(Arc::new(update.dl.clone())),
                _ => None,
            })
            .collect();
        self.load_resources(lists, cx);
        let paused = self.snapshot.phase == Phase::Paused;
        self.update_snapshot(cx, |snapshot| {
            snapshot.phase = if paused { Phase::Paused } else { Phase::Live };
        });
        let settled = event.convergence.settled();
        let revision = event.versions.source_revision;
        if settled && self.awaiting_since.is_some_and(|since| revision >= since) {
            self.awaiting_since = None;
        }
        if !settled {
            self.await_layout(Some(revision), cx);
        }
        self.refresh_pending(cx);
        mark(cx, dirty);
    }

    fn on_paragraph(&mut self, event: ParagraphUpdate, cx: &mut Context<LivePreview>) {
        let revision = event.versions.source_revision;
        if event.status == "removed" {
            let dl = Arc::new(event.dl);
            mark(
                cx,
                self.model
                    .apply_paragraph(event.par_id, dl, Vec::new(), revision),
            );
            return;
        }
        // Something in it cannot be drawn exactly, or TeX stopped on an
        // error: the next whole-document pass shows it.
        if event.status != "ok" {
            self.await_layout(Some(revision), cx);
            return;
        }
        if revision <= self.model.base_revision {
            return;
        }
        let fragments = if event.pagination_stale {
            event.fragments
        } else {
            self.model.place_live(event.par_id, event.fragments)
        };
        let dl = Arc::new(event.dl);
        mark(
            cx,
            self.model
                .apply_paragraph(event.par_id, dl.clone(), fragments, revision),
        );
        self.load_resources(vec![dl], cx);
        if event.pagination_stale {
            self.await_layout(Some(revision), cx);
        }
    }

    /// The fallback PDF that draws pages of layout `layout_version`, once
    /// loaded.
    pub fn fallback_for(&self, layout_version: u64) -> Option<&Fallback> {
        self.fallback
            .as_ref()
            .filter(|fallback| fallback.layout_version >= layout_version)
    }
}

impl LivePreview {
    fn receive(&mut self, line: &str, cx: &mut Context<Self>) {
        let Some(message) = protocol::parse(line) else {
            return;
        };
        if let Some(session) = self.session_mut() {
            session.receive_message(message, cx);
        }
    }

    /// Write the queued commands to rtex, one batch at a time, in order: the
    /// next batch goes once this one is written.
    pub(super) fn flush(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_mut() else {
            return;
        };
        let Some(batch) = session.take_batch() else {
            return;
        };
        let rtex = session.rtex().clone();
        let id = session.id;
        cx.spawn(async move |this, cx| {
            let written = cx
                .background_spawn(async move {
                    let mut rtex = rtex
                        .lock()
                        .map_err(|_| "The live preview has stopped.".to_string())?;
                    batch.iter().try_for_each(|line| {
                        let line = live_preview::allowed_command(line)?;
                        rtex.send(&line)
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(session) = this.session_with(id) {
                    session.batch_written(written, cx);
                }
                this.flush(cx);
            })
            .ok();
        })
        .detach();
    }
}

/// Ask every viewer to draw `pages` again.
fn mark(cx: &mut Context<LivePreview>, pages: Dirty) {
    if !pages.is_empty() {
        cx.emit(LivePreviewEvent::Pages(pages));
        cx.notify();
    }
}
