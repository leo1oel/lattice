//! The deadline above the checks, ported from the Tauri app's
//! `deadline-card.tsx` and `deadline-time.ts`: how long is left in words in
//! the title serif, the AoE time the call for papers gives, then the same
//! moment on the writer's clock. Colour sits on the clock icon alone (amber
//! under three days, red under one) until a day is left, when the countdown
//! turns red too. Without a deadline, one dashed line offers to add it; the
//! pencil (or that line) opens the form in place: what it is for, what is
//! due, the date and the time AoE.
//!
//! AoE is a fixed UTC−12, so the stored "YYYY-MM-DDTHH:MM" is never put
//! through a host time zone: the deadline passes at that wall clock plus
//! twelve hours in UTC. The Tauri app's date and time pickers are the
//! system's; here they are typed fields in the same stored forms.

use std::time::Duration;

use chrono::{DateTime, Datelike as _, Local, NaiveDateTime, Timelike as _, Utc};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::InputState;
use lattice_core::models::ProjectDeadline;
use lattice_i18n::{Locale, join_phrases, locale, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field, IconButton, Segmented},
    interaction::{track_pointer, use_interaction},
    shape::RADIUS_SURFACE,
    tokens::FONT_WEIGHT_MEDIUM,
    typography::tabular_nums,
};

use super::ChecklistPanel;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// The stored AoE wall clock, when it is a real date and time.
pub fn aoe_wall_clock(due: &str) -> Option<NaiveDateTime> {
    if due.len() != 16 {
        return None;
    }
    NaiveDateTime::parse_from_str(due, "%Y-%m-%dT%H:%M").ok()
}

