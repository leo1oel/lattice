//! Prime a cold conventional pdfLaTeX project without writing throwaway PDFs.
//!
//! The visible output is still produced by the unchanged latexmk path, which
//! remains responsible for convergence and may run as many normal passes as it
//! needs. This only replaces its earliest full-output passes with cheaper
//! draft passes, and deliberately declines custom or stateful build setups.

use super::build::{cancelled_build, run_tracked, ActiveBuild};
use super::default_root_document;
use crate::commands;
use crate::latex::BuildResult;
use crate::models::ProjectManifest;
use crate::project;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

// Two draft passes are only a net win when normal passes would repeatedly
// encode a substantial graphics payload. Small projects keep the direct path.
const GRAPHICS_THRESHOLD: u64 = 8 * 1024 * 1024;

/// Every extension a build leaves beside the root document. Any of them means
/// the project is not cold; a prewarm that gives up removes the ones it wrote.
const ARTIFACTS: &str = "aux bbl bcf blg fdb_latexmk fls idx ilg ind lof log lot nav out pdf \
    run.xml snm synctex synctex.gz toc";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bibliography {
    None,
    Bibtex,
    Unsupported,
}

/// What the first draft pass's .aux says the bibliography needs.
fn bibliography(aux: &str) -> Bibliography {
    if aux.contains("\\abx@aux") || aux.contains("\\@input{") {
        return Bibliography::Unsupported;
    }
    let has = |command: &str| aux.lines().any(|line| line.starts_with(command));
    match (has("\\bibdata{"), has("\\bibstyle{")) {
        (false, false) => Bibliography::None,
        (true, true) => Bibliography::Bibtex,
        _ => Bibliography::Unsupported,
    }
}

fn is_candidate(
    root: &Path, root_document: &Path, document_path: &str, manifest: &ProjectManifest, force: bool,
) -> bool {
    !force
        && !manifest.trusted
        && manifest.engine == "pdf"
        && !project::has_latexmkrc(root)
        && Path::new(document_path).components().count() == 1
        && ARTIFACTS
            .split_whitespace()
            .all(|extension| !root_document.with_extension(extension).exists())
}

fn has_large_graphics_payload(root: &Path) -> bool {
    let is_graphics = |path: &Path| {
        path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "eps" | "jb2" | "jbig2" | "jpeg" | "jpg" | "pdf" | "png"
            )
        })
    };
    let mut bytes = 0_u64;
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|entry| entry.file_type().is_file() && is_graphics(entry.path()))
        .any(|entry| {
            bytes = bytes.saturating_add(entry.metadata().map_or(0, |metadata| metadata.len()));
            bytes >= GRAPHICS_THRESHOLD
        })
}

pub(super) fn prewarm_cold_pdf_build(
    root: &Path, force: bool, active: &ActiveBuild, started: Instant,
) -> Result<Option<BuildResult>, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let root_document = project::safe_path(root, &document.path)?;
    if !is_candidate(root, &root_document, &document.path, &manifest, force)
        || !commands::available("pdflatex")
        || !commands::available("bibtex")
        || !has_large_graphics_payload(root)
    {
        return Ok(None);
    }

    let prewarm_started = Instant::now();
    let mut passes =
        DraftPasses { root, document_path: &document.path, active, log: String::new() };
    match passes.run(&root_document.with_extension("aux")) {
        Ok(()) => log::info!(
            target: "lattice::latex",
            "Draft-prewarmed {} in {:.1}s; latexmk will produce and verify the final PDF",
            document.path,
            prewarm_started.elapsed().as_secs_f32()
        ),
        Err(Stop::Cancelled) => {
            return Ok(Some(cancelled_build(started, &passes.log, &document.path)))
        }
        Err(Stop::Abandoned) => {
            for extension in ARTIFACTS.split_whitespace() {
                let _ = fs::remove_file(root_document.with_extension(extension));
            }
        }
    }
    Ok(None)
}

/// Why the draft passes ended early.
enum Stop {
    /// The user stopped the build.
    Cancelled,
    /// Something did not work; leave the build to latexmk from a clean slate.
    Abandoned,
}

