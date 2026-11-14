//! How Overleaf's history draws in the History panel (`OverleafHistoryRow`,
//! `OverleafHistoryState` and `overleaf-history.css` in the Tauri app).
//!
//! An entry reads like a version: a leaf glyph, or a filled tag when
//! Overleaf has a name for it, the name or the files as its title, who
//! (with how many more) and where the change came from when not the editor,
//! and, on the pointer, Compare with now and the whole project's restore.
//! Opened, it lists its names (each removable) and "Name this version", the
//! files its range changed, each a chip that opens its diff, with a restore
//! beside it, then Compare with now and the project's restore.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::overleaf::OverleafUpdate;
use lattice_i18n::{format_count, locale, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Field,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_CONTROL},
};

use super::{
    art,
    body::file_kind_icon,
    diff_view::history_diff,
    overleaf::{OverleafFile, overleaf_key, range},
    panel::HistoryPanel,
    row::{RowParts, Weight, person},
    time, timeline,
    widgets::{Control, inline_message, loading_line},
};

/// How a change that did not come from someone typing in the browser is
/// named; the editor's own leaves none, or "web" or "editor".
fn origin_name(origin: &str) -> Option<String> {
    Some(match origin {
        "web" | "editor" => return None,
        "upload" => t!("file upload").to_string(),
        "dropbox" => "Dropbox".to_string(),
        "git-bridge" => t!("git bridge").to_string(),
        "file-restore" => t!("file restore").to_string(),
        "project-restore" => t!("project restore").to_string(),
        other => other.to_string(),
    })
}

/// The title of an entry: its name, else the files it touched.
fn entry_title(update: &OverleafUpdate) -> String {
    match update.labels.first() {
        Some(label) => label.comment.clone(),
        None if update.paths.is_empty() => t!("Edits").to_string(),
        None => update.paths.join(", "),
    }
}

