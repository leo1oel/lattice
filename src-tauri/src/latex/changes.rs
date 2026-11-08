//! The PDF with changes marked, the one a rebuttal or camera-ready asks for:
//! latexdiff between two versions of the root document, then built like the
//! paper.
//!
//! Both versions are written out in a scratch folder and the marked document
//! is built beside the newer one's figures and bibliography, so neither the
//! project nor its own build output is touched until the finished PDF is
//! copied in beside the paper's (`main.tex` → `main-changes.pdf`).
//!
//! latexdiff is not robust against every macro, so a document whose marked
//! version does not build is tried once more with plainer markup: maths,
//! figures and citations unmarked. Only when that fails too is it an error.
//!
//! Neither latexdiff nor the build may run away (#658): each runs under the
//! time and memory limits in `guard`, and stops when the writer cancels, the
//! project closes or Lattice quits. `\input` files that read each other,
//! which would make `latexdiff --flatten` recurse forever, are named before
//! it starts (`input_loop`). A child stopped by any of these ends the export;
//! the plainer markup would not have finished either.

mod guard;
mod input_loop;
mod review;

use super::build::engine_args;
use super::build_log::parse_diagnostics;
use super::{default_root_document, latexmk};
use crate::{commands, git, project};
pub use guard::ChangesExports;
use guard::{Limits, Ran, Stop, BUILD_LIMITS, LATEXDIFF_LIMITS};
pub use review::review_changes_pdf;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// How the changes are drawn, chosen in the export sheet.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPdfOptions {
    /// Insertions in blue, deletions in red; otherwise underlined and struck in the text colour.
    pub colour: bool,
    /// Deleted text stays in, struck through; otherwise it is left out.
    pub keep_deleted: bool,
    /// A bar in the margin beside every change.
    pub margin_bars: bool,
    /// Pages without a change are left out.
    pub only_changed_pages: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPdf {
    /// Where the PDF was saved, relative to the project.
    pub path: String,
    /// The first attempt did not build, and this one marks only the prose.
    pub simplified: bool,
}

const LATEXDIFF_MISSING: &str = "latexdiff is not installed. It comes with MacTeX; with BasicTeX, run “sudo tlmgr install latexdiff” in Terminal, then export again.";

/// Where latexdiff's own definitions end; ours follow and win.
const PREAMBLE_END: &str = "%DIF END PREAMBLE EXTENSION ADDED BY LATEXDIFF";

const CANCELLED: &str = "The export with changes marked was cancelled.";

/// Why an attempt did not produce the PDF.
enum Failed {
    /// latexdiff or the build failed; plainer markup may get through.
    Attempt(String),
    /// Stopped, or nothing to retry: the export ends with this.
    Export(String),
}

impl From<String> for Failed {
    fn from(reason: String) -> Self {
        Self::Attempt(reason)
    }
}

