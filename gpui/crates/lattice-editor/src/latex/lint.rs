//! The LaTeX source's own lint, as the Tauri app's editor runs it beside
//! TexLab's (`indexDiagnostics` in `latex-diagnostics.ts`, with
//! `unclosedMathDiagnostics` from `math-region.ts`): unmatched and unclosed
//! environments, unclosed math, duplicate labels and bibliography keys, an
//! `\input` or figure the project does not have (with Create file) or has
//! only in another letter case (with Fix case), and, once the project's
//! index has landed, unknown citation keys and labels, unused ones, and a
//! label another file defines too. A line whose comment starts
//! `%novalidate`, and the lines between `%begin novalidate` and
//! `%end novalidate`, are exempt. Offsets are bytes; messages are the Tauri
//! catalog's.

use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::OnceLock,
};

use lattice_i18n::t;
use regex::Regex;

use super::{
    definition::{
        PathKind, miscased_project_path, normalize_project_path, resolve_project_path, root_folder,
        unwrap_latex_path,
    },
    diagnostics::Severity,
    environments::{Delimiter, environment_events},
    folding::uncommented,
};
use crate::index::Reference;

pub mod marks;

/// What checked a finding, which its card names under the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Structure,
    Paths,
    Labels,
    Bibliography,
    Math,
}

impl Source {
    /// Its name in the interface language.
    pub fn name(self) -> String {
        match self {
            Source::Structure => t!("structure"),
            Source::Paths => t!("paths"),
            Source::Labels => t!("labels"),
            Source::Bibliography => t!("bibliography"),
            Source::Math => t!("math"),
        }
        .to_string()
    }
}

/// What a finding's card offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LintAction {
    /// Create the project file (Create file), beside the root document.
    CreateFile(String),
    /// Respell the argument's path in the file's case (Fix case): `insert`
    /// over `range`.
    FixCase { range: Range<usize>, insert: String },
}

/// One finding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lint {
    pub range: Range<usize>,
    pub severity: Severity,
    pub message: String,
    pub source: Source,
    pub action: Option<LintAction>,
}

fn warning(range: Range<usize>, source: Source, message: String) -> Lint {
    Lint {
        range,
        severity: Severity::Warning,
        message,
        source,
        action: None,
    }
}

fn error(range: Range<usize>, message: String) -> Lint {
    Lint {
        range,
        severity: Severity::Error,
        message,
        source: Source::Structure,
        action: None,
    }
}

/// What the project's index knows; empty lists where it knows nothing.
#[derive(Clone, Debug, Default)]
pub struct LintIndex {
    pub citation_keys: HashSet<String>,
    /// The project's labels, the open file's unsaved ones among them.
    pub references: Vec<Reference>,
    /// The keys and labels are not this project's yet: nothing that
    /// depends on them is reported.
    pub pending: bool,
    pub unused_labels: HashSet<String>,
    pub unused_citations: HashSet<String>,
    pub project_paths: Vec<String>,
    pub graphics_roots: Vec<String>,
    /// The root document, whose folder TeX reads paths from.
    pub root_path: String,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid pattern"))
}

const CITATION_COMMANDS: &str =
    "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const REFERENCE_COMMANDS: &str = "ref|eqref|pageref|autoref|cref|Cref";

fn citation_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(&format!(
            r"\\(?:{CITATION_COMMANDS})\*?(?:\[[^\]]*\]){{0,2}}\{{([^}}]*)\}}"
        ))
        .expect("a valid pattern")
    })
}

fn reference_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(&format!(r"\\(?:{REFERENCE_COMMANDS})\*?\{{([^}}]*)\}}"))
            .expect("a valid pattern")
    })
}

fn include_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\(?:input|include)\{([^}]*)\}")
}

fn graphics_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"\\includegraphics(?:\[[^\]]*\])?\{((?:\\detokenize\{[^}]*\}|[^}]+))\}",
    )
}

fn label_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\label\{([^}]*)\}")
}

fn bib_entry_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"@\w+\s*\{\s*([^,\s}]+)")
}

/// A key and where it is written.
struct KeySpan {
    range: Range<usize>,
    key: String,
}

