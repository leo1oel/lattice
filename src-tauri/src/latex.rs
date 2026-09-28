//! LaTeX builds through latexmk, and what they leave behind.
//!
//! - `build` runs latexmk for a project's default root document, one build at
//!   a time and abortable from the UI; `prewarm` shortens a cold first build.
//! - `build_log` turns latexmk's log into editor diagnostics and a trimmed
//!   copy for the Log tab.
//! - `synctex` maps positions between the compiled PDF and its sources.
//!
//! This file holds what they share: which document is built, and the PDF.

use crate::models::{ProjectManifest, RootDocument};
use crate::project;
use std::fs;
use std::path::{Path, PathBuf};

mod build;
mod build_log;
mod prewarm;
mod synctex;

/// Register an already-running process as a project's build, for tests that
/// need one in flight without launching latexmk. They must still hand over a
/// process they own — abort signals a whole process group.
#[cfg(test)]
pub(crate) use build::begin_active as begin_for_test;
pub use build::{abort, build, clean, ActiveBuild};
pub(crate) use build_log::is_pass_noise_warning;
pub use synctex::{forward_search, inverse_search};

/// The document a build compiles: the one marked default, else the first.
pub(crate) fn default_root(manifest: &ProjectManifest) -> Option<&RootDocument> {
    let documents = &manifest.root_documents;
    documents.iter().find(|document| document.is_default).or_else(|| documents.first())
}

fn default_root_document(manifest: &ProjectManifest) -> Result<&RootDocument, String> {
    // Not a failure the reader caused: a folder of notes has nothing to
    // compile, and the way forward is to add a .tex, not to read an error.
    default_root(manifest).ok_or_else(|| {
        "This project has no LaTeX document to build yet. Add a .tex file, or set one as the root document in project settings."
            .to_string()
    })
}

fn compiled_pdf_path(root: &Path) -> Result<PathBuf, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    Ok(project::safe_path(root, &document.path)?.with_extension("pdf"))
}

/// Whether the compiled PDF is missing the SyncTeX file that pairs with it.
fn synctex_missing(root: &Path) -> bool {
    let Ok(pdf) = compiled_pdf_path(root) else {
        return false;
    };
    pdf.is_file()
        && !pdf.with_extension("synctex.gz").is_file()
        && !pdf.with_extension("synctex").is_file()
}

pub fn read_compiled_pdf(root: &Path) -> Result<Vec<u8>, String> {
    let path = compiled_pdf_path(root)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("The compiled PDF could not be read: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    Ok(bytes)
}

pub fn save_pdf(path: &Path, bytes: &[u8]) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("Choose where to save the PDF.".to_string());
    }
    let destination = match path.extension().and_then(|extension| extension.to_str()) {
        None => path.with_extension("pdf"),
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => path.to_path_buf(),
        Some(_) => return Err("The exported paper must use the .pdf extension.".to_string()),
    };
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_a_compiled_pdf_to_the_chosen_path() {
        let directory = crate::test_support::TempDir::new("latex");
        let bytes = b"%PDF-1.7\ntest";
        let destination = save_pdf(&directory.join("paper"), bytes).unwrap();
        assert_eq!(Path::new(&destination).extension().unwrap(), "pdf");
        assert_eq!(fs::read(destination).unwrap(), b"%PDF-1.7\ntest");
        assert!(save_pdf(&directory.join("paper.txt"), bytes).is_err());
    }
}