/// Mark the changes from `from` to `to` (the files now, when `None`) in the
/// project's root document and save the result beside its PDF, as `export`,
/// the number `exports.begin()` gave it; once a later export or a cancel
/// has taken over, its children are not started.
pub fn export_changes_pdf(
    root: &Path, from: &str, to: Option<&str>, options: ChangesPdfOptions,
    exports: &ChangesExports, export: u64,
) -> Result<ChangesPdf, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?.path.replace('\\', "/");
    if !document.to_ascii_lowercase().ends_with(".tex") {
        return Err("Only a LaTeX document can be exported with its changes marked.".to_string());
    }
    let scratch = Scratch::new()?;
    let (older, newer) = (scratch.0.join("from"), scratch.0.join("to"));
    git::write_version(root, Some(from), &older)?;
    git::write_version(root, to, &newer)?;
    if !older.join(&document).is_file() {
        return Err(format!(
            "{document} is not in the older version, so there is nothing to mark its changes against."
        ));
    }
    if !newer.join(&document).is_file() {
        return Err(format!("{document} is not in the newer version."));
    }
    if let Some(chain) = input_loop::input_loop(&newer, &document) {
        return Err(format!("In the newer version, {} read each other with \\input, so latexdiff would never finish. Remove the \\input that closes the loop, then export again.", chain.join(" → ")));
    }
    if let Some(chain) = input_loop::input_loop(&older, &document) {
        return Err(format!("In the older version, {} read each other with \\input, so latexdiff would never finish. Compare from a version after the loop was removed.", chain.join(" → ")));
    }
    let latexdiff = commands::resolve("latexdiff");
    if !commands::available("latexdiff") {
        return Err(LATEXDIFF_MISSING.to_string());
    }
    let run = Runner { exports, export, capture: &scratch.0 };

    let marked = changes_name(&document, "tex");
    let mut first_failure = None;
    for simplified in [false, true] {
        let attempt =
            latexdiff_output(&run, &latexdiff, &older, &newer, &document, options, simplified)
                .and_then(|tex| {
                    fs::write(newer.join(&marked), with_markup(&tex, options))
                        .map_err(|error| Failed::Attempt(error.to_string()))
                })
                .and_then(|()| build_marked(&run, &newer, &marked, &manifest));
        match attempt {
            Ok(pdf) => {
                let saved = changes_name(&document, "pdf");
                let target = project::safe_path(root, &saved)?;
                fs::copy(&pdf, &target)
                    .map_err(|error| format!("Could not save {saved}: {error}"))?;
                // Keep it out of version history, like the paper's own PDF.
                let _ = project::ensure_ignore_line(&root.join(".gitignore"), &format!("/{saved}"));
                return Ok(ChangesPdf { path: saved, simplified });
            }
            Err(Failed::Export(reason)) => return Err(reason),
            Err(Failed::Attempt(reason)) => {
                log::warn!(target: "lattice::changes_pdf", "attempt (simplified: {simplified}) failed: {reason}");
                first_failure.get_or_insert(reason);
            }
        }
    }
    Err(first_failure.unwrap_or_default())
}

/// `paper/main.tex` → `paper/main-changes.<extension>`.
fn changes_name(document: &str, extension: &str) -> String {
    let stem = document.strip_suffix(".tex").or_else(|| document.strip_suffix(".TEX"));
    format!("{}-changes.{extension}", stem.unwrap_or(document))
}

