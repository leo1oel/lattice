//! Settings › Logs, as the Tauri app's `AppLogsSettings`
//! (`src/telemetry/app-log.tsx`, `.app-log-*` in `adaptive-feedback.css`):
//! the search and the level filter over Export…, Clear and Open log folder,
//! then the log in one card that fills the rest of the page and scrolls
//! inside it, the page itself never scrolling. It reads like a terminal:
//! oldest first, newest at the bottom, where a newly opened log starts and
//! where it keeps following while the reader stays near it, so looking at an
//! older entry is not interrupted by new ones.
//!
//! Each row is a time, the terse level and the title with its source; it
//! opens to the whole message, Export… for that entry alone and, for an
//! operation's entry, its metadata (whose id filters the log to it). An
//! operation's entries share one row, which opens to its timeline.

use std::collections::HashSet;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field, Select},
    scrollbar::FluidScrollbar,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::logs_export::{ExportDialog, ExportEvent};
use crate::app_log::{self, AppLog, Entry, Level, groups};

/// Within this of the bottom, new entries keep the view at the bottom.
const FOLLOW_SLACK: f32 = 48.;

/// The level column's terse word (`LOG_LEVEL`).
fn level_word(level: Level) -> &'static str {
    match level {
        Level::Info => t!("INFO"),
        Level::Success => t!("OK"),
        Level::Warning => t!("WARN"),
        Level::Error => t!("ERROR"),
    }
}

/// A level's or an operation phase's readable name (`STATUS_LABELS`).
fn status_label(status: &str) -> &'static str {
    match status {
        "info" => t!("Info"),
        "success" => t!("Success"),
        "warning" => t!("Warning"),
        "error" => t!("Error"),
        "cancelled" => t!("Cancelled"),
        "started" => t!("Started"),
        "progress" => t!("In progress"),
        "completed" => t!("Completed"),
        _ => t!("Unknown"),
    }
}

pub struct LogsPane {
    log: Entity<AppLog>,
    search: Entity<InputState>,
    level: Option<Level>,
    open: HashSet<String>,
    scroll: ScrollHandle,
    /// The log has been drawn once, at its newest entry.
    positioned: bool,
    /// How many entries were shown, and the newest of them (its id and time).
    shown: (usize, Option<(String, String)>),
    /// The monospace face's `ch` at the log's size, which its columns are
    /// measured in (24ch for the time, 6ch for the level).
    ch: gpui::Pixels,
    export: Option<(Entity<ExportDialog>, Subscription)>,
    _subscriptions: Vec<Subscription>,
}

impl LogsPane {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let log = app_log::global(cx);
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search logs…")));
        let subscriptions = vec![
            cx.observe(&log, |_, _, cx| cx.notify()),
            cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        Self {
            log,
            search,
            level: None,
            open: HashSet::new(),
            scroll: ScrollHandle::new(),
            positioned: false,
            shown: (0, None),
            ch: px(7.2),
            export: None,
            _subscriptions: subscriptions,
        }
    }

    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().to_string()
    }

    /// The groups shown now.
    pub fn visible(&self, cx: &App) -> Vec<groups::Group> {
        groups::visible(self.log.read(cx).entries(), self.level, &self.query(cx))
    }

    pub fn set_level(&mut self, level: Option<Level>, cx: &mut Context<Self>) {
        self.level = level;
        cx.notify();
    }

    pub(crate) fn set_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |field, cx| {
            field.set_value(query.to_string(), window, cx)
        });
        cx.notify();
    }

    fn toggle(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.open.remove(key) {
            self.open.insert(key.to_string());
        }
        cx.notify();
    }

    /// Export `entries`: the dialog over Settings.
    pub fn open_export(
        &mut self,
        entries: Vec<Entry>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let log_folder = self.log.read(cx).log_folder();
        let data_folder = crate::shell::workspaces::state_dir(false);
        let dialog = cx.new(|_| ExportDialog::new(&entries, log_folder, data_folder));
        let subscription = cx.subscribe_in(&dialog, window, |this, _, event, _, cx| match event {
            ExportEvent::Close => {
                this.export = None;
                cx.notify();
            }
        });
        self.export = Some((dialog, subscription));
        cx.notify();
    }

    pub fn export_dialog(&self) -> Option<&Entity<ExportDialog>> {
        self.export.as_ref().map(|(dialog, _)| dialog)
    }

    /// How far the log's view sits above its bottom, and how far it can
    /// scroll at all, as of the last frame (the e2e check of `follow`).
    pub fn scroll_extent(&self) -> (gpui::Pixels, gpui::Pixels) {
        let max = self.scroll.max_offset().y;
        (max + self.scroll.offset().y, max)
    }

    fn open_folder(&self, cx: &mut App) {
        if let Some(folder) = self.log.read(cx).log_folder() {
            std::fs::create_dir_all(&folder).ok();
            cx.open_with_system(&folder);
        }
    }

    /// Keep the newest entry in view: at first draw, and while the reader is
    /// near the bottom, whenever the shown entries change: a new one, one the
    /// full log pushes out, or a repeated notice's entry updated in place.
    fn follow(&mut self, shown: &[Entry]) {
        let newest = shown
            .iter()
            .max_by(|a, b| a.timestamp.cmp(&b.timestamp))
            .map(|entry| (entry.id.clone(), entry.timestamp.clone()));
        let shown = (shown.len(), newest);
        let offset = self.scroll.offset().y;
        let max = self.scroll.max_offset().y;
        let near = max + offset < px(FOLLOW_SLACK);
        if !self.positioned || (shown != self.shown && near) {
            self.scroll.scroll_to_bottom();
        }
        self.positioned = true;
        self.shown = shown;
    }
}