impl HistoryPanel {
    /// The Overleaf view: its state, its entries by day, and the next page.
    pub(super) fn render_overleaf_view(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = self.render_overleaf_state(true, cx);
        let rows = timeline::overleaf_rows(&self.overleaf.updates);
        let timeline = self.render_days(rows, window, cx);
        let more = self.render_overleaf_more(t!("Load more"), cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .children(state)
            .child(timeline)
            .children(more)
            .into_any_element()
    }

    /// What the timeline says about Overleaf's history when it could not be
    /// read, and, `alone` in its own view, while it loads or has nothing.
    pub(super) fn render_overleaf_state(
        &mut self,
        alone: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let history = &self.overleaf;
        if let Some(error) = &history.error {
            return Some(
                div()
                    .mt(px(8.))
                    .child(inline_message(error.clone(), true, cx))
                    .into_any_element(),
            );
        }
        if !alone || !history.updates.is_empty() {
            return None;
        }
        Some(if history.loading {
            div()
                .mt(px(16.))
                .child(loading_line(
                    "overleaf-history-loading",
                    t!("Loading Overleaf's history…"),
                    cx,
                ))
                .into_any_element()
        } else {
            art::empty_state(t!("No Overleaf history yet"), self.narrow(), None, cx)
        })
    }

    /// The next page of Overleaf's history, while it has one.
    pub(super) fn render_overleaf_more(
        &mut self,
        label: &'static str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let history = &self.overleaf;
        if history.next_before.is_none() || history.updates.is_empty() {
            return None;
        }
        let loading = history.loading_more;
        Some(
            div()
                .flex()
                .justify_center()
                .mt(px(8.))
                .child(
                    Control::quiet("overleaf-history-more", label)
                        .spinning(loading)
                        .disabled(loading || history.loading)
                        .on_click(cx.listener(|this, _, _, cx| this.load_more_overleaf(cx))),
                )
                .into_any_element(),
        )
    }

    pub(super) fn overleaf_row(
        &mut self,
        update: &OverleafUpdate,
        first: bool,
        last: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> RowParts {
        let palette = cx.palette().clone();
        let locale = locale();
        let key = overleaf_key(update.to_version);
        let expanded = self.expanded.as_deref() == Some(&key);
        let compare = self.compare_key.as_deref() == Some(&key);
        let label = update.labels.first().map(|label| label.comment.clone());
        let author = update
            .authors
            .first()
            .cloned()
            .unwrap_or_else(|| t!("Unknown").to_string());
        let others = update.authors.len().saturating_sub(1);
        let origin = update.origin.as_deref().and_then(origin_name);
        let detail = (label.is_some() && !update.paths.is_empty()).then(|| update.paths.join(", "));
        let meta = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .min_w_0()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .items_center()
                    .min_w_0()
                    .child(person(&author))
                    .when(others > 0, |this| {
                        this.child(
                            div()
                                .flex_none()
                                .child(format!(" +{}", format_count(others as i64))),
                        )
                    }),
            )
            .children(origin.map(|origin| {
                div()
                    .flex_shrink(1.)
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .px(px(4.))
                    .rounded(px(4.))
                    .bg(palette.hover)
                    .child(origin)
            }))
            .children(detail.map(|detail| {
                div()
                    .flex_shrink(1.)
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(detail)
            }))
            .into_any_element();
        let compare_key = key.clone();
        let version = update.to_version;
        let busy = self.overleaf.busy;
        let tools = vec![
            Control::tool(
                SharedString::from(format!("overleaf-history-compare-{version}")),
                Icon::GIT_COMPARE_ARROWS,
                t!("Compare with now"),
            )
            .on(expanded && compare)
            .on_click(cx.listener(move |this, _, _, cx| this.compare_row(compare_key.clone(), cx)))
            .into_any_element(),
            Control::tool(
                SharedString::from(format!("overleaf-history-restore-{version}")),
                Icon::ROTATE_CCW,
                t!("Restore whole project to this version"),
            )
            .disabled(busy)
            .on_click(cx.listener(move |this, _, _, cx| this.restore_overleaf_project(version, cx)))
            .into_any_element(),
        ];
        let body = expanded.then(|| self.overleaf_body(update, window, cx));
        let toggled = key.clone();
        let on_toggle =
            Box::new(cx.listener(move |this, _, _, cx| this.toggle_row(toggled.clone(), cx)));
        RowParts {
            on_toggle,
            probe: None,
            key,
            glyph: if label.is_some() {
                Icon::TAG
            } else {
                Icon::LEAF
            },
            glyph_size: 13.,
            weight: if label.is_some() {
                Weight::Named
            } else {
                Weight::Plain
            },
            title: entry_title(update).into(),
            meta: Some(meta),
            time: time::clock_time(update.end_ts, locale).into(),
            time_title: time::full_time(update.end_ts, locale).into(),
            tools,
            body,
            first,
            last,
        }
    }

    /// An opened entry: its names, the files its range changed with their
    /// diffs and restores, and the project's restore.
    fn overleaf_body(
        &mut self,
        update: &OverleafUpdate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let key = overleaf_key(update.to_version);
        let version = update.to_version;
        let busy = self.overleaf.busy;
        let newest = self
            .overleaf
            .updates
            .first()
            .map(|update| update.to_version);
        let Some(opened) = self
            .overleaf
            .opened
            .as_ref()
            .filter(|opened| opened.to_version == version)
        else {
            return div().into_any_element();
        };
        let compare = opened.compare;
        let (from, to) = range(update, newest, compare);
        let unchanged = from >= to;
        let mut body = div().flex().flex_col().gap(px(8.)).min_w_0();
        if compare {
            let key = key.clone();
            body = body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap_x(px(12.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(if unchanged {
                        t!("Nothing has changed on Overleaf since this version")
                    } else {
                        t!("Compared with now")
                    })
                    .child(
                        Control::link("overleaf-mode-switch", t!("Show this version's changes"))
                            .on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.compare_row(key.clone(), cx)
                                }),
                            ),
                    ),
            );
        }

