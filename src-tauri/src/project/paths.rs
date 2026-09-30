//! Path guards shared by every project file operation, plus the small
//! name/extension helpers built on them and the table of text source kinds.

use super::err;
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

const OUTSIDE_PROJECT: &str = "The requested path is outside the project.";

/// Resolve `relative` beneath `root`, refusing traversal, absolute paths, and
/// symbolic links on any component.
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_project_path(root, relative, false)
}

/// [`safe_path`] for a file about to be written: missing parent folders are created.
pub(crate) fn creation_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_project_path(root, relative, true)
}

/// Non-empty, relative, and made only of plain names (and `.`).
pub(crate) fn stays_inside(relative: &Path) -> bool {
    !relative.as_os_str().is_empty()
        && !relative.is_absolute()
        && relative
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn resolve_project_path(
    root: &Path, relative: &str, create_parents: bool,
) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if !stays_inside(relative_path) {
        return Err(OUTSIDE_PROJECT.to_string());
    }
    let mut cursor = root.canonicalize().map_err(err)?;
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            continue;
        };
        cursor.push(name);
        let is_parent = index + 1 < components.len();
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Symbolic links cannot be used for project file operations.".to_string())
            }
            Ok(metadata) if is_parent && !metadata.is_dir() => {
                return Err("A project path component is not a folder.".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound && !is_parent => {}
            Err(error) if error.kind() == ErrorKind::NotFound && create_parents => {
                fs::create_dir(&cursor).map_err(err)?
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(cursor)
}

/// User-facing file operations never reach into `.research`.
pub(super) fn validate_user_entry(relative: &str) -> Result<(), String> {
    let trimmed = relative.trim();
    let first = Path::new(trimmed).components().next();
    if trimmed.is_empty() || matches!(first, Some(Component::Normal(value)) if value == ".research")
    {
        return Err("Choose a project-relative path outside .research.".to_string());
    }
    Ok(())
}

/// A single visible name: one path component, no leading dot.
pub(super) fn validate_entry_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    let mut components = Path::new(trimmed).components();
    let simple_name =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !simple_name || trimmed.starts_with('.') {
        return Err("Choose a simple name without folders or a leading dot.".to_string());
    }
    Ok(trimmed)
}

/// Transactions may write anywhere in the project except their own history.
pub(super) fn validate_transaction_path(relative: &str) -> Result<(), String> {
    if relative.starts_with(".research/history/") {
        return Err("History records cannot edit themselves.".to_string());
    }
    if !stays_inside(Path::new(relative)) {
        return Err(OUTSIDE_PROJECT.to_string());
    }
    Ok(())
}

/// A name that stays one path segment: non-empty, no separators, not `.`/`..`.
pub(super) fn is_plain_segment(name: &str) -> bool {
    !(name.is_empty() || name.contains(['/', '\\']) || name == "." || name == "..")
}

/// Lowercased extension — the key of every extension table in the project area.
pub(super) fn extension(path: impl AsRef<Path>) -> Option<String> {
    path.as_ref().extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase)
}

/// The text sources Lattice imports, as `(extension, mime the agent composer
/// attaches it as, what a new file starts with, whether search reads it)`. A
/// `None` mime is never attached and a `None` seed is never created. Keep in
/// sync with PROJECT_SOURCE_EXTENSIONS in src/app-utils.ts, which decides what
/// the frontend offers to the source import path.
const SOURCE_KINDS: &[(&str, Option<&str>, Option<&str>, bool)] = &[
    ("tex", Some("text/x-tex"), Some("% New LaTeX file\n"), true),
    ("bib", Some("text/plain"), Some("% Bibliography\n"), true),
    ("md", Some("text/markdown"), Some("# Notes\n"), true),
    ("txt", Some("text/plain"), Some(""), true),
    ("html", Some("text/html"), Some(""), true),
    ("sty", Some("text/x-tex"), Some("% Package\n"), true),
    ("cls", Some("text/x-tex"), Some("% Package\n"), true),
    ("bst", Some("text/plain"), None, false),
    ("tldr", None, Some(""), false),
    ("lattice-sheet", None, Some(""), false),
    ("tsx", Some("text/javascript"), Some(""), true),
    ("ts", Some("text/javascript"), Some(""), true),
    ("jsx", Some("text/javascript"), Some(""), true),
    ("js", Some("text/javascript"), Some(""), true),
];

/// A [`SOURCE_KINDS`] row, found by `path`'s extension.
pub(super) struct SourceKind {
    pub mime: Option<&'static str>,
    pub seed: Option<&'static str>,
    pub searchable: bool,
}

pub(super) fn source_kind(path: impl AsRef<Path>) -> Option<SourceKind> {
    let extension = extension(path)?;
    let (_, mime, seed, searchable) = SOURCE_KINDS.iter().find(|row| row.0 == extension)?;
    Some(SourceKind { mime: *mime, seed: *seed, searchable: *searchable })
}

/// `path` below `base`, forward-slashed as the frontend addresses files.
pub(super) fn relative_to(base: &Path, path: &Path) -> Result<String, String> {
    Ok(path.strip_prefix(base).map_err(err)?.to_string_lossy().replace('\\', "/"))
}

/// The UTF-8 file name of a dropped or imported path; `what` names it when it has none.
pub(super) fn file_name<'a>(path: &'a Path, what: &str) -> Result<&'a str, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{what} has an invalid file name."))
}

/// The label error messages use for a dropped or selected path.
pub(super) fn display_name(path: &Path) -> &str {
    path.file_name().and_then(|name| name.to_str()).unwrap_or("That item")
}

/// First of `name`, `name-2`, `name-3`, … in `directory` that neither exists
/// nor is `reserved`. Files keep their extension last (`plot-2.png`); folders
/// take the suffix whole (`dataset.v1-2`).
pub(super) fn available_path(
    directory: &Path, name: &str, keep_extension: bool, reserved: &BTreeSet<PathBuf>,
) -> PathBuf {
    let path = Path::new(name);
    let (stem, suffix) = match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if keep_extension => (
            path.file_stem().and_then(|value| value.to_str()).unwrap_or("figure"),
            format!(".{extension}"),
        ),
        _ => (name, String::new()),
    };
    std::iter::once(directory.join(name))
        .chain((2..).map(|number| directory.join(format!("{stem}-{number}{suffix}"))))
        .find(|candidate| !candidate.exists() && !reserved.contains(candidate))
        .expect("an unbounded suffix search always finds a free name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn rejects_parent_traversal() {
        let fixture = Fixture::empty("safe-path");
        let root = &fixture.root;
        assert!(safe_path(root, "../secret.txt").is_err());
        assert!(safe_path(root, "missing/file.txt").is_err());
        assert!(!root.join("missing").exists());
    }
}
