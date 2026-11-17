//! An editable figure put into a LaTeX source (`editable-figure.ts`,
//! `insertImportedFigure`): its entry file's `\input` at the caret, or, on an
//! empty line of the document's body outside any figure-holding environment,
//! a whole `figure` float around it; and, in a root document, the
//! `\usepackage` lines it lacks and its folder on `\graphicspath`. A file
//! that is not the root says which lines the main document's preamble needs.
//!
//! Offsets are byte offsets into the source.

use std::sync::LazyLock;

use regex::Regex;

static BEGIN_DOCUMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[^%\n]*\\begin\s*\{document\}").expect("pattern"));
static PACKAGE_LOAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}").expect("pattern")
});
static GRAPHICS_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\graphicspath\s*\{").expect("pattern"));
static FIGURE_HOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\\(begin|end)\s*\{(figure|scheme|chart|graph|table|wrapfigure|SCfigure|sidewaysfigure|subfigure|minipage|tocentry)\*?\}",
    )
    .expect("pattern")
});
static GROUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{([^{}]*)\}").expect("pattern"));
static PACKAGE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]+$").expect("pattern"));

/// One edit: replace `from..to` with `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// What putting a figure in a source does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FigureChanges {
    /// The preamble's additions, in the source's own offsets: before
    /// `body.from`, or after it when the figure goes into the preamble.
    pub preamble: Vec<Edit>,
    /// The include, or the float holding it, over the selection.
    pub body: Edit,
    /// Where the caret goes in `body.insert`: after the include, or inside
    /// the float's caption.
    pub caret: usize,
    /// Lines to add by hand: the file is not the root document.
    pub unplaced: Vec<String>,
}

impl FigureChanges {
    /// Every edit in the source's own offsets, highest offset first, so each
    /// applies over text the ones before it left unchanged; at the body's own
    /// offset a preamble edit comes first, so the body's text goes before it.
    /// With them, the caret's offset once all are applied.
    pub fn ordered(&self) -> (Vec<Edit>, usize) {
        let mut edits = self.preamble.clone();
        edits.push(self.body.clone());
        edits.sort_by_key(|edit| std::cmp::Reverse(edit.from));
        let before: usize = self
            .preamble
            .iter()
            .filter(|edit| edit.from < self.body.from)
            .map(|edit| edit.insert.len() - (edit.to - edit.from))
            .sum();
        (edits, self.body.from + before + self.caret)
    }
}

/// The folder with its closing slash; empty for the project root.
fn figure_folder(directory: &str) -> String {
    let folder = directory.replace('\\', "/");
    let folder = folder.trim_end_matches('/');
    if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    }
}

/// The line that includes a figure's entry file, from the project root
/// (`editableFigureInclude`).
pub fn include(directory: &str, entry: &str) -> String {
    let entry = entry
        .strip_suffix(".tex")
        .or_else(|| entry.strip_suffix(".TEX"))
        .unwrap_or(entry);
    format!("\\input{{{}{entry}}}", figure_folder(directory))
}

/// Commented text blanked, every offset unchanged.
fn blank_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (ix, line) in text.split('\n').enumerate() {
        if ix > 0 {
            out.push('\n');
        }
        let bytes = line.as_bytes();
        let comment =
            (0..bytes.len()).find(|&at| bytes[at] == b'%' && (at == 0 || bytes[at - 1] != b'\\'));
        match comment {
            Some(at) => {
                out.push_str(&line[..at]);
                out.extend(std::iter::repeat_n(' ', line.len() - at));
            }
            None => out.push_str(line),
        }
    }
    out
}

/// A line without its comment.
fn without_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    match (0..bytes.len()).find(|&at| bytes[at] == b'%' && (at == 0 || bytes[at - 1] != b'\\')) {
        Some(at) => &line[..at],
        None => line,
    }
}

