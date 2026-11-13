//! What builds after the writer deletes the compiled document: the root
//! documents that went with a deleted file or folder are dropped, and a
//! project left with one obvious paper builds that one.

use super::manifest::{
    compiles_alone, declares_document_class, default_root_document, make_default_root,
};
use crate::models::ProjectManifest;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

/// The writer deleted `deleted` (a file or a folder): drop the root documents
/// it took with it, so builds and SyncTeX never resolve through a file that is
/// gone. When the compiled document went too, a project left with exactly one
/// other full document (a `.tex` declaring a class that is not `standalone` or
/// `subfiles`) builds that one; with none or several, guessing could compile
/// the wrong paper, so no root stays and the next build compiles the open
/// document if it is a full one, or asks for a main document.
/// Returns whether the manifest changed.
pub(super) fn forget_deleted_root_documents(
    root: &Path, manifest: &mut ProjectManifest, deleted: &str,
) -> bool {
    let gone = |path: &str| Path::new(path).starts_with(deleted);
    let default_gone = default_root_document(manifest).is_some_and(|document| gone(&document.path));
    let listed = manifest.root_documents.len();
    manifest.root_documents.retain(|document| !gone(&document.path));
    if !default_gone {
        return manifest.root_documents.len() != listed;
    }
    match sole_full_document(root) {
        Some(replacement) => {
            make_default_root(manifest, &replacement, "Root");
        }
        None => manifest.root_documents.clear(),
    }
    true
}

/// The project's only `.tex` that typesets a whole document by itself, if it
/// has exactly one. Hidden folders and Overleaf conflict copies do not count,
/// and the walk goes as deep as opening a folder looks for its root.
fn sole_full_document(root: &Path) -> Option<String> {
    let mut found = WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            entry.file_type().is_file()
                && name.ends_with(".tex")
                && !crate::overleaf::is_conflict_copy(&name)
        })
        .filter(|entry| {
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            declares_document_class(&content) && !compiles_alone(&content)
        })
        .filter_map(|entry| {
            let relative = entry.path().strip_prefix(root).ok()?;
            Some(relative.to_string_lossy().replace('\\', "/"))
        });
    let first = found.next()?;
    found.next().is_none().then_some(first)
}
