//! The TeX doctor: which tools a build needs are present and runnable, and
//! whether the open project's own requirements (root document, bibliography,
//! conference packages and fonts) are met.

use crate::commands;
use crate::models::{DoctorCheck, DoctorReport, ProjectManifest};
use crate::{latex, pdf_fonts, project};
use std::path::{Path, PathBuf};

/// Times and Helvetica metrics and Type1 outlines. NeurIPS / ICML templates set
/// `\rmdefault` to Times (`ptm`); without these, bare BasicTeX compiles without
/// error but falls back to other fonts. The metrics (tfm/fd) can exist while
/// the outlines are missing, so both are required.
pub(crate) const CONFERENCE_FONT_FILES: [&str; 6] =
    ["t1ptm.fd", "ptmr8t.tfm", "t1phv.fd", "utmr8a.pfb", "utmb8a.pfb", "uhvr8a.pfb"];

/// Tools a build runs, with the argument that proves each one works.
const RUNNABLE_TOOLS: [(&str, &str, &str); 6] = [
    ("latexmk", "-version", "LaTeX build driver"),
    ("pdflatex", "--version", "pdfLaTeX engine"),
    ("xelatex", "--version", "XeLaTeX engine"),
    ("lualatex", "--version", "LuaLaTeX engine"),
    ("synctex", "help", "SyncTeX bidirectional search"),
    ("bibtex", "--version", "BibTeX bibliography processor"),
];

/// Tools that only need to be found.
const PRESENT_TOOLS: [(&str, &str); 4] = [
    ("biber", "Biber bibliography processor"),
    ("texlab", "TexLab language server (optional editor diagnostics)"),
    ("git", "Git (optional project status / commit panel)"),
    ("texcount", "TeXcount body word counts (optional status bar)"),
];

pub fn run(root: Option<&Path>) -> DoctorReport {
    let mut checks: Vec<DoctorCheck> =
        RUNNABLE_TOOLS.iter().map(|(name, arg, detail)| runnable_tool(name, arg, detail)).collect();
    for (name, detail) in PRESENT_TOOLS {
        checks.push(if commands::available(name) {
            check(name, format!("{detail}: {}", commands::resolve(name).display()), true)
        } else {
            coded(check(name, format!("{detail}: not found on PATH"), false), "tool-not-found", &[])
        });
    }
    for (name, detail) in [
        ("uv", "Python tooling used for literature and bibliography tools"),
        ("uvx", "Runner used for Lattice's pinned literature tools"),
    ] {
        checks.push(match commands::managed_uv_tool_status(name) {
            Ok(path) => check(name, format!("{detail}: {}", path.display()), true),
            Err(error) => coded(
                check(name, format!("{detail}: {error}"), false),
                "managed-tool-failed",
                &[("error", &error)],
            ),
        });
    }

    match root.map(|root| (root, project::read_manifest(root))) {
        Some((root, Ok(manifest))) => checks.extend(project_checks(root, &manifest)),
        Some((_, Err(error))) => checks.push(check("project-root", error, false)),
        None => checks.push(check(
            "project-root",
            "No project open — open a folder to validate manuscript paths.".to_string(),
            true,
        )),
    }

    if let Ok(output) = commands::command("latexmk").arg("-v").output() {
        let text = commands::combined_output(&output);
        let line = text.lines().next().unwrap_or("latexmk available").trim();
        checks.push(check("latexmk-version", line.to_string(), output.status.success()));
    }

    checks.push(kpsewhich_check(
        "conference-fonts",
        "fonts",
        &CONFERENCE_FONT_FILES,
        |found| format!("Times/Helvetica Type1 outlines found on disk. {}", found.join("; ")),
        "PDF text will look wrong even if .tfm exists. Click Install BasicTeX in Lattice (watch Terminal for FONTS OK), then Shift-click Build.",
    ));
    checks.extend(root.and_then(project_pdf_fonts));

    let required_ok = ["latexmk", "synctex", "bibtex", "uv", "uvx", "conference-fonts"]
        .into_iter()
        .all(|name| checks.iter().any(|item| item.name == name && item.ok))
        && checks.iter().any(|item| {
            matches!(item.name.as_str(), "pdflatex" | "xelatex" | "lualatex") && item.ok
        });

    DoctorReport { ok: required_ok, summary: format_summary(&checks, required_ok), checks }
}

