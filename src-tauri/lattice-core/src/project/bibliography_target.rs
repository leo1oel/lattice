//! Which `.bib` file a new reference goes to: the one the document compiles
//! against, read from its `\bibliography{…}` / `\addbibresource{…}`.
//!
//! The manifest's `primary_bibliography` used to be the only answer, and it
//! was guessed once, when Lattice first adopted the folder, as the first
//! `.bib` a directory walk met. An Overleaf download writes its sync base
//! (`.research/overleaf-base/main.bib`) before the folder is first opened,
//! so the walk could step into `.research` and record the base snapshot as
//! the bibliography: every cite then landed in a file no build reads, and a
//! sync could overwrite it. The document says which file it uses, so that is
//! asked first, every time something is written, and the manifest follows.
//! A file under a hidden folder (`.research/`, `.git/`) is never a target.

use super::manifest::{default_root_document, read_manifest, write_manifest};
use super::paths::{safe_path, stays_inside};
use crate::latex::strip_comment;
use crate::models::ProjectManifest;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path};
use std::sync::OnceLock;
use walkdir::WalkDir;

/// The fallback when nothing names a bibliography: what a new project gets.
const DEFAULT_BIBLIOGRAPHY: &str = "references.bib";

/// How many `\input` / `\include` files are followed from the root document.
const MAX_SOURCES: usize = 64;

/// Where a write to the bibliography goes, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyTarget {
    /// The `.bib` file, relative to the project root.
    pub path: String,
    /// Every bibliography the root document uses, in the order it names them.
    pub used: Vec<String>,
    /// The root document they were read from, when one names any.
    pub document: Option<String>,
}

impl BibliographyTarget {
    /// For the Agent, when the choice was not the only one: which files the
    /// document uses and which one received the entry.
    pub fn note(&self) -> Option<String> {
        let document = self.document.as_deref()?;
        (self.used.len() > 1).then(|| {
            format!(
                "{document} uses {} bibliographies ({}); new entries go to {}{}.",
                self.used.len(),
                self.used.join(", "),
                self.path,
                if self.used.first() == Some(&self.path) {
                    ", the first it names"
                } else {
                    ", the project's primary bibliography"
                },
            )
        })
    }
}

/// Whether `relative` lies under a hidden folder (`.research/`, `.git/`, …)
/// or is itself hidden: Lattice's own state, never the writer's bibliography.
pub(crate) fn is_internal_path(relative: &str) -> bool {
    Path::new(relative).components().any(|part| match part {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// The bibliography a write should go to, recording it as the manifest's
/// primary bibliography when that named another file, so the interface and
/// every later read agree with where the entry went.
pub fn citation_bibliography(root: &Path) -> Result<BibliographyTarget, String> {
    let mut manifest = read_manifest(root)?;
    let target = resolve_target(root, &manifest.primary_bibliography, document_of(&manifest));
    if target.path != manifest.primary_bibliography {
        manifest.primary_bibliography = target.path.clone();
        write_manifest(root, &manifest)?;
    }
    Ok(target)
}

/// Point the primary bibliography at the file the root document uses, and
/// off an internal one an earlier version recorded (`.research/overleaf-base/`
/// in a downloaded Overleaf project). Returns whether it changed.
pub(super) fn follow_document_bibliography(root: &Path, manifest: &mut ProjectManifest) -> bool {
    let target = resolve_target(root, &manifest.primary_bibliography, document_of(manifest));
    let changed = target.path != manifest.primary_bibliography;
    manifest.primary_bibliography = target.path;
    changed
}

fn document_of(manifest: &ProjectManifest) -> Option<&str> {
    default_root_document(manifest).map(|document| document.path.as_str())
}

/// The choice itself, without writing: the bibliography `primary` names when
/// the document uses it (several may be in use, and the writer may have
/// picked one), else the first the document names that exists, else the
/// first it names. A document that names none keeps `primary` while it is
/// there, or while no other `.bib` is: a primary that is internal, names a
/// TeX macro (`cvpr/\paperbib.bib`, which an earlier version recorded from
/// `\bibliography{\paperbib}`), or is gone while another `.bib` exists
/// gives way to the shallowest `.bib` outside hidden folders, else
/// `references.bib`.
pub(crate) fn resolve_target(
    root: &Path, primary: &str, document: Option<&str>,
) -> BibliographyTarget {
    let used = document.map(|document| document_bibliographies(root, document)).unwrap_or_default();
    let exists = |relative: &str| safe_path(root, relative).is_ok_and(|path| path.is_file());
    let path = if used.is_empty() {
        let usable = !primary.is_empty() && !is_internal_path(primary) && !primary.contains('\\');
        if usable && exists(primary) {
            primary.to_string()
        } else {
            first_visible_bibliography(root)
                .or_else(|| usable.then(|| primary.to_string()))
                .unwrap_or_else(|| DEFAULT_BIBLIOGRAPHY.to_string())
        }
    } else if used.iter().any(|path| path == primary) {
        primary.to_string()
    } else {
        used.iter().find(|path| exists(path)).unwrap_or(&used[0]).clone()
    };
    let document = (!used.is_empty()).then(|| document.unwrap_or_default().to_string());
    BibliographyTarget { path, used, document }
}

/// The shallowest `.bib` outside hidden folders, in name order among those
/// as deep, so a project's own `references.bib` wins over a template's
/// `author-kit/main.bib` and the pick does not depend on the order the file
/// system lists a directory in.
pub(crate) fn first_visible_bibliography(root: &Path) -> Option<String> {
    WalkDir::new(root)
        .max_depth(3)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "bib"))
        .min_by_key(|entry| entry.depth())
        .and_then(|entry| {
            let relative = entry.path().strip_prefix(root).ok()?;
            Some(relative.to_string_lossy().replace('\\', "/"))
        })
}

/// `\bibliography{a,b}` and `\addbibresource[…]{c.bib}` (and biblatex's
/// `\addglobalbib` / `\addsectionbib`), and `\input` / `\include` to follow.
fn commands() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\\(bibliography|addbibresource|addglobalbib|addsectionbib|input|include|subfile)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}",
        )
        .expect("bibliography command regex")
    })
}

