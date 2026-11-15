//! The "Date added" sort and grouping (`addedGroup`, `addedMonthName` and the
//! `added` sort in `paper-library-view.ts`): when the library first listed a
//! paper is lattice-core's `PaperSummary::added_at` (`papers/added.rs`),
//! absent for a paper that was there before the library kept dates.

use chrono::{DateTime, Datelike as _, Duration, Local, NaiveDate};
use lattice_core::papers::PaperSummary;
use lattice_i18n::{Locale, t};
use std::cmp::Ordering;

/// The groups before the months, newest first.
const RECENT: [&str; 3] = ["today", "week", "month"];

const EN_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Newest first; a paper without a date goes last, ties keep their order.
pub fn compare_added(a: &PaperSummary, b: &PaperSummary) -> Ordering {
    match (a.added_at, b.added_at) {
        (Some(left), Some(right)) => right.cmp(&left),
        (left, right) => right.is_some().cmp(&left.is_some()),
    }
}

/// The group of a paper added at `added_at` (ms since the epoch), as of the
/// local `now`: "today", "week" for the six calendar days before it,
/// "month" for the rest of this month, else its month as `YYYY-MM` (newest
/// first as text); empty without a date. A time ahead of the clock counts
/// as today.
pub fn added_group(added_at: Option<i64>, now: DateTime<Local>) -> String {
    let Some(when) = added_at
        .and_then(DateTime::from_timestamp_millis)
        .map(|at| at.with_timezone(&Local).date_naive())
    else {
        return String::new();
    };
    let today = now.date_naive();
    if when >= today {
        return RECENT[0].into();
    }
    // Calendar days back, not 24-hour spans, so a clock change cannot move it.
    if when >= today - Duration::days(6) {
        return RECENT[1].into();
    }
    if when.year() == today.year() && when.month() == today.month() {
        return RECENT[2].into();
    }
    format!("{}-{:02}", when.year(), when.month())
}

/// The order of two groups' values, the undated group aside.
pub fn compare_added_groups(a: &str, b: &str) -> Ordering {
    let rank = |value: &str| {
        RECENT
            .iter()
            .position(|recent| *recent == value)
            .unwrap_or(RECENT.len())
    };
    rank(a).cmp(&rank(b)).then_with(|| b.cmp(a))
}

/// A group's heading: "Today", "Previous 7 days", "Earlier this month", a
/// month as the interface language writes it ("October 2026", 2026年10月),
/// or "Date unknown".
pub fn added_group_name(value: &str, locale: Locale) -> String {
    match value {
        "" => t!("Date unknown").into(),
        "today" => t!("Today").into(),
        "week" => t!("Previous 7 days").into(),
        "month" => t!("Earlier this month").into(),
        month => {
            let Some(first) = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").ok()
            else {
                return month.into();
            };
            if locale.is_chinese() {
                format!("{}年{}月", first.year(), first.month())
            } else {
                format!("{} {}", EN_MONTHS[first.month0() as usize], first.year())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::{Facts, Group, group, test_support::paper};
    use chrono::TimeZone as _;

    /// An hour on a local calendar day, so the cases read the same in any zone.
    fn noon(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, 0, 0)
            .single()
            .unwrap()
    }

    #[test]
    fn groups_as_the_tauri_app_does() {
        // A Sunday afternoon in mid-November, as paper-library-view.test.ts.
        let now = noon(2026, 11, 15, 15);
        let at = |y, m, d, h| Some(noon(y, m, d, h).timestamp_millis());
        assert_eq!(added_group(at(2026, 11, 15, 0), now), "today");
        assert_eq!(added_group(at(2026, 11, 16, 12), now), "today");
        assert_eq!(added_group(at(2026, 11, 14, 23), now), "week");
        assert_eq!(added_group(at(2026, 11, 9, 0), now), "week");
        assert_eq!(added_group(at(2026, 11, 8, 23), now), "month");
        assert_eq!(added_group(at(2026, 11, 1, 0), now), "month");
        assert_eq!(added_group(at(2026, 10, 31, 23), now), "2026-10");
        assert_eq!(added_group(at(2025, 12, 3, 12), now), "2025-12");
        assert_eq!(added_group(None, now), "");
        assert_eq!(
            added_group(at(2026, 10, 30, 12), noon(2026, 11, 2, 12)),
            "week"
        );

        let mut values = vec!["2025-11", "month", "2026-09", "today", "2026-10", "week"];
        values.sort_by(|a, b| compare_added_groups(a, b));
        assert_eq!(
            values,
            ["today", "week", "month", "2026-10", "2026-09", "2025-11"]
        );
    }

    #[test]
    fn names_a_month_in_the_interface_language() {
        assert_eq!(added_group_name("2026-10", Locale::En), "October 2026");
        assert_eq!(added_group_name("2026-10", Locale::ZhCn), "2026年10月");
    }

    #[test]
    fn sorts_newest_first_with_the_undated_last() {
        let dated = |title: &str, at: Option<i64>| {
            let mut summary = paper(title);
            summary.added_at = at;
            summary
        };
        let mut papers = [
            dated("b", None),
            dated("old", Some(1_000)),
            dated("a", None),
            dated("new", Some(3_000)),
            dated("same", Some(3_000)),
        ];
        papers.sort_by(compare_added);
        let titles: Vec<_> = papers
            .iter()
            .map(|summary| summary.title.as_str())
            .collect();
        assert_eq!(titles, ["new", "same", "old", "b", "a"]);

        // The undated group comes last whatever today is.
        let sections = group(papers.iter().collect(), Group::Added, &Facts::default());
        assert_eq!(sections.last().map(|section| section.papers.len()), Some(2));
    }
}
