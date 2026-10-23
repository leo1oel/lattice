//! The PDF on screen and its SyncTeX map, put back when a build leaves none.
//!
//! pdfTeX deletes the root document's PDF and SyncTeX file when a run ends in
//! a fatal error ("no output PDF file produced": a missing `\input` in nonstop
//! mode, a document that never reaches `\end{document}`, any error under Stop
//! on first error). The preview keeps showing the PDF it last read, but
//! SyncTeX reads these files from disk, so every click on that PDF failed
//! until the error was fixed. Each build that writes a PDF leaves a copy here
//! (an APFS clone, so neither time nor space until the next build rewrites
//! the PDF), and a build that leaves none puts the copy back.

use std::fs;
use std::path::{Path, PathBuf};

const DIRECTORY: &str = ".research/cache/shown-pdf";
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
        false
    } else {
        !pdf.exists() && restore(&kept, &pdf)
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
