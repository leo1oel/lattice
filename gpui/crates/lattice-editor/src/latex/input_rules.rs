//! The LaTeX source's typing rules, as the Tauri app's editor has them
//! (`latex-input.ts`, `beginEnvironmentClose` in `latex-environments.ts`,
//! `insertLatexNewline` and `dollarPairCommand` in `latex-editor.ts`): Enter
//! after a `\begin{…}` writes its `\end{…}` and on an `\item` line starts the
//! next item or leaves the list, a typed or completed `\begin{…}` is closed,
//! `\left(` grows its `\right)`, and `$` pairs. Each returns the edit and
//! where the caret lands, in byte offsets, or `None` for the plain key.

use std::{ops::Range, sync::OnceLock};

use regex::Regex;

use super::{
    edits::{FormatEdit, TextEdit},
    environments::{Delimiter, enclosing_environment, environment_events},
    folding::uncommented,
};

/// An edit to apply, and where the caret lands after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputEdit {
    pub range: Range<usize>,
    pub insert: String,
    pub cursor: usize,
}

impl InputEdit {
    /// The edit as one change, the caret where it lands.
    pub fn into_format(self) -> FormatEdit {
        FormatEdit {
            anchor: self.cursor,
            head: self.cursor,
            changes: vec![TextEdit {
                range: self.range,
                insert: self.insert,
            }],
        }
    }
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid pattern"))
}

/// A line that starts with `\item`, with its indent and optional `[label]`
/// (`\itemsep` is ruled out after the match: no look-ahead here).
fn item_line() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"^([ \t]*)\\item(\[[^\]]*\])?")
}

fn line_bounds(text: &str, cursor: usize) -> Range<usize> {
    let from = text[..cursor].rfind('\n').map_or(0, |n| n + 1);
    let to = text[cursor..].find('\n').map_or(text.len(), |n| cursor + n);
    from..to
}

fn leading_blanks(text: &str) -> &str {
    &text[..text.len() - text.trim_start_matches([' ', '\t']).len()]
}

/// Enter on a line that starts with `\item`, after that `\item`, begins the
/// next item at the same indent. On an item with nothing written yet, it
/// leaves the list instead: the empty item goes, and when nothing but blanks
/// stand between it and the list's `\end`, the caret moves to a new line
/// after that `\end`. Any other line gets `None`, for the plain newline.
pub fn list_item_newline(text: &str, cursor: usize) -> Option<InputEdit> {
    let Range {
        start: line_from,
        end: line_to,
    } = line_bounds(text, cursor);
    let line = &text[line_from..line_to];
    let item = item_line().captures(line)?;
    let whole = item.get(0)?;
    let word_end = item.get(1)?.end() + "\\item".len();
    if line[word_end..].starts_with(|c: char| c.is_ascii_alphabetic() || c == '@') {
        return None;
    }
    let item_end = line_from + whole.end();
    if cursor < item_end {
        return None;
    }
    let indent = &item[1];
    let label = item.get(2).map(|label| &label.as_str()[1..label.len() - 1]);
    if !line[whole.end()..].trim().is_empty() || label.is_some_and(|label| !label.trim().is_empty())
    {
        // Blanks around the caret would trail the old item or lead the new one.
        let from = item_end + text[item_end..cursor].trim_end().len();
        let to = cursor + leading_blanks(&text[cursor..line_to]).len();
        let insert = format!("\n{indent}\\item ");
        return Some(InputEdit {
            cursor: from + insert.len(),
            range: from..to,
            insert,
        });
    }
    if let Some(list) = enclosing_environment(text, cursor)
        && list.end.start >= line_to
        && text[line_to..list.end.start].trim().is_empty()
    {
        let begin_line = line_bounds(text, list.begin.start).start;
        let insert = format!(
            "{}\n{}",
            &text[line_to..list.end.end],
            leading_blanks(&text[begin_line..list.begin.start])
        );
        // The empty item's line goes with the newline before it.
        let from = line_from.saturating_sub(1);
        return Some(InputEdit {
            range: from..list.end.end,
            cursor: from + insert.len(),
            insert,
        });
    }
    let start = line_from + indent.len();
    Some(InputEdit {
        range: start..line_to,
        insert: String::new(),
        cursor: start,
    })
}

fn begin_at_end() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\begin\{([A-Za-z*][A-Za-z0-9*]*)\}$")
}

fn is_list(name: &str) -> bool {
    matches!(
        name.strip_suffix('*').unwrap_or(name),
        "itemize" | "enumerate" | "description"
    )
}

/// More `\begin{name}` than `\end{name}` in `text`, ignoring `%` comments.
fn is_unbalanced(name: &str, text: &str) -> bool {
    let mut open = 0i32;
    for line in text.lines().filter(|line| line.contains(name)) {
        for event in environment_events(uncommented(line)) {
            if event.name == name {
                open += if event.kind == Delimiter::Begin {
                    1
                } else {
                    -1
                };
            }
        }
    }
    open > 0
}

/// The body line and `\end{…}` to add after a just-written `\begin{…}` that
/// ends `before` (the text before the caret), and the caret's offset into
/// that insert, on the body line; `indent` is the `\begin` line's own
/// indentation. A list's body line starts its first `\item`. Nothing is
/// added unless `text` has more `\begin{…}` than `\end{…}` of that name.
pub fn begin_environment_close(before: &str, text: &str, indent: &str) -> Option<(String, usize)> {
    let name = begin_at_end().captures(before)?.get(1)?.as_str();
    if !is_unbalanced(name, text) {
        return None;
    }
    let body = if is_list(name) { "\\item " } else { "" };
    Some((
        format!("\n{indent}  {body}\n{indent}\\end{{{name}}}"),
        3 + indent.len() + body.len(),
    ))
}

