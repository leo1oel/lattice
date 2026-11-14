//! The rtex live preview of a LuaLaTeX project
//! (`src/live-preview/use-live-preview.ts`): whether it runs, and the session
//! while it does.
//!
//! It is offered only to projects whose engine is LuaLaTeX, and is on there
//! unless the writer turns it off (Settings › Editor & builds). The first
//! LuaLaTeX project opened downloads the pinned rtex in the background once
//! the window has settled (lattice-core verifies it), then starts rtex on the
//! project's main document. A Mac that cannot run it downloads nothing, and
//! a failed download leaves the normal build alone: neither shows over the
//! PDF, only in Settings. Leaving the project, switching its engine or
//! turning it off stops rtex.
//!
//! The pieces: the `rtex serve` protocol (`protocol.rs`), what each page
//! shows (`model.rs`), the edits sent (`source_sync.rs`), the session
//! (`session.rs`), the fonts and images display lists draw with
//! (`fonts.rs`, `resources.rs`, `type1.rs`, `virtual_font.rs`), the painter
//! (`paint.rs`), the PDF viewer's page layer (`layer.rs`), the status pill
//! (`status.rs`) and the quiet builds (`quiet_builds.rs`).

mod fonts;
pub(crate) mod layer;
mod model;
mod paint;
mod protocol;
pub(crate) mod quiet_builds;
mod resources;
mod session;
mod source_sync;
pub(crate) mod status;
mod type1;
mod virtual_font;

use std::{path::PathBuf, time::Duration};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Subscription, Task};
use lattice_core::{live_preview, models::FileNode};

pub use model::Dirty;
pub use session::{Phase, Snapshot};
use session::Session;

use crate::{
    editor_panel::EditorPanel,
    project::{Project, ProjectEvent},
};

/// How long a project that needs rtex downloaded waits before the
/// download: its first build, the file tree and the editor come first
/// (`whenIdle(…, 5_000, 2_000)`).
const DOWNLOAD_AFTER: Duration = Duration::from_secs(2);

/// Where the live preview is, as the PDF's pill and Settings show it.
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Off,
    Downloading(f64),
    Starting,
    Running,
    Failed(String),
    /// Not a Mac, or no working LuaLaTeX: nothing downloaded.
    Unavailable,
    /// rtex could not be downloaded (offline, say); builds go on as usual.
    DownloadFailed(String),
}

pub enum LivePreviewEvent {
    /// Pages to draw again.
    Pages(Dirty),
    /// The state or the session's snapshot changed.
    Changed,
}

/// The project the live preview follows, as last configured.
#[derive(Clone, Debug, PartialEq)]
struct Target {
    root: PathBuf,
    main: String,
}

pub struct LivePreview {
    project: Option<Entity<Project>>,
    /// The project is LuaLaTeX's: the preview is offered at all.
    available: bool,
    enabled: bool,
    target: Option<Target>,
    attempt: u64,
    /// The run under way, keyed by what it was started for: a run for
    /// another key is not this one's.
    run_key: Option<(Target, u64)>,
    state: State,
    session: Option<Session>,
    /// lattice-core's last word on rtex (supported, LuaLaTeX, installed),
    /// for Settings.
    install: Option<live_preview::InstallStatus>,
    /// Settings' Remove is under way, and why the last one failed.
    removing: bool,
    remove_error: Option<String>,
    run: Option<Task<()>>,
    _project: Option<Subscription>,
}

impl EventEmitter<LivePreviewEvent> for LivePreview {}

/// Every path in the project tree.
fn flatten(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if !node.path.is_empty() {
            out.push(node.path.clone());
        }
        flatten(&node.children, out);
    }
}

impl LivePreview {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // A switch flipped (here or in another window) applies at once.
        cx.observe_global::<crate::settings::AppSettings>(|this, cx| this.reconfigure(cx))
            .detach();
        Self {
            project: None,
            available: false,
            enabled: false,
            target: None,
            attempt: 0,
            run_key: None,
            state: State::Off,
            session: None,
            install: None,
            removing: false,
            remove_error: None,
            run: None,
            _project: None,
        }
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// The session's snapshot, while one runs.
    pub fn snapshot(&self) -> Option<&Snapshot> {
        self.session.as_ref().map(|session| &session.snapshot)
    }