/// The balanced group opening at `open`, as the offset just past its close.
fn group_end(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut at = open;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 1,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(at + 1);
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

fn same_folder(listed: &str, folder: &str) -> bool {
    let strip = |path: &str| {
        let mut path = path;
        while let Some(rest) = path.strip_prefix("./") {
            path = rest;
        }
        path.to_string()
    };
    strip(listed) == strip(folder)
}

fn lists_folder(path: &str, folder: &str) -> bool {
    GROUP
        .captures_iter(path)
        .any(|group| same_folder(&group[1], folder))
}

enum PathAddition {
    Listed,
    Add(Edit),
}

/// Where the preamble's `\graphicspath` takes `folder`; none without one.
fn graphics_path_addition(source: &str, begin: usize, folder: &str) -> Option<PathAddition> {
    let code = blank_comments(&source[..begin]);
    let command = GRAPHICS_PATH.find(&code)?;
    let open = command.end() - 1;
    let end = group_end(&code, open)?;
    Some(if lists_folder(&code[open + 1..end - 1], folder) {
        PathAddition::Listed
    } else {
        PathAddition::Add(Edit {
            from: end - 1,
            to: end - 1,
            insert: format!("{{{folder}}}"),
        })
    })
}

/// `graphicx` (which `\graphicspath` needs) and `packages`, once each.
fn figure_packages(packages: &[String], folder: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let first = (!folder.is_empty()).then(|| "graphicx".to_string());
    for name in first.into_iter().chain(packages.iter().cloned()) {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// What a root document's preamble lacks for a figure in `folder`
/// (`missingPreambleInsertions`): its packages' `\usepackage` lines after the
/// last package line (else before `\begin{document}`), and the folder on
/// `\graphicspath`. Empty for a file that is not a root document.
pub fn missing_preamble_insertions(source: &str, packages: &[String], folder: &str) -> Vec<Edit> {
    let Some(begin) = BEGIN_DOCUMENT.find(source).map(|found| found.start()) else {
        return Vec::new();
    };
    let preamble = &source[..begin];
    let mut loaded: Vec<String> = Vec::new();
    let mut last_load_end: Option<usize> = None;
    let mut offset = 0;
    for line in preamble.split('\n') {
        for load in PACKAGE_LOAD.captures_iter(without_comment(line)) {
            loaded.extend(load[1].split(',').map(|name| name.trim().to_string()));
            last_load_end = Some(offset + line.len());
        }
        offset += line.len() + 1;
    }
    let missing: Vec<String> = figure_packages(packages, folder)
        .into_iter()
        .filter(|name| PACKAGE_NAME.is_match(name) && !loaded.contains(name))
        .collect();
    let mut lines: Vec<String> = missing
        .iter()
        .map(|name| format!("\\usepackage{{{name}}}"))
        .collect();
    let path = if folder.is_empty() {
        Some(PathAddition::Listed)
    } else {
        graphics_path_addition(source, begin, folder)
    };
    let mut insertions = Vec::new();
    match path {
        None => lines.push(format!("\\graphicspath{{{{{folder}}}}}")),
        Some(PathAddition::Add(edit)) => insertions.push(edit),
        Some(PathAddition::Listed) => {}
    }
    if lines.is_empty() {
        return insertions;
    }
    let text = lines.join("\n");
    let line_start = source[..begin].rfind('\n').map_or(0, |at| at + 1);
    insertions.push(match last_load_end {
        Some(end) => Edit {
            from: end,
            to: end,
            insert: format!("\n{text}"),
        },
        None => Edit {
            from: line_start,
            to: line_start,
            insert: format!("{text}\n"),
        },
    });
    insertions
}

/// Whether `position` is inside an environment that already holds a figure.
fn inside_figure_holder(source: &str, position: usize) -> bool {
    let code = blank_comments(&source[..position]);
    let mut open = 0usize;
    for edge in FIGURE_HOLDER.captures_iter(&code) {
        if &edge[1] == "begin" {
            open += 1;
        } else {
            open = open.saturating_sub(1);
        }
    }
    open > 0
}

/// Whether a figure put over `from..to` gets a float of its own: on an empty
/// line of the document's body, outside any environment holding a figure.
fn takes_figure_block(source: &str, from: usize, to: usize) -> bool {
    let line_start = source[..from].rfind('\n').map_or(0, |at| at + 1);
    let line_end = source[to..].find('\n').map_or(source.len(), |at| to + at);
    if !source[line_start..from].trim().is_empty() || !source[to..line_end].trim().is_empty() {
        return false;
    }
    match BEGIN_DOCUMENT.find(source) {
        Some(begin) => from > begin.start() && !inside_figure_holder(source, from),
        None => false,
    }
}

/// The changes that put the figure whose entry is `directory/entry`, needing
/// `packages`, over `from..to` of `source` (`editableFigureChanges`).
pub fn figure_changes(
    source: &str,
    from: usize,
    to: usize,
    directory: &str,
    entry: &str,
    packages: &[String],
) -> FigureChanges {
    let line = include(directory, entry);
    let (insert, caret) = if takes_figure_block(source, from, to) {
        // The float, the caret in its caption (the snippet's first stop).
        let head = format!("\\begin{{figure}}\n\t\\centering\n\t{line}\n\t\\caption{{");
        let caret = head.len();
        (
            format!("{head}}}\n\t\\label{{fig:}}\n\\end{{figure}}"),
            caret,
        )
    } else {
        let caret = line.len();
        (line, caret)
    };
    let folder = figure_folder(directory);
    let preamble: Vec<Edit> = missing_preamble_insertions(source, packages, &folder)
        .into_iter()
        .filter(|edit| !(edit.from > from && edit.from < to))
        .collect();
    let root = BEGIN_DOCUMENT.is_match(source);
    let unplaced = if root {
        Vec::new()
    } else {
        let mut lines: Vec<String> = figure_packages(packages, &folder)
            .iter()
            .map(|name| format!("\\usepackage{{{name}}}"))
            .collect();
        if !folder.is_empty() {
            lines.push(format!("\\graphicspath{{{{{folder}}}}}"));
        }
        lines
    };
    FigureChanges {
        preamble,
        body: Edit { from, to, insert },
        caret,
        unplaced,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `changes` applied to `source`, as the drop applies them, and the caret.
    fn applied(source: &str, changes: &FigureChanges) -> (String, usize) {
        let (edits, caret) = changes.ordered();
        let mut text = source.to_string();
        for edit in edits {
            text.replace_range(edit.from..edit.to, &edit.insert);
        }
        (text, caret)
    }

    const ROOT: &str = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nText.\n\n\\end{document}\n";

    // editable-figure.test.ts: the include names the entry from the project
    // root, without its .tex.
    #[test]
    fn the_include_names_the_entry_from_the_root() {
        assert_eq!(include("figures", "scheme.tex"), "\\input{figures/scheme}");
        assert_eq!(include("", "scheme.tex"), "\\input{scheme}");
        assert_eq!(include("figures/", "a.tex"), "\\input{figures/a}");
    }

    // On the body's empty line a root document gets the float, graphicx
    // after the last package line and \graphicspath for figures/.
    #[test]
    fn an_empty_body_line_of_a_root_gets_the_float_and_the_preamble_lines() {
        let at = ROOT.find("Text.\n\n").unwrap() + "Text.\n".len();
        let changes = figure_changes(ROOT, at, at, "figures", "plot.tex", &[]);
        assert!(
            changes.body.insert.starts_with(
                "\\begin{figure}\n\t\\centering\n\t\\input{figures/plot}\n\t\\caption{"
            )
        );
        assert_eq!(&changes.body.insert[changes.caret..changes.caret + 1], "}");
        let after_amsmath =
            ROOT.find("\\usepackage{amsmath}").unwrap() + "\\usepackage{amsmath}".len();
        assert_eq!(
            changes.preamble,
            vec![Edit {
                from: after_amsmath,
                to: after_amsmath,
                insert: "\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}".into(),
            }]
        );
        assert!(changes.unplaced.is_empty());
    }

    // Mid-line, only the include goes in; an existing \graphicspath takes the
    // folder, and a loaded package is not loaded again.
    #[test]
    fn mid_line_the_include_goes_in_and_an_existing_path_takes_the_folder() {
        let source = "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{img/}}\n\\begin{document}\nSee here.\n\\end{document}\n";
        let at = source.find("here").unwrap();
        let changes = figure_changes(source, at, at, "figures", "a.tex", &["xcolor".into()]);
        assert_eq!(changes.body.insert, "\\input{figures/a}");
        assert_eq!(changes.caret, changes.body.insert.len());
        let path_end = source.find("{{img/}}").unwrap() + "{{img/}".len();
        let after_graphicx =
            source.find("\\usepackage{graphicx}").unwrap() + "\\usepackage{graphicx}".len();
        assert_eq!(
            changes.preamble,
            vec![
                Edit {
                    from: path_end,
                    to: path_end,
                    insert: "{figures/}".into()
                },
                Edit {
                    from: after_graphicx,
                    to: after_graphicx,
                    insert: "\n\\usepackage{xcolor}".into()
                },
            ]
        );
    }

    // Inside a figure environment the include goes in alone; a chapter file
    // (no \begin{document}) says what the main preamble needs.
    #[test]
    fn a_figure_environment_and_a_chapter_file() {
        let source = "\\begin{figure}\n\n\\end{figure}\n";
        let at = source.find("\n\n").unwrap() + 1;
        let changes = figure_changes(source, at, at, "figures", "a.tex", &[]);
        assert_eq!(changes.body.insert, "\\input{figures/a}");
        assert!(changes.preamble.is_empty());
        assert_eq!(
            changes.unplaced,
            ["\\usepackage{graphicx}", "\\graphicspath{{figures/}}"]
        );
    }

    // A drop at the very start of a root document, in its preamble: the
    // include goes in at the start of line 1, the preamble's lines after
    // `\usepackage{amsmath}`, and the caret right after the include.
    #[test]
    fn a_drop_in_the_preamble_keeps_the_include_where_it_was_dropped() {
        let changes = figure_changes(ROOT, 0, 0, "figures", "x.tex", &[]);
        let (text, caret) = applied(ROOT, &changes);
        assert_eq!(
            text,
            "\\input{figures/x}\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n\\begin{document}\nText.\n\n\\end{document}\n"
        );
        assert_eq!(caret, "\\input{figures/x}".len());
    }

    // On the body's empty line the preamble's lines come before the float,
    // and the caret lands in its caption.
    #[test]
    fn a_body_drop_lands_after_the_preamble_lines() {
        let at = ROOT.find("Text.\n\n").unwrap() + "Text.\n".len();
        let changes = figure_changes(ROOT, at, at, "figures", "plot.tex", &[]);
        let (text, caret) = applied(ROOT, &changes);
        assert!(text.starts_with("\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n\\begin{document}\nText.\n\\begin{figure}\n\t\\centering\n\t\\input{figures/plot}\n\t\\caption{}"));
        assert!(text[..caret].ends_with("\\caption{"));
    }

    #[test]
    fn a_commented_path_is_not_the_preamble_s() {
        let source = "\\documentclass{article}\n% \\graphicspath{{figures/}}\n\\begin{document}\nx\n\\end{document}\n";
        let edits = missing_preamble_insertions(source, &[], "figures/");
        assert_eq!(edits.len(), 1);
        assert_eq!(
            edits[0].insert,
            "\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n"
        );
    }
}
