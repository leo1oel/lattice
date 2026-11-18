//! The palette's plugin steps (docs/plugins.md; the Tauri app's
//! `src/plugins/plugin-run.tsx`): a command that asks for text turns
//! the search row into its field, with the plugin's name in a chip before
//! it and the manifest's placeholder (↩ runs, ⎋ goes back); a running
//! command is the card's one row, the loader and the plugin's latest
//! progress (⎋ stops it and closes); then the search row gives way to a
//! header, "<Plugin> · <summary>", over the result: items, diagnostics
//! grouped by file, a message's Markdown, or the error, with Open Settings
//! when Settings › Plugins can fix it. ↑↓ move, ↩ runs a row's first
//! action (a diagnostic's: open its place), and the row in front or under
//! the pointer shows its other actions as small buttons. A bibliography
//! action asks in the card first, showing the entry (or the entry now and
//! after), and writes once the writer confirms; ⎋ goes back to the result.

use futures::StreamExt as _;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    SharedString, Styled as _, Task, Window, div, px,
};
use lattice_core::plugins::{
    ActionKind, CancelToken, CommandResult, InputKind, PluginCommand, RunRequest,
};
use lattice_i18n::t;
use lattice_settings::SettingsTab;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_MEDIUM};

use super::{CommandPaletteView, PaletteEvent};
use crate::{
    plugins::{
        self, Update, markdown,
        results::{self, Row},
        text::{self, ErrorText},
    },
    shell::plugin_actions::{BibChange, BibTarget},
};

/// A run's token, cancelled when the step that holds it goes (the palette
/// closed by a click outside, Escape, or the result arrived).
pub(super) struct Running(CancelToken);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(super) enum Step {
    /// Asking for the command's text.
    Input {
        command: PluginCommand,
        /// The query the list had, back on ⎋.
        query: String,
    },
    Running {
        command: PluginCommand,
        progress: Option<String>,
        _token: Running,
        _task: Task<()>,
    },
    Done {
        command: PluginCommand,
        outcome: Outcome,
        /// A bibliography action being asked about.
        confirm: Option<Box<BibConfirm>>,
    },
}

/// A bibliography action shown before it writes.
pub(super) struct BibConfirm {
    pub(super) change: BibChange,
    pub(super) target: BibTarget,
    /// The file is being read, or the change written.
    pub(super) busy: bool,
    /// The target has been read: the question can show.
    pub(super) shown: bool,
    _task: Option<Task<()>>,
}

impl BibConfirm {
    /// The question: add this entry, or update one.
    pub(super) fn title(&self) -> String {
        let file = &self.target.file;
        match &self.change {
            BibChange::Add { .. } => t!("Add this entry to {file}?", file = file).to_string(),
            BibChange::Replace { key, .. } => {
                t!("Update “{key}” in {file}?", key = key, file = file).to_string()
            }
        }
    }
}

pub(super) enum Outcome {
    Result {
        result: CommandResult,
        rows: Vec<Row>,
        selected: usize,
        blocks: Vec<markdown::Block>,
    },
    Error(ErrorText),
}