    pub fn available(&self) -> bool {
        self.available
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn install_status(&self) -> Option<&live_preview::InstallStatus> {
        self.install.as_ref()
    }

    fn session_mut(&mut self) -> Option<&mut Session> {
        self.session.as_mut()
    }

    /// The live paragraphs painted over the base PDF now.
    pub fn overlays(&self) -> usize {
        self.session
            .as_ref()
            .map_or(0, |session| session.model.overlays.len())
    }

    /// How many of each event and reply rtex sent this session.
    pub fn received(&self, kind: &str) -> u64 {
        self.session
            .as_ref()
            .and_then(|session| session.received.get(kind).copied())
            .unwrap_or(0)
    }

    /// Follow `project` (none: stop).
    pub fn set_project(&mut self, project: Option<Entity<Project>>, cx: &mut Context<Self>) {
        self._project = project.as_ref().map(|project| {
            cx.subscribe(project, |this, project, event, cx| match event {
                ProjectEvent::ManifestChanged | ProjectEvent::TreeChanged => this.reconfigure(cx),
                ProjectEvent::FilesChanged(paths) => {
                    let paths = paths.clone().unwrap_or_else(|| {
                        let mut all = Vec::new();
                        flatten(project.read(cx).files(), &mut all);
                        all
                    });
                    this.files_changed(paths, cx);
                }
                ProjectEvent::GitChanged => {}
            })
        });
        self.project = project;
        self.reconfigure(cx);
    }

    /// Start, stop or restart for the project as it is now: its engine, its
    /// main document and the writer's switch.
    fn reconfigure(&mut self, cx: &mut Context<Self>) {
        let (available, target) = match &self.project {
            Some(project) => {
                let project = project.read(cx);
                let available = project.manifest().engine == "lualatex";
                let target = project.main_document().map(|main| Target {
                    root: project.root().to_path_buf(),
                    main: main.to_string(),
                });
                (available, target)
            }
            None => (false, None),
        };
        let enabled = target.as_ref().is_some_and(|target| {
            crate::settings::get(cx).live_preview_enabled(&target.root.to_string_lossy())
        });
        let changed = available != self.available || enabled != self.enabled || target != self.target;
        self.available = available;
        self.enabled = enabled;
        self.target = target;
        let key = (available && enabled)
            .then(|| self.target.clone().map(|target| (target, self.attempt)))
            .flatten();
        if key != self.run_key {
            self.restart(key, cx);
        } else if changed {
            cx.emit(LivePreviewEvent::Changed);
            cx.notify();
        }
    }

    fn stop_session(&mut self, cx: &mut Context<Self>) {
        if let Some(mut session) = self.session.take() {
            session.stop(true);
            // Dropping the last handle stops rtex (lattice-core's
            // `Session::drop`), its processes ending on their own thread.
            drop(session);
            cx.emit(LivePreviewEvent::Pages(Dirty::All));
        }
    }

    fn set_state(&mut self, state: State, cx: &mut Context<Self>) {
        if self.state != state {
            self.state = state;
            cx.emit(LivePreviewEvent::Changed);
            cx.notify();
        }
    }

    fn restart(&mut self, key: Option<(Target, u64)>, cx: &mut Context<Self>) {
        self.run = None;
        self.stop_session(cx);
        self.run_key = key.clone();
        let Some((target, _)) = key else {
            self.set_state(State::Off, cx);
            return;
        };
        self.set_state(State::Starting, cx);
        let tex_files = self
            .project
            .as_ref()
            .map(|project| {
                let mut all = Vec::new();
                flatten(project.read(cx).files(), &mut all);
                all
            })
            .unwrap_or_default();
        self.run = Some(cx.spawn(async move |this, cx| {
            let install = cx.background_spawn(async { live_preview::status() }).await;
            let (supported, lualatex, installed) =
                (install.supported(), install.lualatex(), install.installed());
            this.update(cx, |this, cx| {
                this.install = Some(install);
                cx.notify();
            })
            .ok();
            if !supported || !lualatex {
                this.update(cx, |this, cx| this.set_state(State::Unavailable, cx)).ok();
                return;
            }
            if !installed {
                cx.background_executor().timer(DOWNLOAD_AFTER).await;
                if this.update(cx, |this, cx| this.set_state(State::Downloading(0.), cx)).is_err() {
                    return;
                }
                let (progress, mut reports) = mpsc::unbounded::<f64>();
                let installing = cx.background_spawn(async move {
                    let sink = move |report: live_preview::InstallProgress| {
                        if report.stage() == "downloading" {
                            progress.unbounded_send(report.progress()).ok();
                        }
                        Ok(())
                    };
                    live_preview::install(&sink)
                });
                let reporting = {
                    let this = this.clone();
                    cx.spawn(async move |cx| {
                        while let Some(share) = reports.next().await {
                            this.update(cx, |this, cx| this.set_state(State::Downloading(share), cx))
                                .ok();
                        }
                    })
                };
                let installed = installing.await;
                reporting.await;
                match installed {
                    Ok(status) => {
                        this.update(cx, |this, _| this.install = Some(status)).ok();
                    }
                    Err(error) => {
                        this.update(cx, |this, cx| this.set_state(State::DownloadFailed(error), cx))
                            .ok();
                        return;
                    }
                }
                if this.update(cx, |this, cx| this.set_state(State::Starting, cx)).is_err() {
                    return;
                }
            }
            let started = this.update(cx, |_, cx| {
                Session::start(target.root.clone(), target.main.clone(), tex_files, cx)
            });
            let Ok(started) = started else { return };
            if let Err(error) = started.await {
                this.update(cx, |this, cx| {
                    this.stop_session(cx);
                    this.set_state(State::Failed(error), cx);
                })
                .ok();
            }
        }));
    }

    /// The session rtex started: it runs now.
    fn session_started(&mut self, session: Session, cx: &mut Context<Self>) {
        self.session = Some(session);
        self.set_state(State::Running, cx);
        // The PDF on screen is the one the session starts from.
        if let Some(session) = self.session.as_mut() {
            session.base_promoted(cx);
        }
    }

    /// The pill's restart, and Settings' Retry.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.attempt += 1;
        self.run_key = None;
        self.reconfigure(cx);
    }

