//! Build status, diagnostics that jump to their line, and the build's log, in
//! Lattice's tool-panel look: 28px rows on the sheet, a 14px status mark,
//! the message in 12px ink, the location in secondary ink, the log in the
//! editor font.
//!
//! The build is lattice-core's (`latex::build`), the Tauri app's own: while
//! it runs the status line names the passes latexmk announces as they start
//! (the Build button's sequence), and once it ends the diagnostics are the
//! ones the Tauri app reads from the log, with paths relative to the project.

use std::{
    path::{Path, PathBuf},
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
use lattice_core::{
    latex::{BuildResult, BuildStep},
    models::Diagnostic,
};
use lattice_ui::{ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, icons::ICON};

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
        steps: Vec<BuildStep>,
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
    /// The project the diagnostics name their files in.
    root: PathBuf,
    diagnostics: Vec<Diagnostic>,
    log_lines: Vec<SharedString>,
    show_log: bool,
    /// Builds finished so far, for a scenario to tell a new one from the last.
    builds: usize,
    _ticker: Option<Task<()>>,
}

impl EventEmitter<PanelEvent> for BuildPanel {}
impl EventEmitter<OpenLocation> for BuildPanel {}

/// How many of `diagnostics` are at `level` ("error", "warning").
fn count(diagnostics: &[Diagnostic], level: &str) -> usize {
    diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.level == level)
        .count()
}

impl BuildPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            status: Status::Idle,
            root: PathBuf::new(),
            diagnostics: Vec::new(),
            log_lines: Vec::new(),
            show_log: false,
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
            path: self.root.join(file),
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

    /// The passes so far of the build under way, as latexmk announces them.
    pub fn steps(&mut self, latest: Vec<BuildStep>, cx: &mut Context<Self>) {
        if let Status::Running { steps, .. } = &mut self.status {
            *steps = latest;
            cx.notify();
        }
    }

    pub fn finished(&mut self, result: &BuildResult, cx: &mut Context<Self>) {
        self.builds += 1;
        self.status = Status::Finished {
            succeeded: result.success,
            duration: Duration::from_millis(u64::try_from(result.duration_ms).unwrap_or(u64::MAX)),
            errors: count(&result.diagnostics, "error"),
            warnings: count(&result.diagnostics, "warning"),
        };
        self.diagnostics = result.diagnostics.clone();
        let lines: Vec<&str> = result.log.lines().collect();
        let tail = lines.len().saturating_sub(LOG_TAIL_LINES);
        self.log_lines = lines[tail..]
            .iter()
            .map(|line| SharedString::from(line.to_string()))
            .collect();
        if !result.success && self.diagnostics.is_empty() {
            self.show_log = true;
        }
        cx.notify();
    }

    pub fn failed(&mut self, message: String, cx: &mut Context<Self>) {
        self.builds += 1;
        self.status = Status::Failed(message.into());
        self.diagnostics.clear();
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
            Status::Running {
                started,
                document,
                steps,
            } => {
                let passes = steps
                    .iter()
                    .map(|step| step.tool.as_str())
                    .collect::<Vec<_>>()
                    .join(" → ");
                (
                    Icon::LOADER,
                    palette.text_secondary,
                    format!(
                        "Building {document}… {}{:.1} s",
                        if passes.is_empty() {
                            String::new()
                        } else {
                            format!("{passes} · ")
                        },
                        started.elapsed().as_secs_f32()
                    ),
                )
            }
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
        let (icon, color) = match diagnostic.level.as_str() {
            "error" => (Icon::CIRCLE_ALERT, palette.danger),
            "warning" => (Icon::TRIANGLE_ALERT, palette.warning),
            _ => (Icon::INFO, palette.text_secondary),
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

    fn closable(&self, _: &App) -> bool {
        false
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
            "Show the log"
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

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic(level: &str) -> Diagnostic {
        Diagnostic {
            file: Some("main.tex".into()),
            line: Some(3),
            column: None,
            end_line: None,
            end_column: None,
            level: level.into(),
            message: "Undefined control sequence.".into(),
            code: None,
            params: Default::default(),
        }
    }

    #[test]
    fn counts_diagnostics_by_level() {
        let diagnostics = [
            diagnostic("error"),
            diagnostic("warning"),
            diagnostic("error"),
        ];
        assert_eq!(count(&diagnostics, "error"), 2);
        assert_eq!(count(&diagnostics, "warning"), 1);
        assert_eq!(count(&diagnostics, "info"), 0);
    }
}
