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

use std::{cell::Cell, ops::Range, rc::Rc, sync::LazyLock};

use gpui::{
    AnyElement, App, AppContext as _, Entity, HighlightStyle, Hsla, IndentAdjustment,
    InteractiveElement as _, IntoElement, LineFragment, ParentElement as _, Pixels, SharedString,
    Styled as _, Window, canvas, div, prelude::FluentBuilder as _, px,
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

/// The rows the folded diff draws, for its height: each change's lines with
/// their context, and a separator (an empty row here) for each folded run.
fn shown_rows(change: &FileChange) -> Vec<String> {
    let before = change.before.as_deref().unwrap_or("");
    let after = change.after.as_deref().unwrap_or("");
    let diff = TextDiff::from_lines(before, after);
    let groups = diff.grouped_ops(CONTEXT);
    let total_old = diff.old_slices().len();
    let mut rows = Vec::new();
    let mut covered_to = 0;
    for group in &groups {
        let Some(first) = group.first() else { continue };
        if first.old_range().start > covered_to {
            rows.push(String::new());
        }
        rows.extend(group.iter().flat_map(|op| {
            diff.iter_changes(op)
                .map(|change| change.value().trim_end_matches(['\n', '\r']).to_owned())
        }));
        covered_to = group.last().map_or(covered_to, |last| last.old_range().end);
    }
    if covered_to < total_old && !groups.is_empty() {
        rows.push(String::new());
    }
    rows
}

/// How many rows a wrapped diff draws in the code column its body last
/// measured: each shown line broken where the column breaks it. Before the
/// first measure, one row a line.
fn wrapped_rows(diff: &LoadedDiff, rem: Pixels, cx: &App) -> usize {
    let font_size = TEXT_CAPTION.to_pixels(rem);
    // Kit's unified row: 0.5rem of padding each side, the old and new line
    // numbers (`gutter_width`), and the 1rem lane of the change bar.
    let gutter = font_size * 0.7 * diff.digits as f32 + rem;
    let column = diff.width.get() - rem - gutter * 2. - rem;
    if column <= px(0.) {
        return diff.shown.len();
    }
    let mut wrapper = cx
        .text_system()
        .line_wrapper(gpui::font(cx.lattice().fonts.editor.clone()), font_size);
    diff.shown
        .iter()
        .map(|line| {
            1 + wrapper
                .wrap_line(
                    &[LineFragment::text(line)],
                    column,
                    IndentAdjustment::NoIndent,
                )
                .count()
        })
        .sum()
}

/// A diff ready to draw: Kit's state for it, and the rows it shows.
pub struct LoadedDiff {
    pub change: FileChange,
    pub state: Option<Entity<DiffState>>,
    /// Why a change with text to show cannot be drawn: its patch did not
    /// parse (`Could not render these changes`).
    pub error: Option<String>,
    /// The text of each row it shows.
    shown: Vec<String>,
    /// Digits in its longest line number, as Kit sizes the gutter.
    digits: usize,
    /// Its body's width as last drawn, where wrapped lines break.
    width: Rc<Cell<Pixels>>,
}

/// The change as Kit's diff files: `None` when there is nothing to show,
/// an error when its patch does not parse.
pub fn parse_change(change: &FileChange) -> Result<Option<Vec<DiffFile>>, String> {
    let empty = change.before == change.after
        || (change.before.is_none() && change.after.as_deref() == Some(""))
        || (change.after.is_none() && change.before.as_deref() == Some(""));
    if empty {
        return Ok(None);
    }
    DiffFile::parse(&unified_patch(change))
        .map(Some)
        .map_err(|error| error.to_string())
}

impl LoadedDiff {
    pub fn new(change: FileChange, cx: &mut App) -> Self {
        let parsed = parse_change(&change);
        let error = parsed.as_ref().err().cloned();
        let state = parsed.ok().flatten().map(|files| {
            let language = language_of(&change.path);
            let files: Vec<DiffFile> = files
                .into_iter()
                .map(|file| file.with_language(language))
                .collect();
            let appearance = cx.palette().appearance;
            cx.new(|cx| {
                DiffState::new(files, cx)
                    .with_context_lines(Some(CONTEXT))
                    .with_syntax_highlighter(move |language, text| match language {
                        "latex" => highlight_tex(text, appearance),
                        "markdown" => highlight_markdown(text, appearance),
                        _ => Vec::new(),
                    })
            })
        });
        let shown = shown_rows(&change);
        let lines = [&change.before, &change.after]
            .iter()
            .map(|side| side.as_deref().map_or(0, |text| text.lines().count()))
            .max()
            .unwrap_or(0);
        Self {
            change,
            state,
            error,
            shown,
            digits: lines.max(1).to_string().len(),
            width: Rc::default(),
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
    } else if [".md", ".markdown"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        "markdown"
    } else {
        "text"
    }
}

static MARKDOWN_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?m)(?P<heading>^#{1,6}[ \t].*$)",
        r"|(?P<marker>^[ \t]*(?:[-*+]|\d+[.)]|>)[ \t])",
        r"|(?P<code>`[^`\n]+`)",
        r"|(?P<strong>\*\*[^*\n]+\*\*|__[^_\n]+__)",
        r"|(?P<emphasis>\*[^*\s][^*\n]*\*|\b_[^_\s][^_\n]*_\b)",
        r"|(?P<link>\]\([^)\n]*\))",
    ))
    .expect("the Markdown token pattern compiles")
});

