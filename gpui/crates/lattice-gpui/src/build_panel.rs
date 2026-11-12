//! Build status, diagnostics that jump to their line, and the raw log, in
//! Lattice's tool-panel look: 28px rows on the sheet, a 14px status mark,
//! the message in 12px ink, the location in secondary ink, the log in the
//! editor font.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    Window, div, prelude::*, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    h_flex,
    menu::{PopupMenu, PopupMenuItem},
    v_flex,
};
use lattice_ui::{ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, icons::ICON};
use tex::{BuildOutcome, Diagnostic, Level};

/// The log view keeps the tail; a full multi-pass log can run to megabytes.
const LOG_TAIL_LINES: usize = 2_000;

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

enum Status {
    Idle,
    Running {
        started: Instant,
        document: SharedString,
    },
    Finished {
        succeeded: bool,
        duration: Duration,
        errors: usize,
        warnings: usize,
    },
    Failed(SharedString),
}

pub struct BuildPanel {
    focus_handle: FocusHandle,
    status: Status,
    /// Folder the document was built in; diagnostics name files relative to it.
    folder: PathBuf,
    diagnostics: Vec<Diagnostic>,
    log_lines: Vec<SharedString>,
    show_log: bool,
    _ticker: Option<Task<()>>,
}

impl EventEmitter<PanelEvent> for BuildPanel {}
impl EventEmitter<OpenLocation> for BuildPanel {}

