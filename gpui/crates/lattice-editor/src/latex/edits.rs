//! Pure text edits behind the LaTeX source's commands (`latex-edits.ts` in
//! the Tauri app): wrapping the selection in delimiters or an environment,
//! commenting lines or a region out, sorting lines and changing case, in
//! byte offsets, each with the selection it leaves.

use std::ops::Range;

use regex::Regex;

/// One replacement in the document, in its offsets before the edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub range: Range<usize>,
    pub insert: String,
}

/// The edits a toggle makes and the selection after them, in the edited
/// document (`anchor == head` for a caret).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatEdit {
    pub changes: Vec<TextEdit>,
    pub anchor: usize,
    pub head: usize,
}

pub(super) fn edit(range: Range<usize>, insert: &str) -> TextEdit {
    TextEdit {
        range,
        insert: insert.to_string(),
    }
}

/// One replacement and the selection after it, in the edited document
/// (`SelectionEdit` in `latex-edits.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionEdit {
    pub edit: TextEdit,
    pub selection: Range<usize>,
}

impl SelectionEdit {
    /// As a [`FormatEdit`], for one way of applying either.
    pub fn into_format(self) -> FormatEdit {
        FormatEdit {
            changes: vec![self.edit],
            anchor: self.selection.start,
            head: self.selection.end,
        }
    }
}

/// Surround the selection and keep it selected; an empty selection gets
/// `placeholder` between the delimiters and the caret after it.
pub fn wrap_range(
    text: &str,
    from: usize,
    to: usize,
    before: &str,
    after: &str,
    placeholder: &str,
) -> SelectionEdit {
    let selected = &text[from..to];
    let inner = if selected.is_empty() {
        placeholder
    } else {
        selected
    };
    let start = from + before.len();
    SelectionEdit {
        edit: edit(from..to, &format!("{before}{inner}{after}")),
        selection: if selected.is_empty() {
            start + inner.len()..start + inner.len()
        } else {
            start..start + inner.len()
        },
    }
}

/// ⌘⌥E, ⌘⌥I and Wrap in environment…: `\begin{name}` … `\end{name}` on
/// lines of their own around the selection (`equation` for a blank name).
pub fn wrap_environment(text: &str, from: usize, to: usize, name: &str) -> SelectionEdit {
    let name = match name.trim() {
        "" => "equation",
        name => name,
    };
    wrap_range(
        text,
        from,
        to,
        &format!("\\begin{{{name}}}\n"),
        &format!("\n\\end{{{name}}}"),
        "  ",
    )
}

/// How ⌘⌥/ and ⌘⌥; comment a region out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommentWrap {
    /// A `comment` environment.
    Environment,
    /// `\iffalse` … `\fi`.
    IfFalse,
}

pub fn wrap_comment_region(
    text: &str,
    from: usize,
    to: usize,
    style: CommentWrap,
) -> SelectionEdit {
    match style {
        CommentWrap::Environment => wrap_environment(text, from, to, "comment"),
        CommentWrap::IfFalse => wrap_range(text, from, to, "\\iffalse\n", "\n\\fi", "  "),
    }
}

