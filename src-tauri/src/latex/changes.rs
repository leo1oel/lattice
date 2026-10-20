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

use super::build::engine_args;
use super::build_log::parse_diagnostics;
use super::{default_root_document, latexmk};
use crate::{commands, git, project};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Mark the changes from `from` to `to` (the files now, when `None`) in the
/// project's root document and save the result beside its PDF.
pub fn export_changes_pdf(
    root: &Path, from: &str, to: Option<&str>, options: ChangesPdfOptions,
) -> Result<ChangesPdf, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?.path.replace('\\', "/");
    if !document.to_ascii_lowercase().ends_with(".tex") {
        return Err("Only a LaTeX document can be exported with its changes marked.".to_string());
    }
    let latexdiff = commands::resolve("latexdiff");
    if !commands::available("latexdiff") {
        return Err(LATEXDIFF_MISSING.to_string());
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

    let marked = changes_name(&document, "tex");
    let mut first_failure = None;
    for simplified in [false, true] {
        let attempt = latexdiff_output(&latexdiff, &older, &newer, &document, options, simplified)
            .and_then(|tex| {
                fs::write(newer.join(&marked), with_markup(&tex, options))
                    .map_err(|error| error.to_string())
            })
            .and_then(|()| build_marked(&newer, &marked, &manifest));
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
            Err(reason) => {
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
    latexdiff: &Path, older: &Path, newer: &Path, document: &str, options: ChangesPdfOptions,
    simplified: bool,
) -> Result<String, String> {
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
    let output = command.output().map_err(|error| format!("Could not run latexdiff: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        return Err(format!("latexdiff could not compare the two versions: {reason}"));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("latexdiff wrote invalid text: {error}"))
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
    newer: &Path, marked: &str, manifest: &crate::models::ProjectManifest,
) -> Result<PathBuf, String> {
    let output = latexmk(newer)
        .args(["-interaction=nonstopmode", "-file-line-error", "-halt-on-error"])
        .args(engine_args(newer, manifest))
        .arg(marked)
        .output()
        .map_err(|error| format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))?;
    let pdf = newer.join(marked).with_extension("pdf");
    if output.status.success() && pdf.is_file() {
        return Ok(pdf);
    }
    let log = commands::combined_output(&output);
    let first_error =
        parse_diagnostics(&log).into_iter().find(|diagnostic| diagnostic.level == "error");
    Err(match first_error {
        Some(error) => format!("The PDF with changes marked did not build: {}", error.message),
        None => "The PDF with changes marked did not build.".to_string(),
    })
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
        let tex = latexdiff_output(&latexdiff, &older, &newer, "main.tex", OPTIONS, false).unwrap();
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
        let saved = export_changes_pdf(&root, from.trim(), None, every).unwrap();
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
        assert!(!export_changes_pdf(&root, from.trim(), None, plain).unwrap().simplified);
    }
}