struct DraftPasses<'a> {
    root: &'a Path,
    document_path: &'a str,
    active: &'a ActiveBuild,
    log: String,
}

impl DraftPasses<'_> {
    /// pdfLaTeX, BibTeX when the .aux asks for plain BibTeX, then pdfLaTeX.
    fn run(&mut self, aux: &Path) -> Result<(), Stop> {
        self.pdflatex()?;
        match fs::read_to_string(aux).map(|aux| bibliography(&aux)) {
            Ok(Bibliography::None) => {}
            Ok(Bibliography::Bibtex) => {
                let stem = Path::new(self.document_path).file_stem().and_then(|name| name.to_str());
                let mut bibtex = commands::command("bibtex");
                bibtex.arg(stem.ok_or(Stop::Abandoned)?);
                self.pass(bibtex, "BibTeX")?;
            }
            _ => return Err(Stop::Abandoned),
        }
        self.pdflatex()
    }

    fn pdflatex(&mut self) -> Result<(), Stop> {
        let mut pdflatex = commands::command("pdflatex");
        pdflatex.args([
            "-draftmode",
            "-interaction=nonstopmode",
            "-synctex=0",
            "-file-line-error",
            "-halt-on-error",
            "-no-shell-escape",
            self.document_path,
        ]);
        self.pass(pdflatex, "pdfLaTeX")
    }

    fn pass(&mut self, mut command: Command, label: &str) -> Result<(), Stop> {
        command.current_dir(self.root);
        let (output, cancelled) = run_tracked(
            command,
            self.active,
            &format!("Could not start the {label} draft prewarm: "),
            &format!("The {label} draft prewarm stopped unexpectedly: "),
        )
        .map_err(|_| Stop::Abandoned)?;
        if !self.log.is_empty() {
            self.log.push('\n');
        }
        self.log.push_str(&commands::combined_output(&output));
        match (cancelled, output.status.success()) {
            (true, _) => Err(Stop::Cancelled),
            (false, true) => Ok(()),
            (false, false) => Err(Stop::Abandoned),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn draft_prewarm_only_accepts_conventional_bibliographies() {
        for (aux, expected) in [
            ("\\relax\n", Bibliography::None),
            ("\\citation{paper}\n\\bibdata{references}\n\\bibstyle{plain}\n", Bibliography::Bibtex),
            ("\\abx@aux@refcontext{nty/global//global/global/global}\n", Bibliography::Unsupported),
            ("\\@input{chapters/results.aux}\n", Bibliography::Unsupported),
            ("\\bibdata{references}\n", Bibliography::Unsupported),
        ] {
            assert_eq!(bibliography(aux), expected, "{aux}");
        }
    }

    #[test]
    fn draft_prewarm_requires_a_large_graphics_payload() {
        let root = TempDir::new("latex");
        fs::write(root.join("notes.txt"), vec![0; 1024]).unwrap();
        assert!(!has_large_graphics_payload(&root));

        let image = fs::File::create(root.join("figure.pdf")).unwrap();
        image.set_len(GRAPHICS_THRESHOLD).unwrap();
        assert!(has_large_graphics_payload(&root));
    }

    #[test]
    fn draft_prewarm_is_only_for_pristine_simple_pdftex_projects() {
        let root = TempDir::new("latex");
        let root_document = root.write("main.tex", "\\documentclass{article}\n");
        let manifest = project::default_manifest("paper");
        let candidate = |manifest: &ProjectManifest, force| {
            is_candidate(&root, &root_document, "main.tex", manifest, force)
        };

        assert!(candidate(&manifest, false));
        assert!(!candidate(&manifest, true));
        let trusted = ProjectManifest { trusted: true, ..manifest.clone() };
        assert!(!candidate(&trusted, false));

        let aux = root.write("main.aux", "generated");
        assert!(!candidate(&manifest, false));
        fs::remove_file(aux).unwrap();
        root.write("latexmkrc", "$pdf_mode = 1;");
        assert!(!candidate(&manifest, false));
    }
}
