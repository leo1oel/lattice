//! A build's diagnostics, read the way the Tauri app reads them
//! (`src/build/compile-diagnostics.ts`, ported line by line): severity,
//! the file each one names and how it is shown and grouped, the order the
//! panel lists them in, the identity a dismissal remembers, the counts the
//! Build button and the panel's headline give, where a failed build's log
//! opens, and the token a suggestion replaces on its line.

use std::{cmp::Ordering, ops::Range, sync::LazyLock};

use lattice_core::models::Diagnostic;
use lattice_i18n::t;
use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// How severe `level` is: `fatal` is an error, `warn` a warning, anything
/// else a note.
pub fn severity(level: &str) -> Severity {
    match level.trim().to_lowercase().as_str() {
        "error" | "fatal" => Severity::Error,
        "warning" | "warn" => Severity::Warning,
        _ => Severity::Info,
    }
}

static MISSING_TEX_DEPENDENCY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^Missing LaTeX (?:package|dependency) `([^`]+\.(?:sty|cls|bst|bbx|cbx))`\.")
        .expect("valid pattern")
});

/// A TeX file the local distribution can try to resolve through `tlmgr`.
pub fn missing_tex_dependency_file(message: &str) -> Option<String> {
    MISSING_TEX_DEPENDENCY
        .captures(message.trim())
        .map(|found| found[1].to_string())
}

/// The file a missing-package install is for: the one Lattice's advice
/// names (ctex for CJK text), else the one its message names.
pub fn install_target(diagnostic: &Diagnostic) -> Option<String> {
    diagnostic
        .params
        .get("missingFile")
        .cloned()
        .or_else(|| missing_tex_dependency_file(&diagnostic.message))
}

/// `file` with forward slashes and no `.` or empty segments: `./a//./b.tex`
/// is `a/b.tex`.
fn clean_path(file: Option<&str>) -> Option<String> {
    let file = file.filter(|file| !file.is_empty())?;
    let slashed = file.replace('\\', "/");
    let cleaned = slashed
        .split('/')
        .enumerate()
        .filter(|(index, part)| *part != "." && (!part.is_empty() || *index == 0))
        .map(|(_, part)| part)
        .collect::<Vec<_>>()
        .join("/");
    (!cleaned.is_empty()).then_some(cleaned)
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/')
}

/// The name a diagnostic's file is shown and grouped under. The build names
/// a project file by its exact path from the project root
/// (diagnostic_paths.rs), shown whole: `arxiv/` and `paper/` copies of
/// `sections/intro.tex` are two files. Only a path TeX gave in full,
/// outside the project or not, is cut to its last project-like folder, else
/// its name.
pub fn normalize_path(file: Option<&str>) -> Option<String> {
    let cleaned = clean_path(file)?;
    if !is_absolute(&cleaned) {
        return Some(cleaned);
    }
    let lower = cleaned.to_ascii_lowercase();
    for marker in ["/src/", "/chapters/", "/sections/", "/figures/"] {
        if let Some(index) = lower.rfind(marker) {
            return Some(cleaned[index + 1..].to_string());
        }
    }
    cleaned
        .split('/')
        .rfind(|part| !part.is_empty())
        .map(str::to_string)
        .or(Some(cleaned))
}

/// The project file a diagnostic names: the one at its exact path. Failing
/// that, a full path TeX gave that ends with a project file's path, or a
/// shorter one a project file's path ends with, picks that file, but only
/// when exactly one file fits; with several, guessing opened the wrong copy.
/// A suffix counts at a folder boundary only: `intro.tex` is not
/// `preintro.tex`.
pub fn resolve_path(
    diagnostic_file: Option<&str>,
    project_files: &[String],
    fallback: &str,
) -> String {
    let Some(path) = clean_path(diagnostic_file) else {
        return fallback.to_string();
    };
    if let Some(exact) = project_files
        .iter()
        .find(|file| clean_path(Some(file)).as_deref() == Some(path.as_str()))
    {
        return exact.clone();
    }
    let absolute = is_absolute(&path);
    let candidates: Vec<&String> = project_files
        .iter()
        .filter(|file| {
            clean_path(Some(file)).is_some_and(|cleaned| {
                if absolute {
                    path.ends_with(&format!("/{cleaned}"))
                } else {
                    cleaned.ends_with(&format!("/{path}"))
                }
            })
        })
        .collect();
    match candidates.as_slice() {
        [only] => (*only).clone(),
        _ => normalize_path(Some(&path)).unwrap_or(path),
    }
}

/// Two file names in the order a person reads them, as `localeCompare`
/// puts them: letters before their case, then the exact text.
fn compare_files(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

/// Errors, then warnings, then notes; within each, by file, then by line
/// (one with no line last). Stable, as JavaScript's sort is.
pub fn sort(diagnostics: &[Diagnostic]) -> Vec<Diagnostic> {
    let mut sorted = diagnostics.to_vec();
    sorted.sort_by(|left, right| {
        severity(&left.level)
            .cmp(&severity(&right.level))
            .then_with(|| {
                compare_files(
                    &normalize_path(left.file.as_deref()).unwrap_or_default(),
                    &normalize_path(right.file.as_deref()).unwrap_or_default(),
                )
            })
            .then_with(|| {
                left.line
                    .unwrap_or(u32::MAX)
                    .cmp(&right.line.unwrap_or(u32::MAX))
            })
    });
    sorted
}

pub struct FileGroup<'a> {
    /// The file as shown; `None` for what names none ("Build log").
    pub file: Option<String>,
    pub diagnostics: Vec<&'a Diagnostic>,
}