    /// Settings' switch, for the open project.
    pub fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let Some(target) = &self.target else { return };
        let root = target.root.to_string_lossy().into_owned();
        crate::settings::update(cx, |settings| {
            settings.live_preview.insert(root, enabled);
        });
        self.reconfigure(cx);
    }

    pub fn removing(&self) -> bool {
        self.removing
    }

    pub fn remove_error(&self) -> Option<&str> {
        self.remove_error.as_deref()
    }

    /// Turn live preview off everywhere and delete rtex and its build
    /// folders.
    pub fn remove(&mut self, cx: &mut Context<Self>) {
        crate::settings::update(cx, |settings| {
            settings.live_preview.clear();
            settings.live_preview_removed = true;
        });
        self.removing = true;
        self.remove_error = None;
        self.reconfigure(cx);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let removed = cx.background_spawn(async { live_preview::remove() }).await;
            this.update(cx, |this, cx| {
                this.removing = false;
                match removed {
                    Ok(status) => this.install = Some(status),
                    Err(error) => this.remove_error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---- What the app reports ---------------------------------------------

    /// The editor in front changed its text (`project`-relative `path`).
    pub fn note_editor(&mut self, editor: &Entity<EditorPanel>, cx: &mut Context<Self>) {
        let Some(session) = self.session.as_mut() else { return };
        let (path, text, saved) = {
            let editor = editor.read(cx);
            (
                editor.relative().to_string(),
                editor.editor().read(cx).text(cx),
                editor.saved_text().to_string(),
            )
        };
        session.note_text(&path, &text, &saved);
        self.flush(cx);
    }

    /// The editor wrote the open file.
    pub fn note_saved(&mut self) {
        if let Some(session) = self.session.as_mut() {
            session.note_saved();
        }
    }

    fn files_changed(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        let Some(session) = self.session.as_mut() else { return };
        let reads = session.files_to_read(paths);
        let root = session.root.clone();
        for (path, generation) in reads {
            let file = root.join(&path);
            cx.spawn(async move |this, cx| {
                // A removed file: rtex reports the \input it can no longer
                // find.
                let Some(text) = cx
                    .background_spawn(async move { std::fs::read_to_string(file).ok() })
                    .await
                else {
                    return;
                };
                this.update(cx, |this, cx| {
                    if let Some(session) = this.session.as_mut() {
                        session.file_read(&path, generation, &text);
                    }
                    this.flush(cx);
                })
                .ok();
            })
            .detach();
        }
    }

    /// A latexmk pass starts reading the files: the token the PDF it writes
    /// is shown with.
    pub fn build_started(&mut self, quiet: bool, cx: &mut Context<Self>) -> Option<usize> {
        let session = self.session.as_mut()?;
        Some(session.build_started(quiet, cx))
    }

    pub fn build_finished(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.session.as_mut() {
            session.build_finished(cx);
        }
    }

    pub fn base_loading(&mut self, token: Option<usize>, quiet: bool, cx: &mut Context<Self>) {
        if let Some(session) = self.session.as_mut() {
            session.base_loading(token, quiet, cx);
        }
    }

    /// The viewer shows the PDF `base_loading` announced, with its page
    /// count.
    pub fn base_promoted(&mut self, pages: Option<u32>, cx: &mut Context<Self>) {
        if let Some(session) = self.session.as_mut() {
            session.base_page_count(pages, cx);
            session.base_promoted(cx);
            self.flush(cx);
        }
    }

    /// Whether the live preview is live on a .tex file: what the quiet
    /// builds wait on.
    pub fn is_live(&self) -> bool {
        self.snapshot()
            .is_some_and(|snapshot| snapshot.phase == Phase::Live)
    }
}

/// The window's live preview, made once per window by the shell.
pub fn new(cx: &mut App) -> Entity<LivePreview> {
    cx.new(LivePreview::new)
}