/// The root document and bibliography exist, and the venue's packages are installed.
fn project_checks(root: &Path, manifest: &ProjectManifest) -> Vec<DoctorCheck> {
    let exists = |relative: &str| {
        project::safe_path(root, relative).map(|path| path.exists()).unwrap_or(false)
    };
    let missing = |exists: bool| if exists { "" } else { " (missing)" };
    let document = latex::default_root(manifest);
    let root_exists = document.is_some_and(|document| exists(&document.path));
    let root_path = document.map_or("(none)", |document| document.path.as_str());
    let engine = &manifest.engine;
    let project = root.display().to_string();
    let detail =
        format!("Project {project} · engine {engine} · root {root_path}{}", missing(root_exists));
    let mut root_check = check("project-root", detail, root_exists);
    if !root_exists {
        let params = [("project", project.as_str()), ("engine", engine), ("document", root_path)];
        root_check = coded(root_check, "root-document-missing", &params);
    }
    let bibliography = &manifest.primary_bibliography;
    let bib_exists = exists(bibliography);
    let mut bib_check = check(
        "bibliography",
        format!("Primary bibliography {bibliography}{}", missing(bib_exists)),
        bib_exists,
    );
    if !bib_exists {
        bib_check = coded(bib_check, "bibliography-missing", &[("file", bibliography)]);
    }
    let mut checks = vec![root_check, bib_check];
    if manifest.venue.eq_ignore_ascii_case("icml") {
        // The ICML style needs `algorithms`, which bare BasicTeX lacks until
        // it or collection-latexextra is installed.
        checks.push(kpsewhich_check(
            "icml-packages",
            "ICML packages",
            &["algorithm.sty", "algorithmic.sty"],
            |_| "ICML algorithm packages found (algorithm.sty, algorithmic.sty).".into(),
            "ICML Build will Emergency stop. In Terminal: sudo tlmgr install algorithms   (or click Install BasicTeX in Lattice).",
        ));
    } else if manifest.venue.eq_ignore_ascii_case("neurips") {
        // The NeurIPS style pulls in `lineno` and `natbib`, and the template's
        // main.tex a handful more. None ship with bare BasicTeX, and a
        // toolchain that is otherwise fine still dies on the first one missing.
        checks.push(kpsewhich_check(
            "neurips-packages",
            "NeurIPS packages",
            &["natbib.sty", "lineno.sty", "environ.sty", "nicefrac.sty", "microtype.sty", "booktabs.sty"],
            |_| "NeurIPS template packages found (natbib, lineno, environ, nicefrac, microtype, booktabs).".into(),
            "NeurIPS Build will Emergency stop. In Terminal: sudo tlmgr install collection-latexextra   (or click Install BasicTeX in Lattice).",
        ));
    }
    checks
}

fn runnable_tool(name: &str, version_arg: &str, detail: &str) -> DoctorCheck {
    let path = commands::resolve(name).display().to_string();
    let error = match commands::command(name).arg(version_arg).output() {
        Ok(output) if output.status.success() => {
            return check(name, format!("{detail}: {path}"), true)
        }
        Ok(output) => String::from_utf8_lossy(&output.stderr).trim().to_string(),
        Err(error) => error.to_string(),
    };
    let failed = check(name, format!("{detail}: {path} could not run: {error}"), false);
    coded(failed, "tool-failed", &[("path", &path), ("error", &error)])
}

