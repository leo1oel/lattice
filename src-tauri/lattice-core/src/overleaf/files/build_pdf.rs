//! The PDFs this copy's builds write, which never sync in either direction:
//! each is generated here, and Overleaf compiles its own (LATA-51).
//!
//! Before, only the default root document's PDF stayed out. A project with
//! several root documents (a paper, its supplement, last year's version)
//! uploaded the others' PDFs on every build, which moved Overleaf's version
//! and made every collaborator download again, and two people building the
//! same one changed a binary file on both sides: a conflict copy of the PDF.
//!
//! So the PDF of every \documentclass file stays out, root document or not,
//! at any depth, along with each root document the manifest lists. The one
//! exception is a PDF a source includes (\includegraphics, \includepdf): a
//! standalone figure built here that the paper uses, which Overleaf cannot
//! build itself and so must have. A file already on Overleaf under such a
//! name stays there untouched; it simply never comes down.

use super::{is_excluded, APP_FOLDERS};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// Compared without case, as the disk is.
#[derive(Clone, Debug, Default, PartialEq)]
pub(in crate::overleaf) struct BuildPdf(BTreeSet<String>);

impl BuildPdf {
    /// Read from this copy's manifest and sources on every sync, so a PDF
    /// that stops being build output (its document deleted, or a source
    /// starting to include it) syncs again.
    pub fn of(root: &Path) -> Self {
        let manifest = crate::project::read_manifest(root).ok();
        let mut pdfs = BTreeSet::new();
        let mut included = Vec::new();
        if let Some(manifest) = &manifest {
            pdfs.extend(crate::project::default_root_pdf(manifest));
            for document in &manifest.root_documents {
                pdfs.extend(pdf_of(&document.path.replace('\\', "/")));
            }
        }
        for (rel, text) in sources(root) {
            if text.contains("\\documentclass") {
                pdfs.extend(pdf_of(&rel));
            }
            included.extend(includes(&text));
        }
        let default = manifest.as_ref().and_then(crate::project::default_root_pdf);
        let default = default.map(|pdf| pdf.to_ascii_lowercase());
        let pdfs = (pdfs.into_iter())
            .map(|pdf| pdf.to_ascii_lowercase())
            .filter(|pdf| Some(pdf) == default.as_ref() || !included.iter().any(|r| names(pdf, r)))
            .collect();
        Self(pdfs)
    }

    pub fn is(&self, path: &str) -> bool {
        self.0.contains(&path.to_ascii_lowercase())
    }
}

fn pdf_of(tex: &str) -> Option<String> {
    let split = tex.len().checked_sub(".tex".len())?;
    let (stem, extension) = (tex.get(..split)?, tex.get(split..)?);
    (!stem.is_empty() && extension.eq_ignore_ascii_case(".tex")).then(|| format!("{stem}.pdf"))
}

/// Every syncable .tex file of the project, with its text.
fn sources(root: &Path) -> Vec<(String, String)> {
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|entry| {
        entry.depth() == 0
            || !(entry.file_type().is_dir()
                && APP_FOLDERS.contains(&entry.file_name().to_string_lossy().as_ref()))
    });
    walker
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let rel = entry.path().strip_prefix(root).ok()?;
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>();
            let rel = rel.join("/");
            let tex = rel.to_ascii_lowercase().ends_with(".tex") && !is_excluded(&rel);
            tex.then(|| Some((rel, fs::read_to_string(entry.path()).ok()?))).flatten()
        })
        .collect()
}

/// What `text`'s \includegraphics and \includepdf name, lower-cased,
/// without a leading `./`. Comments are not told apart: keeping a commented
/// out figure syncing errs on the side of the file Overleaf may need.
fn includes(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for command in ["\\includegraphics", "\\includepdf"] {
        for (at, _) in text.match_indices(command) {
            let rest = text[at + command.len()..].trim_start_matches('*').trim_start();
            let rest = match rest.strip_prefix('[') {
                Some(options) => options.split_once(']').map_or("", |(_, rest)| rest).trim_start(),
                None => rest,
            };
            let Some(arg) = rest.strip_prefix('{').and_then(|arg| arg.split_once('}')) else {
                continue;
            };
            let arg = arg.0.trim().replace('\\', "/").to_ascii_lowercase();
            let mut arg = arg.as_str();
            while let Some(rest) = arg.strip_prefix("./").or_else(|| arg.strip_prefix("../")) {
                arg = rest;
            }
            let arg = arg.to_string();
            if !arg.is_empty() {
                found.push(arg);
            }
        }
    }
    found
}

/// Whether the include `reference` (relative to any folder, with or without
/// its extension) names `pdf`.
fn names(pdf: &str, reference: &str) -> bool {
    let target = if reference.ends_with(".pdf") { pdf } else { pdf.trim_end_matches(".pdf") };
    target.strip_suffix(reference).is_some_and(|rest| rest.is_empty() || rest.ends_with('/'))
}
