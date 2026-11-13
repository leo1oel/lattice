//! The build's state and its dock panel: the build under way and the passes
//! latexmk announces (the Build button's sequence), how the last one ended,
//! and its diagnostics, explained the way the Tauri app explains them.
//!
//! What the writer reads is the diagnostics card over the PDF, as in the
//! Tauri app (`crate::build::card`, drawn by [`DiagnosticsCard`] inside the
//! PDF panel). This entity holds what both read, and is also a dock panel
//! ("Build", from the Panels menu) that lays the same messages and log out
//! at full height.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ListAlignment, ListOffset, ListState, ParentElement as _, Render, SharedString, Styled as _,
    Task, Window, div, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    v_flex,
};
use lattice_core::{
    latex::{BuildResult, BuildStep},
    models::Diagnostic,
};

use crate::build::{
    card,
    diagnostics::{self, Severity},
    explain::{self, ExplainOptions, Explained},
    outcome::BuildOutcome,
};

/// The log view keeps the tail; a full multi-pass log can run to megabytes.
const LOG_TAIL_LINES: usize = 2_000;

/// A raw log's rows, measured a little beyond the box so a scroll does not
/// show them arriving.
fn log_list() -> ListState {
    ListState::new(0, ListAlignment::Top, px(240.))
}

/// What the build chip in the editor's strip shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChipState {
    Idle,
    Running(Duration),
    Succeeded(Duration),
    /// A failed build, with its error count.
    Failed(usize),
}

pub struct OpenLocation {
    pub path: PathBuf,
    pub line: Option<u32>,
}

/// What the card's buttons ask the shell to do.
pub enum BuildAction {
    /// Install the TeX package that provides this file.
    Install(String),
    /// Replace `token` on `line` of `path` with `replacement`, save and build.
    ReplaceToken {
        path: PathBuf,
        line: u32,
        token: String,
        replacement: String,
    },
    /// Build with this engine from now on (`keep`: the writer chose it, so
    /// an automatic switch leaves it alone), then build.
    SwitchEngine { engine: String, keep: bool },
}

enum Status {
    Idle,
    Running {
        started: Instant,
        document: SharedString,
        steps: Vec<BuildStep>,
    },
    Finished,
    /// The build could not start or run at all.
    Failed,
}

/// The last finished build, as the card reads it.
pub struct LastBuild {
    pub success: bool,
    pub wrote_pdf: bool,
    pub root_document: String,
    /// In the order the card lists them, each with its explanation.
    pub diagnostics: Vec<Diagnostic>,
    pub explained: Vec<Option<Explained>>,
    pub log: String,
    pub log_lines: Rc<[SharedString]>,
    /// The log line a failed build's log opens at.
    pub log_anchor: Option<usize>,
}

/// Messages or the raw log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputTab {
    Messages,
    Log,
}

pub struct BuildPanel {
    focus_handle: FocusHandle,
    status: Status,
    /// How the last finished build ended; `None` before one, while one the
    /// writer sees runs, and after one the writer stopped.
    outcome: Option<BuildOutcome>,
    /// The project the diagnostics name their files in, and its files.
    root: PathBuf,
    project_files: Vec<String>,
    last: Option<LastBuild>,
    pub(crate) expanded: bool,
    pub(crate) dismissed: bool,
    dismissed_fingerprint: Option<String>,
    /// Floating over the page or docked under it; until the writer chooses,
    /// a build that succeeded docks and a failed one floats.
    docked_choice: Option<bool>,
    pub(crate) tab: OutputTab,
    /// Errors fixed in place from the card, by their place in the list,
    /// until the build that follows reports again.
    pub(crate) replaced: HashMap<usize, String>,
    /// The copy button that just copied, which shows a check for a moment.
    pub(crate) copied: Option<(usize, Instant)>,
    /// The raw log's rows, laid out only where they show: the card's and
    /// the dock panel's, which can both be on screen at different widths.
    pub(crate) card_log: ListState,
    pub(crate) panel_log: ListState,
    /// The diagnostic F8 last went to.
    cycle: Option<usize>,
    /// Builds finished so far, for a scenario to tell a new one from the last.
    builds: usize,
    _ticker: Option<Task<()>>,
}