fn any_begin_at_end() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\begin\{[^}]+\}$")
}

/// Enter (`insertLatexNewline`): right after a `\begin{env}` it opens an
/// indented body line and writes the matching `\end{env}`, unless the
/// environment is already closed, when it only indents the new line; on an
/// `\item` line it starts the next item, or leaves the list from an empty
/// one. `None` leaves the key to the plain newline, which keeps the line's
/// indent.
pub fn latex_newline(text: &str, from: usize, to: usize) -> Option<InputEdit> {
    let line = line_bounds(text, from);
    let before = text[line.start..from].trim_end_matches([' ', '\t']);
    let opens = any_begin_at_end().is_match(before);
    if from == to && !opens {
        return list_item_newline(text, from);
    }
    if from != to || !opens {
        return None;
    }
    let indent = leading_blanks(&text[line.clone()]);
    let (insert, offset) = begin_environment_close(before, text, indent)
        .unwrap_or_else(|| (format!("\n{indent}  "), indent.len() + 3));
    // Trailing blanks after the `\begin{…}` would otherwise end up after the `\end{…}`.
    let start = line.start + before.len();
    Some(InputEdit {
        range: start..from,
        cursor: start + offset,
        insert,
    })
}

/// After a typed or completed character, with the caret at `head`: the
/// `\begin{…}` it finished closed by its `\end{…}`, or the `\left(` it
/// finished closed by its `\right)`.
pub fn after_input(text: &str, head: usize) -> Option<InputEdit> {
    let line = line_bounds(text, head);
    let before = &text[line.start..head];
    let indent = leading_blanks(&text[line.clone()]);
    if let Some((insert, offset)) = begin_environment_close(before, text, indent) {
        return Some(InputEdit {
            range: head..head,
            cursor: head + offset,
            insert,
        });
    }
    let (replace, insert) = sized_delimiter_close(before, &text[head..line.end])?;
    Some(InputEdit {
        range: head..head + replace,
        insert,
        cursor: head,
    })
}

/// `\left` and the sized `\bigl` family, each with the command that closes it.
const SIZES: &[(&str, &str)] = &[
    ("left", "right"),
    ("bigl", "bigr"),
    ("Bigl", "Bigr"),
    ("biggl", "biggr"),
    ("Biggl", "Biggr"),
];
const DELIMITERS: &[(&str, &str)] = &[
    ("(", ")"),
    ("[", "]"),
    ("\\{", "\\}"),
    ("|", "|"),
    ("\\|", "\\|"),
    ("\\langle", "\\rangle"),
    ("\\lvert", "\\rvert"),
    ("\\lVert", "\\rVert"),
    ("\\lfloor", "\\rfloor"),
    ("\\lceil", "\\rceil"),
];

fn opened() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        let sizes: Vec<&str> = SIZES.iter().map(|(open, _)| *open).collect();
        let delimiters: Vec<String> = DELIMITERS
            .iter()
            .map(|(open, _)| regex::escape(open))
            .collect();
        Regex::new(&format!(
            r"\\({})\s*({})$",
            sizes.join("|"),
            delimiters.join("|")
        ))
        .expect("a valid pattern")
    })
}

/// How many of the `\name` commands in `names` stand in `line` as whole
/// commands (`\left` but not `\leftarrow`).
fn count_commands(line: &str, names: impl Iterator<Item = &'static str> + Clone) -> usize {
    line.match_indices('\\')
        .filter(|(at, _)| {
            let rest = &line[at + 1..];
            names.clone().any(|name| {
                rest.starts_with(name)
                    && !rest[name.len()..].starts_with(|c: char| c.is_ascii_alphabetic())
            })
        })
        .count()
}

/// The `\right)` (or `\bigr]`, …) to write at the caret after a just-typed
/// `\left(` (or `\bigl[`, …), given the caret's line split at the caret, and
/// how many bytes after the caret it replaces: the `)`, `]` or `}` bracket
/// pairing wrote there becomes part of the closer. Nothing is written when
/// the line already closes as many sizes as it opens, as when the opener is
/// retyped in front of its partner.
pub fn sized_delimiter_close(before: &str, after: &str) -> Option<(usize, String)> {
    let found = opened().captures(before)?;
    let line = format!("{before}{after}");
    let closers = count_commands(&line, SIZES.iter().map(|(_, close)| *close));
    let openers = count_commands(&line, SIZES.iter().map(|(open, _)| *open));
    if closers >= openers {
        return None;
    }
    let size = SIZES.iter().find(|(open, _)| *open == &found[1])?.1;
    let delimiter = DELIMITERS.iter().find(|(open, _)| *open == &found[2])?.1;
    let paired = match &found[2] {
        "(" => Some(")"),
        "[" => Some("]"),
        "\\{" => Some("}"),
        _ => None,
    };
    let replace = usize::from(paired.is_some_and(|pair| after.starts_with(pair)));
    Some((replace, format!("\\{size}{delimiter}")))
}

/// `$` at an empty caret (`dollarPairCommand`): writes `$$` with the caret
/// between them, turns `$|$` into display math `$$|$$`, and steps over a
/// closing `$`. A selection is wrapped by the caller.
pub fn dollar_pair(text: &str, head: usize) -> InputEdit {
    let before = text[..head].ends_with('$');
    let after = text[head..].starts_with('$');
    let (range, insert) = match (after, before) {
        (false, _) => (head..head, "$$"),
        (true, true) => (head - 1..head + 1, "$$$$"),
        (true, false) => (head..head, ""),
    };
    InputEdit {
        range,
        insert: insert.to_string(),
        cursor: head + 1,
    }
}

#[cfg(test)]
mod tests;