/// Whether kpsewhich finds every one of `files`. `found` describes success
/// from the `name → path` pairs; a failure lists what is missing, then `hint`.
fn kpsewhich_check(
    name: &str, subject: &str, files: &[&str], found: impl FnOnce(&[String]) -> String, hint: &str,
) -> DoctorCheck {
    if !commands::available("kpsewhich") {
        let detail =
            format!("Cannot verify {subject} (kpsewhich missing). Install BasicTeX from Lattice.");
        return coded(check(name, detail, false), "kpsewhich-missing", &[]);
    }
    let mut located = Vec::new();
    let mut missing = Vec::new();
    for file in files {
        match kpsewhich(file) {
            Some(path) => located.push(format!("{file} → {}", path.display())),
            None => missing.push(*file),
        }
    }
    if missing.is_empty() {
        check(name, found(&located), true)
    } else {
        let files = missing.join(", ");
        coded(
            check(name, format!("Missing {files} — {hint}"), false),
            "files-missing",
            &[("files", &files)],
        )
    }
}

/// Inspect the project's compiled PDF (if present) — no poppler/`pdffonts` needed.
fn project_pdf_fonts(root: &Path) -> Option<DoctorCheck> {
    let manifest = project::read_manifest(root).ok()?;
    let document = latex::default_root(&manifest)?;
    let pdf_path = project::safe_path(root, &document.path).ok()?.with_extension("pdf");
    if !pdf_path.exists() {
        let file_name = pdf_path.file_name().and_then(|name| name.to_str()).unwrap_or("main.pdf");
        let detail = format!(
            "No {file_name} yet — Build once and Recheck; Lattice will verify NeurIPS Times without pdffonts."
        );
        return Some(check("pdf-embedded-fonts", detail, true));
    }
    Some(match pdf_fonts::inspect_pdf_path(&pdf_path) {
        // Inconclusive scans (compressed streams we cannot name) are not failures.
        Ok(report) => {
            let ok = !report.conclusive || report.ok_for_conference;
            let fonts = check("pdf-embedded-fonts", report.detail, ok);
            match report.problem.filter(|_| !ok) {
                Some(code) => coded(fonts, code, &[("fonts", &report.fonts)]),
                None => fonts,
            }
        }
        Err(error) => {
            let path = pdf_path.display().to_string();
            let failed =
                check("pdf-embedded-fonts", format!("Could not read {path}: {error}"), false);
            coded(failed, "pdf-unreadable", &[("path", &path), ("error", &error)])
        }
    })
}

/// Where kpsewhich finds `name`, if that file can also be opened.
fn kpsewhich(name: &str) -> Option<PathBuf> {
    let output = commands::command("kpsewhich").arg(name).output().ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || path.is_empty() {
        return None;
    }
    let path = PathBuf::from(path);
    std::fs::File::open(&path).ok().map(|_| path)
}

fn check(name: &str, detail: String, ok: bool) -> DoctorCheck {
    let (code, params) = (None, Default::default());
    DoctorCheck { name: name.to_string(), detail, ok, code, params }
}

/// `check` with the message code the interface translates its detail by
/// (src/build/tex-doctor-messages.ts); `detail` stays the English text.
fn coded(
    mut check: DoctorCheck, code: &'static str, params: &[(&'static str, &str)],
) -> DoctorCheck {
    check.code = Some(code);
    check.params = params.iter().map(|(name, value)| (*name, value.to_string())).collect();
    check
}

fn format_summary(checks: &[DoctorCheck], required_ok: bool) -> String {
    let status = if required_ok { "ready" } else { "missing required tools" };
    let mut lines =
        vec!["Lattice TeX doctor".to_string(), format!("Status: {status}"), String::new()];
    for item in checks {
        let state = if item.ok { "OK" } else { "MISSING" };
        lines.push(format!("{state} {} — {}", item.name, item.detail));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_reports_tex_environment() {
        let report = run(None);
        assert!(report.summary.contains("Lattice TeX doctor"));
    }
}
