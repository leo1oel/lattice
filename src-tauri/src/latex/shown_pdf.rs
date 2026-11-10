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

use crate::util::sha256_hex;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const DIRECTORY: &str = ".research/cache/shown-pdf";
/// Each root document's PDF as this copy's last build of it left it, by
/// SHA-256 (`replaced`). One entry per document, unlike the single copy
/// above, so building another root document or a standalone figure in
/// between never forgets it.
const HASHES: &str = ".research/cache/build-pdf-hashes.json";
/// A `-synctex=1` build compresses the map; an rc file's `-synctex=-1` does not.
const SYNCTEX: [&str; 2] = ["synctex.gz", "synctex"];

/// After a build of `document` (relative to `root`): keep the PDF it wrote,
/// or put back the last one when it wrote none. Returns whether it put one
/// back.
pub(super) fn settle(root: &Path, document: &str, wrote_pdf: bool) -> bool {
    let pdf = root.join(document).with_extension("pdf");
    let kept = root.join(DIRECTORY).join(document).with_extension("pdf");
    if wrote_pdf {
        keep(root, &pdf, &kept);
        record_hash(root, document, &pdf);
        false
    } else {
        !pdf.exists() && restore(&kept, &pdf)
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

/// Only the latest root document's PDF is kept: another one built since
/// replaces it, so a project holds one copy at most.
fn keep(root: &Path, pdf: &Path, kept: &Path) {
    let directory = root.join(DIRECTORY);
    let _ = fs::remove_dir_all(&directory);
    let Some(parent) = kept.parent() else { return };
    if fs::create_dir_all(parent).is_err() || clone(pdf, kept).is_err() {
        return;
    }
    if let Some(synctex) = synctex_of(pdf) {
        let _ = clone(&synctex, &with_synctex(kept, &synctex));
    }
}

fn restore(kept: &Path, pdf: &Path) -> bool {
    if clone(kept, pdf).is_err() {
        return false;
    }
    // A map from another build would point clicks at the wrong lines.
    for extension in SYNCTEX {
        let _ = fs::remove_file(pdf.with_extension(extension));
    }
    if let Some(synctex) = synctex_of(kept) {
        let _ = clone(&synctex, &with_synctex(pdf, &synctex));
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

    #[test]
    fn a_build_that_writes_no_pdf_gets_the_last_one_and_its_map_back() {
        let root = TempDir::new("shown-pdf");
        root.write("paper/main.pdf", "%PDF-1.5 first");
        root.write("paper/main.synctex.gz", "first map");
        assert!(!settle(&root, "paper/main.tex", true));

        // The next build ends in a fatal error: pdfTeX deleted both.
        fs::remove_file(root.join("paper/main.pdf")).unwrap();
        fs::remove_file(root.join("paper/main.synctex.gz")).unwrap();
        assert!(settle(&root, "paper/main.tex", false));
        let read = |path: &str| fs::read_to_string(root.join(path)).unwrap();
        assert_eq!(read("paper/main.pdf"), "%PDF-1.5 first");
        assert_eq!(read("paper/main.synctex.gz"), "first map");

        // A PDF still on disk (a stopped build's) is left alone.
        root.write("paper/main.pdf", "%PDF-1.5 partial");
        assert!(!settle(&root, "paper/main.tex", false));
        assert_eq!(read("paper/main.pdf"), "%PDF-1.5 partial");
    }

    #[test]
    fn a_pdf_written_over_since_the_last_build_reads_as_replaced() {
        let root = TempDir::new("shown-pdf");
        assert!(!replaced(&root, "cvpr/main.tex"), "no PDF and no copy");
        root.write("cvpr/main.pdf", "%PDF-1.5 mine");
        assert!(!replaced(&root, "cvpr/main.tex"), "no build has left a copy yet");
        settle(&root, "cvpr/main.tex", true);
        assert!(!replaced(&root, "cvpr/main.tex"));

        // A collaborator's build, pulled in by a sync: same size, other bytes.
        root.write("cvpr/main.pdf", "%PDF-1.5 them");
        assert!(replaced(&root, "cvpr/main.tex"));
        root.write("cvpr/main.pdf", "%PDF-1.5 theirs, longer");
        assert!(replaced(&root, "cvpr/main.tex"));
    }

    /// Building `arxiv/main.tex`, or a standalone figure, in between keeps
    /// what `cvpr/main.tex`'s build left, where the single kept copy does not.
    #[test]
    fn each_root_documents_pdf_is_remembered_across_other_builds() {
        let root = TempDir::new("shown-pdf");
        for document in ["cvpr/main.tex", "arxiv/main.tex", "figures/plot.tex"] {
            root.write(document, "\\documentclass{article}");
            root.write(&document.replace(".tex", ".pdf"), &format!("%PDF-1.5 {document}"));
            settle(&root, document, true);
        }
        root.write("cvpr/main.pdf", "%PDF-1.5 a collaborator's");
        assert!(replaced(&root, "cvpr/main.tex"));
        assert!(!replaced(&root, "arxiv/main.tex"));
        assert!(!replaced(&root, "figures/plot.tex"));

        // A document deleted since is forgotten at the next build.
        fs::remove_file(root.join("cvpr/main.tex")).unwrap();
        settle(&root, "arxiv/main.tex", true);
        assert!(!replaced(&root, "cvpr/main.tex"));
        assert!(!read_hashes(&root).contains_key("cvpr/main.tex"));
    }

    #[test]
    fn only_the_latest_root_documents_pdf_is_kept() {
        let root = TempDir::new("shown-pdf");
        root.write("main.pdf", "%PDF-1.5 main");
        root.write("main.synctex.gz", "main map");
        settle(&root, "main.tex", true);
        root.write("slides.pdf", "%PDF-1.5 slides");
        settle(&root, "slides.tex", true);

        fs::remove_file(root.join("main.pdf")).unwrap();
        fs::remove_file(root.join("main.synctex.gz")).unwrap();
        assert!(!settle(&root, "main.tex", false), "slides.tex replaced main.tex's copy");
        assert!(!root.join("main.pdf").exists());

        // And a PDF kept without a map comes back without one, never with a
        // stale map left beside it.
        fs::remove_file(root.join("slides.pdf")).unwrap();
        root.write("slides.synctex", "older map");
        assert!(settle(&root, "slides.tex", false));
        assert!(!root.join("slides.synctex").exists());
    }
}