/// Each `pattern` argument (group 1): where its content starts, and it.
fn arguments<'a>(text: &'a str, pattern: &Regex) -> impl Iterator<Item = (usize, &'a str)> {
    pattern.captures_iter(text).filter_map(|found| {
        let content = found.get(1)?;
        Some((content.start(), content.as_str()))
    })
}

/// The trimmed, non-empty comma-separated keys of an argument at `from`.
fn key_spans(content: &str, from: usize) -> Vec<KeySpan> {
    let mut spans = Vec::new();
    let mut at = 0;
    for part in content.split(',') {
        let lead = part.len() - part.trim_start().len();
        let key = part.trim();
        if !key.is_empty() {
            let start = from + at + lead;
            spans.push(KeySpan {
                range: start..start + key.len(),
                key: key.to_string(),
            });
        }
        at += part.len() + 1;
    }
    spans
}

fn label_spans(text: &str) -> Vec<KeySpan> {
    arguments(text, label_pattern())
        .filter_map(|(from, content)| {
            let key = content.trim();
            (!key.is_empty()).then(|| KeySpan {
                range: from..from + content.len(),
                key: key.to_string(),
            })
        })
        .collect()
}

fn bib_key_spans(text: &str) -> Vec<KeySpan> {
    bib_entry_pattern()
        .captures_iter(text)
        .filter_map(|found| {
            let key = found.get(1)?;
            Some(KeySpan {
                range: key.range(),
                key: key.as_str().to_string(),
            })
        })
        .collect()
}

/// Every repeat of a key after its first occurrence.
fn duplicates(spans: Vec<KeySpan>, source: Source, message: impl Fn(&str) -> String) -> Vec<Lint> {
    let mut seen = HashSet::new();
    spans
        .into_iter()
        .filter_map(|span| {
            (!seen.insert(span.key.clone()))
                .then(|| warning(span.range, source, message(&span.key)))
        })
        .collect()
}

/// Where TeX looks for a missing include: beside the root document.
fn missing_include_path(raw: &str, root_path: &str) -> Option<String> {
    let path = unwrap_latex_path(raw);
    if path.is_empty() || path.starts_with('/') || path.contains(':') {
        return None;
    }
    let file = if path.ends_with(".tex") {
        path
    } else {
        format!("{path}.tex")
    };
    normalize_project_path(&format!("{}{file}", root_folder(root_path)))
        .filter(|path| !path.is_empty())
}

/// An argument that names a project file only when case is ignored, with
/// Fix case respelling the path in place (a `\detokenize` wrapper and any
/// backslashes kept).
fn case_lint(from: usize, content: &str, file: &str, respelled: Option<String>) -> Lint {
    let path = unwrap_latex_path(content);
    // `unwrap_latex_path` writes `\` as `/`; so does this, keeping offsets.
    let offset = content.replace('\\', "/").rfind(&path);
    let message = t!(
        "“{path}” differs in case from {file} on disk. Overleaf and arXiv can fail to find it.",
        path = &path,
        file = file
    )
    .to_string();
    let mut lint = warning(from..from + content.len(), Source::Paths, message);
    if let (Some(respelled), Some(offset)) = (respelled, offset) {
        let at = from + offset;
        let written = &content[offset..offset + path.len()];
        // The respelling, with each `\` the argument wrote kept.
        let insert: String = written
            .chars()
            .zip(respelled.chars())
            .map(|(written, respelled)| if written == '\\' { '\\' } else { respelled })
            .collect();
        lint.action = Some(LintAction::FixCase {
            range: at..at + path.len(),
            insert,
        });
    }
    lint
}

