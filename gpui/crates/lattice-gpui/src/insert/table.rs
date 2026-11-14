//! The table generator's model (`table-generator.ts`, `table-data.ts`): a
//! grid of at most 20 by 20 cells, each plain text (escaped for LaTeX) or
//! LaTeX as written, with column alignments, numbers rounded to a number of
//! decimals, booktabs rules and a `table` float with its caption and label.
//!
//! A generated table is managed: the grid rides above its source as a
//! `% lattice-table-v1` comment (the data as URI-encoded JSON in lines of at
//! most 120 characters) and `% /lattice-table` closes it, so the caret in it
//! opens it again in the generator. The comment is the Tauri app's to the
//! byte: either app opens the other's tables, and a table whose source was
//! edited by hand no longer matches its comment and stays the source
//! editor's.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// The most rows and columns a generated table has.
pub const MAX: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    pub text: String,
    pub latex: bool,
}

/// A column's alignment, as `tabular` spells it.
pub type Align = char;

/// The grid and its options (`TableData`); the field order is the stored
/// JSON's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableData {
    pub cells: Vec<Vec<Cell>>,
    #[serde(with = "aligns")]
    pub align: Vec<Align>,
    pub decimals: Option<u8>,
    pub booktabs: bool,
    pub float: bool,
    pub caption: String,
    pub label: String,
}

/// Alignments stored as the one-letter strings the Tauri app writes.
mod aligns {
    use serde::{Deserialize, Deserializer, Serializer, ser::SerializeSeq as _};

    pub fn serialize<S: Serializer>(align: &[char], serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(align.len()))?;
        for a in align {
            seq.serialize_element(&a.to_string())?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<char>, D::Error> {
        let values = Vec::<String>::deserialize(deserializer)?;
        values
            .into_iter()
            .map(|value| match value.as_str() {
                "l" | "c" | "r" => Ok(value.chars().next().unwrap_or('l')),
                _ => Err(serde::de::Error::custom("an alignment is l, c or r")),
            })
            .collect()
    }
}

const START: &str = "% lattice-table-v1 ";
const END: &str = "% /lattice-table";

/// A cell's text, in UTF-16 code units, as the Tauri app measures limits.
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A new table: three columns headed "Col 1" to "Col 3" over two empty
/// rows, left aligned, booktabs, in a float (`newTableData`).
pub fn new_table() -> TableData {
    let cell = |text: &str| Cell {
        text: text.into(),
        latex: false,
    };
    TableData {
        cells: vec![
            vec![cell("Col 1"), cell("Col 2"), cell("Col 3")],
            vec![cell(""), cell(""), cell("")],
            vec![cell(""), cell(""), cell("")],
        ],
        align: vec!['l'; 3],
        decimals: None,
        booktabs: true,
        float: true,
        caption: String::new(),
        label: String::new(),
    }
}

/// Pasted CSV or TSV as a rectangular grid of at most 20 by 20, quoted
/// fields with doubled quotes, or nothing when it is not that
/// (`parseTableData`).
pub fn parse_data(text: &str, delimiter: char) -> Option<Vec<Vec<String>>> {
    if text.is_empty() || units(text) > 100_000 {
        return None;
    }
    let source = text.replace("\r\n", "\n").replace('\r', "\n");
    let source = source.strip_prefix('\u{FEFF}').unwrap_or(&source);
    let mut rows: Vec<Vec<String>> = vec![vec![]];
    let (mut value, mut quoted, mut closed) = (String::new(), false, false);
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' && chars.peek() == Some(&'"') {
                value.push('"');
                chars.next();
            } else if c == '"' {
                quoted = false;
                closed = true;
            } else {
                value.push(c);
            }
        } else if c == delimiter {
            rows.last_mut()?.push(std::mem::take(&mut value));
            closed = false;
        } else if c == '\n' {
            rows.last_mut()?.push(std::mem::take(&mut value));
            closed = false;
            rows.push(vec![]);
        } else if c == '"' && value.is_empty() && !closed {
            quoted = true;
        } else if closed || c == '"' {
            return None;
        } else {
            value.push(c);
        }
        if rows.len() > MAX + 1 || rows.last()?.len() > MAX {
            return None;
        }
    }
    if quoted {
        return None;
    }
    rows.last_mut()?.push(value);
    if source.ends_with('\n') {
        rows.pop();
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if rows.len() > MAX || width > MAX {
        return None;
    }
    Some(
        rows.into_iter()
            .map(|mut row| {
                row.resize(width, String::new());
                row
            })
            .collect(),
    )
}

