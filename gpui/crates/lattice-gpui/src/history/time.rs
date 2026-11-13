//! How the history timeline names a time, ported from the Tauri app's
//! `src/history/history-time.ts`. A day heads its entries, so an entry needs
//! only its clock time, and two entries an afternoon apart read apart where
//! "3h ago" would not. Both follow the interface language as `Intl` does
//! there: "Today", "Sat, Oct 10" and "3:05 PM" in English; 今天, 10月10日周六
//! and 15:05 in Chinese.

use chrono::{DateTime, Datelike as _, Local, NaiveDate, Timelike as _};
use lattice_i18n::Locale;

/// A git or history timestamp (RFC 3339) in milliseconds since the epoch.
pub fn parse_ms(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|at| at.timestamp_millis())
}

fn local(ms: i64) -> Option<DateTime<Local>> {
    DateTime::from_timestamp_millis(ms).map(|at| at.with_timezone(&Local))
}

/// The local day `ms` falls on, as a key two times on that day share.
pub fn day_key(ms: i64) -> Option<NaiveDate> {
    local(ms).map(|at| at.date_naive())
}

const EN_WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EN_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const ZH_WEEKDAYS: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/// "Today", "Yesterday", or a short date (with the year once it is not this one).
pub fn day_name(ms: i64, locale: Locale) -> String {
    day_name_at(ms, Local::now(), locale)
}

fn day_name_at(ms: i64, now: DateTime<Local>, locale: Locale) -> String {
    let Some(when) = local(ms) else {
        return String::new();
    };
    let day = when.date_naive();
    let today = now.date_naive();
    // A calendar day back, not 24 hours, so a clock change cannot move it.
    let yesterday = today.pred_opt();
    let chinese = locale.is_chinese();
    if day == today {
        return if chinese { "今天" } else { "Today" }.into();
    }
    if Some(day) == yesterday {
        return if chinese { "昨天" } else { "Yesterday" }.into();
    }
    let weekday = day.weekday().num_days_from_monday() as usize;
    let this_year = day.year() == today.year();
    if chinese {
        let year = if this_year {
            String::new()
        } else {
            format!("{}年", day.year())
        };
        format!(
            "{year}{}月{}日{}",
            day.month(),
            day.day(),
            ZH_WEEKDAYS[weekday]
        )
    } else {
        let date = format!(
            "{}, {} {}",
            EN_WEEKDAYS[weekday],
            EN_MONTHS[day.month0() as usize],
            day.day()
        );
        if this_year {
            date
        } else {
            format!("{date}, {}", day.year())
        }
    }
}

/// The clock time of `ms`, to the minute.
pub fn clock_time(ms: i64, locale: Locale) -> String {
    let Some(when) = local(ms) else {
        return String::new();
    };
    clock(when.hour(), when.minute(), locale)
}

fn clock(hour: u32, minute: u32, locale: Locale) -> String {
    if locale.is_chinese() {
        return format!("{hour:02}:{minute:02}");
    }
    let (twelve, meridiem) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{twelve}:{minute:02}\u{202f}{meridiem}")
}

/// The full date and time, for a tooltip.
pub fn full_time(ms: i64, locale: Locale) -> String {
    let Some(when) = local(ms) else {
        return String::new();
    };
    let (year, month, day) = (when.year(), when.month(), when.day());
    if locale.is_chinese() {
        format!(
            "{year}/{month}/{day} {:02}:{:02}:{:02}",
            when.hour(),
            when.minute(),
            when.second()
        )
    } else {
        let time = clock(when.hour(), when.minute(), locale);
        let (clock, meridiem) = time.split_once('\u{202f}').unwrap_or((&time, ""));
        format!(
            "{month}/{day}/{year}, {clock}:{:02}\u{202f}{meridiem}",
            when.second()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

    fn at(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, 5, 0)
            .single()
            .expect("an unambiguous local time")
    }

    #[test]
    fn names_days_as_the_tauri_app_does() {
        let now = at(2026, 10, 10, 12);
        let ms = |when: DateTime<Local>| when.timestamp_millis();
        assert_eq!(
            day_name_at(ms(at(2026, 10, 10, 9)), now, Locale::En),
            "Today"
        );
        assert_eq!(
            day_name_at(ms(at(2026, 10, 9, 23)), now, Locale::En),
            "Yesterday"
        );
        assert_eq!(
            day_name_at(ms(at(2026, 10, 3, 9)), now, Locale::En),
            "Sat, Oct 3"
        );
        assert_eq!(
            day_name_at(ms(at(2025, 10, 3, 9)), now, Locale::En),
            "Fri, Oct 3, 2025"
        );
        assert_eq!(
            day_name_at(ms(at(2026, 10, 10, 9)), now, Locale::ZhCn),
            "今天"
        );
        assert_eq!(
            day_name_at(ms(at(2026, 10, 3, 9)), now, Locale::ZhCn),
            "10月3日周六"
        );
        assert_eq!(
            day_name_at(ms(at(2025, 10, 3, 9)), now, Locale::ZhCn),
            "2025年10月3日周五"
        );
    }

    #[test]
    fn reads_clock_times_in_each_language() {
        assert_eq!(clock(15, 5, Locale::En), "3:05\u{202f}PM");
        assert_eq!(clock(0, 30, Locale::En), "12:30\u{202f}AM");
        assert_eq!(clock(15, 5, Locale::ZhCn), "15:05");
    }
}
