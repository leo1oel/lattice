//! The PDF on screen and its SyncTeX map, put back when a build leaves none.
//!
//! pdfTeX deletes the root document's PDF and SyncTeX file when a run ends in
//! a fatal error ("no output PDF file produced": a missing `\input` in nonstop
//! mode, a document that never reaches `\end{document}`, any error under Stop
//! on first error). The preview keeps showing the PDF it last read, but
//! SyncTeX reads these files from disk, so every click on that PDF failed
//! until the error was fixed. Each build that writes a PDF leaves a copy here
//! (an APFS clone, so neither time nor space until the next build rewrites
//! the PDF), and a build that leaves none puts the copy back. Each root
//! document's PDF is also remembered by hash, so a build notices one that
//! something else wrote over since (`replaced`).
//!
//! The copy is per document: the preview keeps a tab open for each root
//! document built (a manuscript and its supplement), and each tab shows,
//! and clicks through to, its own document's last build. The copy is also
//! what such a tab reads (`kept`) when the project opens again: it is this
//! copy's build by construction, where the PDF beside the document may be a
//! collaborator's that a sync brought in.

use super::aux_files::{self, AuxFiles, SYNCTEX};
use crate::project;
use crate::util::sha256_hex;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const DIRECTORY: &str = ".research/cache/shown-pdf";
/// Each root document's PDF as this copy's last build of it left it, by
/// SHA-256 (`replaced`). One entry per document, as for the copies above,
/// so building another root document or a standalone figure in between
/// never forgets it.
const HASHES: &str = ".research/cache/build-pdf-hashes.json";

/// After a build of `document` (relative to `root`) in `layout`: keep the PDF
/// it wrote, or put back the last one when it wrote none, with its map where
/// `layout` keeps maps (`aux_files`). Returns whether it put one back.
pub(super) fn settle(root: &Path, document: &str, wrote_pdf: bool, layout: AuxFiles) -> bool {
    let pdf = root.join(document).with_extension("pdf");
    let kept = root.join(DIRECTORY).join(document).with_extension("pdf");
    if wrote_pdf {
        keep(root, document, &pdf, &kept);
        record_hash(root, document, &pdf);
        false
    } else {
        !pdf.exists() && restore(root, document, layout, &kept, &pdf)
    }
}

/// Whether the PDF of `document` is no longer the one this copy's last build
/// of it left: something other than a build wrote over it since. An Overleaf
/// sync or a `git pull` that brings in a collaborator's PDF leaves the
/// sources as they were, so latexmk finds nothing to do and the preview would
/// show their build as this one's. `false` when no build here has recorded
/// that document's PDF, so a first build never typesets twice.
pub(super) fn replaced(root: &Path, document: &str) -> bool {
    let Some(recorded) = read_hashes(root).remove(document) else { return false };
    let pdf = root.join(document).with_extension("pdf");
    fs::read(pdf).is_ok_and(|bytes| sha256_hex(bytes) != recorded)
}

fn read_hashes(root: &Path) -> BTreeMap<String, String> {
    let raw = fs::read(root.join(HASHES)).unwrap_or_default();
    serde_json::from_slice(&raw).unwrap_or_default()
}

/// Record `document`'s PDF, and forget documents whose `.tex` is gone.
fn record_hash(root: &Path, document: &str, pdf: &Path) {
    let Ok(bytes) = fs::read(pdf) else { return };
    let mut hashes = read_hashes(root);
    hashes.retain(|other, _| root.join(other).is_file());
    hashes.insert(document.to_string(), sha256_hex(bytes));
    let path = root.join(HASHES);
    let Ok(json) = serde_json::to_vec_pretty(&hashes) else { return };
    if path.parent().is_some_and(|parent| fs::create_dir_all(parent).is_ok()) {
        let _ = fs::write(path, json);
    }
}

/// The last PDF this copy built of `document`, if a build here left one:
/// what its preview tab shows when no build of it ran this session. `None`
/// for a path that is not a project-relative `.tex` name.
pub(super) fn kept(root: &Path, document: &str) -> Option<PathBuf> {
    let relative = Path::new(document);
    let tex = relative.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("tex"));
    (tex && project::stays_inside(relative))
        .then(|| root.join(DIRECTORY).join(relative).with_extension("pdf"))
        .filter(|kept| kept.is_file())
}

/// Each root document keeps its own copy, replaced by its next build; copies
/// of documents whose `.tex` is gone are dropped, so a project holds one per
/// root document at most.
fn keep(root: &Path, document: &str, pdf: &Path, kept: &Path) {
    let directory = root.join(DIRECTORY);
    forget_deleted(root, &directory, &directory);
    for extension in ["pdf", SYNCTEX[0], SYNCTEX[1]] {
        let _ = fs::remove_file(kept.with_extension(extension));
    }
    let Some(parent) = kept.parent() else { return };
    if fs::create_dir_all(parent).is_err() || clone(pdf, kept).is_err() {
        return;
    }
    if let Some(synctex) = aux_files::synctex(root, document) {
        let _ = clone(&synctex, &with_synctex(kept, &synctex));
    }
}

