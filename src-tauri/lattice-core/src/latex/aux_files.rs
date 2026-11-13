//! Where a build leaves a root document's intermediate files.
//!
//! By default latexmk writes them beside the document (`latexmk`'s `-cd`):
//! `paper/main.aux`, `.log`, `.fls`, `.fdb_latexmk`, `.bbl`, `.blg`, the
//! `.aux` of each `\include`d chapter, and the SyncTeX map beside the PDF.
//! With the global "Keep build files in a hidden folder" setting
//! ([`AuxFiles::Hidden`]) they go to `.research/build/`, which mirrors the
//! project's folders: `paper/main.tex` builds into `.research/build/paper/`,
//! its chapters' `.aux` into `.research/build/paper/chapters/`, the same
//! shape as beside the document. Only the PDF stays where it was, beside the
//! document.
//!
//! `.research/` is Lattice's own folder, so everything that must not see
//! build files already leaves it alone: the project watcher (no rebuild
//! loops), the project tree, Overleaf sync, project export, git and the
//! arXiv pack's "never ship" list.
//!
//! latexmk runs TeX with `-output-directory` set to that folder and moves the
//! PDF and SyncTeX map out to the document's folder after each pass that
//! wrote them. The map is then moved back in (`stow_synctex`), and `synctex`
//! is pointed at it with `-d`.
//!
//! Readers do not ask which layout the setting names: switching it applies
//! at the next build, so the files on disk are the last build's, in either
//! place. They look in the hidden folder first and then beside the document.
//! A build in one layout removes the other layout's files of its document
//! first (`retire_other_layout`), so the two never mix and a stale `.log` or
//! SyncTeX map from before the switch is never read. That first build after a
//! switch starts without latexmk's incremental state and typesets in full.

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

/// The hidden folder, relative to the project root, that mirrors its folders.
pub(crate) const HIDDEN_FOLDER: &str = ".research/build";

/// A SyncTeX map: `-synctex=1` compresses it, an rc file's `-synctex=-1` does not.
pub(crate) const SYNCTEX: [&str; 2] = ["synctex.gz", "synctex"];

/// Where a build writes the root document's intermediate files: the global
/// setting, which the build is told (`latex::build`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuxFiles {
    /// Beside the document, as latexmk and every other TeX tool leave them.
    #[default]
    Beside,
    /// In `.research/build/`, mirroring the document's folder.
    Hidden,
}

/// The folder a build of `document` (relative to `root`) in `layout` writes
/// its intermediate files to.
pub(crate) fn folder(root: &Path, document: &str, layout: AuxFiles) -> PathBuf {
    root.join(relative(document, layout))
}

/// That folder relative to `root`, `/`-separated; empty for the root itself.
pub(crate) fn relative_folder(document: &str, layout: AuxFiles) -> String {
    relative(document, layout).to_string_lossy().replace('\\', "/")
}

/// The folder relative to the project root. Joining an empty path would add
/// a trailing separator (`.research/build/`), so the root's own is not joined.
fn relative(document: &str, layout: AuxFiles) -> PathBuf {
    let parent = Path::new(document).parent().filter(|parent| !parent.as_os_str().is_empty());
    match (layout, parent) {
        (AuxFiles::Beside, parent) => parent.map(Path::to_path_buf).unwrap_or_default(),
        (AuxFiles::Hidden, Some(parent)) => Path::new(HIDDEN_FOLDER).join(parent),
        (AuxFiles::Hidden, None) => PathBuf::from(HIDDEN_FOLDER),
    }
}

/// `document`'s intermediate file with `extension` in `layout`'s folder.
pub(crate) fn in_layout(root: &Path, document: &str, extension: &str, layout: AuxFiles) -> PathBuf {
    let stem = Path::new(document).file_stem().unwrap_or_default().to_string_lossy();
    folder(root, document, layout).join(format!("{stem}.{extension}"))
}

/// The last build's `extension` file of `document` (`log`, `aux`, `blg`,
/// `bcf`, `bbl`, `fls`): the hidden folder's when it has one, else the one
/// beside the document, which may not exist either.
pub(crate) fn file(root: &Path, document: &str, extension: &str) -> PathBuf {
    let hidden = in_layout(root, document, extension, AuxFiles::Hidden);
    if hidden.is_file() {
        return hidden;
    }
    in_layout(root, document, extension, AuxFiles::Beside)
}

/// [`file`] relative to `root`, `/`-separated.
pub(crate) fn relative_file(root: &Path, document: &str, extension: &str) -> String {
    let stem = Path::new(document).file_stem().unwrap_or_default().to_string_lossy();
    let hidden = in_layout(root, document, extension, AuxFiles::Hidden).is_file();
    let layout = if hidden { AuxFiles::Hidden } else { AuxFiles::Beside };
    let folder = relative_folder(document, layout);
    if folder.is_empty() {
        format!("{stem}.{extension}")
    } else {
        format!("{folder}/{stem}.{extension}")
    }
}

/// The SyncTeX map of `document`'s PDF, if the last build left one: in the
/// hidden folder, else beside the PDF.
pub(crate) fn synctex(root: &Path, document: &str) -> Option<PathBuf> {
    [AuxFiles::Hidden, AuxFiles::Beside].into_iter().find_map(|layout| {
        SYNCTEX
            .iter()
            .map(|extension| in_layout(root, document, extension, layout))
            .find(|path| path.is_file())
    })
}

/// Where `document`'s SyncTeX map goes in `layout`, compressed (`gz`) or not.
pub(crate) fn synctex_in(root: &Path, document: &str, layout: AuxFiles, gz: bool) -> PathBuf {
    in_layout(root, document, if gz { SYNCTEX[0] } else { SYNCTEX[1] }, layout)
}

