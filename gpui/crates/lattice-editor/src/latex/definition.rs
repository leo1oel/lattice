//! Go to definition (F12, ⌘-click) in a LaTeX source, as the Tauri app's
//! `definitionTargetAt` (`latex-symbols.ts`) finds it: a `\ref`'s or
//! `\label`'s label goes to where it is defined, a citation key to its
//! bibliography entry, an `\input` or `\include` to the file the build
//! reads, and an `\includegraphics` path to the figure. Paths are read from
//! the root document's folder, as latexmk `-cd` typesets there
//! (`findPathCandidate` in `latex-text.ts`). All offsets are bytes.

use std::sync::OnceLock;

use regex::Regex;

use super::syntax::{citation_target, reference_target};
use crate::index::Reference;

/// Where a definition is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DefinitionTarget {
    /// A label's `\label`, at its project-relative `path` and 1-based `line`.
    Reference {
        path: String,
        line: u32,
        label: String,
    },
    /// A citation key, whose bibliography entry the index knows.
    Citation { key: String },
    /// The project `.tex` file an `\input` or `\include` names.
    Include { path: String },
    /// The project file an `\includegraphics` names.
    Asset { path: String },
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid pattern"))
}

fn label_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\label\{([^}]*)\}")
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

fn graphicspath_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"\\graphicspath\s*\{((?:\{[^}]*\})+)\}")
}

/// graphicx tries the extensions it knows; the bare name, last, finds a
/// file saved without one.
const GRAPHICS_EXTENSIONS: &[&str] =
    &[".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp", ""];

/// The value `read` makes of the argument of `pattern` (its group 1) that
/// `position` is in, from its first character to just past its last.
fn argument_at(
    text: &str,
    pattern: &Regex,
    position: usize,
    read: impl Fn(&str) -> String,
) -> Option<String> {
    pattern.captures_iter(text).find_map(|found| {
        let content = found.get(1)?;
        let value = read(content.as_str());
        (!value.is_empty() && (content.start()..=content.end()).contains(&position))
            .then_some(value)
    })
}

/// A `\label`'s or `\ref`'s label under `position`.
pub fn label_at(text: &str, position: usize) -> Option<String> {
    reference_target(text, position)
        .map(|span| span.key)
        .or_else(|| {
            argument_at(text, label_pattern(), position, |raw| {
                raw.trim().to_string()
            })
        })
}

/// What `position` names, with the project's labels (`references`, the open
/// file's unsaved ones among them), its files (`project_paths`), its
/// `\graphicspath` roots (read only for a figure) and the root document
/// (`root_path`).
pub fn definition_target_at(
    text: &str,
    position: usize,
    references: &[Reference],
    project_paths: &[String],
    graphics_roots: impl FnOnce() -> Vec<String>,
    root_path: &str,
) -> Option<DefinitionTarget> {
    if let Some(label) = label_at(text, position)
        && let Some(reference) = references.iter().find(|item| item.label == label)
    {
        return Some(DefinitionTarget::Reference {
            path: reference.path.clone(),
            line: reference.line,
            label: reference.label.clone(),
        });
    }
    if let Some(citation) = citation_target(text, position) {
        return Some(DefinitionTarget::Citation { key: citation.key });
    }
    if let Some(figure) = argument_at(text, graphics_pattern(), position, unwrap_latex_path) {
        let path = resolve_project_path(
            &figure,
            project_paths,
            PathKind::Graphics,
            &graphics_roots(),
            root_path,
        )
        .unwrap_or(figure);
        return Some(DefinitionTarget::Asset { path });
    }
    let include = argument_at(text, include_pattern(), position, |raw| {
        raw.trim().to_string()
    })?;
    let file = if include.ends_with(".tex") {
        include.clone()
    } else {
        format!("{include}.tex")
    };
    let path = resolve_project_path(&include, project_paths, PathKind::Tex, &[], root_path)
        .or_else(|| normalize_project_path(&format!("{}{file}", root_folder(root_path))))
        .unwrap_or(file);
    Some(DefinitionTarget::Include { path })
}