/// Remove the copies under `folder` whose document (the same path under
/// `root`, as a `.tex`) no longer exists.
fn forget_deleted(root: &Path, directory: &Path, folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            forget_deleted(root, directory, &path);
            continue;
        }
        let Ok(relative) = path.strip_prefix(directory) else { continue };
        // `a.synctex.gz` belongs to `a.tex`, as `a.pdf` does.
        let name = relative.to_string_lossy();
        let stem = SYNCTEX
            .iter()
            .chain(["pdf"].iter())
            .find_map(|extension| name.strip_suffix(&format!(".{extension}")));
        if stem.is_some_and(|stem| !root.join(format!("{stem}.tex")).is_file()) {
            let _ = fs::remove_file(&path);
        }
    }
}

fn restore(root: &Path, document: &str, layout: AuxFiles, kept: &Path, pdf: &Path) -> bool {
    if clone(kept, pdf).is_err() {
        return false;
    }
    // A map from another build would point clicks at the wrong lines.
    aux_files::remove_synctex(root, document);
    if let Some(synctex) = synctex_of(kept) {
        let gz = synctex.extension().is_some_and(|extension| extension == "gz");
        let target = aux_files::synctex_in(root, document, layout, gz);
        if target.parent().is_some_and(|parent| fs::create_dir_all(parent).is_ok()) {
            let _ = clone(&synctex, &target);
        }
    }
    true
}

fn synctex_of(pdf: &Path) -> Option<PathBuf> {
    SYNCTEX.iter().map(|extension| pdf.with_extension(extension)).find(|path| path.is_file())
}

/// `pdf`'s SyncTeX file with the same extension as `synctex`.
fn with_synctex(pdf: &Path, synctex: &Path) -> PathBuf {
    let gz = synctex.extension().is_some_and(|extension| extension == "gz");
    pdf.with_extension(if gz { SYNCTEX[0] } else { SYNCTEX[1] })
}