/// latexdiff's marked document, flattened so changes in `\input` files are
/// marked too. Section titles stay unmarked (markup in a moving argument
/// breaks the table of contents), and displayed maths is marked whole.
fn latexdiff_output(
    run: &Runner, latexdiff: &Path, older: &Path, newer: &Path, document: &str,
    options: ChangesPdfOptions, simplified: bool,
) -> Result<String, Failed> {
    let mut command = commands::with_child_path(Command::new(latexdiff));
    command.current_dir(newer).args([
        "--flatten",
        "--no-label",
        "--type=UNDERLINE",
        "--exclude-textcmd=section,subsection",
    ]);
    command.arg(if options.only_changed_pages {
        "--subtype=ONLYCHANGEDPAGE"
    } else {
        "--subtype=SAFE"
    });
    command.arg(if simplified { "--math-markup=off" } else { "--math-markup=whole" });
    // Pages are dropped by marks that floats copy, which latexdiff refuses to
    // combine with marking figures.
    if simplified || options.only_changed_pages {
        command.arg("--graphics-markup=none");
    }
    if simplified {
        command.arg("--disable-citation-markup");
    }
    command.arg(older.join(document)).arg(newer.join(document));
    let output =
        run.output(command, LATEXDIFF_LIMITS, "latexdiff").map_err(|failed| match failed {
            Failed::Attempt(error) => Failed::Export(format!("Could not run latexdiff: {error}")),
            stopped => stopped,
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        return Err(format!("latexdiff could not compare the two versions: {reason}").into());
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("latexdiff wrote invalid text: {error}").into())
}

/// The marks the sheet asked for, defined after latexdiff's own.
fn with_markup(tex: &str, options: ChangesPdfOptions) -> String {
    let block = markup_definitions(options);
    if let Some(at) = tex.find(PREAMBLE_END) {
        let end = tex[at..].find('\n').map_or(tex.len(), |line| at + line + 1);
        return format!("{}{block}{}", &tex[..end], &tex[end..]);
    }
    match tex.find("\\begin{document}") {
        Some(at) => format!("{}{block}{}", &tex[..at], &tex[at..]),
        None => tex.to_string(),
    }
}

fn markup_definitions(options: ChangesPdfOptions) -> String {
    let added = if options.colour { r"{\protect\color{blue}\uwave{#1}}" } else { r"{\uwave{#1}}" };
    let deleted = match (options.keep_deleted, options.colour) {
        (false, _) => "{}",
        (true, true) => r"{\protect\color{red}\sout{#1}}",
        (true, false) => r"{\sout{#1}}",
    };
    let mut lines = vec!["%DIF LATTICE MARKUP".to_string()];
    if options.margin_bars {
        // In the left margin, where a reader's eye starts each line; grey
        // unless the changes are in colour, when they take the insertions' blue.
        if options.colour {
            lines.push(r"\RequirePackage[leftbars,color]{changebar}".to_string());
            lines.push(r"\cbcolor{blue}".to_string());
        } else {
            lines.push(r"\RequirePackage[leftbars]{changebar}".to_string());
        }
        lines
            .push(format!(r"\renewcommand{{\DIFadd}}[1]{{\protect\cbstart{added}\protect\cbend}}"));
        lines.push(format!(
            r"\renewcommand{{\DIFdel}}[1]{{\protect\cbdelete{deleted}\protect\cbdelete}}"
        ));
    } else {
        lines.push(format!(r"\renewcommand{{\DIFadd}}[1]{{{added}}}"));
        lines.push(format!(r"\renewcommand{{\DIFdel}}[1]{{{deleted}}}"));
    }
    lines.push("%DIF END LATTICE MARKUP".to_string());
    lines.iter().map(|line| format!("{line}\n")).collect()
}

/// Build the marked document in the newer version's folder, as the paper is
/// built; the PDF's path, or the first error the log names.
fn build_marked(
    run: &Runner, newer: &Path, marked: &str, manifest: &crate::models::ProjectManifest,
) -> Result<PathBuf, Failed> {
    let mut command = latexmk(newer);
    command
        .args(["-interaction=nonstopmode", "-file-line-error", "-halt-on-error"])
        .args(engine_args(newer, manifest))
        .arg(marked);
    let output = run.output(command, BUILD_LIMITS, "latexmk").map_err(|failed| match failed {
        Failed::Attempt(error) => {
            Failed::Export(format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))
        }
        stopped => stopped,
    })?;
    let pdf = newer.join(marked).with_extension("pdf");
    if output.status.success() && pdf.is_file() {
        return Ok(pdf);
    }
    let log = commands::combined_output(&output);
    let first_error =
        parse_diagnostics(&log).into_iter().find(|diagnostic| diagnostic.level == "error");
    Err(Failed::Attempt(match first_error {
        Some(error) => format!("The PDF with changes marked did not build: {}", error.message),
        None => "The PDF with changes marked did not build.".to_string(),
    }))
}

/// One export's children, run under its limits and stopped with it.
struct Runner<'a> {
    exports: &'a ChangesExports,
    export: u64,
    capture: &'a Path,
}

impl Runner<'_> {
    /// The child's output once it exits; a child that could not start is an
    /// `Attempt` with the OS error, one that was stopped ends the export.
    fn output(&self, command: Command, limits: Limits, tool: &str) -> Result<Output, Failed> {
        match self.exports.run(self.export, command, limits, self.capture, tool) {
            Ok(Ran::Finished(output)) => Ok(output),
            Ok(Ran::Stopped(stop)) => Err(Failed::Export(stopped(tool, stop))),
            Err(error) => Err(Failed::Attempt(error.to_string())),
        }
    }
}