impl EventEmitter<PanelEvent> for BuildPanel {}
impl EventEmitter<OpenLocation> for BuildPanel {}
impl EventEmitter<BuildAction> for BuildPanel {}

impl BuildPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            status: Status::Idle,
            outcome: None,
            root: PathBuf::new(),
            project_files: Vec::new(),
            last: None,
            expanded: false,
            dismissed: false,
            dismissed_fingerprint: None,
            docked_choice: None,
            tab: OutputTab::Messages,
            replaced: HashMap::new(),
            copied: None,
            card_log: log_list(),
            panel_log: log_list(),
            cycle: None,
            builds: 0,
            _ticker: None,
        }
    }

    /// How many builds have finished, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn builds(&self) -> usize {
        self.builds
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status, Status::Running { .. })
    }

    /// Whether the last build succeeded; `None` before the first one ends.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn succeeded(&self) -> Option<bool> {
        match self.status {
            Status::Finished => Some(self.last.as_ref().is_some_and(|last| last.success)),
            Status::Failed => Some(false),
            Status::Idle | Status::Running { .. } => None,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn diagnostics(&self) -> &[Diagnostic] {
        self.last.as_ref().map_or(&[], |last| &last.diagnostics)
    }

    pub fn last(&self) -> Option<&LastBuild> {
        self.last.as_ref()
    }

    pub fn outcome(&self) -> Option<&BuildOutcome> {
        self.outcome.as_ref()
    }

    /// The build under way: when it started and its passes so far.
    pub fn running(&self) -> Option<(Instant, &[BuildStep])> {
        match &self.status {
            Status::Running { started, steps, .. } => Some((*started, steps)),
            _ => None,
        }
    }

    /// Show a finished, clean build that took `duration`, without running
    /// one: the parity scene stages the build chip as the mock backend's
    /// `build=clean` does, so the harness needs no TeX for it.
    #[cfg(target_os = "macos")]
    pub fn stage_succeeded(&mut self, duration: Duration, cx: &mut Context<Self>) {
        let result = BuildResult {
            success: true,
            has_pdf: true,
            log: String::new(),
            duration_ms: duration.as_millis(),
            diagnostics: Vec::new(),
            root_document: "main.tex".into(),
            one_off: false,
            venue: None,
            steps: Vec::new(),
            pages: None,
            synctex: Some(true),
            outputs: Vec::new(),
            unchanged: false,
        };
        self.finished(&result, true, false, HashMap::new(), cx);
    }

    /// The last outcome's moment, while it may still arrive (`chip_mark`):
    /// its key, one per build, and how long ago it ended.
    pub fn chip_moment(&self) -> Option<(usize, Duration)> {
        let outcome = self.outcome.as_ref()?;
        let age = outcome.finished_at.elapsed();
        (!self.is_running() && age < crate::build::chip_mark::FRESH_WINDOW)
            .then_some((self.builds, age))
    }

    /// A success that left errors or warnings to read: its check carries a
    /// warning dot, as the Tauri app's `has-warnings` does.
    pub fn chip_warned(&self) -> bool {
        self.outcome.as_ref().is_some_and(|outcome| {
            outcome.succeeded && outcome.counts.error + outcome.counts.warning > 0
        })
    }

    pub fn chip(&self) -> ChipState {
        match &self.status {
            Status::Idle => ChipState::Idle,
            Status::Running { started, .. } => ChipState::Running(started.elapsed()),
            Status::Finished | Status::Failed => match &self.outcome {
                Some(outcome) if outcome.succeeded => ChipState::Succeeded(outcome.duration),
                Some(outcome) => ChipState::Failed(outcome.counts.error),
                // A stopped build reports nothing.
                None => ChipState::Idle,
            },
        }
    }

    /// The project file a diagnostic names, resolved against the project
    /// tree, and its line.
    pub fn location(&self, diagnostic: &Diagnostic) -> Option<OpenLocation> {
        if diagnostic.file.is_none() && diagnostic.line.is_none() {
            return None;
        }
        let fallback = self
            .last
            .as_ref()
            .map_or("", |last| last.root_document.as_str());
        let path =
            diagnostics::resolve_path(diagnostic.file.as_deref(), &self.project_files, fallback);
        (!path.is_empty()).then(|| OpenLocation {
            path: self.root.join(path),
            line: diagnostic.line,
        })
    }

    pub fn started(&mut self, root: &Path, document: &str, cx: &mut Context<Self>) {
        self.root = root.to_path_buf();
        self.status = Status::Running {
            started: Instant::now(),
            document: document.to_string().into(),
            steps: Vec::new(),
        };
        // The spinner stands in while it runs; what the build before
        // reported does not come back if no pass of this one reports.
        self.outcome = None;
        // Keep the elapsed time ticking without redrawing every frame.
        self._ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                let running = this
                    .update(cx, |this, cx| {
                        cx.notify();
                        this.is_running()
                    })
                    .unwrap_or(false);
                if !running {
                    break;
                }
            }
        }));
        cx.notify();
    }

    /// The document the build under way compiles.
    pub fn document(&self) -> Option<&str> {
        match &self.status {
            Status::Running { document, .. } => Some(document),
            _ => None,
        }
    }

    /// The passes so far of the build under way, as latexmk announces them.
    pub fn steps(&mut self, latest: Vec<BuildStep>, cx: &mut Context<Self>) {
        if let Status::Running { steps, .. } = &mut self.status {
            *steps = latest;
            cx.notify();
        }
    }

    /// The project's files, which diagnostics are resolved against.
    pub fn set_project_files(&mut self, files: Vec<String>) {
        self.project_files = files;
    }

    /// A build ended with `result`. `wrote_pdf`: the PDF on screen is this
    /// build's; `requested`: the writer asked for it, so its failure comes
    /// back even when dismissed; `sources`: the text of each file the
    /// diagnostics name, as the build compiled it.
    pub fn finished(
        &mut self,
        result: &BuildResult,
        wrote_pdf: bool,
        requested: bool,
        sources: HashMap<String, String>,
        cx: &mut Context<Self>,
    ) {
        self.builds += 1;
        self.status = Status::Finished;
        self.outcome = BuildOutcome::of(result, wrote_pdf);
        let sorted = diagnostics::sort(&result.diagnostics);
        let counts = diagnostics::summarize(&sorted);
        let table_ends_clash = sorted
            .iter()
            .any(|diagnostic| diagnostic.code == Some("arydshln-after-colortbl"));
        let explained = sorted
            .iter()
            .enumerate()
            .map(|(ix, diagnostic)| {
                let same_after = sorted[ix + 1..]
                    .iter()
                    .filter(|other| {
                        other.file == diagnostic.file
                            && other.line == diagnostic.line
                            && other.message == diagnostic.message
                    })
                    .count();
                let source = diagnostic.file.as_ref().and_then(|file| sources.get(file));
                explain::explain(
                    diagnostic,
                    ExplainOptions {
                        log: &result.log,
                        root_document: &result.root_document,
                        source: source.map(String::as_str),
                        after_error: counts.error > 0,
                        same_after,
                        table_ends_clash,
                    },
                )
            })
            .collect();
        let lines: Vec<&str> = result.log.lines().collect();
        let tail = lines.len().saturating_sub(LOG_TAIL_LINES);
        let log_anchor = (!result.success).then(|| {
            let anchor = diagnostics::failed_log_anchor(&result.log);
            let line = result.log[..anchor].matches('\n').count();
            // One line of what came before stays in view above the error.
            line.saturating_sub(tail).saturating_sub(1)
        });
        // Reopening the card is for news: autosave rebuilds after every
        // pause in typing, and a warning the writer chose to live with must
        // not come back seconds after they dismissed it. A failed build
        // they asked for is different: its result is the answer to the ask.
        let fingerprint = diagnostics::fingerprint(&result.diagnostics);
        self.dismissed = (result.success || !requested)
            && self.dismissed_fingerprint.as_deref() == Some(fingerprint.as_str());
        // A switch the writer did not ask for is shown open, with its undo,
        // and so is CJK text the PDF dropped: the build succeeded, the page
        // did not.
        self.expanded = !result.success
            || sorted.iter().any(|diagnostic| {
                diagnostic.level == "error"
                    || matches!(
                        diagnostic.code,
                        Some("engine-switched" | "cjk-glyphs-missing")
                    )
            });
        self.tab = if sorted.is_empty() {
            OutputTab::Log
        } else {
            OutputTab::Messages
        };
        self.replaced.clear();
        self.cycle = None;
        self.last = Some(LastBuild {
            success: result.success,
            wrote_pdf,
            root_document: result.root_document.clone(),
            diagnostics: sorted,
            explained,
            log: result.log.clone(),
            log_lines: lines[tail..]
                .iter()
                .map(|line| SharedString::from(line.to_string()))
                .collect(),
            log_anchor,
        });
        for list in [&self.card_log, &self.panel_log] {
            list.reset(lines.len() - tail);
        }
        self.scroll_log_to_anchor();
        cx.notify();
    }

    /// The build under way was of a project no longer open: none of it
    /// is shown.
    pub fn cleared(&mut self, cx: &mut Context<Self>) {
        self.status = Status::Idle;
        self.outcome = None;
        self.last = None;
        self.dismissed_fingerprint = None;
        cx.notify();
    }

    /// The build could not run (no TeX, a project that changed under it):
    /// the chip says it failed; the message goes in a notice.
    pub fn failed(&mut self, cx: &mut Context<Self>) {
        self.builds += 1;
        self.status = Status::Failed;
        self.outcome = Some(BuildOutcome::rejected());
        cx.notify();
    }

    /// Whether the card is up: a build reported something to read, and the
    /// writer has not dismissed it.
    pub fn card_shown(&self) -> bool {
        !self.dismissed
            && self
                .last
                .as_ref()
                .is_some_and(|last| !last.success || !last.diagnostics.is_empty())
    }

    pub fn docked(&self) -> bool {
        self.docked_choice
            .unwrap_or_else(|| self.last.as_ref().is_some_and(|last| last.success))
    }

    pub fn set_docked(&mut self, docked: bool, cx: &mut Context<Self>) {
        self.docked_choice = Some(docked);
        cx.notify();
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        if let Some(last) = &self.last {
            self.dismissed_fingerprint = Some(diagnostics::fingerprint(&last.diagnostics));
        }
        self.dismissed = true;
        cx.notify();
    }

    /// Bring the card back, open, on the raw log when that is all there is.
    pub fn reveal(&mut self, cx: &mut Context<Self>) {
        self.dismissed = false;
        self.expanded = true;
        cx.notify();
    }

    pub fn set_expanded(&mut self, expanded: bool, cx: &mut Context<Self>) {
        self.expanded = expanded;
        cx.notify();
    }

    pub fn set_tab(&mut self, tab: OutputTab, cx: &mut Context<Self>) {
        self.tab = tab;
        if tab == OutputTab::Log {
            self.scroll_log_to_anchor();
        }
        cx.notify();
    }

    /// A failed build's log opens with the line before the error on top.
    fn scroll_log_to_anchor(&self) {
        let Some(anchor) = self.last.as_ref().and_then(|last| last.log_anchor) else {
            return;
        };
        for list in [&self.card_log, &self.panel_log] {
            list.scroll_to(ListOffset {
                item_ix: anchor,
                offset_in_item: px(0.),
            });
        }
    }

    /// Go to the diagnostic at `ix` in the list.
    pub fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(diagnostic) = self.last.as_ref().and_then(|last| last.diagnostics.get(ix)) else {
            return;
        };
        if let Some(location) = self.location(diagnostic) {
            self.cycle = Some(ix);
            cx.emit(location);
        }
    }

    /// F8 / ⇧F8: step to the next or previous diagnostic in the order the
    /// card lists them, wrapping. A new build restarts the walk at its first
    /// (or, stepping back, its last).
    pub fn cycle(&mut self, forward: bool, cx: &mut Context<Self>) {
        let count = self.last.as_ref().map_or(0, |last| last.diagnostics.len());
        if count == 0 {
            return;
        }
        let next = match (self.cycle, forward) {
            (Some(at), true) => (at + 1) % count,
            (Some(at), false) => (at + count - 1) % count,
            (None, true) => 0,
            (None, false) => count - 1,
        };
        self.cycle = Some(next);
        if let Some(diagnostic) = self
            .last
            .as_ref()
            .and_then(|last| last.diagnostics.get(next))
            && let Some(location) = self.location(diagnostic)
        {
            cx.emit(location);
        }
    }

    /// The problem the Build button's card names: the first error, else
    /// the first warning.
    pub fn first_problem(&mut self, cx: &mut Context<Self>) {
        let first = self.last.as_ref().and_then(|last| {
            last.diagnostics.iter().position(|diagnostic| {
                matches!(
                    diagnostics::severity(&diagnostic.level),
                    Severity::Error | Severity::Warning
                )
            })
        });
        if let Some(ix) = first {
            self.reveal(cx);
            self.select(ix, cx);
        }
    }

    /// Replace the token an explained error stopped at with its suggestion.
    pub fn replace(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(last) = &self.last else {
            return;
        };
        let (Some(diagnostic), Some(Some(explained))) =
            (last.diagnostics.get(ix), last.explained.get(ix))
        else {
            return;
        };
        let (Some(token), Some(suggestion), Some(line)) =
            (&explained.token, &explained.suggestion, diagnostic.line)
        else {
            return;
        };
        let Some(location) = self.location(diagnostic) else {
            return;
        };
        let action = BuildAction::ReplaceToken {
            path: location.path,
            line,
            token: token.clone(),
            replacement: suggestion.clone(),
        };
        self.replaced.insert(ix, suggestion.clone());
        cx.emit(action);
        cx.notify();
    }

    pub fn copy(&mut self, slot: usize, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.copied = Some((slot, Instant::now()));
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(card::COPIED_FOR).await;
            this.update(cx, |this, cx| {
                if this.copied.is_some_and(|(copied, _)| copied == slot) {
                    this.copied = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn act(&mut self, action: BuildAction, cx: &mut Context<Self>) {
        cx.emit(action);
    }
}

impl Focusable for BuildPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for BuildPanel {
    fn panel_name(&self) -> &'static str {
        "BuildPanel"
    }

    /// Its tab's X takes it off screen, as the Tauri app's does; the Panels
    /// menu brings it back.
    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for BuildPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("Build".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "Build"
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for BuildPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        v_flex()
            .track_focus(&self.focus_handle)
            .size_full()
            .child(div().flex_1().min_h_0().child(card::panel(self, &this, cx)))
    }
}

/// The card over the PDF: a view of its own, which the PDF panel holds, so
/// it redraws with the build and not with the pages.
pub struct DiagnosticsCard {
    build: gpui::Entity<BuildPanel>,
}

impl DiagnosticsCard {
    pub fn new(build: gpui::Entity<BuildPanel>, cx: &mut Context<Self>) -> Self {
        cx.observe(&build, |_, _, cx| cx.notify()).detach();
        // A notice's package update reports its progress in the card.
        let center = crate::build::tex_setup::center::install(cx);
        cx.observe(&center, |_, _, cx| cx.notify()).detach();
        Self { build }
    }
}

impl Render for DiagnosticsCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let build = self.build.clone();
        let panel = build.read(cx);
        if !panel.card_shown() {
            return div().into_any_element();
        }
        card::card(panel, &build, window, cx)
    }
}
