//! How the History panel draws, ported from the Tauri app's `HistoryDrawer`
//! and `HistoryDay` (`history-drawer.tsx`), the versions toolbar and states
//! (`versions-timeline.tsx`) and their sheet, `history-timeline.css`. Each
//! row is drawn by [`super::row`].

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::{git::GitLogEntry, project::HistoryItem};
use lattice_i18n::{format_count, locale, t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Field, Segmented},
    scrollbar::FluidScrollbar,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_CONTROL},
};

use super::{
    art, body, messages,
    panel::{HistoryPanel, Phase},
    row::{RowParts, Weight, history_row, person},
    time,
    timeline::{self, ActivityFilter, HistoryView, TimelineRow},
    widgets::{Control, inline_message, loading_line},
};

impl Render for HistoryPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.catch_up(cx);
        let palette = cx.palette().clone();
        let width = self.width.clone();
        let entity = cx.entity().downgrade();
        let probe = canvas(
            move |bounds, _, cx| {
                if width.get() != bounds.size.width {
                    width.set(bounds.size.width);
                    entity.update(cx, |_, cx| cx.notify()).ok();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let content = match self.comparing.clone() {
            Some(compare) => compare.into_any_element(),
            None => self.render_timeline_view(window, cx),
        };
        div()
            .id("history-panel")
            .track_focus(&self.focus_handle(cx))
            .relative()
            .size_full()
            .bg(palette.input)
            .child(probe)
            .child(
                div()
                    .id("history-scroll")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .min_h_full()
                            .flex()
                            .flex_col()
                            .p(px(14.))
                            .pt(px(14.))
                            .child(content),
                    ),
            )
            .child(FluidScrollbar::vertical("history-scrollbar", &self.scroll))
    }
}

use gpui::Focusable as _;

