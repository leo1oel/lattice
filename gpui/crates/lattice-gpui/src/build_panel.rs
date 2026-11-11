//! Build status, diagnostics that jump to their line, and the raw log.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    Window, div, prelude::*, px,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    dock::{BasePanel, Panel, PanelEvent},
    h_flex, v_flex,
};
use tex::{BuildOutcome, Diagnostic, Level};

/// The log view keeps the tail; a full multi-pass log can run to megabytes.
const LOG_TAIL_LINES: usize = 2_000;

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
        let theme = cx.theme();
        let (icon, color, text): (IconName, _, String) = match &self.status {
            Status::Idle => (
                IconName::Hammer,
                theme.muted_foreground,
                "Not built yet. Press ⌘B to build.".into(),
            ),
            Status::Running { started, document } => (
                IconName::Loader,
                theme.muted_foreground,
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
                    IconName::Info
                } else {
                    IconName::CircleAlert
                },
                if *succeeded {
                    theme.success
                } else {
                    theme.danger
                },
                format!(
                    "{} in {:.1} s · {errors} error{} · {warnings} warning{}",
                    if *succeeded { "Built" } else { "Build failed" },
                    duration.as_secs_f32(),
                    if *errors == 1 { "" } else { "s" },
                    if *warnings == 1 { "" } else { "s" },
                ),
            ),
            Status::Failed(message) => (IconName::CircleAlert, theme.danger, message.to_string()),
        };
        h_flex()
            .gap_2()
            .px_3()
            .py_1()
            .text_sm()
            .child(div().text_color(color).child(icon))
            .child(text)
    }

    fn diagnostic_row(
        &self,
        ix: usize,
        diagnostic: &Diagnostic,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let (icon, color) = match diagnostic.level {
            Level::Error => (IconName::CircleAlert, theme.danger),
            Level::Warning => (IconName::TriangleAlert, theme.warning),
            Level::Info => (IconName::Info, theme.muted_foreground),
        };
        let location = match (&diagnostic.file, diagnostic.line) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            (Some(file), None) => file.clone(),
            _ => String::new(),
        };
        let target = self.location(diagnostic);
        let hover = theme.list_hover;
        let muted = theme.muted_foreground;
        h_flex()
            .id(("diagnostic", ix))
            .gap_2()
            .px_3()
            .py(px(3.))
            .items_start()
            .text_sm()
            .when(target.is_some(), |row| {
                row.cursor_pointer().hover(move |style| style.bg(hover))
            })
            .child(div().pt(px(2.)).text_color(color).child(icon))
            .child(div().flex_1().child(diagnostic.message.clone()))
            .child(div().text_color(muted).child(location))
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

    fn closable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for BuildPanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "Build"
    }

    fn toolbar_buttons(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<Vec<Button>> {
        Some(vec![
            Button::new("build-toggle-log")
                .label(if self.show_log { "Problems" } else { "Raw log" })
                .ghost()
                .xsmall()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.show_log = !this.show_log;
                    cx.notify();
                })),
        ])
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for BuildPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = if self.show_log {
            let muted = cx.theme().muted_foreground;
            v_flex()
                .id("build-log")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px_3()
                .font_family("Menlo")
                .text_xs()
                .text_color(muted)
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
