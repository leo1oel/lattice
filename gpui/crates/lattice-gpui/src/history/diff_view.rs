//! One file's source diff, as the Tauri app's history surfaces draw it with
//! Pierre's diffs (`src/history/file-diff-view.tsx`, `pierre-diff.ts`):
//! unified, the changed words marked within each changed line, three lines
//! of context around each change with the rest folded into a "N unmodified
//! lines" separator that opens on a click, a coloured bar beside each changed
//! line, the code in the editor's font at the diff size, and line numbers in
//! the interface font. The diff is GPUI Kit's (`gpui_kit::component::diff`),
//! itself modelled on Pierre's: its additions and deletions wash the line in
//! the status colour at 12%, as Pierre's `color-mix(surface 88%, success)`
//! does, and its theme is Lattice's (`lattice_ui::kit`).
//!
//! The file sits in the `.history-diff` frame: a 1px hairline on the control
//! corner over the app's ground, its path and kind of change in a 28px meta
//! row, and a body at most 420px tall that scrolls within itself. TeX is
//! coloured as GitHub's theme colours it, the theme Pierre is given in both
//! appearances.

use std::{ops::Range, sync::LazyLock};

use gpui::{
    AnyElement, App, AppContext as _, Entity, HighlightStyle, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, Styled as _, Window, div, px,
};
use gpui_kit::component::diff::{
    Diff, DiffChangeIndicator, DiffFile, DiffHoverHighlight, DiffHunkSeparator, DiffState,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Appearance, CodeTheme, TextRole, TextRoleStyle as _,
    tokens::{FONT_WEIGHT_MEDIUM, TEXT_CAPTION},
};
use regex::Regex;
use similar::TextDiff;

/// One file's two sides; a missing side means created or deleted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// What happened to a file between its two sides.
pub fn change_kind(change: &FileChange) -> &'static str {
    match (&change.before, &change.after) {
        (None, Some(_)) => t!("created"),
        (Some(_), None) => t!("deleted"),
        _ => t!("edited"),
    }
}

/// The diff's longest body before it scrolls within itself (`.lattice-file-diff-body`).
const MAX_BODY: f32 = 420.;
/// Unchanged lines kept around a change.
const CONTEXT: usize = 3;

/// A unified patch of the whole file, so Kit can fold the unchanged runs
/// and open them again: Pierre's diff of two whole files does the same.
fn unified_patch(change: &FileChange) -> String {
    let before = change.before.as_deref().unwrap_or("");
    let after = change.after.as_deref().unwrap_or("");
    let diff = TextDiff::from_lines(before, after);
    let old = if change.before.is_some() {
        format!("a/{}", change.path)
    } else {
        "/dev/null".into()
    };
    let new = if change.after.is_some() {
        format!("b/{}", change.path)
    } else {
        "/dev/null".into()
    };
    let mut patch = format!("--- {old}\n+++ {new}\n");
    patch.push_str(
        &diff
            .unified_diff()
            .context_radius(usize::MAX / 4)
            .missing_newline_hint(true)
            .to_string(),
    );
    patch
}

/// How many rows the folded diff draws, for its height: each change's lines
/// with their context, and a separator for each folded run.
fn shown_rows(change: &FileChange) -> usize {
    let before = change.before.as_deref().unwrap_or("");
    let after = change.after.as_deref().unwrap_or("");
    let diff = TextDiff::from_lines(before, after);
    let groups = diff.grouped_ops(CONTEXT);
    let total_old = diff.old_slices().len();
    let mut rows = 0;
    let mut covered_to = 0;
    for group in &groups {
        let Some(first) = group.first() else { continue };
        if first.old_range().start > covered_to {
            rows += 1;
        }
        rows += group
            .iter()
            .map(|op| diff.iter_changes(op).count())
            .sum::<usize>();
        covered_to = group.last().map_or(covered_to, |last| last.old_range().end);
    }
    if covered_to < total_old && !groups.is_empty() {
        rows += 1;
    }
    rows
}

/// A diff ready to draw: Kit's state for it, and the rows it shows.
pub struct LoadedDiff {
    pub change: FileChange,
    pub state: Option<Entity<DiffState>>,
    rows: usize,
}

impl LoadedDiff {
    pub fn new(change: FileChange, cx: &mut App) -> Self {
        let empty = change.before == change.after
            || (change.before.is_none() && change.after.as_deref() == Some(""))
            || (change.after.is_none() && change.before.as_deref() == Some(""));
        let state = (!empty)
            .then(|| DiffFile::parse(&unified_patch(&change)).ok())
            .flatten()
            .map(|files| {
                let language = language_of(&change.path);
                let files: Vec<DiffFile> = files
                    .into_iter()
                    .map(|file| file.with_language(language))
                    .collect();
                let appearance = cx.palette().appearance;
                cx.new(|cx| {
                    DiffState::new(files, cx)
                        .with_context_lines(Some(CONTEXT))
                        .with_syntax_highlighter(move |language, text| {
                            if language == "latex" {
                                highlight_tex(text, appearance)
                            } else {
                                Vec::new()
                            }
                        })
                })
            });
        let rows = shown_rows(&change);
        Self {
            change,
            state,
            rows,
        }
    }
}

fn language_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if [".tex", ".ltx", ".sty", ".cls", ".bib"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        "latex"
    } else {
        "text"
    }
}

