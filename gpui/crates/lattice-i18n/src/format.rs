//! What reads differently in Chinese beyond the words: counts in 万 and 亿,
//! the full-width comma between clauses, the enumeration comma, and the space
//! between Chinese and Latin text (`src/i18n.ts`, `trellis-titles.ts`).

use crate::{Locale, locale};

/// A count as the interface language reads it: digits grouped ("120,400"),
/// and in Chinese from 10,000 on in 万 and 亿 with up to two decimals
/// ("12.04 万"), the unit a Chinese reader counts in (`formatCount`).
pub fn format_count(value: i64) -> String {
    format_count_in(value, locale())
}

pub(crate) fn format_count_in(value: i64, locale: Locale) -> String {
    if locale.is_chinese() && value.unsigned_abs() >= 10_000 {
        let units = [(1e12, "万亿"), (1e8, "亿"), (1e4, "万")];
        let magnitude = value.unsigned_abs() as f64;
        let mut index = units
            .iter()
            .position(|(size, _)| magnitude >= *size)
            .unwrap_or(units.len() - 1);
        let mut scaled = (magnitude / units[index].0 * 100.).round() / 100.;
        // 9,999.996 万 rounds to 10,000 万, which Chinese reads as 1 亿.
        if scaled >= 10_000. && index > 0 {
            index -= 1;
            scaled = (magnitude / units[index].0 * 100.).round() / 100.;
        }
        let digits = format!("{scaled:.2}");
        let digits = digits.trim_end_matches('0').trim_end_matches('.');
        let sign = if value < 0 { "-" } else { "" };
        return format!("{sign}{} {}", group(digits), units[index].1);
    }
    group(&value.to_string())
}

/// Thousands separators in the integer part.
fn group(number: &str) -> String {
    let (sign, rest) = match number.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", number),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (rest, None),
    };
    let mut grouped = String::new();
    for (i, digit) in integer.chars().enumerate() {
        if i > 0 && (integer.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

/// The comma between the clauses of one line, full-width in Chinese
/// ("3 处，2 篇论文").
pub fn comma() -> &'static str {
    if locale().is_chinese() { "，" } else { ", " }
}

/// A line's clauses joined with [`comma`], the empty ones left out.
pub fn join_phrases<S: AsRef<str>>(parts: &[S]) -> String {
    parts
        .iter()
        .map(AsRef::as_ref)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(comma())
}

/// Items listed within one clause, with the enumeration comma "、" between
/// them in Chinese.
pub fn join_list<S: AsRef<str>>(items: &[S]) -> String {
    let separator = if locale().is_chinese() { "、" } else { ", " };
    items
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(separator)
}

/// Items as one phrase, "A, B, and C" or "A、B和C" (`Intl.ListFormat`'s
/// conjunction); in Chinese a 和 between Latin words takes a space on
/// either side, as `readableAuthors` respaces it.
pub fn join_conjunction<S: AsRef<str>>(items: &[S]) -> String {
    join_conjunction_in(items, locale())
}

pub(crate) fn join_conjunction_in<S: AsRef<str>>(items: &[S], locale: Locale) -> String {
    let items: Vec<&str> = items.iter().map(AsRef::as_ref).collect();
    let Some((last, rest)) = items.split_last() else {
        return String::new();
    };
    if rest.is_empty() {
        return last.to_string();
    }
    if locale.is_chinese() {
        let head = rest.join("、");
        let before = head.chars().last().is_some_and(|c| c == '.' || is_latin(c));
        let and = if before && last.chars().next().is_some_and(is_latin) {
            " 和 "
        } else {
            "和"
        };
        return format!("{head}{and}{last}");
    }
    match rest {
        [only] => format!("{only} and {last}"),
        _ => format!("{}, and {last}", rest.join(", ")),
    }
}

/// A letter of the Latin script (`\p{Script=Latin}`): ASCII, Latin-1, the
/// Latin Extended blocks and the fullwidth forms.
fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic()
        || matches!(c, '\u{AA}' | '\u{BA}')
        || ('\u{C0}'..='\u{24F}').contains(&c) && !matches!(c, '\u{D7}' | '\u{F7}')
        || ('\u{1E00}'..='\u{1EFF}').contains(&c)
        || ('\u{2C60}'..='\u{2C7F}').contains(&c)
        || ('\u{A720}'..='\u{A7FF}').contains(&c)
        || ('\u{AB30}'..='\u{AB6F}').contains(&c)
        || ('\u{FF21}'..='\u{FF3A}').contains(&c)
        || ('\u{FF41}'..='\u{FF5A}').contains(&c)
}