/// The project's `\graphicspath` roots across `sources`, in order, each
/// written with `/` and without a trailing one (`parseGraphicsPaths`).
pub fn graphics_roots<'a>(sources: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for source in sources {
        for found in graphicspath_pattern().captures_iter(source) {
            for part in found[1]
                .split('{')
                .filter_map(|part| part.split('}').next())
            {
                let path = part.trim().replace('\\', "/");
                let path = path.trim_end_matches('/');
                if !path.is_empty() && !roots.iter().any(|root| root == path) {
                    roots.push(path.to_string());
                }
            }
        }
    }
    roots
}

/// An argument as a path: `\detokenize{…}` unwrapped, `\` written as `/`.
pub fn unwrap_latex_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("\\detokenize{")
        .map(|rest| rest.strip_suffix('}').unwrap_or(rest))
        .filter(|inner| !inner.contains('}'))
        .unwrap_or(trimmed);
    inner.trim().replace('\\', "/")
}

/// What the argument names: a `.tex` file or a figure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Tex,
    Graphics,
}

/// The paths an argument may name, in the order TeX tries them, each with
/// the extension it adds: as written or with the extension TeX or graphicx
/// adds, a figure under each `\graphicspath` root too (each extension
/// first, as graphicx tries it in the build folder and then in each root).
fn candidates(
    path: &str,
    kind: PathKind,
    graphics_roots: &[String],
) -> Vec<(String, &'static str)> {
    if kind == PathKind::Tex {
        return if path.ends_with(".tex") {
            vec![(path.to_string(), "")]
        } else {
            vec![(path.to_string(), ""), (format!("{path}.tex"), ".tex")]
        };
    }
    // Only the file name says whether an extension was given.
    let name = path.rsplit('/').next().unwrap_or(path);
    let extensions: &[&'static str] = if name.contains('.') {
        &[""]
    } else {
        GRAPHICS_EXTENSIONS
    };
    let prefixes: Vec<String> = std::iter::once(String::new())
        .chain(graphics_roots.iter().map(|root| format!("{root}/")))
        .collect();
    extensions
        .iter()
        .flat_map(|extension| {
            prefixes.iter().map(move |prefix| {
                let joined = format!("{prefix}{path}{extension}");
                let mut collapsed = String::with_capacity(joined.len());
                for c in joined.chars() {
                    if !(c == '/' && collapsed.ends_with('/')) {
                        collapsed.push(c);
                    }
                }
                (collapsed, *extension)
            })
        })
        .collect()
}

/// A URL resolves to itself; anything else must name a project file, read
/// from the root document's folder as TeX reads it (`resolveProjectPath`).
pub fn resolve_project_path(
    raw: &str,
    project_paths: &[String],
    kind: PathKind,
    graphics_roots: &[String],
    root_path: &str,
) -> Option<String> {
    let path = unwrap_latex_path(raw);
    if path.is_empty() {
        return None;
    }
    if path.starts_with("http:") || path.starts_with("https:") {
        return Some(path);
    }
    find_path_candidate(
        &candidates(&path, kind, graphics_roots),
        project_paths,
        None,
        root_path,
    )
    .map(|(file, _)| file)
}

/// A project file an argument names only when letter case is ignored, and
/// the argument's path respelled in that file's case
/// (`miscasedProjectPath`): macOS's disk ignores case, so the build here
/// finds the file, but TeX on Linux (Overleaf, arXiv) does not when a
/// folder's case differs. The respelling is `None` when it has no place in
/// the argument (a doubled `/` the lookup collapsed). `folded_paths` is
/// `project_paths` through [`fold_case`], folded once by the caller.
pub fn miscased_project_path(
    raw: &str,
    project_paths: &[String],
    folded_paths: &[String],
    kind: PathKind,
    graphics_roots: &[String],
    root_path: &str,
) -> Option<(String, Option<String>)> {
    let path = unwrap_latex_path(raw);
    if path.is_empty() || path.starts_with("http:") || path.starts_with("https:") {
        return None;
    }
    let (file, extension) = find_path_candidate(
        &candidates(&path, kind, graphics_roots),
        project_paths,
        Some(folded_paths),
        root_path,
    )?;
    // The file ends with the candidate, folded, and folding keeps lengths,
    // so the written path sits just before the extension the lookup added.
    let end = file.len() - extension.len();
    let respelled = end
        .checked_sub(path.len())
        .and_then(|start| file.get(start..end))
        .filter(|respelled| *respelled != path && fold_case(respelled) == fold_case(&path))
        .map(str::to_string);
    Some((file, respelled))
}