/// Remove `document`'s SyncTeX maps in both layouts.
pub(crate) fn remove_synctex(root: &Path, document: &str) {
    for layout in [AuxFiles::Hidden, AuxFiles::Beside] {
        remove_synctex_in(root, document, layout);
    }
}

/// Remove `document`'s SyncTeX map in `layout`'s folder.
pub(crate) fn remove_synctex_in(root: &Path, document: &str, layout: AuxFiles) {
    for extension in SYNCTEX {
        let _ = fs::remove_file(in_layout(root, document, extension, layout));
    }
}

/// After a hidden-folder build: latexmk moved the SyncTeX map it wrote out to
/// the PDF; put it back in the hidden folder, replacing the one there. A map
/// already in the folder and none beside the PDF (latexmk typeset nothing) is
/// left as it is.
pub(crate) fn stow_synctex(root: &Path, document: &str) {
    for (index, extension) in SYNCTEX.iter().enumerate() {
        let beside = in_layout(root, document, extension, AuxFiles::Beside);
        if !beside.is_file() {
            continue;
        }
        let hidden = in_layout(root, document, extension, AuxFiles::Hidden);
        // The other form of the map is from an older build.
        let _ = fs::remove_file(in_layout(root, document, SYNCTEX[1 - index], AuxFiles::Hidden));
        if hidden.parent().is_some_and(|parent| fs::create_dir_all(parent).is_ok()) {
            let _ = fs::rename(&beside, &hidden);
        }
    }
}

/// Whether the folder `layout` names holds a build of `document`: what
/// latexmk or TeX always leaves after one.
pub(crate) fn has_build(root: &Path, document: &str, layout: AuxFiles) -> bool {
    ["fdb_latexmk", "fls", "log", "aux"]
        .iter()
        .any(|extension| in_layout(root, document, extension, layout).is_file())
}

/// The layout a build in `layout` replaces: the other one.
pub(crate) fn other(layout: AuxFiles) -> AuxFiles {
    match layout {
        AuxFiles::Beside => AuxFiles::Hidden,
        AuxFiles::Hidden => AuxFiles::Beside,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn the_hidden_folder_mirrors_the_documents_folder() {
        let root = Path::new("/p");
        assert_eq!(folder(root, "main.tex", AuxFiles::Beside), Path::new("/p"));
        assert_eq!(folder(root, "main.tex", AuxFiles::Hidden), Path::new("/p/.research/build"));
        assert_eq!(
            folder(root, "paper/main.tex", AuxFiles::Hidden),
            Path::new("/p/.research/build/paper")
        );
        assert_eq!(relative_folder("main.tex", AuxFiles::Beside), "");
        assert_eq!(relative_folder("main.tex", AuxFiles::Hidden), ".research/build");
        assert_eq!(folder(root, "main.tex", AuxFiles::Hidden).to_str(), Some("/p/.research/build"));
        assert_eq!(relative_folder("paper/main.tex", AuxFiles::Beside), "paper");
        assert_eq!(relative_folder("paper/main.tex", AuxFiles::Hidden), ".research/build/paper");
    }

    #[test]
    fn a_reader_takes_the_hidden_folders_file_first() {
        let root = TempDir::new("aux-files-read");
        assert_eq!(file(&root, "paper/main.tex", "log"), root.join("paper/main.log"));
        assert_eq!(relative_file(&root, "paper/main.tex", "bbl"), "paper/main.bbl");
        root.write("paper/main.log", "beside");
        assert_eq!(file(&root, "paper/main.tex", "log"), root.join("paper/main.log"));
        root.write(".research/build/paper/main.log", "hidden");
        root.write(".research/build/paper/main.bbl", "hidden");
        assert_eq!(
            file(&root, "paper/main.tex", "log"),
            root.join(".research/build/paper/main.log")
        );
        assert_eq!(relative_file(&root, "paper/main.tex", "bbl"), ".research/build/paper/main.bbl");
        assert_eq!(relative_file(&root, "main.tex", "bbl"), "main.bbl");
    }

    #[test]
    fn the_synctex_map_is_found_and_stowed_in_the_hidden_folder() {
        let root = TempDir::new("aux-files-synctex");
        assert_eq!(synctex(&root, "main.tex"), None);
        root.write("main.synctex.gz", "fresh");
        root.write(".research/build/main.synctex", "older, uncompressed");
        stow_synctex(&root, "main.tex");
        assert!(!root.join("main.synctex.gz").exists());
        assert!(!root.join(".research/build/main.synctex").exists());
        let stowed = root.join(".research/build/main.synctex.gz");
        assert_eq!(fs::read_to_string(&stowed).unwrap(), "fresh");
        assert_eq!(synctex(&root, "main.tex"), Some(stowed));
        // latexmk typeset nothing: the stowed map stays.
        stow_synctex(&root, "main.tex");
        assert_eq!(
            fs::read_to_string(root.join(".research/build/main.synctex.gz")).unwrap(),
            "fresh"
        );
        remove_synctex(&root, "main.tex");
        assert_eq!(synctex(&root, "main.tex"), None);
    }

    #[test]
    fn a_build_is_recognised_by_what_it_always_leaves() {
        let root = TempDir::new("aux-files-build");
        assert!(!has_build(&root, "paper/main.tex", AuxFiles::Beside));
        root.write("paper/main.pdf", "a PDF alone is no build here");
        assert!(!has_build(&root, "paper/main.tex", AuxFiles::Beside));
        root.write(".research/build/paper/main.fdb_latexmk", "");
        assert!(has_build(&root, "paper/main.tex", AuxFiles::Hidden));
        assert!(!has_build(&root, "paper/main.tex", AuxFiles::Beside));
    }
}
