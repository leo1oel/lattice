//! The research environment's build: Lattice's latexmk run with everything
//! an agent could use to change what gets graded pinned down.
//!
//! The app's `build` follows the writer's context on purpose: it retargets
//! the root onto the open file, switches engines when the log says so,
//! honours a project `.latexmkrc` and builds from a cached preamble format.
//! Here the root and engine come from the task, latexmk runs with `-norc`
//! (no rc file, which is Perl, runs), there is no shell escape and no format
//! cache, TeX's user trees and HOME are the episode's own, and the clock is
//! pinned (`SOURCE_DATE_EPOCH` with `FORCE_SOURCE_DATE`), without which every
//! PDF carries the time it was built and no two builds compare equal.
//!
//! The log is read with the app's own parser, so an agent sees the same
//! diagnostics a writer does. Nothing in the app calls this.

use super::build::{abort, cancelled_build, run_tracked, ActiveBuild};
use super::build_log::{log_conference_template, pages_written, parse_diagnostics, trim_log};
use super::{BuildResult, BuildSteps};
use crate::{commands, project};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Variables that would redirect TeX's search or configuration; the
/// operator's own environment, not the agent's, but cleared all the same so
/// two machines build alike.
const TEX_SEARCH_VARIABLES: [&str; 9] = [
    "TEXINPUTS",
    "BIBINPUTS",
    "BSTINPUTS",
    "TEXFONTS",
    "TFMFONTS",
    "TEXMFCNF",
    "TEXMFLOCAL",
    "TEXMFHOME",
    "TEXMFVAR",
];

pub struct PinnedBuild<'a> {
    /// Project-relative path of the root document.
    pub document: &'a str,
    /// Lattice's engine name (`pdf`, `xelatex`, `lualatex`). Only pdfTeX's
    /// output has been verified byte-identical across runs and folders.
    pub engine: &'a str,
    /// Seconds since the epoch that every timestamp in the PDF reads.
    pub epoch: u64,
    /// The episode's own HOME; TeX's user trees go inside it.
    pub home: &'a Path,
    pub timeout: Duration,
}

/// Build `root` as `options` pins it; a build that runs past the timeout is
/// stopped and reported like one the writer stopped.
pub fn build_pinned(root: &Path, options: &PinnedBuild) -> Result<BuildResult, String> {
    let document = project::safe_path(root, options.document)?;
    if !document.is_file() {
        return Err(format!("Root document not found: {}", options.document));
    }
    let mut command = commands::command("latexmk");
    super::unwrapped_log(&mut command).current_dir(root);
    for variable in TEX_SEARCH_VARIABLES {
        command.env_remove(variable);
    }
    for (variable, tree) in
        [("TEXMFHOME", "texmf"), ("TEXMFVAR", "texmf-var"), ("TEXMFCONFIG", "texmf-config")]
    {
        let path = options.home.join(tree);
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        command.env(variable, path);
    }
    command
        .env("HOME", options.home)
        .env("SOURCE_DATE_EPOCH", options.epoch.to_string())
        .env("FORCE_SOURCE_DATE", "1")
        .env("TZ", "UTC")
        .args(["-norc", "-interaction=nonstopmode", "-synctex=1", "-file-line-error"])
        .args(["-halt-on-error", project::latexmk_engine_arg(options.engine), "-no-shell-escape"])
        .arg(options.document);

    let active = ActiveBuild::default();
    let steps = BuildSteps::new(|_, _| {});
    let (done, finished) = mpsc::channel::<()>();
    let watchdog = {
        let active = active.clone();
        let timeout = options.timeout;
        std::thread::spawn(move || {
            if finished.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                let _ = abort(&active);
            }
        })
    };
    let ran = run_tracked(
        command,
        &active,
        &steps,
        "Could not start latexmk. Install MacTeX or TeX Live. ",
        "latexmk exited unexpectedly: ",
    );
    let _ = done.send(());
    let _ = watchdog.join();
    let (output, cancelled) = ran?;
    let log = commands::combined_output(&output);
    if cancelled {
        return Ok(cancelled_build(steps.started(), &log, options.document));
    }
    let pdf = document.with_extension("pdf");
    let tex_log = fs::read_to_string(document.with_extension("log")).unwrap_or_default();
    let has_pdf = pdf.is_file();
    Ok(BuildResult {
        success: output.status.success() && has_pdf,
        has_pdf,
        diagnostics: parse_diagnostics(&log),
        log: trim_log(&log),
        duration_ms: steps.started().elapsed().as_millis(),
        root_document: options.document.to_string(),
        venue: log_conference_template(&tex_log).or_else(|| log_conference_template(&log)),
        steps: steps.take(),
        pages: pages_written(&tex_log),
        synctex: has_pdf.then(|| synctex_beside(&pdf)),
        outputs: Vec::new(),
    })
}

fn synctex_beside(pdf: &Path) -> bool {
    let with = |extension: &str| -> PathBuf { pdf.with_extension(extension) };
    with("synctex.gz").is_file() || with("synctex").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn pinned(home: &Path) -> PinnedBuild<'_> {
        PinnedBuild {
            document: "main.tex",
            engine: "pdf",
            epoch: 1_700_000_000,
            home,
            timeout: Duration::from_secs(60),
        }
    }

    #[test]
    fn a_missing_root_document_is_an_error_not_a_failed_build() {
        let root = TempDir::new("pinned");
        let home = TempDir::new("pinned-home");
        let error = build_pinned(&root, &pinned(&home)).unwrap_err();
        assert!(error.starts_with("Root document not found"), "{error}");
    }

    #[test]
    #[ignore = "requires latexmk and pdfLaTeX"]
    fn builds_ignore_a_project_rc_file_and_are_byte_identical_across_folders() {
        let main = "\\documentclass{article}\n\\begin{document}\nHello \\today.\n\\end{document}\n";
        let build = || {
            let root = TempDir::new("pinned");
            let home = TempDir::new("pinned-home");
            root.write("main.tex", main);
            // Under Lattice's ordinary build this rc file would run.
            root.write(".latexmkrc", "system('touch rc-ran');\n");
            let result = build_pinned(&root, &pinned(&home)).unwrap();
            assert!(result.success, "{}", result.log);
            assert!(!root.join("rc-ran").exists(), "the project rc file ran");
            fs::read(root.join("main.pdf")).unwrap()
        };
        assert_eq!(build(), build());
    }

    #[test]
    #[ignore = "requires latexmk and pdfLaTeX"]
    fn a_runaway_build_is_stopped_at_the_timeout() {
        let root = TempDir::new("pinned");
        let home = TempDir::new("pinned-home");
        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n",
        );
        let mut options = pinned(&home);
        options.timeout = Duration::from_secs(3);
        let result = build_pinned(&root, &options).unwrap();
        assert!(!result.success);
        assert_eq!(result.diagnostics[0].code, Some("build-cancelled"));
    }
}