fn is_han(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c)
}

/// A space between Chinese and Latin letters or digits, and none between two
/// Chinese characters a catalog's placeholder left apart ("关闭 {title}"
/// around a Chinese title reads "关闭项目"), as `spaceMixedScript` does.
pub fn space_mixed_script(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        if c == ' ' && i > 0 && i + 1 < chars.len() && is_han(chars[i - 1]) && is_han(chars[i + 1])
        {
            continue;
        }
        out.push(c);
        if let Some(&next) = chars.get(i + 1) {
            let latin = |c: char| c.is_ascii_alphanumeric();
            if (is_han(c) && latin(next)) || ((latin(c) || c == '.') && is_han(next)) {
                out.push(' ');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `new Intl.ListFormat(locale, { type: "conjunction" })`'s output for
    /// en and zh-CN, with readableAuthors' respacing of 和 between Latin
    /// names.
    #[test]
    fn conjunctions_read_as_the_tauri_app_lists_them() {
        assert_eq!(join_conjunction_in(&["A"], Locale::En), "A");
        assert_eq!(join_conjunction_in(&["A", "B"], Locale::En), "A and B");
        assert_eq!(
            join_conjunction_in(&["A", "B", "C"], Locale::En),
            "A, B, and C"
        );
        assert_eq!(
            join_conjunction_in(&["Ashish Vaswani", "Noam Shazeer"], Locale::ZhCn),
            "Ashish Vaswani 和 Noam Shazeer"
        );
        assert_eq!(
            join_conjunction_in(&["张三", "李四", "王五"], Locale::ZhCn),
            "张三、李四和王五"
        );
        assert_eq!(
            join_conjunction_in(&["José García", "Émile Zola"], Locale::ZhCn),
            "José García 和 Émile Zola"
        );
        assert_eq!(
            join_conjunction_in(&["Ashish Vaswani", "张三"], Locale::ZhCn),
            "Ashish Vaswani和张三"
        );
        assert_eq!(
            join_conjunction_in(&["张三", "Émile Zola"], Locale::ZhCn),
            "张三和Émile Zola"
        );
        assert_eq!(join_conjunction_in::<&str>(&[], Locale::En), "");
    }

    #[test]
    fn counts_group_digits_and_switch_to_wan_and_yi_in_chinese() {
        assert_eq!(format_count_in(120_400, Locale::En), "120,400");
        assert_eq!(format_count_in(9_999, Locale::ZhCn), "9,999");
        assert_eq!(format_count_in(120_400, Locale::ZhCn), "12.04 万");
        assert_eq!(format_count_in(10_000, Locale::ZhCn), "1 万");
        assert_eq!(format_count_in(250_000_000, Locale::ZhCn), "2.5 亿");
        assert_eq!(format_count_in(99_999_999, Locale::ZhCn), "1 亿");
        assert_eq!(format_count_in(-12_345, Locale::ZhCn), "-1.23 万");
        assert_eq!(format_count_in(-1_234, Locale::En), "-1,234");
    }

    #[test]
    fn mixed_script_spacing_matches_the_tauri_app() {
        assert_eq!(space_mixed_script("切换到Writing"), "切换到 Writing");
        assert_eq!(space_mixed_script("main.tex已保存"), "main.tex 已保存");
        assert_eq!(space_mixed_script("关闭 项目"), "关闭项目");
        assert_eq!(space_mixed_script("Show Project"), "Show Project");
        assert_eq!(space_mixed_script("12.04 万 词"), "12.04 万词");
    }
}