/// Plain text made safe for LaTeX, a line break a space
/// (`escapeTableText`).
fn escape(text: &str) -> String {
    let mut out = String::new();
    let mut in_break = false;
    for c in text.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
            continue;
        }
        in_break = false;
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            _ => out.push(c),
        }
    }
    out
}

static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[+-]?(?:\d+\.?\d*|\.\d+)$").expect("the number pattern"));
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_:.-]*$").expect("the label pattern"));
static LATEX_CELL_BREAKS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\r\n%&]|\\\\|\\(?:begin|end)\b").expect("the LaTeX cell pattern")
});

/// `Number(text).toFixed(decimals)`: rounded on the double's exact value,
/// a tie away from zero, as JavaScript rounds.
fn to_fixed(value: f64, decimals: usize) -> String {
    let rounded = format!("{value:.decimals$}");
    // A tie only rounds to even in Rust's formatting: look at the exact
    // expansion past the kept digits.
    let exact = format!("{value:.*}", decimals + 60);
    let tail = &exact[exact.len() - 60..];
    if tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0') {
        let step = 10f64.powi(-(decimals as i32));
        let up = (value.abs() / step).floor() * step + step;
        let up = if value < 0. { -up } else { up };
        return format!("{up:.decimals$}");
    }
    rounded
}

/// Whether the grid is one the generator can write (`validTableData`).
pub fn is_valid(data: &TableData) -> bool {
    let columns = data.align.len();
    !data.cells.is_empty()
        && data.cells.len() <= MAX
        && columns > 0
        && columns <= MAX
        && data.align.iter().all(|a| matches!(a, 'l' | 'c' | 'r'))
        && data.cells.iter().all(|row| {
            row.len() == columns
                && row.iter().all(|cell| {
                    units(&cell.text) <= 10_000
                        && (!cell.latex || !LATEX_CELL_BREAKS.is_match(&cell.text))
                })
        })
        && data.decimals.is_none_or(|decimals| decimals <= 8)
        && LABEL.is_match(&data.label)
}