/// Missing `\input`s and figures, and those that differ only in case.
pub fn path_lint(text: &str, index: &LintIndex) -> Vec<Lint> {
    let paths = &index.project_paths;
    if paths.is_empty() {
        return Vec::new();
    }
    let root = index.root_path.as_str();
    let mut lints = Vec::new();
    for (from, content) in arguments(text, include_pattern()) {
        let path = content.trim();
        if path.is_empty() || resolve_project_path(path, paths, PathKind::Tex, &[], root).is_some()
        {
            continue;
        }
        if let Some((file, respelled)) =
            miscased_project_path(path, paths, PathKind::Tex, &[], root)
        {
            lints.push(case_lint(from, content, &file, respelled));
            continue;
        }
        let mut lint = warning(
            from..from + content.len(),
            Source::Paths,
            t!("Missing file “{path}”.", path = path).to_string(),
        );
        lint.action = missing_include_path(path, root).map(LintAction::CreateFile);
        lints.push(lint);
    }
    let roots = &index.graphics_roots;
    for (from, content) in arguments(text, graphics_pattern()) {
        let raw = content.trim();
        if raw.is_empty()
            || resolve_project_path(raw, paths, PathKind::Graphics, roots, root).is_some()
        {
            continue;
        }
        if let Some((file, respelled)) =
            miscased_project_path(raw, paths, PathKind::Graphics, roots, root)
        {
            lints.push(case_lint(from, content, &file, respelled));
            continue;
        }
        let figure = unwrap_latex_path(raw);
        let figure = if figure.is_empty() {
            raw.to_string()
        } else {
            figure
        };
        lints.push(warning(
            from..from + content.len(),
            Source::Paths,
            t!("Missing figure “{figure}”.", figure = figure).to_string(),
        ));
    }
    lints
}