impl EventEmitter<()> for LogsPane {}

/// What a row's head shows, beside its entry.
struct Head {
    id: SharedString,
    title: String,
    /// The `key=value` fields after the title.
    fields: String,
    /// An operation's outcome, the level column's tooltip.
    status_title: Option<&'static str>,
    open: bool,
    /// What opening it toggles.
    key: String,
}

impl LogsPane {
    /// A row's head, shared by an entry and an operation.
    fn summary(&self, entry: &Entry, head: Head, cx: &mut Context<Self>) -> AnyElement {
        let Head {
            id,
            title,
            fields,
            status_title,
            open,
            key,
        } = head;
        let palette = cx.palette().clone();
        let level_ink = match entry.level {
            Level::Info => palette.info,
            Level::Success => palette.success,
            Level::Warning => palette.warning,
            Level::Error => palette.danger,
        };
        div()
            .id(id)
            .group("app-log-row")
            .flex()
            .items_baseline()
            .gap(px(10.))
            .px(px(10.))
            .py(px(2.))
            .cursor_pointer()
            .text_color(palette.text_secondary)
            .hover(|this| this.bg(palette.hover))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(&key, cx)))
            .child(
                div()
                    .flex_none()
                    .w(self.ch * 24.)
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_color(palette.text_secondary.opacity(0.75))
                    .font_features(lattice_ui::typography::tabular_nums())
                    .child(entry.timestamp.clone()),
            )
            .child(
                div()
                    .id("app-log-level")
                    .flex_none()
                    .w(self.ch * 6.)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(level_ink)
                    .child(level_word(entry.level))
                    .when_some(status_title, |this, title| {
                        this.tooltip(move |_, cx| -> gpui::AnyView {
                            lattice_ui::components::LatticeTooltip::view(title, None, cx)
                        })
                    }),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(palette.text)
                    // One run, as the app's inline span: the fields after the
                    // title in the secondary ink, cut off together.
                    .child({
                        let start = title.len();
                        let text = format!("{title}{fields}");
                        let end = text.len();
                        gpui::StyledText::new(SharedString::from(text)).with_highlights([(
                            start..end,
                            gpui::HighlightStyle {
                                color: Some(palette.text_secondary),
                                ..Default::default()
                            },
                        )])
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .self_center()
                    .when(!open, |this| {
                        this.invisible()
                            .group_hover("app-log-row", |this| this.visible())
                    })
                    .child(
                        if open {
                            Icon::CHEVRON_DOWN
                        } else {
                            Icon::CHEVRON_RIGHT
                        }
                        .element(px(13.), palette.text_secondary),
                    ),
            )
            .into_any_element()
    }

    fn entry_row(&self, entry: &Entry, key: String, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let open = self.open.contains(&key);
        let detail = if entry.context.is_some() {
            app_log::visible_detail(&entry.detail)
        } else {
            entry.detail.clone()
        };
        // A console capture's event name says less than its first line.
        let console = [
            "console.warn",
            "console.error",
            "console.info",
            "console.log",
        ]
        .contains(&entry.title.as_str());
        let title = if console && !detail.trim().is_empty() {
            detail.trim().lines().next().unwrap_or_default().to_string()
        } else {
            entry.title.clone()
        };
        let head = self.summary(
            entry,
            Head {
                id: SharedString::from(format!("app-log-entry-{key}")),
                title,
                fields: format!(" source={}", entry.source),
                status_title: None,
                open,
                key: key.clone(),
            },
            cx,
        );
        let content = open.then(|| {
            let message = [entry.title.clone(), detail]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let exported = entry.clone();
            let context = entry.context.clone();
            div()
                .min_w_0()
                .mx(px(10.))
                .my(px(6.))
                .px(px(10.))
                .py(px(8.))
                .border_l_1()
                .border_color(palette.line_strong)
                .bg(palette.panel)
                .child(
                    div().flex().justify_end().child(
                        Button::new(
                            SharedString::from(format!("app-log-export-{key}")),
                            t!("Export…"),
                        )
                        .compact()
                        .icon(Icon::DOWNLOAD)
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_export(vec![exported.clone()], window, cx)
                            },
                        )),
                    ),
                )
                .child(
                    div()
                        .mt(px(8.))
                        .text_size(px(11.))
                        .line_height(gpui::relative(1.6))
                        .text_color(palette.text)
                        .child(message),
                )
                .children(context.map(|context| {
                    let operation_id = context.operation_id.clone();
                    let chip = |text: String| {
                        div()
                            .max_w_full()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .bg(palette.raised)
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(text)
                    };
                    let fields = serde_json::to_string_pretty(&context).unwrap_or_default();
                    div()
                        .child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .flex_wrap()
                                .gap(px(4.))
                                .text_size(px(11.))
                                .text_color(palette.text_secondary)
                                .child(chip(context.operation.clone()))
                                .child(chip(
                                    status_label(
                                        context.outcome.as_deref().unwrap_or(&context.phase),
                                    )
                                    .to_string(),
                                ))
                                .children(context.duration_ms.map(|ms| chip(format!("{ms} ms"))))
                                .child(
                                    chip(operation_id.chars().take(8).collect())
                                        .id(SharedString::from(format!("app-log-op-{key}")))
                                        .cursor_pointer()
                                        .hover(|this| this.text_color(palette.text))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.set_query(&operation_id, window, cx)
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .mt(px(8.))
                                .pt(px(8.))
                                .border_t_1()
                                .border_color(palette.line)
                                .text_size(px(11.))
                                .line_height(gpui::relative(1.6))
                                .text_color(palette.text_secondary)
                                .child(fields),
                        )
                }))
        });
        div().child(head).children(content).into_any_element()
    }

    fn group_row(&self, group: &groups::Group, cx: &mut Context<Self>) -> AnyElement {
        let Some(operation_id) = group.operation_id.clone() else {
            return self.entry_row(&group.summary, group.key.clone(), cx);
        };
        let palette = cx.palette().clone();
        let open = self.open.contains(&group.key);
        let summary = &group.summary;
        let context = summary.context.as_ref();
        let status = context
            .map(|context| {
                context
                    .outcome
                    .clone()
                    .unwrap_or_else(|| context.phase.clone())
            })
            .map_or(t!("Incomplete history"), |status| status_label(&status));
        let fields = format!(
            "{} operation_id={operation_id}",
            context
                .and_then(|context| context.duration_ms)
                .map(|ms| format!(" duration_ms={ms}"))
                .unwrap_or_default()
        );
        let head = self.summary(
            summary,
            Head {
                id: SharedString::from(format!("app-log-{}", group.key)),
                title: summary.title.clone(),
                fields,
                status_title: Some(status),
                open,
                key: group.key.clone(),
            },
            cx,
        );
        let timeline = open.then(|| {
            div()
                .my(px(6.))
                .border_l_1()
                .border_color(palette.line_strong)
                .bg(palette.panel)
                .children(
                    group
                        .entries
                        .iter()
                        .map(|entry| self.entry_row(entry, entry.id.clone(), cx))
                        .collect::<Vec<_>>(),
                )
        });
        div().child(head).children(timeline).into_any_element()
    }
}