/// The `.bib` files `document` (relative to the project root) uses, in the
/// order it names them, following its `\input` and `\include` files. Each
/// name resolves as BibTeX would, against the root document's folder, and
/// then against the project root (where Overleaf compiles); a name found in
/// neither resolves against the document's folder, the file a write would
/// create. Names outside the project or under hidden folders are dropped.
pub(crate) fn document_bibliographies(root: &Path, document: &str) -> Vec<String> {
    let base = Path::new(document).parent().unwrap_or(Path::new("")).to_path_buf();
    let mut found = Vec::new();
    let mut queue = vec![document.to_string()];
    let mut visited = BTreeSet::new();
    let mut macros: HashMap<String, Vec<String>> = HashMap::new();
    while let Some(source) = queue.pop() {
        if visited.len() >= MAX_SOURCES || !visited.insert(source.clone()) {
            continue;
        }
        let Ok(path) = safe_path(root, &source) else { continue };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        for line in text.lines().map(strip_comment) {
            for capture in definitions().captures_iter(line) {
                macros
                    .entry(capture[1].to_string())
                    .or_default()
                    .push(capture[2].trim().to_string());
            }
        }
        let mut inputs = Vec::new();
        for line in text.lines().map(strip_comment) {
            for capture in commands().captures_iter(line) {
                let (command, argument) = (&capture[1], capture[2].trim());
                match command {
                    "input" | "include" | "subfile" => {
                        let name = with_extension(argument, "tex");
                        if let Some(relative) = resolve(root, &base, &name) {
                            inputs.push(relative);
                        }
                    }
                    "bibliography" => {
                        for name in
                            argument.split(',').map(str::trim).filter(|name| !name.is_empty())
                        {
                            found.extend(resolve_named(root, &base, name, &macros, true));
                        }
                    }
                    _ => found.extend(resolve_named(root, &base, argument, &macros, false)),
                }
            }
        }
        // Depth first, in the order the document names them.
        queue.extend(inputs.into_iter().rev());
    }
    let mut seen = BTreeSet::new();
    found.retain(|path| {
        !is_internal_path(path) && path.ends_with(".bib") && seen.insert(path.clone())
    });
    found
}

/// A name a bibliography command gives, resolved as [`resolve`] does. A TeX
/// macro (`\bibliography{\paperbib}`, set by `\def\paperbib{references}`
/// or `../references` depending on where it compiles) stands for the
/// values the sources define it as: the first that exists, else the first.
/// A macro with no plain definition names no file Lattice can know.
fn resolve_named(
    root: &Path, base: &Path, name: &str, macros: &HashMap<String, Vec<String>>, bib: bool,
) -> Option<String> {
    let file = |name: &str| if bib { with_extension(name, "bib") } else { name.to_string() };
    let Some(macro_name) = name.strip_prefix('\\') else {
        return (!name.contains('\\')).then(|| resolve(root, base, &file(name))).flatten();
    };
    let candidates: Vec<String> = macros
        .get(macro_name)?
        .iter()
        .filter(|value| !value.is_empty() && !value.contains('\\'))
        .filter_map(|value| resolve(root, base, &file(value)))
        .collect();
    let exists = |relative: &&String| safe_path(root, relative).is_ok_and(|path| path.is_file());
    candidates.iter().find(exists).or(candidates.first()).cloned()
}

/// `\def\name{value}` and `\newcommand{\name}{value}` (and its re- and
/// provide- forms) with a plain value: what a macro in a bibliography
/// command may stand for.
fn definitions() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\\(?:def|(?:re)?newcommand\*?|providecommand\*?)\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\{([^{}\\]*)\}",
        )
        .expect("macro definition regex")
    })
}

fn with_extension(name: &str, extension: &str) -> String {
    if Path::new(name).extension().is_some_and(|ext| ext == extension) {
        name.to_string()
    } else {
        format!("{name}.{extension}")
    }
}

/// `name` relative to the project root: beside the root document if it is
/// there, else at the project root if it is there, else beside the document.
fn resolve(root: &Path, base: &Path, name: &str) -> Option<String> {
    let name = name.trim().trim_start_matches("./");
    if name.is_empty() || Path::new(name).is_absolute() {
        return None;
    }
    let candidates = [normalize(&base.join(name)), normalize(Path::new(name))];
    let existing = candidates
        .iter()
        .flatten()
        .find(|relative| safe_path(root, relative).is_ok_and(|path| path.is_file()));
    existing.or(candidates[0].as_ref()).cloned()
}

/// A relative path with `..` folded in, or `None` once it leaves the project.
fn normalize(path: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    let joined = parts.join("/");
    stays_inside(Path::new(&joined)).then_some(joined)
}

#[cfg(test)]
mod tests;