impl HistoryPanel {
    fn render_timeline_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let toolbar = self.render_toolbar(window, cx);
        let body = match self.view {
            HistoryView::Versions => self.render_versions_body(window, cx),
            HistoryView::Activity => self.render_activity_body(window, cx),
            HistoryView::Everything => self.render_everything(window, cx),
        };
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(toolbar)
            .children(self.render_save_form(cx))
            .child(body)
            .into_any_element()
    }

    /// The views, Compare…, then Save version and a refresh.
    fn render_toolbar(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut views = vec![
            (
                HistoryView::Everything,
                SharedString::from(t!("Everything")),
            ),
            (HistoryView::Versions, t!("Versions").into()),
            (HistoryView::Activity, tc!("history tab", "Activity").into()),
        ];
        let pills = views.drain(..).map(|(view, label)| {
            let id = SharedString::from(format!("history-view-{view:?}"));
            Control::pill(id, label)
                .on(self.view == view)
                .when(self.view == view, |pill| pill.parity("history/view/active"))
                .on_click(cx.listener(move |this, _, _, cx| this.select_view(view, cx)))
                .into_any_element()
        });
        let can_compare = self.versions.phase == Phase::Ready && !self.versions.entries.is_empty();
        let compare = can_compare.then(|| {
            Control::pill("history-compare", t!("Compare…"))
                .icon(Icon::GIT_COMPARE_ARROWS, px(12.))
                .parity("history/compare")
                .on_click(cx.listener(|this, _, window, cx| this.start_comparing(window, cx)))
                .into_any_element()
        });
        let save = (self.versions.phase == Phase::Ready).then(|| {
            let narrow = self.narrow();
            let mut save = Control::outline(
                "versions-save",
                if narrow { "" } else { t!("Save version") },
            )
            .icon(Icon::SAVE, px(12.))
            .tooltip(t!("Save version"))
            .parity("history/save")
            .disabled(self.versions.busy || self.save_field.is_some())
            .on_click(cx.listener(|this, _, window, cx| this.open_save_field(window, cx)));
            if narrow {
                save = save.label("");
            }
            div().ml_auto().child(save).into_any_element()
        });
        let refresh =
            Control::icon_button("versions-refresh", Icon::REFRESH, t!("Refresh history"))
                .spinning(self.versions.refreshing)
                .parity("history/refresh")
                .disabled(self.versions.refreshing || self.versions.busy)
                .on_click(cx.listener(|this, _, _, cx| this.reload(cx)));
        div()
            .relative()
            .children(lattice_ui::parity::probe("history/toolbar"))
            .flex()
            .items_start()
            .gap(px(6.))
            .min_w_0()
            .mt(px(12.))
            .mb(px(4.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .flex_shrink(1.)
                    .gap(px(4.))
                    .min_w_0()
                    .children(pills)
                    .children(compare),
            )
            .when(save.is_none(), |this| this.child(div().ml_auto()))
            .children(save)
            .child(refresh)
            .into_any_element()
    }

    /// The field a version's name is typed in, Save, and the X.
    fn render_save_form(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (field, _) = self.save_field.as_ref()?;
        let field = field.clone();
        let read = field.clone();
        Some(
            div()
                .id("versions-save-form")
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .mt(px(8.))
                .mb(px(4.))
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                    // Escape closes the field, not the panel around it.
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.close_save_field(cx);
                    }
                }))
                .child(div().flex_1().min_w_0().child(Field::new(&field).compact()))
                .child(
                    Control::outline("versions-save-submit", t!("Save"))
                        .icon(Icon::SAVE, px(12.))
                        .disabled(self.versions.busy)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let label = read.read(cx).value().to_string();
                            this.submit_save(label, cx);
                        })),
                )
                .child(
                    Control::icon_button("versions-save-cancel", Icon::X, t!("Cancel"))
                        .on_click(cx.listener(|this, _, _, cx| this.close_save_field(cx))),
                )
                .into_any_element(),
        )
    }

    /// What the Versions view says in place of versions, or above them.
    fn render_versions_state(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let narrow = self.narrow();
        let versions = &self.versions;
        let error_line = (!versions.error.is_empty()).then(|| {
            div()
                .mt(px(8.))
                .child(inline_message(versions.error.clone(), true, cx))
                .into_any_element()
        });
        match versions.phase {
            Phase::Loading => Some(
                div()
                    .mt(px(16.))
                    .child(loading_line(
                        "versions-loading",
                        t!("Loading versions…"),
                        cx,
                    ))
                    .into_any_element(),
            ),
            Phase::Unavailable => Some(art::empty_state(
                t!("Git isn’t available on this Mac"),
                narrow,
                None,
                cx,
            )),
            Phase::Error => Some(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(10.))
                    .mt(px(16.))
                    .child(inline_message(
                        t!("Version history is unavailable: {0}", versions.error),
                        true,
                        cx,
                    ))
                    .child(
                        Control::outline("versions-try-again", t!("Try again"))
                            .icon(Icon::REFRESH, px(12.))
                            .disabled(versions.refreshing)
                            .on_click(cx.listener(|this, _, _, cx| this.load_versions(cx))),
                    )
                    .into_any_element(),
            ),
            Phase::NoRepo => Some(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .children(error_line)
                    .child(art::empty_state(
                        t!("Version tracking is off"),
                        narrow,
                        Some(
                            Control::outline("versions-enable", t!("Enable version tracking"))
                                .icon(Icon::GIT_BRANCH, px(13.))
                                .disabled(versions.busy)
                                .on_click(cx.listener(|this, _, _, cx| this.enable_tracking(cx)))
                                .into_any_element(),
                        ),
                        cx,
                    ))
                    .into_any_element(),
            ),
            Phase::Ready if versions.entries.is_empty() => Some(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .children(error_line)
                    .child(art::empty_state(t!("No versions yet"), narrow, None, cx))
                    .into_any_element(),
            ),
            Phase::Ready => error_line,
        }
    }

    /// The versions' state as one quiet line above the whole stream.
    fn render_versions_notice(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let versions = &self.versions;
        match versions.phase {
            Phase::Error => Some(
                div()
                    .mt(px(8.))
                    .child(inline_message(
                        t!("Version history is unavailable: {0}", versions.error),
                        true,
                        cx,
                    ))
                    .into_any_element(),
            ),
            Phase::NoRepo => Some(
                div()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap_x(px(8.))
                    .gap_y(px(4.))
                    .mt(px(8.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_CONTROL)
                    .bg(palette.hover)
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("Version tracking is off for this project"))
                    .child(
                        Control::link("versions-notice-enable", t!("Enable version tracking"))
                            .disabled(versions.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.enable_tracking(cx))),
                    )
                    .into_any_element(),
            ),
            Phase::Ready if !versions.error.is_empty() => Some(
                div()
                    .mt(px(8.))
                    .child(inline_message(versions.error.clone(), true, cx))
                    .into_any_element(),
            ),
            _ => None,
        }
    }

    fn render_versions_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let state = self.render_versions_state(cx);
        let rows = if self.versions.phase == Phase::Ready {
            timeline::version_rows(&self.versions.entries)
        } else {
            Vec::new()
        };
        let timeline = self.render_days(rows, window, cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .children(state)
            .child(timeline)
            .into_any_element()
    }

    fn render_activity_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let filter = self.filter;
        let mut filters = Segmented::new("history-filters").filled();
        for (value, label) in [
            (ActivityFilter::All, t!("All")),
            (ActivityFilter::User, t!("You")),
            (ActivityFilter::Agent, t!("Agent")),
            (ActivityFilter::Citation, t!("Citations")),
        ] {
            filters = filters.label(
                label,
                filter == value,
                cx.listener(move |this, _, _, cx| this.set_filter(value, cx)),
            );
        }
        let rows = timeline::activity_rows(&self.activity, filter);
        let none = rows.is_empty();
        let timeline = self.render_days(rows, window, cx);
        let narrow = self.narrow();
        let empty = none.then(|| {
            if self.activity.is_empty() {
                art::empty_state(t!("Nothing has changed yet"), narrow, None, cx)
            } else {
                div()
                    .flex()
                    .justify_center()
                    .p(px(16.))
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(cx.palette().text)
                    .child(t!("No changes match this filter"))
                    .into_any_element()
            }
        });
        div()
            .flex_1()
            .flex()
            .flex_col()
            .child(div().flex().my(px(12.)).max_w_full().child(filters))
            .child(timeline)
            .children(empty)
            .into_any_element()
    }

    fn render_everything(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let notice = self.render_versions_notice(cx);
        let mut rows = timeline::activity_rows(&self.activity, ActivityFilter::All);
        if self.versions.phase == Phase::Ready {
            rows.extend(timeline::version_rows(&self.versions.entries));
        }
        let waiting = self.versions.phase == Phase::Loading;
        let empty = (rows.is_empty() && !waiting)
            .then(|| art::empty_state(t!("Nothing has changed yet"), self.narrow(), None, cx));
        let timeline = self.render_days(rows, window, cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .children(notice)
            .child(timeline)
            .children(empty)
            .into_any_element()
    }

    /// `rows` newest first, by day, each run of automatic versions folded.
    fn render_days(
        &mut self,
        rows: Vec<TimelineRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let locale = locale();
        let days = timeline::days(rows);
        let mut out = div().flex().flex_col().min_w_0();
        let (mut row_probed, mut fold_probed, mut day_probed) = (false, false, false);
        for day in days {
            let mut lines: Vec<(TimelineRow, bool)> = Vec::new();
            for row in day.rows {
                match &row {
                    TimelineRow::Automatic { entries, .. } => {
                        let open = self.open_folds.contains(&row.key());
                        let entries = entries.clone();
                        lines.push((row, true));
                        if open {
                            for entry in entries {
                                let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
                                lines.push((TimelineRow::Version { at, entry }, false));
                            }
                        }
                    }
                    _ => lines.push((row, false)),
                }
            }
            let count = lines.len();
            let mut list = div().flex().flex_col().min_w_0();
            for (index, (row, _)) in lines.into_iter().enumerate() {
                let (first, last) = (index == 0, index + 1 == count);
                let mut parts = match row {
                    TimelineRow::Activity { at, item } => {
                        self.activity_row(&item, at, first, last, window, cx)
                    }
                    TimelineRow::Version { entry, .. } => {
                        self.version_row(&entry, first, last, window, cx)
                    }
                    TimelineRow::Automatic { entries, .. } => {
                        self.fold_row(&entries, first, last, cx)
                    }
                };
                if parts.key.starts_with("fold:") {
                    if !fold_probed {
                        fold_probed = true;
                        parts.probe = Some("history/fold");
                    }
                } else if !row_probed {
                    row_probed = true;
                    parts.probe = Some("history/row");
                }
                list = list.child(history_row(parts, window, cx));
            }
            out = out.child(
                div()
                    .mt(px(8.))
                    .child(
                        div()
                            .relative()
                            .when(!day_probed, |this| {
                                let name = time::day_name(day.at, locale);
                                this.children(lattice_ui::parity::probe("history/day"))
                                    .children(lattice_ui::parity::text_probe(
                                        "history/day",
                                        0,
                                        name,
                                    ))
                            })
                            .py(px(6.))
                            .bg(palette.input)
                            .text_role(TextRole::Caption, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(time::day_name(day.at, locale)),
                    )
                    .child(list),
            );
            day_probed = true;
        }
        out.into_any_element()
    }

    fn activity_row(
        &mut self,
        item: &HistoryItem,
        at: i64,
        first: bool,
        last: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> RowParts {
        let palette = cx.palette().clone();
        let locale = locale();
        let key = timeline::activity_key(&item.id);
        let expanded = self.expanded.as_deref() == Some(&key);
        let actor = if item.actor.is_empty() {
            "user"
        } else {
            item.actor.as_str()
        };
        let glyph = match actor {
            "agent" => Icon::SPARKLES,
            "citation" => Icon::BOOK_MARKED,
            "system" => Icon::ARROW_DOWN_UP,
            _ => Icon::PEN_LINE,
        };
        let (edited, files) = timeline::activity_title(item);
        let title: SharedString = match edited {
            Some(name) => t!("Edit {editedName}", editedName = name).into(),
            None => item.label.clone().into(),
        };
        let actor_label = match actor {
            "agent" => t!("Agent"),
            "citation" => t!("Citation tool"),
            "system" => "Lattice",
            _ => t!("You"),
        };
        let meta = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .min_w_0()
            .overflow_hidden()
            .child(div().flex_none().child(actor_label))
            .when(!files.is_empty(), |this| {
                this.child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(files.join(", ")),
                )
            })
            .into_any_element();
        let checkpoint = item.kind == "agent-checkpoint";
        let restore_title = if checkpoint {
            t!("Undo this Agent turn's file changes")
        } else {
            t!("Restore the state before this change")
        };
        let id = item.id.clone();
        let mut tools = vec![
            Control::tool(
                SharedString::from(format!("history-restore-{}", item.id)),
                Icon::ROTATE_CCW,
                restore_title,
            )
            .on_click(cx.listener(move |this, _, _, cx| this.revert_entry(id.clone(), None, cx)))
            .into_any_element(),
        ];
        if !checkpoint {
            let id = item.id.clone();
            tools.push(
                Control::tool(
                    SharedString::from(format!("history-delete-{}", item.id)),
                    Icon::TRASH,
                    t!("Delete this history entry"),
                )
                .danger()
                .on_click(cx.listener(move |this, _, _, cx| this.delete_entry(id.clone(), cx)))
                .into_any_element(),
            );
        }
        let body = expanded.then(|| body::activity_body(self, item, window, cx));
        let _ = palette;
        let toggled = item.clone();
        let on_toggle =
            Box::new(cx.listener(move |this, _, _, cx| this.toggle_activity(&toggled, cx)));
        RowParts {
            on_toggle,
            probe: None,
            key,
            glyph,
            glyph_size: 13.,
            weight: Weight::Plain,
            title,
            meta: Some(meta),
            time: time::clock_time(at, locale).into(),
            time_title: time::full_time(at, locale).into(),
            tools,
            body,
            first,
            last,
        }
    }

    fn version_row(
        &mut self,
        entry: &GitLogEntry,
        first: bool,
        last: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> RowParts {
        let locale = locale();
        let key = timeline::version_key(&entry.hash);
        let expanded = self.expanded.as_deref() == Some(&key);
        let compare = self.compare_key.as_deref() == Some(&key);
        let count = entry.files.len();
        let name = if entry.author_name.is_empty() {
            t!("Unknown").to_string()
        } else {
            entry.author_name.clone()
        };
        let meta = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .min_w_0()
            .overflow_hidden()
            .child(person(&name))
            .child(div().flex_none().child(if count == 1 {
                t!("1 file").to_string()
            } else {
                t!("{0} files", format_count(count as i64))
            }))
            .into_any_element();
        let weight = if messages::is_automatic(&entry.message) {
            Weight::Quiet
        } else if messages::is_bookkeeping(&entry.message) {
            Weight::Plain
        } else {
            Weight::Named
        };
        let compare_key = key.clone();
        let hash = entry.hash.clone();
        let tools = vec![
            Control::tool(
                SharedString::from(format!("history-compare-{}", entry.hash)),
                Icon::GIT_COMPARE_ARROWS,
                t!("Compare with now"),
            )
            .on(expanded && compare)
            .on_click(cx.listener(move |this, _, _, cx| this.compare_row(compare_key.clone(), cx)))
            .into_any_element(),
            Control::tool(
                SharedString::from(format!("history-restore-version-{}", entry.hash)),
                Icon::ROTATE_CCW,
                t!("Restore project to this version"),
            )
            .disabled(self.versions.busy)
            .on_click(cx.listener(move |this, _, _, cx| this.restore_project(hash.clone(), cx)))
            .into_any_element(),
        ];
        let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
        let body = expanded.then(|| body::version_body(self, entry, window, cx));
        let toggled = key.clone();
        let on_toggle =
            Box::new(cx.listener(move |this, _, _, cx| this.toggle_row(toggled.clone(), cx)));
        RowParts {
            on_toggle,
            probe: None,
            key,
            glyph: Icon::GIT_COMMIT_HORIZONTAL,
            glyph_size: 14.,
            weight,
            title: messages::label(&entry.message).into(),
            meta: Some(meta),
            time: time::clock_time(at, locale).into(),
            time_title: time::full_time(at, locale).into(),
            tools,
            body,
            first,
            last,
        }
    }

    /// A run of automatic versions, folded to one line until opened.
    fn fold_row(
        &mut self,
        entries: &[GitLogEntry],
        first: bool,
        last: bool,
        cx: &mut Context<Self>,
    ) -> RowParts {
        let locale = locale();
        let key = format!("fold:{}", entries[0].hash);
        let open = self.open_folds.contains(&key);
        let newest = time::parse_ms(&entries[0].timestamp).unwrap_or(0);
        let oldest = time::parse_ms(&entries[entries.len() - 1].timestamp).unwrap_or(0);
        let (since, until) = (
            time::clock_time(oldest, locale),
            time::clock_time(newest, locale),
        );
        let toggled = key.clone();
        let on_toggle =
            Box::new(cx.listener(move |this, _, _, cx| this.toggle_fold(toggled.clone(), cx)));
        RowParts {
            on_toggle,
            probe: None,
            key,
            glyph: if open {
                Icon::CHEVRON_DOWN
            } else {
                Icon::CHEVRON_RIGHT
            },
            glyph_size: 12.,
            weight: Weight::Quiet,
            title: t!(
                "{count} automatic versions",
                count = format_count(entries.len() as i64)
            )
            .into(),
            meta: None,
            time: if since == until {
                until
            } else {
                format!("{since}–{until}")
            }
            .into(),
            time_title: format!(
                "{} – {}",
                time::full_time(oldest, locale),
                time::full_time(newest, locale)
            )
            .into(),
            tools: Vec::new(),
            body: None,
            first,
            last,
        }
    }
}