/// `text` with every `%` comment blanked to spaces, every offset kept, as
/// folding and auto-close read comments.
fn strip_line_comments(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let kept = uncommented(line);
            format!("{kept}{}", " ".repeat(line.len() - kept.len()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn novalidate_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"^%\s*(?:(begin|end)\s+)?novalidate([^A-Za-z]|$)")
}

/// `text` with what the writer exempted blanked, every offset kept: a line
/// whose comment starts `%novalidate`, and every line from
/// `%begin novalidate` through `%end novalidate` (or the end).
fn without_novalidate(text: &str) -> String {
    if !text.contains("novalidate") {
        return text.to_string();
    }
    let mut exempt = false;
    text.split('\n')
        .map(|line| {
            let comment = &line[uncommented(line).len()..];
            let marker = novalidate_pattern().captures(comment);
            let kind = marker
                .as_ref()
                .and_then(|found| found.get(1))
                .map(|kind| kind.as_str());
            if kind == Some("begin") {
                exempt = true;
            }
            let blank = exempt || (marker.is_some() && kind.is_none());
            if kind == Some("end") {
                exempt = false;
            }
            if blank {
                " ".repeat(line.len())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Unclosed `$`, `$$`, `\(` and `\[` (math environments are the structure
/// check's).
fn unclosed_math(text: &str) -> Vec<Lint> {
    let delimiters: [(&str, &str, bool); 4] = [
        ("$$", "$$", true),
        ("\\[", "\\]", true),
        ("\\(", "\\)", false),
        ("$", "$", false),
    ];
    let mut lints = Vec::new();
    for (open, close, display) in delimiters {
        let mut start = text.find(open);
        while let Some(at) = start {
            // A single `$` inside `$$` is not one.
            if open == "$" && text[at..].starts_with("$$") {
                start = text[at + 2..].find(open).map(|next| at + 2 + next);
                continue;
            }
            let Some(end) = text[at + open.len()..]
                .find(close)
                .map(|end| at + open.len() + end)
            else {
                let message = if display {
                    t!("Unclosed display math {open}.", open = open)
                } else {
                    t!("Unclosed inline math {open}.", open = open)
                };
                lints.push(Lint {
                    range: at..at + open.len(),
                    severity: Severity::Error,
                    message: message.to_string(),
                    source: Source::Math,
                    action: None,
                });
                break;
            };
            let after = end + close.len();
            start = text[after..].find(open).map(|next| after + next);
        }
    }
    lints
}

/// What the file says about itself: environments, duplicate labels and
/// bibliography keys, and unclosed math.
pub fn structure_lint(text: &str) -> Vec<Lint> {
    let source = strip_line_comments(text);
    let mut lints = Vec::new();
    let mut stack = Vec::new();
    for event in environment_events(&source) {
        if event.kind == Delimiter::Begin {
            stack.push(event);
            continue;
        }
        let found = format!("\\end{{{}}}", event.name);
        match stack.pop() {
            None => lints.push(error(
                event.range,
                t!("Unmatched {found}.", found = &found).to_string(),
            )),
            Some(open) if open.name != event.name => {
                let expected = format!("\\end{{{}}}", open.name);
                lints.push(error(
                    event.range,
                    t!(
                        "Expected {expected}, found {found}.",
                        expected = &expected,
                        found = &found
                    )
                    .to_string(),
                ));
            }
            Some(_) => {}
        }
    }
    for open in stack {
        let command = format!("\\begin{{{}}}", open.name);
        lints.push(error(
            open.range,
            t!("Unclosed {command}.", command = &command).to_string(),
        ));
    }
    lints.extend(duplicates(label_spans(&source), Source::Labels, |key| {
        t!("Duplicate label “{key}”.", key = key).to_string()
    }));
    lints.extend(duplicates(
        bib_key_spans(&source),
        Source::Bibliography,
        |key| t!("Duplicate bibliography key “{key}”.", key = key).to_string(),
    ));
    lints.extend(unclosed_math(&source));
    lints
}

/// Every finding for the file at `current_path` (project-relative).
pub fn index_lint(source: &str, index: &LintIndex, current_path: &str) -> Vec<Lint> {
    let text = without_novalidate(source);
    let mut lints = structure_lint(&text);
    lints.extend(path_lint(&text, index));
    if index.pending {
        return lints;
    }
    let labels: HashSet<&str> = index
        .references
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    let mut label_paths: HashMap<&str, Vec<&str>> = HashMap::new();
    for reference in &index.references {
        let paths = label_paths.entry(reference.label.as_str()).or_default();
        if !paths.contains(&reference.path.as_str()) {
            paths.push(reference.path.as_str());
        }
    }
    let unknown = |pattern: &Regex,
                   known: &dyn Fn(&str) -> bool,
                   source: Source,
                   message: &dyn Fn(&str) -> String| {
        arguments(&text, pattern)
            .flat_map(|(from, content)| key_spans(content, from))
            .filter(|span| !known(&span.key))
            .map(|span| warning(span.range, source, message(&span.key)))
            .collect::<Vec<_>>()
    };
    lints.extend(unknown(
        citation_pattern(),
        &|key| index.citation_keys.contains(key),
        Source::Bibliography,
        &|key| t!("Unknown citation key “{key}”.", key = key).to_string(),
    ));
    lints.extend(unknown(
        reference_pattern(),
        &|key| labels.contains(key),
        Source::Labels,
        &|key| t!("Unknown label “{key}”.", key = key).to_string(),
    ));
    for span in label_spans(&text) {
        let others: Vec<&str> = if current_path.is_empty() {
            Vec::new()
        } else {
            label_paths
                .get(span.key.as_str())
                .map(|paths| {
                    paths
                        .iter()
                        .copied()
                        .filter(|path| *path != current_path)
                        .collect()
                })
                .unwrap_or_default()
        };
        let message = match others.as_slice() {
            [] if index.unused_labels.contains(&span.key) => {
                Some(t!("Unused label “{key}”.", key = &span.key).to_string())
            }
            [] => None,
            [path] => Some(
                t!(
                    "Duplicate label “{key}” also defined in {path}.",
                    key = &span.key,
                    path = path
                )
                .to_string(),
            ),
            [path, rest @ ..] => Some(
                t!(
                    "Duplicate label “{key}” also defined in {path} (+{more} more).",
                    key = &span.key,
                    path = path,
                    more = rest.len()
                )
                .to_string(),
            ),
        };
        if let Some(message) = message {
            lints.push(warning(span.range, Source::Labels, message));
        }
    }
    lints.extend(
        bib_key_spans(&text)
            .into_iter()
            .filter(|span| index.unused_citations.contains(&span.key))
            .map(|span| {
                warning(
                    span.range,
                    Source::Bibliography,
                    t!("Unused citation key “{key}”.", key = &span.key).to_string(),
                )
            }),
    );
    lints
}

#[cfg(test)]
mod tests;