/// What the writer reads when `tool` was stopped, and what to try next.
fn stopped(tool: &str, stop: Stop) -> String {
    let gigabytes = |bytes: u64| format!("{:.1}", bytes as f64 / (1024.0 * 1024.0 * 1024.0));
    match (tool, stop) {
        (_, Stop::Cancelled) => CANCELLED.to_string(),
        ("latexdiff", Stop::TimedOut(time)) => format!("latexdiff was stopped after {} minutes without finishing. Compare two versions closer together, or move a very large generated file (a data table, a long listing) out of an \\input, then export again.", time.as_secs() / 60),
        ("latexdiff", Stop::OutOfMemory(bytes)) => format!("latexdiff was stopped when it used {} GB of memory. Compare two versions closer together, or move a very large generated file (a data table, a long listing) out of an \\input, then export again.", gigabytes(bytes)),
        (_, Stop::TimedOut(time)) => format!("The PDF with changes marked was stopped after {} minutes without finishing its build. Build the paper itself to check that it finishes, then export again.", time.as_secs() / 60),
        (_, Stop::OutOfMemory(bytes)) => format!("The PDF with changes marked was stopped when its build used {} GB of memory. Build the paper itself to check that it finishes, then export again.", gigabytes(bytes)),
    }
}

/// A private folder for one export, removed when it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("lattice-changes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const OPTIONS: ChangesPdfOptions = ChangesPdfOptions {
        colour: true,
        keep_deleted: true,
        margin_bars: false,
        only_changed_pages: false,
    };

    #[test]
    fn the_marked_file_and_pdf_sit_beside_the_paper() {
        assert_eq!(changes_name("main.tex", "pdf"), "main-changes.pdf");
        assert_eq!(changes_name("paper/rebuttal.tex", "tex"), "paper/rebuttal-changes.tex");
    }

    #[test]
    fn the_sheet_s_choices_follow_latexdiff_s_own_definitions() {
        let tex = format!(
            "\\documentclass{{article}}\n{PREAMBLE_END}\n\\begin{{document}}x\\end{{document}}\n"
        );
        let marked = with_markup(&tex, OPTIONS);
        let ours = marked.find("%DIF LATTICE MARKUP").unwrap();
        assert!(
            ours > marked.find(PREAMBLE_END).unwrap()
                && ours < marked.find("\\begin{document}").unwrap()
        );
        assert!(marked.contains(r"\renewcommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}"));
        assert!(marked.contains(r"\renewcommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}"));

        let plain =
            markup_definitions(ChangesPdfOptions { colour: false, keep_deleted: false, ..OPTIONS });
        assert!(plain.contains(r"\renewcommand{\DIFadd}[1]{{\uwave{#1}}}"));
        assert!(plain.contains(r"\renewcommand{\DIFdel}[1]{{}}"));
        assert!(!plain.contains("color"));

        let bars = markup_definitions(ChangesPdfOptions { margin_bars: true, ..OPTIONS });
        assert!(
            bars.contains(r"\RequirePackage[leftbars,color]{changebar}")
                && bars.contains(r"\cbcolor{blue}")
        );
        assert!(bars.contains(r"\protect\cbstart{\protect\color{blue}\uwave{#1}}\protect\cbend"));

        // Without latexdiff's marker the definitions still land in the preamble.
        let bare =
            with_markup("\\documentclass{article}\n\\begin{document}x\\end{document}\n", OPTIONS);
        assert!(
            bare.find("%DIF LATTICE MARKUP").unwrap() < bare.find("\\begin{document}").unwrap()
        );
    }

    fn repository(name: &str) -> TempDir {
        let root = TempDir::new(name);
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "lattice@example.com"],
            &["config", "user.name", "Lattice"],
        ] {
            assert!(Command::new("git").current_dir(&*root).args(args).status().unwrap().success());
        }
        root.write(".gitignore", ".research/\n");
        root
    }

    fn commit(root: &Path) -> String {
        let git =
            |args: &[&str]| Command::new("git").current_dir(root).args(args).output().unwrap();
        assert!(
            git(&["add", "-A"]).status.success() && git(&["commit", "-qm", "v"]).status.success()
        );
        String::from_utf8(git(&["rev-parse", "HEAD"]).stdout).unwrap().trim().to_string()
    }

    /// #658: `latexdiff --flatten` recursed forever on these, so the loop is
    /// named before it starts, in whichever version has it.
    #[test]
    fn inputs_that_read_each_other_are_refused_before_latexdiff_runs() {
        let root = repository("changes-loop");
        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}\n",
        );
        root.write("a.tex", "A\n\\input{b}\n");
        root.write("b.tex", "B\n");
        let clean = commit(&root);
        root.write("b.tex", "B\n\\input{a}\n");
        let looped = commit(&root);
        let exports = ChangesExports::default();

        let error = export_changes_pdf(&root, &clean, None, OPTIONS, &exports, exports.begin())
            .unwrap_err();
        assert_eq!(error, "In the newer version, main.tex → a.tex → b.tex → a.tex read each other with \\input, so latexdiff would never finish. Remove the \\input that closes the loop, then export again.");

        root.write("b.tex", "B again\n");
        let error = export_changes_pdf(&root, &looped, None, OPTIONS, &exports, exports.begin())
            .unwrap_err();
        assert!(
            error.starts_with("In the older version, main.tex → a.tex → b.tex → a.tex"),
            "{error}"
        );
    }

    /// The whole path on a real repository: two versions of a paper with an
    /// `\input` chapter, every option on, then the plain one.
    #[test]
    #[ignore = "requires git, latexdiff and a working pdfLaTeX installation"]
    fn exports_a_pdf_with_the_changes_between_two_versions_marked() {
        let root = TempDir::new("changes-pdf");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git").current_dir(&*root).args(args).status().unwrap();
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "lattice@example.com"]);
        git(&["config", "user.name", "Lattice"]);
        root.write(".gitignore", ".research/\n");
        let paper = |body: &str| {
            format!("\\documentclass{{article}}\n\\begin{{document}}\n\\section{{Intro}}\n{body}\n\\input{{chapter}}\n\\end{{document}}\n")
        };
        root.write("main.tex", paper("Additive attention let a decoder look at encoder states."));
        root.write("chapter.tex", "Attention maps explain predictions.\n");
        git(&["add", "-A"]);
        git(&["commit", "-qm", "Submitted"]);
        let from = String::from_utf8(
            Command::new("git")
                .current_dir(&*root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        root.write(
            "main.tex",
            paper("Additive attention let a decoder retrieve different encoder states."),
        );
        root.write("chapter.tex", "Attention maps describe routing weights.\n");

        // The chapter is flattened in, so its change is marked as well.
        let (older, newer) = (TempDir::new("changes-older"), TempDir::new("changes-newer"));
        git::write_version(&root, Some(from.trim()), &older).unwrap();
        git::write_version(&root, None, &newer).unwrap();
        let latexdiff = commands::resolve("latexdiff");
        let (exports, capture) = (ChangesExports::default(), TempDir::new("changes-capture"));
        let run = Runner { exports: &exports, export: exports.begin(), capture: &capture };
        let Ok(tex) =
            latexdiff_output(&run, &latexdiff, &older, &newer, "main.tex", OPTIONS, false)
        else {
            panic!("latexdiff failed");
        };
        assert!(
            tex.contains(r"\DIFadd{retrieve different") && tex.contains(r"\DIFdel{look at"),
            "{tex}"
        );
        assert!(tex.contains(r"\DIFadd{describe routing weights}"), "{tex}");

        let every = ChangesPdfOptions {
            colour: true,
            keep_deleted: true,
            margin_bars: true,
            only_changed_pages: true,
        };
        let saved =
            export_changes_pdf(&root, from.trim(), None, every, &exports, exports.begin()).unwrap();
        assert_eq!((saved.path.as_str(), saved.simplified), ("main-changes.pdf", false));
        assert!(fs::read(root.join("main-changes.pdf")).unwrap().starts_with(b"%PDF-"));
        assert!(fs::read_to_string(root.join(".gitignore")).unwrap().contains("/main-changes.pdf"));
        // Nothing else lands in the project.
        assert!(!root.join("main-changes.tex").exists() && !root.join("main-changes.aux").exists());

        let plain = ChangesPdfOptions {
            colour: false,
            keep_deleted: false,
            margin_bars: false,
            only_changed_pages: false,
        };
        assert!(
            !export_changes_pdf(&root, from.trim(), None, plain, &exports, exports.begin())
                .unwrap()
                .simplified
        );
    }
}
