//! LaTeX builds through latexmk, and what they leave behind.
//!
//! - `build` runs latexmk for a project's default root document, one build at
//!   a time and abortable from the UI; `prewarm` shortens a cold first build.
//! - `build_log` turns latexmk's log into editor diagnostics and a trimmed
//!   copy for the Log tab.
//! - `synctex` maps positions between the compiled PDF and its sources.
//!
//! This file holds what they share: which document is built, and the PDF.

use crate::models::{Diagnostic, ProjectManifest, RootDocument};
use crate::project;
use serde::Serialize;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub success: bool,
    pub has_pdf: bool,
    pub log: String,
    pub duration_ms: u128,
    pub diagnostics: Vec<Diagnostic>,
    /// Project-relative path of the document latexmk was pointed at. The build
    /// may have re-targeted onto the open file (Overleaf's rule), and the
    /// frontend needs to know without re-reading the manifest.
    pub root_document: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSyncTarget {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