/// Sorted diagnostics gathered under their file, so twenty warnings from
/// one chapter read as one place to visit. Groups and their messages keep
/// the sorted order, so a file with an error still comes first and leads
/// with it.
pub fn group_by_file(sorted: &[Diagnostic]) -> Vec<FileGroup<'_>> {
    let mut groups: Vec<FileGroup<'_>> = Vec::new();
    for diagnostic in sorted {
        let file = normalize_path(diagnostic.file.as_deref());
        match groups.iter_mut().find(|group| group.file == file) {
            Some(group) => group.diagnostics.push(diagnostic),
            None => groups.push(FileGroup {
                file,
                diagnostics: vec![diagnostic],
            }),
        }
    }
    groups
}

/// Identity of a set of diagnostics, for "has this changed since you
/// dismissed it?": autosave rebuilds on every pause in typing, and a warning
/// the writer dismissed must stay dismissed across those rebuilds. Order is
/// not identity: latexmk can emit the same set in a different sequence
/// between passes.
pub fn fingerprint(diagnostics: &[Diagnostic]) -> String {
    sort(diagnostics)
        .iter()
        .map(|diagnostic| {
            [
                diagnostic.level.clone(),
                normalize_path(diagnostic.file.as_deref()).unwrap_or_default(),
                diagnostic
                    .line
                    .map(|line| line.to_string())
                    .unwrap_or_default(),
                diagnostic.message.clone(),
            ]
            .join("\u{0}")
        })
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// How many diagnostics a build reported at each severity. `capped`: the
/// build listed only its first located diagnostics (build_log.rs), so these
/// are lower bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub error: usize,
    pub warning: usize,
    pub info: usize,
    pub capped: bool,
}

pub fn summarize(diagnostics: &[Diagnostic]) -> Counts {
    let mut counts = Counts::default();
    for diagnostic in diagnostics {
        // The cap's own note is about the list, not one more thing the build found.
        if diagnostic.code == Some("diagnostics-capped") {
            counts.capped = true;
            continue;
        }
        match severity(&diagnostic.level) {
            Severity::Error => counts.error += 1,
            Severity::Warning => counts.warning += 1,
            Severity::Info => counts.info += 1,
        }
    }
    counts
}

/// `file:line`, the file alone, `line N`, or "Build log".
pub fn location_label(diagnostic: &Diagnostic) -> String {
    match (normalize_path(diagnostic.file.as_deref()), diagnostic.line) {
        (Some(file), Some(line)) if line > 0 => format!("{file}:{line}"),
        (Some(file), _) => file,
        (None, Some(line)) if line > 0 => t!("line {line}", line = line),
        _ => t!("Build log").to_string(),
    }
}

static TEX_ERROR_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(?:! |[^\s:][^:\n]*:\d+: )").expect("valid pattern"));
static PACKAGE_ERROR_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^.*\b(?:LaTeX|Package \S+) Error\b").expect("valid pattern"));

/// Where a failed build's log should open: TeX's first error, else the
/// first LaTeX or package error, else the end, where latexmk says why it
/// stopped. Builds run with -file-line-error, so most errors read
/// `./main.tex:4: …`; one raised before TeX knows its line (a missing
/// package) keeps `! …`. A byte offset into `log`.
pub fn failed_log_anchor(log: &str) -> usize {
    TEX_ERROR_LINE
        .find(log)
        .or_else(|| PACKAGE_ERROR_LINE.find(log))
        .map_or(log.len(), |found| found.start())
}

fn is_command(token: &str) -> bool {
    token.len() > 1
        && token.starts_with('\\')
        && token[1..]
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '@')
}

/// Where `token` stands on `text`, as a byte offset; a command only where
/// it ends (`\cite` is not the start of `\citep`).
pub fn token_offset(text: &str, token: &str) -> Option<usize> {
    let mut at = text.find(token)?;
    if !is_command(token) {
        return Some(at);
    }
    loop {
        let continues = text[at + token.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '@');
        if !continues {
            return Some(at);
        }
        at += 1 + text[at + 1..].find(token)?;
    }
}

/// The replacement a suggestion makes on `line` of `text`: the byte range
/// `token` stands at, or `None` when the token is no longer there.
pub fn replace_token_on_line(text: &str, line: u32, token: &str) -> Option<Range<usize>> {
    let index = usize::try_from(line).ok()?.checked_sub(1)?;
    let mut offset = 0;
    for (number, content) in text.split('\n').enumerate() {
        if number == index {
            let at = token_offset(content, token)?;
            return Some(offset + at..offset + at + token.len());
        }
        offset += content.len() + 1;
    }
    None
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
pub(crate) mod tests;
