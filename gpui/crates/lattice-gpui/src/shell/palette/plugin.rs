//! The palette's plugin steps (docs/plugins.md; the Tauri app's
//! `src/plugins/plugin-run.tsx`): a command that asks for text turns
//! the search row into its field, with the plugin's name in a chip before
//! it and the manifest's placeholder (↩ runs, ⎋ goes back); a running
//! command is one row, a spinner and the plugin's latest progress (⎋ stops
//! it and closes); then its result under a header line: items, diagnostics
//! grouped by file, or a message's Markdown, or the error, with Open
//! Settings when Settings › Plugins can fix it. ↑↓ move, ↩ runs a row's
//! first action (a diagnostic's: open its place), and the row in front or
//! under the pointer shows its other actions as small buttons.

use futures::StreamExt as _;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    SharedString, Styled as _, Task, Window, div, px,
};
use lattice_core::plugins::{
    ActionKind, CancelToken, CommandResult, InputKind, PluginCommand, RunRequest,
};
use lattice_settings::SettingsTab;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, icons::ICON, shape,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{CommandPaletteView, PaletteEvent};
use crate::plugins::{
    self, Update, markdown,
    results::{self, Row},
    text::{self, ErrorText},
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
    },
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

impl Step {
    fn command(&self) -> &PluginCommand {
        match self {
            Step::Input { command, .. }
            | Step::Running { command, .. }
            | Step::Done { command, .. } => command,
        }
    }
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
                self.plugin = Some(Step::Done { command, outcome });
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

    /// Run an action of row `at`; the palette closes unless the action
    /// asks the writer to confirm first.
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
        let confirms = matches!(
            action,
            ActionKind::AddBibEntry { .. } | ActionKind::ReplaceBibEntry { .. }
        );
        if !confirms {
            cx.emit(PaletteEvent::Dismiss);
        }
        let shell = self.shell.clone();
        window.defer(cx, move |window, cx| {
            shell
                .update(cx, |shell, cx| {
                    shell.perform_plugin_action(action, window, cx)
                })
                .ok();
        });
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

    /// The search row's content in a plugin step: the chip, then the field
    /// (asking) or the command's title.
    pub(super) fn plugin_search_row(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let step = self.plugin.as_ref()?;
        let palette = cx.palette().clone();
        let command = step.command();
        let chip = div()
            .flex_none()
            .px(px(6.))
            .h(px(20.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .bg(palette.accent_soft)
            .text_color(palette.accent)
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .child(SharedString::from(command.plugin_name.clone()));
        let field = match step {
            Step::Input { .. } => div()
                .flex_1()
                .text_role(TextRole::Body, cx)
                .child(
                    gpui_kit::component::input::Input::new(&self.input)
                        .appearance(false)
                        .bordered(false),
                )
                .into_any_element(),
            _ => div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_role(TextRole::Body, cx)
                .text_color(palette.text)
                .child(SharedString::from(command.title.clone()))
                .into_any_element(),
        };
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .flex_1()
                .min_w_0()
                .child(Icon::PUZZLE.element(ICON, palette.text_secondary))
                .child(chip)
                .child(field)
                .into_any_element(),
        )
    }

    /// The card's body in a plugin step after the search row.
    pub(super) fn plugin_body(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let padded = || div().p(shape::PALETTE_LIST.inset);
        match self.plugin.as_ref()? {
            Step::Input { .. } => None,
            Step::Running {
                command, progress, ..
            } => {
                let message = progress
                    .clone()
                    .unwrap_or_else(|| text::running(&command.title));
                Some(
                    padded()
                        .child(
                            div()
                                .id("plugin-progress")
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .min_h(px(28.))
                                .px(px(10.))
                                .py(px(6.))
                                .child(lattice_ui::loading::loader(
                                    "plugin-progress-spinner",
                                    ICON,
                                    palette.text_secondary,
                                    cx,
                                ))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_role(TextRole::Body, cx)
                                        .text_color(palette.text_secondary)
                                        .child(SharedString::from(message)),
                                ),
                        )
                        .into_any_element(),
                )
            }
            Step::Done { command, outcome } => {
                let summary = match outcome {
                    Outcome::Result { result, .. } => results::summary(result),
                    Outcome::Error(_) => None,
                };
                let header = text::result_header(&command.plugin_name, summary, &command.title);
                let heading = div()
                    .px(px(10.))
                    .pt(px(4.))
                    .pb(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text_secondary)
                    .truncate()
                    .child(SharedString::from(header));
                let body = match outcome {
                    Outcome::Error(error) => self.error_view(error.clone(), cx),
                    Outcome::Result { .. } => self.result_view(window, cx),
                };
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .pt(shape::PALETTE_LIST.inset)
                        .child(heading)
                        .child(body)
                        .into_any_element(),
                )
            }
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
}
