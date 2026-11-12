//! Overleaf paths that differ only in letter case.
//!
//! Overleaf keeps `fig/Plot.png` and `fig/plot.png` apart. A Mac's disk, as
//! formatted by default, does not: the second write lands on the first file.
//! Left to that, a sync drops one of them without a word, and a clone writes
//! one over the other, after which the next sync uploads the wrong bytes over
//! the first and offers the second for deletion. Folders clash the same way:
//! `figures/b.png` written beside `Figures/a.png` reads back as
//! `Figures/b.png`, a new file to upload.
//!
//! So clashes are found in Overleaf's copy before anything is planned or
//! written. One spelling of each syncs; the rest, with everything under them,
//! take no part at all (never written here, uploaded, or offered for deletion
//! on either side) and are named, so the writer can rename one on Overleaf.
//! This holds whatever the volume: a case-sensitive one is rare on a Mac, and
//! a project that only works there breaks for the next person to clone it.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Two spellings of one name on Overleaf, which this Mac cannot keep apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseCollision {
    /// The file or folder that syncs: the spelling already here, else the
    /// first in path order.
    pub kept: String,
    /// The one left out of the sync, along with everything under it.
    pub skipped: String,
}

/// The clashes among Overleaf's `paths`, shallowest first: when two folders
/// clash, the files under the skipped one are not reported again.
/// `here(path)` says whether a spelling is already in use on this side, so
/// the copy a writer already has keeps its name.
pub(super) fn find<'a>(
    paths: impl IntoIterator<Item = &'a String>, here: impl Fn(&str) -> bool,
) -> Vec<CaseCollision> {
    let mut paths: Vec<&str> = paths.into_iter().map(String::as_str).collect();
    let mut collisions = Vec::new();
    for depth in 1.. {
        let mut spellings: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
        for prefix in paths.iter().filter_map(|path| leading(path, depth)) {
            spellings.entry(prefix.to_lowercase()).or_default().insert(prefix);
        }
        if spellings.is_empty() {
            break;
        }
        for group in spellings.into_values().filter(|group| group.len() > 1) {
            let first = group.first().copied();
            let Some(kept) = group.iter().copied().find(|spelling| here(spelling)).or(first) else {
                continue;
            };
            for skipped in group.into_iter().filter(|spelling| *spelling != kept) {
                collisions.push(CaseCollision { kept: kept.into(), skipped: skipped.into() });
            }
        }
        paths.retain(|path| !skips(&collisions, path));
    }
    collisions
}

/// The first `depth` components of `path`, if it has that many.
fn leading(path: &str, depth: usize) -> Option<&str> {
    let mut ends = path.match_indices('/').map(|(at, _)| at).chain([path.len()]);
    ends.nth(depth - 1).map(|end| &path[..end])
}

/// Whether `path` is a skipped spelling or lies under one.
pub(super) fn skips(collisions: &[CaseCollision], path: &str) -> bool {
    (collisions.iter()).any(|collision| {
        (path.strip_prefix(collision.skipped.as_str()))
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// Take every clashing path out of a sync's copies of the project before it
/// plans anything, and return the clashes with the Overleaf paths set aside.
///
/// A path in use here keeps its spelling: a file on disk, a folder holding
/// one, or a file the last sync agreed on. Beside the skipped Overleaf files
/// themselves, a file here that is one of them in another spelling — what a
/// folder clash left on disk before this check existed — is set aside too,
/// rather than uploaded as new.
pub(super) fn set_aside<T>(
    remote: &mut BTreeMap<String, T>, local: &mut BTreeMap<String, Vec<u8>>,
    agreed: &BTreeMap<String, String>,
) -> (Vec<CaseCollision>, BTreeSet<String>) {
    let here = |path: &str| holds(local, path) || holds(agreed, path);
    let collisions = find(remote.keys(), here);
    let aside: BTreeSet<String> =
        remote.keys().filter(|path| skips(&collisions, path)).cloned().collect();
    remote.retain(|path, _| !aside.contains(path));
    let folded: BTreeSet<String> = aside.iter().map(|path| path.to_lowercase()).collect();
    local.retain(|path, _| remote.contains_key(path) || !folded.contains(&path.to_lowercase()));
    (collisions, aside)
}

/// Whether `files` has `path` as a file or as a folder of files.
fn holds<T>(files: &BTreeMap<String, T>, path: &str) -> bool {
    let folder = format!("{path}/");
    files.contains_key(path)
        || (files.range(folder.clone()..).next()).is_some_and(|(file, _)| file.starts_with(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clashes(paths: &[&str], here: &[&str]) -> Vec<(String, String)> {
        let paths: Vec<String> = paths.iter().map(|path| path.to_string()).collect();
        (find(&paths, |path| here.contains(&path)).into_iter())
            .map(|CaseCollision { kept, skipped }| (kept, skipped))
            .collect()
    }

    fn pair(kept: &str, skipped: &str) -> (String, String) {
        (kept.into(), skipped.into())
    }

    #[test]
    fn files_and_folders_clash_by_case_and_keep_the_spelling_already_here() {
        // With nothing here, the first spelling in path order syncs.
        assert_eq!(
            clashes(&["fig/Plot.png", "fig/plot.png", "main.tex"], &[]),
            [pair("fig/Plot.png", "fig/plot.png")]
        );
        // The file already here keeps its name; Overleaf's newer twin waits.
        assert_eq!(
            clashes(&["fig/Plot.png", "fig/plot.png"], &["fig/plot.png"]),
            [pair("fig/plot.png", "fig/Plot.png")]
        );
        // Two folders clash once, as folders, not again file by file, and
        // a clash inside the skipped one is moot.
        assert_eq!(
            clashes(&["Figures/a.png", "figures/a.png", "figures/B.png", "figures/b.png"], &[]),
            [pair("Figures", "figures")]
        );
        // A file and a folder can clash too.
        assert_eq!(clashes(&["notes", "Notes/a.tex"], &[]), [pair("Notes", "notes")]);
        // Letters beyond ASCII fold as well.
        assert_eq!(clashes(&["Über.tex", "über.tex"], &[]), [pair("Über.tex", "über.tex")]);
        // Names that only share a prefix are not a clash.
        assert!(clashes(&["fig/a.png", "Fig-old/a.png", "fig.tex"], &[]).is_empty());
    }
}
