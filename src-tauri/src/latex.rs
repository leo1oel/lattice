//! LaTeX builds through latexmk, and what they leave behind.
//!
//! - `build` runs latexmk for a project's default root document, one build at
//!   a time and abortable from the UI; `prewarm` shortens a cold first build;
//!   `preamble_format` keeps a pdfLaTeX format of the document's preamble so
//!   passes skip loading it; `build_steps` times the passes it runs.
//! - `changes` builds the PDF with the changes between two versions marked.
//! - `build_log` turns latexmk's log into editor diagnostics and a trimmed
//!   copy for the Log tab.
//! - `synctex` maps positions between the compiled PDF and its sources.
//! - `venue` reads which conference template a document's preamble loads.
//! - `arxiv` makes and checks the source pack an arXiv submission needs.
//! - `pinned` is the research environment's build: root, engine, rc files
//!   and clock fixed so an agent cannot change what is graded.
//!
//! This file holds what they share: which document is built, and the PDF.

use crate::models::{Diagnostic, ProjectManifest, RootDocument};
use crate::{commands, project};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

mod arxiv;
mod bib_log;
mod build;
mod build_log;
mod build_steps;
mod changes;
mod diagnostic_paths;
mod engine_mismatch;
mod pinned;
mod preamble_format;
mod prewarm;
mod synctex;
mod venue;

pub use arxiv::{
    check as check_arxiv, export as export_arxiv, ArxivCheck, ArxivChecks, ArxivOptions,
};
/// Register an already-running process as a project's build, for tests that
/// need one in flight without launching latexmk. They must still hand over a
/// process they own — abort signals a whole process group.
#[cfg(test)]
pub(crate) use build::begin_active as begin_for_test;
pub use build::{abort, build, classify_build_error, clean, ActiveBuild};
pub(crate) use build_log::{is_pass_noise_warning, unwrap_log_lines};
pub use build_steps::{BuildStep, BuildSteps};
pub use changes::{export_changes_pdf, ChangesPdf, ChangesPdfOptions};
pub use pinned::{build_pinned, PinnedBuild};
pub use synctex::{
    body_pages, forward_search, heading_pages, inverse_search, BodySpan, SourceLine,
};
pub(crate) use venue::document_venue;

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

/// latexmk for a root document named relative to `root`, which holds the
/// project's rc file. `-cd` typesets in the document's own folder, as
/// Overleaf, TeXShop and LaTeX Workshop do: its `\input`s resolve from there,
/// and its PDF, SyncTeX map, .aux and .log land beside it, where everything
/// here reads them. From `root` instead, a document in a subfolder left its
/// fresh PDF at the top while the preview showed whatever stale one sat
/// beside it. latexmk still reads `root`'s rc file before it changes folder.
fn latexmk(root: &Path) -> Command {
    let mut command = commands::command("latexmk");
    command.current_dir(root).arg("-cd");
    unwrapped_log(&mut command);
    command
}

/// TeX breaks its terminal output and log at `max_print_line`, 79 characters
/// by default, mid-path and mid-message: a long file name reached the
/// diagnostics cut short (`e_here/deep.tex`, which cannot be opened), and so
/// did the message. Every run whose output is read is told never to wrap.
fn unwrapped_log(command: &mut Command) -> &mut Command {
    command.env("max_print_line", "10000")
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
    /// The conference template the typeset document loaded ("NeurIPS"), by
    /// the log rather than the manifest: the welcome screen's badge on the
    /// project's first page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue: Option<&'static str>,
    /// The passes latexmk (and any draft prewarm) ran, in order.
    pub steps: Vec<BuildStep>,
    /// How many pages the last pass wrote, as TeX's log says.
    pub pages: Option<u32>,
    /// Whether the PDF has its SyncTeX map beside it; absent with no PDF.
    pub synctex: Option<bool>,
    /// The project files TeX wrote, by the root document's `.fls` recorder.
    /// The project watcher reports them like any change, and an automatic
    /// build must not take a package's unfamiliar output for an edit and
    /// compile again, and again.
    pub outputs: Vec<String>,
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