/// The `tabular`, in a `table` float when asked, with the caret's offset
/// (`buildTabularSnippet`, for a grid of data).
pub fn tabular(data: &TableData, rows: &[Vec<String>]) -> (String, usize) {
    let columns = data.align.len().clamp(1, MAX);
    let align: String = data.align.iter().collect();
    let header = rows.first().map(|row| row.join(" & ")).unwrap_or_else(|| {
        (1..=columns)
            .map(|c| format!("Col {c}"))
            .collect::<Vec<_>>()
            .join(" & ")
    });
    let empty = vec![" "; columns].join(" & ");
    let body = (1..rows.len().max(1))
        .map(|r| {
            let row = rows
                .get(r)
                .map(|row| row.join(" & "))
                .unwrap_or_else(|| empty.clone());
            format!("    {row} \\\\")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let lines = [
        format!("  \\begin{{tabular}}{{{align}}}"),
        if data.booktabs {
            "    \\toprule".into()
        } else {
            String::new()
        },
        format!("    {header} \\\\"),
        if data.booktabs {
            "    \\midrule".into()
        } else {
            "    \\hline".into()
        },
        body,
        if data.booktabs {
            "    \\bottomrule".into()
        } else {
            String::new()
        },
        "  \\end{tabular}".into(),
    ];
    let tabular = lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !data.float {
        let insert = format!("{tabular}\n");
        let cursor = insert.find("Col 1").unwrap_or(0);
        return (insert, cursor);
    }
    let caption = data.caption.trim();
    let label = data.label.trim();
    let insert = [
        "\\begin{table}[t]".to_string(),
        "  \\centering".into(),
        if caption.is_empty() {
            String::new()
        } else {
            format!("  \\caption{{{caption}}}")
        },
        if label.is_empty() {
            String::new()
        } else {
            format!("  \\label{{{label}}}")
        },
        tabular,
        "\\end{table}".into(),
        String::new(),
    ]
    // An empty caption or label leaves its line empty, as the Tauri
    // app's join does: the managed comment checks the source to the byte.
    .join("\n");
    let cursor = insert.find(caption).unwrap_or(0);
    (insert, cursor)
}

/// The table's LaTeX (`tableSource`): plain cells escaped, numbers below
/// the header rounded to the decimals asked for.
pub fn source(data: &TableData) -> String {
    let rows: Vec<Vec<String>> = data
        .cells
        .iter()
        .enumerate()
        .map(|(r, row)| {
            row.iter()
                .map(|cell| {
                    if cell.latex {
                        return cell.text.clone();
                    }
                    let mut text = cell.text.clone();
                    if let Some(decimals) = data.decimals.filter(|_| r > 0)
                        && NUMBER.is_match(text.trim())
                        && let Ok(number) = text.trim().parse::<f64>()
                        && number.is_finite()
                        && number.abs() < 1e21
                    {
                        text = to_fixed(number, decimals as usize);
                    }
                    escape(&text)
                })
                .collect()
        })
        .collect();
    let escaped = TableData {
        caption: escape(&data.caption),
        ..data.clone()
    };
    tabular(&escaped, &rows).0
}

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()`
/// percent-encoded as UTF-8.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The table with its managed comment (`managedTableSource`).
pub fn managed_source(data: &TableData) -> String {
    let json = serde_json::to_string(data).unwrap_or_default();
    let encoded = encode_uri_component(&json);
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(120)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect();
    format!("{START}{}\n{}{END}\n", chunks.join("\n% "), source(data))
}

/// The table the caret is in (`tableAtCursor`): a managed table's span and
/// its grid (none when its source was edited since); for the caret inside
/// another `table` or `tabular`, an empty span at the caret and no grid; or
/// nothing, outside every table.
#[derive(Clone, Debug, PartialEq)]
pub struct TableAt {
    pub from: usize,
    pub to: usize,
    pub data: Option<TableData>,
}

static MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^% lattice-table-v1 .*$(?:\n% [A-Za-z0-9%_.!~*'()-]+$)*")
        .expect("the table marker pattern")
});
static ENVIRONMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(begin|end)\{(?:table\*?|tabular\*?)\}").expect("the environment pattern")
});

pub fn table_at(source: &str, cursor: usize) -> Option<TableAt> {
    for marker in MARKER.find_iter(source) {
        let from = marker.start();
        let end = source[from..].find(&format!("\n{END}")).map(|at| from + at);
        let to = match end {
            None => source.len(),
            Some(end) => {
                let close = end + 1 + END.len();
                close + usize::from(source[close..].starts_with('\n'))
            }
        };
        if cursor < from || cursor >= to {
            continue;
        }
        let encoded = marker.as_str()[START.len()..].replace("\n% ", "");
        let data = decode_uri_component(&encoded)
            .and_then(|json| serde_json::from_str::<TableData>(&json).ok())
            .filter(|data| is_valid(data) && managed_source(data) == source[from..to]);
        return Some(TableAt { from, to, data });
    }
    let mut depth: i64 = 0;
    for token in ENVIRONMENT.captures_iter(&source[..cursor.min(source.len())]) {
        depth = (depth + if &token[1] == "begin" { 1 } else { -1 }).max(0);
    }
    (depth > 0).then_some(TableAt {
        from: cursor,
        to: cursor,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_and_tsv_parse_with_quotes_and_pad_short_rows() {
        assert_eq!(
            parse_data("a,\"b, \"\"c\"\"\"\n1\n", ','),
            Some(vec![
                vec!["a".into(), "b, \"c\"".into()],
                vec!["1".into(), "".into()]
            ])
        );
        assert_eq!(
            parse_data("x\ty\r\n3\t4", '\t'),
            Some(vec![
                vec!["x".into(), "y".into()],
                vec!["3".into(), "4".into()]
            ])
        );
        // A stray quote, an open quote, and a grid over 20 wide are refused.
        assert_eq!(parse_data("a\"b", ','), None);
        assert_eq!(parse_data("\"open", ','), None);
        assert_eq!(parse_data(&vec!["x"; 21].join(","), ','), None);
    }

    #[test]
    fn rounding_follows_javascripts_to_fixed() {
        // Ties on an exact double round away from zero, unlike Rust's {:.0}.
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        // 1.005 is just below the tie as a double: (1.005).toFixed(2) is "1.00".
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(3.0, 2), "3.00");
    }

    #[test]
    fn the_source_escapes_plain_cells_and_rounds_numbers_below_the_header() {
        let mut data = new_table();
        data.cells[0][0].text = "Model & size".into();
        data.cells[1][0].text = "1.5".into();
        data.cells[1][1].text = "$x^2$".into();
        data.cells[1][1].latex = true;
        data.cells[1][2].text = "50%".into();
        data.decimals = Some(2);
        data.caption = "Results_1".into();
        data.label = "tab:results".into();
        // The Tauri app's tableSource for the same grid.
        assert_eq!(
            source(&data),
            "\\begin{table}[t]\n  \\centering\n  \\caption{Results\\_1}\n  \\label{tab:results}\n  \\begin{tabular}{lll}\n    \\toprule\n    Model \\& size & Col 2 & Col 3 \\\\\n    \\midrule\n    1.50 & $x^2$ & 50\\% \\\\\n     &  &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n"
        );
    }

    #[test]
    fn a_table_without_float_or_booktabs_is_a_bare_tabular() {
        let mut data = new_table();
        data.float = false;
        data.booktabs = false;
        assert_eq!(
            source(&data),
            "  \\begin{tabular}{lll}\n    Col 1 & Col 2 & Col 3 \\\\\n    \\hline\n     &  &  \\\\\n     &  &  \\\\\n  \\end{tabular}\n"
        );
    }

    #[test]
    fn a_managed_table_opens_again_and_one_edited_by_hand_does_not() {
        let mut data = new_table();
        data.caption = "Été ½".into();
        let managed = managed_source(&data);
        let document = format!("Before.\n{managed}After.\n");
        let inside = document.find("\\toprule").unwrap();
        let found = table_at(&document, inside).unwrap();
        assert_eq!(found.from, "Before.\n".len());
        assert_eq!(&document[found.from..found.to], managed);
        assert_eq!(found.data, Some(data.clone()));
        assert_eq!(table_at(&document, 2), None);
        let edited = document.replace("Col 2", "Col two");
        assert_eq!(table_at(&edited, inside).unwrap().data, None);
    }

    #[test]
    fn the_managed_comment_is_the_tauri_apps_to_the_byte() {
        // The Tauri app's managedTableSource(newTableData()), run under Node.
        assert_eq!(
            managed_source(&new_table()),
            "% lattice-table-v1 %7B%22cells%22%3A%5B%5B%7B%22text%22%3A%22Col%201%22%2C%22latex%22%3Afalse%7D%2C%7B%22text%22%3A%22Col%202%22%2C%22latex\n% %22%3Afalse%7D%2C%7B%22text%22%3A%22Col%203%22%2C%22latex%22%3Afalse%7D%5D%2C%5B%7B%22text%22%3A%22%22%2C%22latex%22%3Af\n% alse%7D%2C%7B%22text%22%3A%22%22%2C%22latex%22%3Afalse%7D%2C%7B%22text%22%3A%22%22%2C%22latex%22%3Afalse%7D%5D%2C%5B%7B%\n% 22text%22%3A%22%22%2C%22latex%22%3Afalse%7D%2C%7B%22text%22%3A%22%22%2C%22latex%22%3Afalse%7D%2C%7B%22text%22%3A%22%22%2\n% C%22latex%22%3Afalse%7D%5D%5D%2C%22align%22%3A%5B%22l%22%2C%22l%22%2C%22l%22%5D%2C%22decimals%22%3Anull%2C%22booktabs%22\n% %3Atrue%2C%22float%22%3Atrue%2C%22caption%22%3A%22%22%2C%22label%22%3A%22%22%7D\n\\begin{table}[t]\n  \\centering\n\n\n  \\begin{tabular}{lll}\n    \\toprule\n    Col 1 & Col 2 & Col 3 \\\\\n    \\midrule\n     &  &  \\\\\n     &  &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n% /lattice-table\n"
        );
    }

    #[test]
    fn the_caret_in_a_hand_written_table_is_inside_one_with_no_grid() {
        let source = "\\begin{table}\n\\begin{tabular}{l}\nx\n\\end{tabular}\n\\end{table}\nafter";
        assert_eq!(
            table_at(source, 30),
            Some(TableAt {
                from: 30,
                to: 30,
                data: None
            })
        );
        assert_eq!(table_at(source, source.len()), None);
    }

    #[test]
    fn validity_matches_the_tauri_rules() {
        let mut data = new_table();
        assert!(is_valid(&data));
        data.label = "tab:a b".into();
        assert!(!is_valid(&data));
        data.label = "tab:a".into();
        data.cells[1][0] = Cell {
            text: "a & b".into(),
            latex: true,
        };
        assert!(!is_valid(&data));
        data.cells[1][0].latex = false;
        data.decimals = Some(9);
        assert!(!is_valid(&data));
    }
}