impl Render for LogsPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let text_system = window.text_system();
        let face = text_system.resolve_font(&gpui::font(cx.lattice().fonts.editor.clone()));
        if let Ok(zero) = text_system.advance(face, px(12.), '0') {
            self.ch = zero.width;
        }
        let total = self.log.read(cx).entries().len();
        let visible = self.visible(cx);
        let shown: Vec<Entry> = visible
            .iter()
            .flat_map(|group| group.entries.iter().cloned())
            .collect();
        self.follow(&shown);
        let has_folder = self.log.read(cx).log_folder().is_some();
        let levels: Vec<(Option<Level>, SharedString)> =
            std::iter::once((None, t!("All levels").into()))
                .chain(
                    Level::ALL
                        .iter()
                        .map(|level| (Some(*level), status_label(level.tag()).into())),
                )
                .collect();
        let selected = levels.iter().position(|(level, _)| *level == self.level);
        let values: Vec<Option<Level>> = levels.iter().map(|(level, _)| *level).collect();
        let mono = cx.lattice().fonts.editor.clone();
        let query = self.query(cx);
        let actions = div()
            .relative()
            .children(lattice_ui::parity::probe("logs/actions"))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .mb(px(10.))
            .child(
                div()
                    .flex_grow(1.)
                    .flex_basis(px(260.))
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Field::new(&self.search).search()),
                    )
                    .child(
                        div().flex_none().child(
                            Select::new(
                                "app-log-level-filter",
                                levels.into_iter().map(|(_, label)| label),
                                selected,
                            )
                            .on_change(cx.listener(
                                move |this, ix: &usize, _, cx| {
                                    if let Some(level) = values.get(*ix) {
                                        this.set_level(*level, cx);
                                    }
                                },
                            )),
                        ),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        Button::new("app-log-export", t!("Export…"))
                            .icon(Icon::DOWNLOAD)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_export(shown.clone(), window, cx)
                            })),
                    )
                    .child(
                        Button::new("app-log-clear", t!("Clear"))
                            .disabled(total == 0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open.clear();
                                this.log.update(cx, |log, cx| log.clear(cx));
                            })),
                    )
                    .child(
                        Button::new("app-log-folder", t!("Open log folder"))
                            .icon(Icon::FOLDER_OPEN)
                            .disabled(!has_folder)
                            .on_click(cx.listener(|this, _, _, cx| this.open_folder(cx))),
                    ),
            );
        let body = if visible.is_empty() {
            div()
                .py(px(8.))
                .text_role(TextRole::BodyCompact, cx)
                .font_weight(lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text)
                .children(lattice_ui::parity::probe("logs/empty"))
                .child(if total == 0 {
                    t!("No logs yet")
                } else if !query.trim().is_empty() {
                    t!("No matching logs")
                } else {
                    t!("No logs at this level")
                })
                .into_any_element()
        } else {
            let rows: Vec<AnyElement> = visible
                .iter()
                .map(|group| self.group_row(group, cx))
                .collect();
            div()
                .relative()
                .flex_1()
                .min_h(px(140.))
                .rounded(px(12.))
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised)
                .overflow_hidden()
                .children(lattice_ui::parity::probe("logs/card"))
                .child(
                    div()
                        .id("app-log-scroll")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .py(px(8.))
                        .font_family(mono)
                        .text_size(px(12.))
                        .line_height(gpui::relative(1.8))
                        .children(rows),
                )
                .child(FluidScrollbar::vertical("app-log-scrollbar", &self.scroll))
                .into_any_element()
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(actions)
            .child(body)
            .children(self.export.as_ref().map(|(dialog, _)| dialog.clone()))
    }
}