impl CommandPaletteView {
    /// A plugin row chosen: its input step, or the run at once.
    pub(super) fn choose_plugin(
        &mut self,
        command: PluginCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if command.input.kind != InputKind::Text {
            self.start_plugin(command, None, window, cx);
            return;
        }
        let query = self.input.read(cx).value().to_string();
        let placeholder = command.input.placeholder.clone().unwrap_or_default();
        self.input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.set_placeholder(placeholder, window, cx);
            input.focus(window, cx);
        });
        self.plugin = Some(Step::Input { command, query });
        cx.notify();
    }

    /// ⎋ in the input step: the list again, as it was.
    fn plugin_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Step::Input { query, .. }) = self.plugin.take() else {
            return;
        };
        let placeholder = self.placeholder;
        self.input.update(cx, |input, cx| {
            input.set_placeholder(placeholder, window, cx);
            input.set_value(query, window, cx);
        });
        self.filter(cx);
    }

    /// ↩ in the input step.
    pub(super) fn plugin_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Step::Input { command, .. }) = &self.plugin else {
            return;
        };
        let command = command.clone();
        let input = self.input.read(cx).value().to_string();
        self.start_plugin(command, Some(input), window, cx);
    }

    fn start_plugin(
        &mut self,
        command: PluginCommand,
        input: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let project = self
            .shell
            .upgrade()
            .and_then(|shell| shell.read(cx).plugin_project(cx));
        let request = RunRequest {
            plugin_id: command.plugin_id.clone(),
            command_id: command.command_id.clone(),
            input,
            project,
            locale: lattice_i18n::locale().tag().to_string(),
        };
        let token = CancelToken::new();
        let mut updates = plugins::run(request, token.clone(), cx);
        let task = cx.spawn(async move |this, cx| {
            while let Some(update) = updates.next().await {
                if this
                    .update(cx, |this, cx| this.plugin_update(update, cx))
                    .is_err()
                {
                    return;
                }
            }
        });
        self.plugin = Some(Step::Running {
            command,
            progress: None,
            _token: Running(token),
            _task: task,
        });
        // The field leaves the card: the keys go to the palette itself.
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn plugin_update(&mut self, update: Update, cx: &mut Context<Self>) {
        let Some(Step::Running { command, .. }) = &self.plugin else {
            return;
        };
        let command = command.clone();
        match update {
            Update::Progress(message) => {
                if let Some(Step::Running { progress, .. }) = &mut self.plugin {
                    *progress = Some(message);
                }
            }
            Update::Done(outcome) => {
                let outcome = match outcome {
                    Ok(result) => {
                        let rows = results::rows(&result);
                        let blocks = match &result {
                            CommandResult::Message { markdown, .. } => markdown::parse(markdown),
                            _ => Vec::new(),
                        };
                        Outcome::Result {
                            selected: results::first(&rows),
                            rows,
                            blocks,
                            result,
                        }
                    }
                    Err(error) => Outcome::Error(text::error_text(&error)),
                };
                self.plugin = Some(Step::Done {
                    command,
                    outcome,
                    confirm: None,
                });
                self.result_scroll.scroll_to_item(0);
            }
        }
        cx.notify();
    }

    /// The palette's keys in a plugin step; `false` when it has none.
    pub(super) fn plugin_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = event.keystroke.key.as_str();
        match (&mut self.plugin, key) {
            (None, _) => return false,
            (Some(Step::Input { .. }), "escape") => self.plugin_back(window, cx),
            (Some(Step::Input { .. }), "up" | "down") => {}
            (Some(Step::Input { .. }), _) => return false,
            (Some(Step::Running { .. }), "escape") => {
                self.plugin = None;
                cx.emit(PaletteEvent::Dismiss);
            }
            (
                Some(Step::Done {
                    confirm: Some(confirm),
                    ..
                }),
                _,
            ) => match key {
                "escape" if !confirm.busy => self.cancel_bib(cx),
                "escape" => cx.emit(PaletteEvent::Dismiss),
                "enter" => self.write_bib(window, cx),
                _ => {}
            },
            (Some(Step::Done { .. }), "escape") => cx.emit(PaletteEvent::Dismiss),
            (
                Some(Step::Done {
                    outcome: Outcome::Result { rows, selected, .. },
                    ..
                }),
                "up" | "down",
            ) => {
                *selected = results::step(rows, *selected, if key == "up" { -1 } else { 1 });
                let at = *selected;
                self.result_scroll.scroll_to_item(at + 1);
                cx.notify();
            }
            (Some(Step::Done { .. }), "enter") => {
                if let Some(at) = self.selected_row() {
                    self.plugin_act(at, None, window, cx);
                }
            }
            (Some(Step::Done { .. }), "up" | "down") => {}
            _ => return false,
        }
        true
    }

    pub(super) fn selected_row(&self) -> Option<usize> {
        match &self.plugin {
            Some(Step::Done {
                outcome: Outcome::Result { rows, selected, .. },
                ..
            }) => rows
                .get(*selected)
                .filter(|row| row.acts())
                .map(|_| *selected),
            _ => None,
        }
    }

    /// The action of row `at`: its `index`th (a diagnostic's fixes, an
    /// item's actions), or its default.
    fn row_action(&self, at: usize, index: Option<usize>) -> Option<ActionKind> {
        let Some(Step::Done {
            outcome: Outcome::Result { result, rows, .. },
            ..
        }) = &self.plugin
        else {
            return None;
        };
        match (rows.get(at)?, result) {
            (Row::Item(item), CommandResult::Items { items, .. }) => {
                let item = items.get(*item)?;
                match index {
                    Some(index) => item.actions.get(index).map(|action| action.kind.clone()),
                    None => results::item_default(item).cloned(),
                }
            }
            (Row::Diagnostic(item), CommandResult::Diagnostics { items, .. }) => {
                let diagnostic = items.get(*item)?;
                match index {
                    Some(index) => diagnostic.fixes.get(index).map(|fix| fix.kind.clone()),
                    None => Some(results::diagnostic_default(diagnostic)),
                }
            }
            _ => None,
        }
    }

    /// Run an action of row `at`: the palette closes and the shell does
    /// it, except a bibliography write, which the card asks about first.
    pub(super) fn plugin_act(
        &mut self,
        at: usize,
        index: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(action) = self.row_action(at, index) else {
            return;
        };
        let change = match &action {
            ActionKind::AddBibEntry { bibtex, file } => Some((
                BibChange::Add {
                    bibtex: bibtex.clone(),
                },
                file.clone(),
                None,
            )),
            ActionKind::ReplaceBibEntry { key, bibtex, file } => Some((
                BibChange::Replace {
                    key: key.clone(),
                    bibtex: bibtex.clone(),
                },
                file.clone(),
                Some(key.clone()),
            )),
            _ => None,
        };
        if let Some((change, file, replacing)) = change {
            self.ask_bib(change, file, replacing, cx);
            return;
        }
        cx.emit(PaletteEvent::Dismiss);
        let shell = self.shell.clone();
        window.defer(cx, move |window, cx| {
            shell
                .update(cx, |shell, cx| {
                    shell.perform_plugin_action(action, window, cx)
                })
                .ok();
        });
    }

    fn bib_confirm(&mut self) -> Option<&mut BibConfirm> {
        match &mut self.plugin {
            Some(Step::Done { confirm, .. }) => confirm.as_deref_mut(),
            _ => None,
        }
    }

    /// Read where `change` goes (and the entry it updates), then ask.
    fn ask_bib(
        &mut self,
        change: BibChange,
        file: Option<String>,
        replacing: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(shell) = self.shell.upgrade() else {
            return;
        };
        let target = shell.read(cx).plugin_bib_target(file, replacing, cx);
        let task = cx.spawn(async move |this, cx| {
            let target = target.await;
            this.update(cx, |this, cx| {
                if let Some(confirm) = this.bib_confirm() {
                    confirm.target = target;
                    confirm.busy = false;
                    confirm.shown = true;
                }
                cx.notify();
            })
            .ok();
        });
        if let Some(Step::Done { confirm, .. }) = &mut self.plugin {
            *confirm = Some(Box::new(BibConfirm {
                change,
                target: BibTarget::default(),
                busy: true,
                shown: false,
                _task: Some(task),
            }));
        }
        cx.notify();
    }

    /// Cancel, or ⎋: back to the result.
    pub(super) fn cancel_bib(&mut self, cx: &mut Context<Self>) {
        if let Some(Step::Done { confirm, .. }) = &mut self.plugin {
            *confirm = None;
        }
        cx.notify();
    }

    /// Add entry or Update entry: write, then close; a failure stays in the
    /// card.
    pub(super) fn write_bib(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(shell) = self.shell.upgrade() else {
            return;
        };
        let Some(confirm) = self.bib_confirm() else {
            return;
        };
        let replacing = matches!(confirm.change, BibChange::Replace { .. });
        if confirm.busy
            || !confirm.shown
            || confirm.target.file.is_empty()
            || (replacing && confirm.target.before.is_none())
        {
            return;
        }
        confirm.busy = true;
        confirm.target.error = None;
        let (file, change) = (confirm.target.file.clone(), confirm.change.clone());
        let written = shell.update(cx, |shell, cx| {
            shell.write_plugin_bib(file, change, window, cx)
        });
        let task = cx.spawn(async move |this, cx| {
            let written = written.await;
            this.update(cx, |this, cx| match written {
                Ok(()) => cx.emit(PaletteEvent::Dismiss),
                Err(error) => {
                    if let Some(confirm) = this.bib_confirm() {
                        confirm.busy = false;
                        confirm.target.error = Some(error);
                    }
                    cx.notify();
                }
            })
            .ok();
        });
        if let Some(confirm) = self.bib_confirm() {
            confirm._task = Some(task);
        }
        cx.notify();
    }

    pub(super) fn open_plugin_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(PaletteEvent::Dismiss);
        let shell = self.shell.clone();
        window.defer(cx, move |window, cx| {
            shell
                .update(cx, |shell, cx| {
                    shell.open_settings(Some(SettingsTab::Plugins), window, cx)
                })
                .ok();
        });
    }

    /// Whether the search row shows: only while the list or the command's
    /// field is in it, not once a command runs.
    pub(super) fn search_row_shown(&self) -> bool {
        matches!(self.plugin, None | Some(Step::Input { .. }))
    }

    /// The input step's search row: the plugin's name in a chip, then the
    /// field (`.plugin-input-header`).
    pub(super) fn plugin_search_row(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let Some(Step::Input { command, .. }) = &self.plugin else {
            return None;
        };
        let palette = cx.palette().clone();
        let chip = div()
            .flex_none()
            .max_w(px(220.))
            .px(px(8.))
            .py(px(2.))
            .rounded_full()
            .bg(palette.accent_soft)
            .text_color(palette.text)
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .truncate()
            .child(SharedString::from(command.plugin_name.clone()));
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .flex_1()
                .min_w_0()
                .child(chip)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_role(TextRole::Body, cx)
                        .child(
                            gpui_kit::component::input::Input::new(&self.input)
                                .appearance(false)
                                .bordered(false),
                        ),
                )
                .into_any_element(),
        )
    }

    /// Over a result, its confirmation or an error, in the search row's
    /// place: the plugin's name, a dot, then the result's summary or the
    /// command's title (`.plugin-run-header`).
    pub(super) fn plugin_header(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let Some(Step::Done {
            command, outcome, ..
        }) = &self.plugin
        else {
            return None;
        };
        let palette = cx.palette().clone();
        let summary = match outcome {
            Outcome::Result { result, .. } => results::summary(result),
            Outcome::Error(_) => None,
        }
        .unwrap_or(&command.title);
        Some(
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .min_w_0()
                .px(px(16.))
                .py(px(10.))
                .border_b_1()
                .border_color(palette.line)
                .text_role(TextRole::Body, cx)
                .child(
                    div()
                        .flex_none()
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(SharedString::from(command.plugin_name.clone())),
                )
                .child(
                    div()
                        .flex_none()
                        .text_color(palette.text_secondary)
                        .child("·"),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(palette.text_secondary)
                        .child(SharedString::from(summary.to_string())),
                )
                .into_any_element(),
        )
    }

    /// The card's body in a plugin step, under the search row or header.
    pub(super) fn plugin_body(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        match self.plugin.as_ref()? {
            Step::Input { .. } => None,
            Step::Running {
                command, progress, ..
            } => {
                let message = progress
                    .as_deref()
                    .map(str::trim)
                    .filter(|progress| !progress.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| text::running(&command.title));
                Some(
                    div()
                        .id("plugin-progress")
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(16.))
                        .py(px(12.))
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text_secondary)
                        .child(crate::build::chip_mark::infinity_loader(
                            "plugin-progress-loader",
                            px(16.),
                            &palette,
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(SharedString::from(message)),
                        )
                        .into_any_element(),
                )
            }
            Step::Done {
                confirm: Some(confirm),
                ..
            } if confirm.shown => Some(self.confirm_view(cx)),
            Step::Done { outcome, .. } => Some(match outcome {
                Outcome::Error(error) => self.error_view(error.clone(), cx),
                Outcome::Result { .. } => self.result_view(window, cx),
            }),
        }
    }

    /// What a scenario reads of a plugin step: its name, and its rows as
    /// `(kind, text)` (`file`, `item`, `diagnostic`, `progress`,
    /// `message`, `error`, `empty`).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn plugin_state(&self) -> Option<(&'static str, Vec<(String, String)>)> {
        let step = self.plugin.as_ref()?;
        Some(match step {
            Step::Input { .. } => ("input", Vec::new()),
            Step::Running { progress, .. } => (
                "running",
                vec![("progress".into(), progress.clone().unwrap_or_default())],
            ),
            Step::Done {
                outcome: Outcome::Error(error),
                ..
            } => ("done", vec![("error".into(), error.text.clone())]),
            Step::Done {
                confirm: Some(confirm),
                ..
            } if confirm.shown => (
                "confirm",
                vec![(
                    "confirm".into(),
                    confirm
                        .target
                        .error
                        .clone()
                        .unwrap_or_else(|| confirm.title()),
                )],
            ),
            Step::Done {
                outcome: Outcome::Result { result, rows, .. },
                ..
            } => {
                let shown = match result {
                    CommandResult::Message { markdown, .. } => {
                        vec![("message".into(), markdown.clone())]
                    }
                    CommandResult::Items { items, .. } if items.is_empty() => {
                        vec![("empty".into(), String::new())]
                    }
                    CommandResult::Diagnostics { items, .. } if items.is_empty() => {
                        vec![("empty".into(), String::new())]
                    }
                    CommandResult::Items { items, .. } => rows
                        .iter()
                        .filter_map(|row| match row {
                            Row::Item(index) => Some(("item".into(), items[*index].title.clone())),
                            _ => None,
                        })
                        .collect(),
                    CommandResult::Diagnostics { items, .. } => rows
                        .iter()
                        .map(|row| match row {
                            Row::File(file) => ("file".into(), file.clone()),
                            Row::Diagnostic(index) => {
                                ("diagnostic".into(), items[*index].message.clone())
                            }
                            Row::Item(_) => (String::new(), String::new()),
                        })
                        .collect(),
                };
                ("done", shown)
            }
        })
    }

    /// Type `text` in the input step and press ↩, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn plugin_submit(
        &mut self,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
        self.plugin_enter(window, cx);
    }

    /// Run action `index` (or the default) of the row whose text is
    /// `label`, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn plugin_act_on(
        &mut self,
        label: &str,
        index: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some((_, rows)) = self.plugin_state() else {
            return false;
        };
        let Some(Step::Done {
            outcome: Outcome::Result { rows: all, .. },
            ..
        }) = &self.plugin
        else {
            return false;
        };
        let acting: Vec<usize> = (0..all.len()).filter(|at| all[*at].acts()).collect();
        let found = rows
            .iter()
            .filter(|(kind, _)| kind != "file")
            .position(|(_, text)| text == label);
        let Some(at) = found.and_then(|found| acting.get(found).copied()) else {
            return false;
        };
        self.plugin_act(at, index, window, cx);
        true
    }

    /// Type `text` in the input step without running it, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn plugin_type(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
    }

    /// Press the confirmation's answer, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn plugin_confirm_accept(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.write_bib(window, cx);
    }
}