/// The instant the deadline passes, in ms since the epoch: the AoE clock
/// plus twelve hours in UTC.
pub fn deadline_instant(due: &str) -> Option<i64> {
    aoe_wall_clock(due).map(|wall| wall.and_utc().timestamp_millis() + 12 * HOUR_MS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Urgency {
    Calm,
    Soon,
    Urgent,
}

pub fn urgency(remaining_ms: i64) -> Urgency {
    if remaining_ms < DAY_MS {
        Urgency::Urgent
    } else if remaining_ms < 3 * DAY_MS {
        Urgency::Soon
    } else {
        Urgency::Calm
    }
}

/// The two largest whole units of a span, as people say it.
pub fn duration_parts(span_ms: i64) -> (i64, i64, i64) {
    let total = span_ms.abs() / 60_000;
    let days = total / 1440;
    let hours = (total % 1440) / 60;
    let minutes = if days > 0 { 0 } else { total % 60 };
    (days, hours, minutes)
}

/// How long is left, or how long ago it closed.
pub fn left_text(remaining_ms: i64) -> String {
    let (days, hours, minutes) = duration_parts(remaining_ms);
    let unit =
        |count: i64, one: &str, many: String| if count == 1 { one.to_string() } else { many };
    let span: Vec<String> = [
        (days > 0).then(|| unit(days, t!("1 day"), t!("{days} days", days = days))),
        (hours > 0).then(|| unit(hours, t!("1 hour"), t!("{hours} hours", hours = hours))),
        (minutes > 0).then(|| {
            unit(
                minutes,
                t!("1 minute"),
                t!("{minutes} minutes", minutes = minutes),
            )
        }),
    ]
    .into_iter()
    .flatten()
    .collect();
    let span = span.join(" ");
    match (remaining_ms <= 0, span.is_empty()) {
        (true, false) => t!("Closed {span} ago", span = span),
        (true, true) => t!("Closed just now").to_string(),
        (false, false) => t!("{span} left", span = span),
        (false, true) => t!("Less than a minute left").to_string(),
    }
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_ZH: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A moment as `Intl` writes `{ weekday: short, month: short, day, hour,
/// minute: 2-digit }` (with the year when it is another year's).
pub fn when(time: NaiveDateTime, language: Locale, year: bool) -> String {
    let weekday = time.weekday().num_days_from_monday() as usize;
    let (hour, minute) = (time.hour(), time.minute());
    if language.is_chinese() {
        let year = if year {
            format!("{}年", time.year())
        } else {
            String::new()
        };
        return format!(
            "{year}{}月{}日{} {hour:02}:{minute:02}",
            time.month(),
            time.day(),
            WEEKDAYS_ZH[weekday]
        );
    }
    let (twelve, meridiem) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    let date = format!(
        "{}, {} {}",
        WEEKDAYS[weekday],
        MONTHS[time.month0() as usize],
        time.day()
    );
    let date = if year {
        format!("{date}, {}", time.year())
    } else {
        date
    };
    format!("{date}, {twelve}:{minute:02}\u{202f}{meridiem}")
}

/// The writer's zone named once, as `GMT+8` (`timeZoneName: short`).
fn zone_name(local: &DateTime<Local>) -> String {
    let seconds = local.offset().local_minus_utc();
    let (sign, seconds) = if seconds < 0 {
        ('-', -seconds)
    } else {
        ('+', seconds)
    };
    let (hours, minutes) = (seconds / 3600, (seconds % 3600) / 60);
    match (hours, minutes) {
        (0, 0) => "GMT".into(),
        (_, 0) => format!("GMT{sign}{hours}"),
        _ => format!("GMT{sign}{hours}:{minutes:02}"),
    }
}

/// "{when} your time ({zone})" for the instant.
fn local_line(instant_ms: i64, year: bool) -> String {
    let Some(utc) = DateTime::<Utc>::from_timestamp_millis(instant_ms) else {
        return String::new();
    };
    let local = utc.with_timezone(&Local);
    t!(
        "{when} your time ({zone})",
        when = when(local.naive_local(), locale(), year),
        zone = zone_name(&local)
    )
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "abstract" => t!("abstract"),
        "rebuttal" => t!("rebuttal"),
        _ => t!("full paper"),
    }
}

/// The card's state: the form's fields while it is open, and the minute
/// ticker that keeps the countdown current.
#[derive(Default)]
pub(super) struct DeadlineState {
    form: Option<DeadlineForm>,
    _tick: Option<Task<()>>,
}

struct DeadlineForm {
    venue: Entity<InputState>,
    kind: String,
    date: Entity<InputState>,
    time: Entity<InputState>,
}

impl ChecklistPanel {
    /// Keep the countdown to the minute while the panel lives.
    fn tick(&mut self, cx: &mut Context<Self>) {
        if self.deadline._tick.is_some() {
            return;
        }
        self.deadline._tick = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(30))
                    .await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        }));
    }

    fn open_deadline_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = self
            .manifest(cx)
            .and_then(|manifest| manifest.deadline.clone());
        let venue_name = self.venue_name(cx);
        let (venue, kind, date, time) = match &current {
            Some(deadline) => {
                let (date, time) = deadline
                    .due
                    .split_once('T')
                    .unwrap_or((&deadline.due, "23:59"));
                (
                    deadline.venue.clone(),
                    deadline.kind.clone(),
                    date.to_string(),
                    time.to_string(),
                )
            }
            None => (
                venue_name,
                "paper".to_string(),
                String::new(),
                "23:59".to_string(),
            ),
        };
        let field = |value: String,
                     placeholder: &'static str,
                     window: &mut Window,
                     cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value)
            })
        };
        let venue = field(venue, t!("e.g. NeurIPS 2027"), window, cx);
        venue.update(cx, |field, cx| field.focus(window, cx));
        self.deadline.form = Some(DeadlineForm {
            venue,
            kind,
            date: field(date, "YYYY-MM-DD", window, cx),
            time: field(time, "HH:MM", window, cx),
        });
        cx.notify();
    }

    /// The project template's name, offered as a new deadline's.
    fn venue_name(&self, cx: &gpui::App) -> String {
        self.manifest(cx)
            .and_then(|manifest| {
                crate::welcome::new_project::VENUES
                    .iter()
                    .find(|(id, _)| *id == manifest.venue)
            })
            .map(|(_, label)| label.to_string())
            .unwrap_or_default()
    }

    fn form_draft(&self, cx: &gpui::App) -> Option<(ProjectDeadline, Option<i64>)> {
        let form = self.deadline.form.as_ref()?;
        let due = format!(
            "{}T{}",
            form.date.read(cx).value().trim(),
            form.time.read(cx).value().trim()
        );
        let instant = deadline_instant(&due);
        Some((
            ProjectDeadline {
                venue: form.venue.read(cx).value().trim().to_string(),
                kind: form.kind.clone(),
                due,
            },
            instant,
        ))
    }

    pub(super) fn render_deadline(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.tick(cx);
        if self.deadline.form.is_some() {
            return self.render_deadline_form(cx);
        }
        let palette = cx.palette().clone();
        let deadline = self
            .manifest(cx)
            .and_then(|manifest| manifest.deadline.clone());
        let wall = deadline
            .as_ref()
            .and_then(|deadline| aoe_wall_clock(&deadline.due));
        let (Some(deadline), Some(wall)) = (deadline, wall) else {
            // One quiet line in the card's place offers to add it.
            let (state, pointer) = use_interaction("deadline-add", window, cx);
            let add = div()
                .id("deadline-add")
                .mb(px(8.))
                .flex()
                .items_start()
                .gap(px(8.))
                .px(px(12.))
                .py(px(10.))
                .rounded(RADIUS_SURFACE)
                .border_1()
                .border_dashed()
                .border_color(palette.line_strong)
                .bg(state.wash(gpui::transparent_black(), palette.hover, palette.pressed))
                .text_color(palette.text_secondary)
                .cursor_pointer()
                .children(lattice_ui::parity::probe("checklist/deadline-add"))
                .child(
                    div()
                        .pt(px(3.))
                        .child(Icon::CLOCK.element(px(14.), palette.text_secondary)),
                )
                .child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(t!("Add the submission deadline")),
                )
                .on_click(cx.listener(|this, _, window, cx| this.open_deadline_form(window, cx)));
            return track_pointer(add, pointer).into_any_element();
        };
        let instant = wall.and_utc().timestamp_millis() + 12 * HOUR_MS;
        let now = Utc::now().timestamp_millis();
        let remaining = instant - now;
        let urgency = urgency(remaining);
        let clock_ink = match urgency {
            Urgency::Calm => palette.text_secondary,
            Urgency::Soon => palette.warning,
            Urgency::Urgent => palette.danger,
        };
        let other_year = wall.year() != Utc::now().year();
        let aoe = when(wall, locale(), other_year);
        div()
            .relative()
            .mb(px(8.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .pt(px(10.))
            .px(px(12.))
            .pb(px(12.))
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .children(lattice_ui::parity::probe("checklist/deadline"))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_role(TextRole::Caption, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(Icon::CLOCK.element(px(13.), clock_ink))
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .child(join_phrases(&[
                                        deadline.venue.clone(),
                                        kind_label(&deadline.kind).to_string(),
                                    ])),
                            ),
                    )
                    .child(
                        IconButton::new("deadline-edit", Icon::PENCIL)
                            .tooltip(t!("Edit deadline"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_deadline_form(window, cx)
                            })),
                    ),
            )
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .font_features(tabular_nums())
                    .text_color(if urgency == Urgency::Urgent {
                        palette.danger
                    } else {
                        palette.text
                    })
                    .child(left_text(remaining)),
            )
            .child(
                div()
                    .mt(px(4.))
                    .flex()
                    .flex_wrap()
                    .gap_x(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .font_features(tabular_nums())
                    .text_color(palette.text_secondary)
                    .child(
                        div()
                            .text_color(palette.text)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .child(aoe),
                    )
                    .child(t!("AoE (UTC−12)")),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_size(TextRole::Micro.font_size(lattice_ui::TypeScale::Interface, cx))
                    .font_features(tabular_nums())
                    .text_color(palette.text_secondary)
                    .child(local_line(instant, other_year)),
            )
            .into_any_element()
    }

    fn render_deadline_form(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(form) = self.deadline.form.as_ref() else {
            return div().into_any_element();
        };
        let (draft, instant) = self.form_draft(cx).unzip();
        let instant = instant.flatten();
        let valid =
            draft.as_ref().is_some_and(|draft| !draft.venue.is_empty()) && instant.is_some();
        let has_deadline = self
            .manifest(cx)
            .is_some_and(|manifest| manifest.deadline.is_some());
        let labelled = |label: &'static str, field: &Entity<InputState>| {
            div()
                .min_w_0()
                .flex_grow(1.)
                .flex_basis(px(120.))
                .flex()
                .flex_col()
                .gap(px(4.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(label)
                .child(Field::new(field).compact())
        };
        let kind = form.kind.clone();
        let kinds = [
            ("abstract", t!("Abstract")),
            ("paper", t!("Paper")),
            ("rebuttal", t!("Rebuttal")),
        ];
        let mut segmented = Segmented::new("deadline-kind").filled();
        for (value, label) in kinds {
            segmented = segmented.label(
                label,
                kind == value,
                cx.listener(move |this, _, _, cx| {
                    if let Some(form) = this.deadline.form.as_mut() {
                        form.kind = value.into();
                        cx.notify();
                    }
                }),
            );
        }
        div()
            .mb(px(8.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .pt(px(10.))
            .px(px(12.))
            .pb(px(12.))
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .child(labelled(t!("Deadline for"), &form.venue))
            .child(segmented)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(labelled(t!("Date"), &form.date))
                    .child(labelled(t!("Time, AoE (UTC−12)"), &form.time)),
            )
            .child(
                // Empty until a date is set, its line held so the actions don't jump.
                div()
                    .min_h(TextRole::Caption.leading(lattice_ui::TypeScale::Interface))
                    .text_size(TextRole::Micro.font_size(lattice_ui::TypeScale::Interface, cx))
                    .text_color(palette.text_secondary)
                    .children(instant.map(|instant| local_line(instant, true))),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_end()
                    .gap(px(6.))
                    .when(has_deadline, |actions| {
                        actions.child(
                            div().mr_auto().child(
                                Button::new("deadline-remove", t!("Remove"))
                                    .ghost()
                                    .compact()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.deadline.form = None;
                                        this.save_deadline(None, cx);
                                    })),
                            ),
                        )
                    })
                    .child(
                        Button::new("deadline-cancel", t!("Cancel"))
                            .ghost()
                            .compact()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.deadline.form = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("deadline-save", t!("Save deadline"))
                            .primary()
                            .compact()
                            .disabled(!valid)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some((draft, Some(_))) = this.form_draft(cx) {
                                    if !draft.venue.is_empty() {
                                        this.deadline.form = None;
                                        this.save_deadline(Some(draft), cx);
                                    }
                                }
                            })),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deadline_passes_twelve_hours_after_its_aoe_clock() {
        let due = "2027-05-16T23:59";
        let instant = deadline_instant(due).unwrap();
        let utc = DateTime::<Utc>::from_timestamp_millis(instant).unwrap();
        assert_eq!(utc.format("%Y-%m-%dT%H:%M").to_string(), "2027-05-17T11:59");
        assert!(deadline_instant("2027-02-30T10:00").is_none());
        assert!(deadline_instant("2027-05-16T24:00").is_none());
        assert!(deadline_instant("2027-5-16T10:00").is_none());
    }

    #[test]
    fn the_countdown_reads_as_people_say_it() {
        let minute = 60_000;
        assert_eq!(
            left_text(3 * DAY_MS + 4 * HOUR_MS + 5 * minute),
            "3 days 4 hours left"
        );
        assert_eq!(left_text(HOUR_MS + minute), "1 hour 1 minute left");
        assert_eq!(left_text(30_000), "Less than a minute left");
        assert_eq!(left_text(-2 * HOUR_MS), "Closed 2 hours ago");
        assert_eq!(urgency(2 * DAY_MS), Urgency::Soon);
        assert_eq!(urgency(-1), Urgency::Urgent);
        assert_eq!(urgency(5 * DAY_MS), Urgency::Calm);
    }

    #[test]
    fn a_moment_reads_as_intl_writes_it() {
        let time = NaiveDateTime::parse_from_str("2027-05-16T19:59", "%Y-%m-%dT%H:%M").unwrap();
        assert_eq!(when(time, Locale::En, false), "Sun, May 16, 7:59\u{202f}PM");
        assert_eq!(
            when(time, Locale::En, true),
            "Sun, May 16, 2027, 7:59\u{202f}PM"
        );
        assert_eq!(when(time, Locale::ZhCn, false), "5月16日周日 19:59");
    }
}