/// `fs::copy` clones on APFS only into a path that does not exist yet.
fn clone(from: &Path, to: &Path) -> std::io::Result<()> {
    let _ = fs::remove_file(to);
    fs::copy(from, to).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const BESIDE: AuxFiles = AuxFiles::Beside;

    #[test]
    fn a_build_that_writes_no_pdf_gets_the_last_one_and_its_map_back() {
        let root = TempDir::new("shown-pdf");
        root.write("paper/main.pdf", "%PDF-1.5 first");
        root.write("paper/main.synctex.gz", "first map");
        assert!(!settle(&root, "paper/main.tex", true, BESIDE));

        // The next build ends in a fatal error: pdfTeX deleted both.
        fs::remove_file(root.join("paper/main.pdf")).unwrap();
        fs::remove_file(root.join("paper/main.synctex.gz")).unwrap();
        assert!(settle(&root, "paper/main.tex", false, BESIDE));
        let read = |path: &str| fs::read_to_string(root.join(path)).unwrap();
        assert_eq!(read("paper/main.pdf"), "%PDF-1.5 first");
        assert_eq!(read("paper/main.synctex.gz"), "first map");

        // A PDF still on disk (a stopped build's) is left alone.
        root.write("paper/main.pdf", "%PDF-1.5 partial");
        assert!(!settle(&root, "paper/main.tex", false, BESIDE));
        assert_eq!(read("paper/main.pdf"), "%PDF-1.5 partial");
    }

    #[test]
    fn a_pdf_written_over_since_the_last_build_reads_as_replaced() {
        let root = TempDir::new("shown-pdf");
        assert!(!replaced(&root, "cvpr/main.tex"), "no PDF and no copy");
        root.write("cvpr/main.pdf", "%PDF-1.5 mine");
        assert!(!replaced(&root, "cvpr/main.tex"), "no build has left a copy yet");
        settle(&root, "cvpr/main.tex", true, BESIDE);
        assert!(!replaced(&root, "cvpr/main.tex"));

        // A collaborator's build, pulled in by a sync: same size, other bytes.
        root.write("cvpr/main.pdf", "%PDF-1.5 them");
        assert!(replaced(&root, "cvpr/main.tex"));
        root.write("cvpr/main.pdf", "%PDF-1.5 theirs, longer");
        assert!(replaced(&root, "cvpr/main.tex"));
    }

    /// Building `arxiv/main.tex`, or a standalone figure, in between keeps
    /// the hash of what `cvpr/main.tex`'s build left.
    #[test]
    fn each_root_documents_pdf_is_remembered_across_other_builds() {
        let root = TempDir::new("shown-pdf");
        for document in ["cvpr/main.tex", "arxiv/main.tex", "figures/plot.tex"] {
            root.write(document, "\\documentclass{article}");
            root.write(&document.replace(".tex", ".pdf"), format!("%PDF-1.5 {document}"));
            settle(&root, document, true, BESIDE);
        }
        root.write("cvpr/main.pdf", "%PDF-1.5 a collaborator's");
        assert!(replaced(&root, "cvpr/main.tex"));
        assert!(!replaced(&root, "arxiv/main.tex"));
        assert!(!replaced(&root, "figures/plot.tex"));

        // A document deleted since is forgotten at the next build.
        fs::remove_file(root.join("cvpr/main.tex")).unwrap();
        settle(&root, "arxiv/main.tex", true, BESIDE);
        assert!(!replaced(&root, "cvpr/main.tex"));
        assert!(!read_hashes(&root).contains_key("cvpr/main.tex"));
    }

    /// The supplement built after the paper keeps the paper's copy, so a
    /// paper build that writes no PDF still gets its own back, map included.
    #[test]
    fn each_root_document_keeps_its_own_copy() {
        let root = TempDir::new("shown-pdf");
        root.write("main.tex", "\\documentclass{article}");
        root.write("supplement/SI.tex", "\\documentclass{article}");
        root.write("main.pdf", "%PDF-1.5 main");
        root.write("main.synctex.gz", "main map");
        settle(&root, "main.tex", true, BESIDE);
        root.write("supplement/SI.pdf", "%PDF-1.5 SI");
        settle(&root, "supplement/SI.tex", true, BESIDE);
        let read = |path: &Path| fs::read_to_string(path).unwrap();
        assert_eq!(read(&kept(&root, "main.tex").unwrap()), "%PDF-1.5 main");
        assert_eq!(read(&kept(&root, "supplement/SI.tex").unwrap()), "%PDF-1.5 SI");

        fs::remove_file(root.join("main.pdf")).unwrap();
        fs::remove_file(root.join("main.synctex.gz")).unwrap();
        assert!(settle(&root, "main.tex", false, BESIDE));
        assert_eq!(read(&root.join("main.pdf")), "%PDF-1.5 main");
        assert_eq!(read(&root.join("main.synctex.gz")), "main map");

        // A PDF kept without a map comes back without one, never with a
        // stale map left beside it.
        fs::remove_file(root.join("supplement/SI.pdf")).unwrap();
        root.write("supplement/SI.synctex", "older map");
        assert!(settle(&root, "supplement/SI.tex", false, BESIDE));
        assert!(!root.join("supplement/SI.synctex").exists());

        // A rebuild that drops its map drops the kept one too.
        settle(&root, "main.tex", true, BESIDE);
        root.write("main.pdf", "%PDF-1.5 main, no map");
        fs::remove_file(root.join("main.synctex.gz")).unwrap();
        settle(&root, "main.tex", true, BESIDE);
        let copy = kept(&root, "main.tex").unwrap();
        assert!(!copy.with_extension("synctex.gz").exists());
    }

    #[test]
    fn a_deleted_documents_copy_goes_and_only_tex_names_are_read() {
        let root = TempDir::new("shown-pdf");
        for document in ["main.tex", "SI.tex"] {
            root.write(document, "\\documentclass{article}");
            root.write(&document.replace(".tex", ".pdf"), "%PDF-1.5");
            root.write(&document.replace(".tex", ".synctex.gz"), "map");
            settle(&root, document, true, BESIDE);
        }
        fs::remove_file(root.join("SI.tex")).unwrap();
        settle(&root, "main.tex", true, BESIDE);
        assert!(kept(&root, "SI.tex").is_none());
        assert!(!root.join(DIRECTORY).join("SI.synctex.gz").exists());
        assert!(kept(&root, "main.tex").is_some());
        for refused in ["main.pdf", "../main.tex", "/main.tex", ""] {
            assert!(kept(&root, refused).is_none(), "{refused}");
        }
    }

    /// With the hidden build folder the map lives there: it is kept from
    /// there, and a build that writes no PDF gets it back there.
    #[test]
    fn the_hidden_folders_map_is_kept_and_put_back_there() {
        let root = TempDir::new("shown-pdf-hidden");
        root.write("paper/main.tex", "\\documentclass{article}");
        root.write("paper/main.pdf", "%PDF-1.5 first");
        root.write(".research/build/paper/main.synctex.gz", "first map");
        assert!(!settle(&root, "paper/main.tex", true, AuxFiles::Hidden));

        fs::remove_file(root.join("paper/main.pdf")).unwrap();
        fs::remove_file(root.join(".research/build/paper/main.synctex.gz")).unwrap();
        // A map left beside the PDF from before the switch is not this build's.
        root.write("paper/main.synctex.gz", "stale map");
        assert!(settle(&root, "paper/main.tex", false, AuxFiles::Hidden));
        let read = |path: &str| fs::read_to_string(root.join(path)).unwrap();
        assert_eq!(read("paper/main.pdf"), "%PDF-1.5 first");
        assert_eq!(read(".research/build/paper/main.synctex.gz"), "first map");
        assert!(!root.join("paper/main.synctex.gz").exists());
    }
}