static TEX_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)(?P<comment>(?:^|[^\\])%.*$)|(?P<command>\\(?:[A-Za-z@]+\*?|.))|(?P<math>\$[^$\n]*\$)")
        .expect("the TeX token pattern compiles")
});

/// TeX as GitHub's theme colours it: control sequences in its keyword blue,
/// inline maths as its strings, comments in its grey.
fn highlight_tex(text: &str, appearance: Appearance) -> Vec<(Range<usize>, HighlightStyle)> {
    let Some(source) = CodeTheme::Github.source() else {
        return Vec::new();
    };
    let syntax = source.in_app(appearance).syntax;
    let paint = |color: Hsla| HighlightStyle {
        color: Some(color),
        ..HighlightStyle::default()
    };
    TEX_TOKEN
        .captures_iter(text)
        .filter_map(|captures| {
            if let Some(comment) = captures.name("comment") {
                // The character before an unescaped % is not the comment's.
                let start = comment
                    .as_str()
                    .find('%')
                    .map_or(comment.start(), |at| comment.start() + at);
                Some((start..comment.end(), paint(syntax.comment.hsla())))
            } else if let Some(command) = captures.name("command") {
                Some((command.range(), paint(syntax.keyword.hsla())))
            } else {
                captures
                    .name("math")
                    .map(|math| (math.range(), paint(syntax.string.hsla())))
            }
        })
        .collect()
}

/// The file's diff under its path, in the `.history-diff` frame; a binary
/// change says so in the same frame. `on_line` opens the file at a line.
pub fn history_diff(
    id: impl Into<SharedString>,
    diff: &LoadedDiff,
    binary: bool,
    header_action: Option<AnyElement>,
    on_line: Option<super::OnLine>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let id: SharedString = id.into();
    let meta = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .min_h(px(28.))
        .px(px(8.))
        .py(px(5.))
        .border_b_1()
        .border_color(palette.line)
        .text_role(TextRole::Micro, cx)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(palette.text)
                .child(diff.change.path.clone()),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_color(palette.text_secondary)
                        .child(capitalized(if binary {
                            t!("binary")
                        } else {
                            change_kind(&diff.change)
                        })),
                )
                .children(header_action),
        );
    let body: AnyElement = if binary {
        notice(t!("Binary file changed"), px(8.), cx)
    } else {
        match &diff.state {
            None => {
                let change = &diff.change;
                let text = if change.before == change.after {
                    t!("No textual changes")
                } else if change.before.is_none() {
                    t!("Empty file added")
                } else {
                    t!("Empty file deleted")
                };
                notice(text, px(9.), cx)
            }
            Some(state) => {
                let rem = window.rem_size();
                let row = TEXT_CAPTION.to_pixels(rem) * 1.6;
                let height = (row * diff.rows.max(1) as f32).min(px(MAX_BODY) * (rem / px(16.)));
                let mut view = Diff::new(state)
                    .header_visible(false)
                    .hunk_separator(DiffHunkSeparator::LineInfo)
                    .change_indicator(DiffChangeIndicator::Bars)
                    .hover_highlight(DiffHoverHighlight::Line)
                    .w_full()
                    .h(height)
                    .bg(palette.window);
                if let Some(on_line) = on_line {
                    view = view.on_line_click(move |position, _, window, cx| {
                        on_line(position.line(), window, cx)
                    });
                }
                div()
                    .id(SharedString::from(format!("{id}-body")))
                    .w_full()
                    .bg(palette.window)
                    .child(view)
                    .into_any_element()
            }
        }
    };
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .border_1()
        .border_color(palette.line)
        .rounded(lattice_ui::tokens::RADIUS_CONTROL)
        .overflow_hidden()
        .bg(palette.window)
        .child(meta)
        .child(body)
        .into_any_element()
}

/// A word with its first letter capitalized, as `text-transform: capitalize` draws a kind.
fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn notice(text: &str, pad: gpui::Pixels, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .p(pad)
        .text_role(TextRole::Micro, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .text_color(palette.text_secondary)
        .child(text.to_string())
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(before: Option<&str>, after: Option<&str>) -> FileChange {
        FileChange {
            path: "main.tex".into(),
            before: before.map(str::to_string),
            after: after.map(str::to_string),
        }
    }

    #[test]
    fn writes_a_patch_kit_reads() {
        for change in [
            change(Some("a\nb\nc\n"), Some("a\nB\nc\n")),
            change(None, Some("new\n")),
            change(Some("old\n"), None),
            change(Some("no newline"), Some("no newline, still")),
        ] {
            let files = DiffFile::parse(&unified_patch(&change)).expect("Kit reads the patch");
            assert_eq!(files.len(), 1);
            assert!(files[0].has_changes());
        }
    }

    #[test]
    fn counts_the_rows_a_folded_diff_shows() {
        let before: String = (1..=20).map(|line| format!("line {line}\n")).collect();
        let after = before.replace("line 10\n", "line ten\n");
        // Folded above, 3 + 2 + 3 lines, folded below.
        assert_eq!(shown_rows(&change(Some(&before), Some(&after))), 1 + 8 + 1);
    }

    #[test]
    fn colours_tex_commands_comments_and_maths() {
        let spans = highlight_tex("\\section{A} $x$ % note", Appearance::Light);
        let texts: Vec<&str> = spans
            .iter()
            .map(|(range, _)| &"\\section{A} $x$ % note"[range.clone()])
            .collect();
        assert_eq!(texts, vec!["\\section", "$x$", "% note"]);
    }
}