        // The names Overleaf keeps for this version, and naming it.
        let chips = update.labels.iter().map(|label| {
            let (id, comment) = (label.id.clone(), label.comment.clone());
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .min_w_0()
                .max_w_full()
                .h(px(24.))
                .pl(px(8.))
                .pr(px(4.))
                .rounded(RADIUS_CONTROL)
                .bg(palette.accent_soft)
                .text_color(palette.accent)
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .child(Icon::TAG.element(px(10.), palette.accent))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(label.comment.clone()),
                )
                .child(
                    Control::icon_button(
                        SharedString::from(format!("overleaf-label-remove-{}", label.id)),
                        Icon::X,
                        t!("Remove the \"{comment}\" label", comment = &label.comment),
                    )
                    .disabled(busy)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.delete_overleaf_label(id.clone(), comment.clone(), cx)
                    })),
                )
                .into_any_element()
        });
        let naming = match opened.label.as_ref() {
            Some((field, _)) => {
                let field = field.clone();
                let empty = field.read(cx).value().trim().is_empty();
                div()
                    .id("overleaf-label-form")
                    .flex()
                    .flex_1()
                    .items_center()
                    .gap(px(4.))
                    .min_w(px(160.))
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                        if event.keystroke.key == "escape" {
                            cx.stop_propagation();
                            this.close_overleaf_label(cx);
                        }
                    }))
                    .child(div().flex_1().min_w_0().child(Field::new(&field).compact()))
                    .child(
                        Control::quiet("overleaf-label-save", t!("Save"))
                            .disabled(empty || busy)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let comment = field.read(cx).value().to_string();
                                this.add_overleaf_label(version, comment, cx);
                            })),
                    )
                    .child(
                        Control::quiet("overleaf-label-cancel", t!("Cancel"))
                            .on_click(cx.listener(|this, _, _, cx| this.close_overleaf_label(cx))),
                    )
                    .into_any_element()
            }
            None => Control::quiet("overleaf-name-version", t!("Name this version"))
                .icon(Icon::TAG, px(11.))
                .on_click(cx.listener(|this, _, window, cx| this.open_overleaf_label(window, cx)))
                .into_any_element(),
        };
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .children(chips)
                .child(naming),
        );

        // The files the range changed.
        let files = &opened.files;
        if files.loading {
            body = body.child(loading_line(
                "overleaf-files-loading",
                t!("Loading files…"),
                cx,
            ));
        } else if !files.error.is_empty() {
            body = body.child(inline_message(files.error.clone(), true, cx));
        } else if let Some(files) = files.value.as_ref() {
            if files.is_empty() {
                body = body.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(t!("No file changes recorded for this update")),
                );
            } else {
                let open = opened.diff.key.clone();
                let rows = files
                    .iter()
                    .map(|file| self.overleaf_file_row(version, file, open.as_deref(), cx));
                body = body.child(div().flex().flex_col().gap(px(4.)).min_w_0().children(rows));
            }
        }
        if let Some(path) = opened.diff.key.clone() {
            body = body.child(self.overleaf_diff(&path, window, cx));
        }

        let mut actions = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(8.))
            .gap_y(px(6.))
            .min_w_0();
        if !compare {
            actions = actions.child(
                Control::action("overleaf-compare-now", t!("Compare with now"))
                    .icon(Icon::GIT_COMPARE_ARROWS, px(12.))
                    .on_click(cx.listener(move |this, _, _, cx| this.compare_row(key.clone(), cx))),
            );
        }
        actions = actions.child(
            Control::action(
                "overleaf-restore-project",
                t!("Restore whole project to this version"),
            )
            .icon(Icon::ROTATE_CCW, px(12.))
            .disabled(busy)
            .on_click(
                cx.listener(move |this, _, _, cx| this.restore_overleaf_project(version, cx)),
            ),
        );
        body.child(actions).into_any_element()
    }

    /// One changed file: a chip opening its diff, and its restore.
    fn overleaf_file_row(
        &self,
        version: i64,
        file: &OverleafFile,
        open: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let deleted = file.operation == "removed" && file.deleted_at_v.is_some();
        let name = match (&file.operation[..], &file.new_pathname) {
            ("renamed", Some(to)) => format!("{} → {to}", file.pathname),
            _ => file.pathname.clone(),
        };
        let target = file
            .new_pathname
            .clone()
            .unwrap_or_else(|| file.pathname.clone());
        let is_open = open == Some(target.as_str());
        let restored = file.clone();
        div()
            .flex()
            .items_center()
            .gap(px(4.))
            .min_w_0()
            .child(
                div().flex_shrink(1.).min_w_0().child(
                    Control::chip(
                        SharedString::from(format!("overleaf-file-{}", file.pathname)),
                        name.clone(),
                    )
                    .leading(file_kind_icon(&file.operation, cx))
                    .on(is_open)
                    .tooltip(name)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_overleaf_file(target.clone(), cx)
                    })),
                ),
            )
            .child(
                Control::quiet(
                    SharedString::from(format!("overleaf-file-restore-{}", file.pathname)),
                    if deleted {
                        t!("Restore")
                    } else {
                        t!("Restore this file")
                    },
                )
                .icon(Icon::ROTATE_CCW, px(11.))
                .disabled(self.overleaf.busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.restore_overleaf_file(version, restored.clone(), cx)
                })),
            )
            .into_any_element()
    }

    /// The open file's diff across the entry's range.
    fn overleaf_diff(&self, path: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(opened) = self.overleaf.opened.as_ref() else {
            return div().into_any_element();
        };
        let diff = &opened.diff;
        if !diff.error.is_empty() {
            return inline_message(diff.error.clone(), true, cx);
        }
        let Some(value) = diff.value.as_ref() else {
            return loading_line("overleaf-diff-loading", t!("Loading diff…"), cx);
        };
        let open_line = super::body::open_line(path.to_string(), cx);
        match &value.loaded {
            Some(loaded) => history_diff(
                format!("overleaf-diff-{path}"),
                loaded,
                false,
                None,
                Some(open_line),
                window,
                cx,
            ),
            None => {
                let change = super::diff_view::FileChange {
                    path: path.to_string(),
                    before: None,
                    after: None,
                };
                let loaded = super::diff_view::LoadedDiff::new(change, cx);
                history_diff(
                    format!("overleaf-diff-{path}"),
                    &loaded,
                    true,
                    None,
                    None,
                    window,
                    cx,
                )
            }
        }
    }
}