/// `path` with each character lower-cased where that keeps its length, as
/// the Tauri app's `foldCase` folds a UTF-16 unit, so offsets still line up.
pub fn fold_case(path: &str) -> String {
    path.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(l), None) if l.len_utf8() == c.len_utf8() => l,
                _ => c,
            }
        })
        .collect()
}

/// The first candidate on TeX's search path, else the first found by the
/// leniency below: a file TeX would not read never wins over one it would.
/// The file found, and the extension its candidate added. Case is ignored
/// when `folded_paths` (the folded `project_paths`) is given.
fn find_path_candidate(
    candidates: &[(String, &'static str)],
    project_paths: &[String],
    folded_paths: Option<&[String]>,
    root_path: &str,
) -> Option<(String, &'static str)> {
    let paths = ProjectPaths {
        written: project_paths,
        folded: folded_paths,
    };
    // An absolute path names a file on disk, never one in the project.
    let relative: Vec<&(String, &'static str)> = candidates
        .iter()
        .filter(|(candidate, _)| !candidate.starts_with('/'))
        .collect();
    relative
        .iter()
        .find_map(|(candidate, extension)| {
            on_tex_search_path(candidate, &paths, root_path).map(|file| (file, *extension))
        })
        .or_else(|| {
            relative.iter().find_map(|(candidate, extension)| {
                elsewhere(candidate, &paths).map(|file| (file, *extension))
            })
        })
}

/// `path` collapsed of `.` and `..`, or `None` when it leaves the project.
pub fn normalize_project_path(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// The folder holding the root document, with its trailing `/`.
pub fn root_folder(root_path: &str) -> &str {
    &root_path[..root_path.rfind('/').map_or(0, |at| at + 1)]
}

/// The project's files as written, and folded when case is ignored; a
/// lookup matches against `folded` (when given) and answers with the
/// written path at the same index.
struct ProjectPaths<'a> {
    written: &'a [String],
    folded: Option<&'a [String]>,
}

impl ProjectPaths<'_> {
    /// `path` as a lookup compares it.
    fn key(&self, path: String) -> String {
        if self.folded.is_some() {
            fold_case(&path)
        } else {
            path
        }
    }

    fn compared(&self) -> &[String] {
        self.folded.unwrap_or(self.written)
    }
}

/// `path` as the project writes it, case ignored when `paths` is folded.
fn project_file(path: Option<String>, paths: &ProjectPaths) -> Option<String> {
    let wanted = paths.key(path?);
    let at = paths.compared().iter().position(|known| *known == wanted)?;
    Some(paths.written[at].clone())
}

/// The project file a path names where TeX reads it: from the root's folder
/// first (the only place a `./` or `../` path can mean), then, for a root in
/// a subfolder, from the project's folder, as Overleaf finds it.
fn on_tex_search_path(candidate: &str, paths: &ProjectPaths, root_path: &str) -> Option<String> {
    let folder = root_folder(root_path);
    let beside = project_file(
        normalize_project_path(&format!("{folder}{candidate}")),
        paths,
    );
    if beside.is_some()
        || folder.is_empty()
        || candidate.starts_with("./")
        || candidate.starts_with("../")
    {
        return beside;
    }
    project_file(normalize_project_path(candidate), paths)
}

/// The one project file that ends with the path, for a file TeX would not
/// find; none when several do, or when a `.` or `..` pins the folder.
fn elsewhere(candidate: &str, paths: &ProjectPaths) -> Option<String> {
    let wanted = normalize_project_path(candidate)?;
    if candidate.split('/').any(|part| part == "." || part == "..") {
        return None;
    }
    let suffix = format!("/{}", paths.key(wanted));
    let mut found = paths
        .compared()
        .iter()
        .enumerate()
        .filter(|(_, path)| path.ends_with(&suffix));
    let (first, _) = found.next()?;
    found.next().is_none().then(|| paths.written[first].clone())
}

#[cfg(test)]
mod tests;