/// ⌘/: the selected lines commented with `% `, or uncommented when every
/// line with text already is; the lines stay selected.
pub fn toggle_line_comments(text: &str, from: usize, to: usize) -> SelectionEdit {
    // `lastIndexOf("\n", from - 1)`: a newline just before the caret
    // starts its line.
    let start = text[..from].rfind('\n').map_or(0, |at| at + 1);
    let probe = if to > from { to - 1 } else { from };
    let end = text[probe.min(text.len())..]
        .find('\n')
        .map_or(text.len(), |at| probe + at);
    let lines: Vec<&str> = text[start..end].split('\n').collect();
    let content: Vec<&&str> = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let uncomment = !content.is_empty()
        && content
            .iter()
            .all(|line| line.trim_start().starts_with('%'));
    let insert = lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                return line.to_string();
            }
            let indent = &line[..line.len() - line.trim_start().len()];
            let rest = &line[indent.len()..];
            if uncomment {
                let rest = rest.strip_prefix('%').unwrap_or(rest);
                format!("{indent}{}", rest.strip_prefix(' ').unwrap_or(rest))
            } else {
                format!("{indent}% {rest}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let len = insert.len();
    SelectionEdit {
        edit: edit(start..end, &insert),
        selection: start..start + len,
    }
}

/// ⌘⌥S: the whole lines the selection touches, sorted case-insensitively;
/// none when there is nothing to sort.
pub fn sort_selected_lines(text: &str, from: usize, to: usize) -> Option<SelectionEdit> {
    if from == to {
        return None;
    }
    let start = text[..from].rfind('\n').map_or(0, |at| at + 1);
    let end = text[to..].find('\n').map_or(text.len(), |at| to + at);
    let block = &text[start..end];
    let mut lines: Vec<&str> = block.split('\n').collect();
    if lines.len() < 2 {
        return None;
    }
    lines.sort_by_key(|line| line.to_lowercase());
    let insert = lines.join("\n");
    (insert != block).then(|| SelectionEdit {
        selection: start..start + insert.len(),
        edit: edit(start..end, &insert),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseMode {
    Upper,
    Lower,
    Title,
}

/// ⌘⌥U, ⌘⌥L and ⌘⌥C on the selection; none when nothing changes.
pub fn transform_case(text: &str, from: usize, to: usize, mode: CaseMode) -> Option<SelectionEdit> {
    if from == to {
        return None;
    }
    let selected = &text[from..to];
    let insert = match mode {
        CaseMode::Upper => selected.to_uppercase(),
        CaseMode::Lower => selected.to_lowercase(),
        CaseMode::Title => title_case(selected),
    };
    (insert != selected).then(|| SelectionEdit {
        selection: from..from + insert.len(),
        edit: edit(from..to, &insert),
    })
}

/// Each word (`[A-Za-z0-9]+` joined by `'`, `’` or `-`) capitalised, the
/// rest of it lower case.
fn title_case(text: &str) -> String {
    static WORD: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let word = WORD.get_or_init(|| {
        Regex::new(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*").expect("a valid pattern")
    });
    word.replace_all(text, |found: &regex::Captures| {
        let word = &found[0];
        let mut chars = word.chars();
        let first = chars
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_default();
        format!("{first}{}", chars.as_str().to_lowercase())
    })
    .into_owned()
}

/// `doc` with `changes` (sorted, non-overlapping) made.
pub fn apply(doc: &str, changes: &[TextEdit]) -> String {
    let mut out = String::with_capacity(doc.len());
    let mut at = 0;
    for change in changes {
        out.push_str(&doc[at..change.range.start]);
        out.push_str(&change.insert);
        at = change.range.end;
    }
    out.push_str(&doc[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(source: &str) -> String {
        source.chars().filter(|c| !"[]|".contains(*c)).collect()
    }

    fn run_edit(source: &str, make: impl Fn(&str, usize, usize) -> FormatEdit) -> String {
        let (from, to) = match source.find('|') {
            Some(caret) => (caret, caret),
            None => (source.find('[').unwrap(), source.find(']').unwrap() - 1),
        };
        let doc: String = source.chars().filter(|c| !"[]|".contains(*c)).collect();
        let result = make(&doc, from, to);
        let text = apply(&doc, &result.changes);
        if result.anchor == result.head {
            format!("{}|{}", &text[..result.anchor], &text[result.anchor..])
        } else {
            format!(
                "{}[{}]{}",
                &text[..result.anchor],
                &text[result.anchor..result.head],
                &text[result.head..]
            )
        }
    }

    #[test]
    fn wraps_keep_the_selection_or_leave_a_placeholder() {
        let wrapped = |source: &str, name: &str| {
            run_edit(source, |doc, from, to| {
                wrap_environment(doc, from, to, name).into_format()
            })
        };
        assert_eq!(
            wrapped("a [x] b", "itemize"),
            "a \\begin{itemize}\n[x]\n\\end{itemize} b"
        );
        assert_eq!(
            wrapped("a | b", ""),
            "a \\begin{equation}\n  |\n\\end{equation} b"
        );
        let iffalse = run_edit("[x]", |doc, from, to| {
            wrap_comment_region(doc, from, to, CommentWrap::IfFalse).into_format()
        });
        assert_eq!(iffalse, "\\iffalse\n[x]\n\\fi");
    }

    #[test]
    fn line_comments_toggle_on_every_line_with_text() {
        let on = run_edit("[a\n\n  b]", |doc, from, to| {
            toggle_line_comments(doc, from, to).into_format()
        });
        assert_eq!(on, "[% a\n\n  % b]");
        let off = run_edit(&on, |doc, from, to| {
            toggle_line_comments(doc, from, to).into_format()
        });
        assert_eq!(off, "[a\n\n  b]");
        // A caret comments its own line.
        let caret = run_edit("x\nab|c\ny", |doc, from, to| {
            toggle_line_comments(doc, from, to).into_format()
        });
        assert_eq!(caret, "x\n[% abc]\ny");
    }

    #[test]
    fn sorts_whole_lines_and_changes_case() {
        let sorted = sort_selected_lines("b\nC\na", 0, 5).unwrap();
        assert_eq!(apply("b\nC\na", &[sorted.edit]), "a\nb\nC");
        assert_eq!(sort_selected_lines("a\nb", 0, 3), None);
        let title = transform_case("the it's well-known x", 0, 21, CaseMode::Title).unwrap();
        // A hyphen joins one word, as the Tauri app's word pattern reads it.
        assert_eq!(title.edit.insert, "The It's Well-known X");
        assert_eq!(transform_case("ABC", 0, 3, CaseMode::Upper), None);
        assert_eq!(
            transform_case("Abc", 0, 3, CaseMode::Lower)
                .unwrap()
                .edit
                .insert,
            "abc"
        );
    }
}