impl BuildPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            status: Status::Idle,
            folder: PathBuf::new(),
            diagnostics: Vec::new(),
            log_lines: Vec::new(),
            show_log: false,
            _ticker: None,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status, Status::Running { .. })
    }

    /// Whether the last build succeeded; `None` before the first one ends.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn succeeded(&self) -> Option<bool> {
        match self.status {
            Status::Finished { succeeded, .. } => Some(succeeded),
            Status::Failed(_) => Some(false),
            Status::Idle | Status::Running { .. } => None,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Show a finished, clean build that took `duration`, without running
    /// one: the parity scene stages the build chip as the mock backend's
    /// `build=clean` does, so the harness needs no TeX for it.
    #[cfg(target_os = "macos")]
    pub fn stage_succeeded(&mut self, duration: Duration, cx: &mut Context<Self>) {
        self.status = Status::Finished {
            succeeded: true,
            duration,
            errors: 0,
            warnings: 0,
        };
        cx.notify();
    }

    pub fn chip(&self) -> ChipState {
        match &self.status {
            Status::Idle => ChipState::Idle,
            Status::Running { started, .. } => ChipState::Running(started.elapsed()),
            Status::Finished {
                succeeded: true,
                duration,
                ..
            } => ChipState::Succeeded(*duration),
            Status::Finished { errors, .. } => ChipState::Failed(*errors),
            Status::Failed(_) => ChipState::Failed(0),
        }
    }

    /// Where a diagnostic's file is on disk.
    pub fn location(&self, diagnostic: &Diagnostic) -> Option<OpenLocation> {
        diagnostic.file.as_ref().map(|file| OpenLocation {
            path: self.folder.join(file),
            line: diagnostic.line,
        })
    }

    pub fn started(&mut self, document: &std::path::Path, cx: &mut Context<Self>) {
        self.folder = document.parent().map(PathBuf::from).unwrap_or_default();
        self.status = Status::Running {
            started: Instant::now(),
            document: document
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
                .into(),
        };
        self.log_lines.clear();
        // Keep the elapsed time ticking without redrawing every frame.
        self._ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(200))
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

    pub fn push_lines(&mut self, lines: Vec<String>, cx: &mut Context<Self>) {
        self.log_lines
            .extend(lines.into_iter().map(SharedString::from));
        let excess = self.log_lines.len().saturating_sub(LOG_TAIL_LINES);
        self.log_lines.drain(..excess);
        cx.notify();
    }

    pub fn finished(&mut self, outcome: &BuildOutcome, cx: &mut Context<Self>) {
        self.status = Status::Finished {
            succeeded: outcome.succeeded,
            duration: outcome.duration,
            errors: outcome.error_count(),
            warnings: outcome.warning_count(),
        };
        self.diagnostics = outcome.diagnostics.clone();
        if !outcome.succeeded && self.diagnostics.is_empty() {
            self.show_log = true;
        }
        cx.notify();
    }

    pub fn failed(&mut self, message: String, cx: &mut Context<Self>) {
        self.status = Status::Failed(message.into());
        cx.notify();
    }

    fn status_line(&self, cx: &App) -> impl IntoElement {
        let palette = cx.palette();
        let (icon, color, text): (Icon, _, String) = match &self.status {
            Status::Idle => (
                Icon::HAMMER,
                palette.text_secondary,
                format!(
                    "Not built yet. Press {} to build",
                    crate::shell::BUILD_SHORTCUT_LABEL
                ),
            ),
            Status::Running { started, document } => (
                Icon::LOADER,
                palette.text_secondary,
                format!(
                    "Building {document}… {:.1} s",
                    started.elapsed().as_secs_f32()
                ),
            ),
            Status::Finished {
                succeeded,
                duration,
                errors,
                warnings,
            } => (
                if *succeeded {
                    Icon::CHECK_HEAVY
                } else {
                    Icon::CIRCLE_ALERT
                },
                if *succeeded {
                    palette.success
                } else {
                    palette.danger
                },
                format!(
                    "{} in {:.1} s · {errors} error{} · {warnings} warning{}",
                    if *succeeded { "Built" } else { "Build failed" },
                    duration.as_secs_f32(),
                    if *errors == 1 { "" } else { "s" },
                    if *warnings == 1 { "" } else { "s" },
                ),
            ),
            Status::Failed(message) => (Icon::CIRCLE_ALERT, palette.danger, message.to_string()),
        };
        h_flex()
            .flex_none()
            .gap(px(6.))
            .h(px(28.))
            .px(px(14.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(icon.element(ICON, color))
            .child(text)
    }

    fn diagnostic_row(
        &self,
        ix: usize,
        diagnostic: &Diagnostic,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (icon, color) = match diagnostic.level {
            Level::Error => (Icon::CIRCLE_ALERT, palette.danger),
            Level::Warning => (Icon::TRIANGLE_ALERT, palette.warning),
            Level::Info => (Icon::INFO, palette.text_secondary),
        };
        let location = match (&diagnostic.file, diagnostic.line) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            (Some(file), None) => file.clone(),
            _ => String::new(),
        };
        let target = self.location(diagnostic);
        let hover = palette.hover;
        h_flex()
            .id(("diagnostic", ix))
            .gap(px(8.))
            .mx(px(6.))
            .px(px(8.))
            .py(px(6.))
            .items_start()
            .rounded(px(6.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text)
            .when(target.is_some(), |row| {
                row.cursor_pointer().hover(move |style| style.bg(hover))
            })
            .child(div().pt(px(1.)).child(icon.element(ICON, color)))
            .child(div().flex_1().child(diagnostic.message.clone()))
            .child(
                div()
                    .flex_none()
                    .text_color(palette.text_secondary)
                    .child(location),
            )
            .when_some(target, |row, target| {
                row.on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(OpenLocation {
                        path: target.path.clone(),
                        line: target.line,
                    });
                }))
            })
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

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let view = cx.entity().downgrade();
        let label = if self.show_log {
            "Show problems"
        } else {
            "Show the raw log"
        };
        menu.item(PopupMenuItem::new(label).on_click(move |_, _, cx| {
            view.update(cx, |this, cx| {
                this.show_log = !this.show_log;
                cx.notify();
            })
            .ok();
        }))
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for BuildPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let body = if self.show_log {
            v_flex()
                .id("build-log")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(px(14.))
                .pb(px(8.))
                .font_family(editor_font)
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(palette.text_secondary)
                .children(self.log_lines.iter().cloned().map(|line| div().child(line)))
                .into_any_element()
        } else {
            let rows: Vec<_> = self
                .diagnostics
                .clone()
                .iter()
                .enumerate()
                .map(|(ix, diagnostic)| self.diagnostic_row(ix, diagnostic, cx).into_any_element())
                .collect();
            v_flex()
                .id("build-diagnostics")
                .flex_1()
                .min_h_0()
                .pb(px(6.))
                .overflow_y_scroll()
                .children(rows)
                .into_any_element()
        };
        v_flex()
            .track_focus(&self.focus_handle)
            .size_full()
            .child(self.status_line(cx))
            .child(body)
    }
}
