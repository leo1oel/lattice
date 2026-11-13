//! LaTeX builds through latexmk, and what they leave behind.
//!
//! - `build` runs latexmk for a project's default root document, one build at
//!   a time and abortable from the UI; `prewarm` shortens a cold first build;
//!   `preamble_format` keeps a pdfLaTeX format of the document's preamble so
//!   passes skip loading it; `build_steps` times the passes it runs.
//! - `changes` builds the PDF with the changes between two versions marked,
//!   and review mode's, with the changes since its base.
//! - `compile_root` picks the document a build compiles: the manifest
//!   default, or a standalone figure open in the editor, built once.
//! - `aux_files` is where a build leaves the intermediate files: beside the
//!   document, or in a hidden folder (a global setting).
//! - `build_log` turns latexmk's log into editor diagnostics and a trimmed
//!   copy for the Log tab; `cjk_text` explains CJK text the build dropped.
//! - `synctex` maps positions between the compiled PDF and its sources;
//!   `shown_pdf` puts the last PDF and its map back when a build leaves none.
//! - `venue` reads which conference template a document's preamble loads.
//! - `arxiv` makes and checks the source pack an arXiv submission needs.
//! - `figure_preview` typesets one figure alone in a scratch folder, for the
//!   agent to look at before it inserts the figure.
//! - `pinned` is the research environment's build: root, engine, rc files
//!   and clock fixed so an agent cannot change what is graded.
//!
//! This file holds what they share: which document is built, and the PDF.

use crate::models::{Diagnostic, ProjectManifest, RootDocument};
use crate::{commands, project};
use compile_root::compiled_document;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

mod arxiv;
pub(crate) mod aux_files;
mod bib_log;
mod build;
mod build_log;
mod build_stall;
mod build_steps;
mod changes;
mod cjk_text;
mod compile_root;
mod diagnostic_paths;
mod engine_mismatch;
mod figure_preview;
mod outdated_lineno;
mod package_order;
mod pinned;
mod preamble_format;
mod prewarm;
mod rc_failure;
mod search_paths;
mod shown_pdf;
mod submission_review;
mod synctex;
mod venue;

pub use arxiv::journal::{export as export_journal, JournalExport, JournalOptions};
pub(crate) use arxiv::written_by_recorder;
pub use arxiv::{
    check as check_arxiv, export as export_arxiv, ArxivCheck, ArxivChecks, ArxivOptions,
    ArxivPackage, Bibliography, CommentLine, CompileOutcome,
};
pub use aux_files::AuxFiles;
/// Register an already-running process as a project's build, for tests that
/// need one in flight without launching latexmk. They must still hand over a
/// process they own — abort signals a whole process group.
#[cfg(all(test, unix))]
pub(crate) use build::begin_active as begin_for_test;
pub use build::{abort, build, classify_build_error, clean, is_running, ActiveBuild};
pub(crate) use build_log::{is_pass_noise_warning, unwrap_log_lines};
pub use build_steps::{BuildStep, BuildSteps};
pub use changes::{
    export_changes_pdf, review_changes_pdf, ChangesExports, ChangesPdf, ChangesPdfOptions,
};
pub use figure_preview::{preview_figure, FigurePreview, FigurePreviewRequest};
pub use pinned::{build_pinned, PinnedBuild};
pub use submission_review::{review_submission, SubmissionReview};
pub use synctex::{
    body_pages, forward_search, forward_search_in, heading_pages, inverse_search,
    inverse_search_in, BodySpan, SourceLine,
};
pub(crate) use venue::{document_venue, strip_comment};

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
/// TeXShop and LaTeX Workshop do: its `\input`s resolve from there, and its
/// PDF lands beside it, with the SyncTeX map, .aux and .log unless the hidden
/// build folder takes those (`latexmk_into`, `aux_files`). Overleaf typesets in the project folder instead, so a build
/// also searches that (`search_paths`). From `root` instead, a document in a subfolder left its
/// fresh PDF at the top while the preview showed whatever stale one sat
/// beside it. latexmk still reads `root`'s rc file before it changes folder.
///
/// That rc file, and the user's own `~/.latexmkrc`, may move the output or
/// start a previewer, which nothing here can follow: `$out_dir`/`$aux_dir`
/// built the PDF into a subfolder while the preview kept the stale one beside
/// the document, and `$preview_continuous_mode` kept latexmk watching for
/// edits so the build never ended. Command-line options outrank every rc
/// file, so `LATEXMK_OVERRIDES` pin those back and leave the rc's other rules
/// (engines, custom dependencies) in force.
fn latexmk(root: &Path) -> Command {
    latexmk_into(root, AuxFiles::Beside, "")
}