/// Markdown as GitHub's theme colours it (`pierre-diff.ts`'s markdown
/// grammar): headings in its constant blue and bold, list and quote
/// markers as keywords, inline code and link targets as strings, strong
/// text bold and emphasis italic.
fn highlight_markdown(text: &str, appearance: Appearance) -> Vec<(Range<usize>, HighlightStyle)> {
    let Some(source) = CodeTheme::Github.source() else {
        return Vec::new();
    };
    let syntax = source.in_app(appearance).syntax;
    let color = |color: Hsla| HighlightStyle {
        color: Some(color),
        ..HighlightStyle::default()
    };
    MARKDOWN_TOKEN
        .captures_iter(text)
        .filter_map(|captures| {
            let style = if captures.name("heading").is_some() {
                HighlightStyle {
                    font_weight: Some(gpui::FontWeight::BOLD),
                    ..color(syntax.constant.hsla())
                }
            } else if captures.name("marker").is_some() {
                color(syntax.keyword.hsla())
            } else if captures.name("code").is_some() || captures.name("link").is_some() {
                color(syntax.string.hsla())
            } else if captures.name("strong").is_some() {
                HighlightStyle {
                    font_weight: Some(gpui::FontWeight::BOLD),
                    ..HighlightStyle::default()
                }
            } else {
                HighlightStyle {
                    font_style: Some(gpui::FontStyle::Italic),
                    ..HighlightStyle::default()
                }
            };
            let range = captures.get(0)?.range();
            Some((range, style))
        })
        .collect()
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
/// change says so in the same frame. `on_line` opens the file at a line;
/// `wrap` wraps long lines instead of scrolling sideways (`FileDiffView`'s
/// `wrap`, Pierre's `overflow: "wrap"`).
#[allow(clippy::too_many_arguments)]
pub fn history_diff(
    id: impl Into<SharedString>,
    diff: &LoadedDiff,
    binary: bool,
    header_action: Option<AnyElement>,
    on_line: Option<super::OnLine>,
    wrap: bool,
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
                let rows = if wrap {
                    wrapped_rows(diff, rem, cx)
                } else {
                    diff.shown.len()
                };
                let height = (row * rows.max(1) as f32).min(px(MAX_BODY) * (rem / px(16.)));
                let mut view = Diff::new(state)
                    .header_visible(false)
                    .soft_wrap(wrap)
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
                // Wrapped, the height follows the width the lines break at.
                let width = diff.width.clone();
                let probe = canvas(
                    move |bounds, window, _| {
                        if width.get() != bounds.size.width {
                            width.set(bounds.size.width);
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0();
                div()
                    .id(SharedString::from(format!("{id}-body")))
                    .relative()
                    .w_full()
                    .bg(palette.window)
                    .when(wrap, |body| body.child(probe))
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

    #[test]
    fn a_change_whose_patch_does_not_parse_says_why() {
        // Text either side parses, empty says nothing.
        let parsed = parse_change(&FileChange {
            path: "main.tex".into(),
            before: Some("a\n".into()),
            after: Some("b\n".into()),
        });
        assert!(matches!(parsed, Ok(Some(ref files)) if files.len() == 1));
        let same = parse_change(&FileChange {
            path: "main.tex".into(),
            before: Some("a\n".into()),
            after: Some("a\n".into()),
        });
        assert!(matches!(same, Ok(None)));
        // A name that breaks the patch's headers is a failure to draw, not
        // a silent blank (`Could not render these changes`).
        let broken = parse_change(&FileChange {
            path: "notes\n@@ -1 +1 @@.tex".into(),
            before: Some("a\n".into()),
            after: Some("b\n".into()),
        });
        assert!(broken.is_err());
    }

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
        assert_eq!(
            shown_rows(&change(Some(&before), Some(&after))).len(),
            1 + 8 + 1
        );
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

    #[test]
    fn markdown_diffs_are_coloured_by_their_marks() {
        assert_eq!(super::language_of("notes/Plan.MD"), "markdown");
        let text =
            "## Results\n- see `fit.py` and [the data](data.csv)\nIt is **clear** and *new*.";
        let spans: Vec<&str> = super::highlight_markdown(text, Appearance::Light)
            .into_iter()
            .map(|(range, _)| &text[range])
            .collect();
        assert_eq!(
            spans,
            [
                "## Results",
                "- ",
                "`fit.py`",
                "](data.csv)",
                "**clear**",
                "*new*"
            ]
        );
    }
}