/// `latexmk`, with the intermediate files of `document` (relative to `root`)
/// written where `layout` puts them (`aux_files`). The hidden folder is named
/// by its full path: `-cd` changes folder before latexmk reads the option.
/// latexmk hands TeX `-output-directory` and moves the PDF and SyncTeX map
/// out beside the document after each pass that wrote them.
fn latexmk_into(root: &Path, layout: AuxFiles, document: &str) -> Command {
    let mut command = commands::command("latexmk");
    command.current_dir(root).arg("-cd").args(LATEXMK_OVERRIDES);
    if layout == AuxFiles::Hidden {
        let folder = aux_files::folder(root, document, layout);
        #[cfg(windows)]
        let folder = PathBuf::from(crate::host_paths::tex_path(&folder));
        // After `-auxdir=.` in the overrides: the last one wins.
        command.arg(format!("-auxdir={}", folder.display()));
    }
    unwrapped_log(&mut command);
    command
}

/// Output beside the document (relative to it, after `-cd`), no previewer,
/// no watching for changes. See `latexmk`.
const LATEXMK_OVERRIDES: [&str; 4] = ["-outdir=.", "-auxdir=.", "-pv-", "-pvc-"];

/// TeX breaks its terminal output and log at `max_print_line`, 79 characters
/// by default, mid-path and mid-message: a long file name reached the
/// diagnostics cut short (`e_here/deep.tex`, which cannot be opened), and so
/// did the message. Every run whose output is read is told never to wrap.
fn unwrapped_log(command: &mut Command) -> &mut Command {
    command.env("max_print_line", "10000")
}

fn compiled_pdf_path(root: &Path) -> Result<PathBuf, String> {
    let manifest = project::read_manifest(root)?;
    let document = compiled_document(root, &manifest)?;
    Ok(project::safe_path(root, &document)?.with_extension("pdf"))
}

/// Whether the compiled PDF is missing the SyncTeX file that pairs with it.
fn synctex_missing(root: &Path) -> bool {
    let compiled =
        project::read_manifest(root).and_then(|manifest| compiled_document(root, &manifest));
    compiled.is_ok_and(|document| lacks_synctex(root, &document))
}

/// Whether the PDF of `document` (relative to `root`) exists without the
/// SyncTeX file that pairs with it, beside it or in the hidden build folder.
fn lacks_synctex(root: &Path, document: &str) -> bool {
    root.join(document).with_extension("pdf").is_file()
        && aux_files::synctex(root, document).is_none()
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

/// The PDF this copy last built of `document`, a root document other than
/// the one on screen, for its own preview tab (`shown_pdf::kept`). Never the
/// PDF beside the document, which a sync may have replaced with a
/// collaborator's build.
pub fn read_kept_pdf(root: &Path, document: &str) -> Result<Vec<u8>, String> {
    let path = shown_pdf::kept(root, document)
        .ok_or_else(|| format!("{document} has not been built in Lattice yet."))?;
    let bytes =
        fs::read(&path).map_err(|error| format!("The compiled PDF could not be read: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    Ok(bytes)
}

/// Where the copy `read_kept_pdf` reads lives, for a viewer that reads the
/// file itself: `None` until this copy has built `document`.
pub fn kept_pdf_path(root: &Path, document: &str) -> Option<PathBuf> {
    shown_pdf::kept(root, document)
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
    /// `root_document` compiled this once (a standalone figure, a subfiles
    /// chapter) and is not the manifest default: the frontend must not adopt
    /// it as one.
    pub one_off: bool,
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
    /// Nothing the document reads changed since its last build, which failed,
    /// and nobody asked for this one (`build::unchanged`): the result restates
    /// that build's errors, and the PDF and SyncTeX map on disk are its, of
    /// these same inputs. Nothing was typeset or written.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    /// The project-relative folder holding this build's `.aux` and the other
    /// intermediate files (`aux_files`): the document's own folder, or its
    /// mirror under the hidden build folder. Empty for the project root. The
    /// frontend reads the `.aux` there for the numbers a build gave labels.
    pub aux_folder: String,
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
