use crate::commands;
use crate::models::{DoctorCheck, DoctorReport};
use crate::pdf_fonts;
use crate::project;
use std::path::Path;

pub fn run(root: Option<&Path>, agent_executable: &Path, agent_assets: &Path) -> DoctorReport {
    let mut checks = Vec::new();
    push_tool(&mut checks, "latexmk", "LaTeX build driver");
    push_tool(&mut checks, "pdflatex", "pdfLaTeX engine");
    push_tool(&mut checks, "xelatex", "XeLaTeX engine");
    push_tool(&mut checks, "lualatex", "LuaLaTeX engine");
    push_tool(&mut checks, "synctex", "SyncTeX bidirectional search");
    push_tool(&mut checks, "bibtex", "BibTeX bibliography processor");
    push_tool(&mut checks, "biber", "Biber bibliography processor");
    push_tool(
        &mut checks,
        "texlab",
        "TexLab language server (optional editor diagnostics)",
    );
    push_tool(
        &mut checks,
        "git",
        "Git (optional project status / commit panel)",
    );
    push_tool(
        &mut checks,
        "texcount",
        "TeXcount body word counts (optional status bar)",
    );
    push_tool(&mut checks, "uv", "Python tooling used by research skills");
    push_tool(&mut checks, "npx", "Node helper used by bibcite skill");

    let agent_ok = agent_executable.is_file();
    checks.push(check(
        "lattice-agent",
        if agent_ok {
            format!("Bundled agent runtime at {}", agent_executable.display())
        } else {
            format!(
                "Missing bundled agent runtime at {}",
                agent_executable.display()
            )
        },
        agent_ok,
    ));
    let assets_ok = agent_assets.is_dir();
    checks.push(check(
        "omp-assets",
        if assets_ok {
            format!("OMP assets at {}", agent_assets.display())
        } else {
            format!("Missing OMP assets at {}", agent_assets.display())
        },
        assets_ok,
    ));

    if let Some(root) = root {
        match project::read_manifest(root) {
            Ok(manifest) => {
                let root_document = manifest
                    .root_documents
                    .iter()
                    .find(|document| document.is_default)
                    .or_else(|| manifest.root_documents.first());
                let root_path = root_document
                    .map(|document| document.path.as_str())
                    .unwrap_or("(none)");
                let root_exists = root_document
                    .map(|document| {
                        project::safe_path(root, &document.path)
                            .map(|path| path.exists())
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                checks.push(check(
                    "project-root",
                    format!(
                        "Project {} · engine {} · root {}{}",
                        root.display(),
                        manifest.engine,
                        root_path,
                        if root_exists { "" } else { " (missing)" }
                    ),
                    root_exists,
                ));
                let bib = project::safe_path(root, &manifest.primary_bibliography)
                    .map(|path| path.exists())
                    .unwrap_or(false);
                checks.push(check(
                    "bibliography",
                    format!(
                        "Primary bibliography {}{}",
                        manifest.primary_bibliography,
                        if bib { "" } else { " (missing)" }
                    ),
                    bib,
                ));
                if manifest.venue.eq_ignore_ascii_case("icml") {
                    push_icml_packages(&mut checks);
                }
            }
            Err(error) => checks.push(check("project-root", error, false)),
        }
    } else {
        checks.push(check(
            "project-root",
            "No project open — open a folder to validate manuscript paths.".to_string(),
            true,
        ));
    }

    if let Ok(output) = commands::command("latexmk").arg("-v").output() {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let line = text.lines().next().unwrap_or("latexmk available").trim();
        checks.push(check(
            "latexmk-version",
            line.to_string(),
            output.status.success(),
        ));
    }

    push_conference_fonts(&mut checks);
    push_project_pdf_fonts(&mut checks, root);

    let required_ok = [
        "latexmk",
        "synctex",
        "bibtex",
        "lattice-agent",
        "omp-assets",
    ]
    .into_iter()
    .all(|name| checks.iter().any(|item| item.name == name && item.ok))
        && checks.iter().any(|item| {
            matches!(item.name.as_str(), "pdflatex" | "xelatex" | "lualatex") && item.ok
        });

    DoctorReport {
        ok: required_ok,
        summary: format_summary(&checks, required_ok),
        checks,
    }
}

fn push_tool(checks: &mut Vec<DoctorCheck>, name: &str, detail: &str) {
    let path = commands::resolve(name);
    let ok = commands::available(name);
    checks.push(check(
        name,
        if ok {
            format!("{detail}: {}", path.display())
        } else {
            format!("{detail}: not found on PATH")
        },
        ok,
    ));
}

/// ICML style requires `algorithms` (algorithm.sty + algorithmic.sty). Bare BasicTeX
/// often lacks it until `collection-latexextra` / `algorithms` is installed.
fn push_icml_packages(checks: &mut Vec<DoctorCheck>) {
    if !commands::available("kpsewhich") {
        checks.push(check(
            "icml-packages",
            "Cannot verify ICML packages (kpsewhich missing). Install BasicTeX from Lattice."
                .to_string(),
            false,
        ));
        return;
    }
    let required = ["algorithm.sty", "algorithmic.sty"];
    let mut missing = Vec::new();
    for name in required {
        if kpsewhich(name).is_none() {
            missing.push(name);
        }
    }
    if missing.is_empty() {
        checks.push(check(
            "icml-packages",
            "ICML algorithm packages found (algorithm.sty, algorithmic.sty).".to_string(),
            true,
        ));
    } else {
        checks.push(check(
            "icml-packages",
            format!(
                "Missing {} — ICML Build will Emergency stop. In Terminal: sudo tlmgr install algorithms   (or click Install BasicTeX in Lattice).",
                missing.join(", ")
            ),
            false,
        ));
    }
}

/// NeurIPS / ICML templates set `\rmdefault` to Times (`ptm`). Bare BasicTeX often
/// compiles without error but falls back to ugly fonts when these files are missing.
fn push_conference_fonts(checks: &mut Vec<DoctorCheck>) {
    if !commands::available("kpsewhich") {
        checks.push(check(
            "conference-fonts",
            "Cannot verify fonts (kpsewhich missing). Install BasicTeX from Lattice.".to_string(),
            false,
        ));
        return;
    }
    // Metrics (tfm/fd) can exist while Type1 outlines are missing — then pdfTeX
    // falls back to ugly bitmaps / CM and the PDF looks nothing like NeurIPS.
    let required = [
        "t1ptm.fd",
        "ptmr8t.tfm",
        "t1phv.fd",
        "utmr8a.pfb",
        "utmb8a.pfb",
        "uhvr8a.pfb",
    ];
    let mut missing = Vec::new();
    let mut found = Vec::new();
    for name in required {
        match kpsewhich(name) {
            Some(path) => found.push(format!("{name} → {}", path.display())),
            None => missing.push(name.to_string()),
        }
    }
    if missing.is_empty() {
        checks.push(check(
            "conference-fonts",
            format!(
                "Times/Helvetica Type1 outlines found on disk. {}",
                found.join("; ")
            ),
            true,
        ));
    } else {
        checks.push(check(
            "conference-fonts",
            format!(
                "Missing {} — PDF text will look wrong even if .tfm exists. Click Install BasicTeX in Lattice (watch Terminal for FONTS OK), then Shift-click Build.",
                missing.join(", ")
            ),
            false,
        ));
    }
}

/// Inspect the project's compiled PDF (if present) — no poppler/`pdffonts` needed.
fn push_project_pdf_fonts(checks: &mut Vec<DoctorCheck>, root: Option<&Path>) {
    let Some(root) = root else {
        return;
    };
    let Ok(manifest) = project::read_manifest(root) else {
        return;
    };
    let Some(document) = manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
    else {
        return;
    };
    let Ok(tex_path) = project::safe_path(root, &document.path) else {
        return;
    };
    let pdf_path = tex_path.with_extension("pdf");
    if !pdf_path.exists() {
        checks.push(check(
            "pdf-embedded-fonts",
            format!(
                "No {} yet — Build once and Recheck; Lattice will verify NeurIPS Times without pdffonts.",
                pdf_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("main.pdf")
            ),
            true,
        ));
        return;
    }
    match pdf_fonts::inspect_pdf_path(&pdf_path) {
        Ok(report) => checks.push(check(
            "pdf-embedded-fonts",
            report.detail,
            // Inconclusive scans (compressed streams we cannot name) are not failures.
            !report.conclusive || report.ok_for_conference,
        )),
        Err(error) => checks.push(check(
            "pdf-embedded-fonts",
            format!("Could not read {}: {error}", pdf_path.display()),
            false,
        )),
    }
}

fn kpsewhich(name: &str) -> Option<std::path::PathBuf> {
    let output = commands::command("kpsewhich").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(path))
    }
}

fn check(name: &str, detail: String, ok: bool) -> DoctorCheck {
    DoctorCheck {
        name: name.to_string(),
        detail,
        ok,
    }
}

fn format_summary(checks: &[DoctorCheck], required_ok: bool) -> String {
    let mut lines = vec![
        "Lattice TeX doctor".to_string(),
        if required_ok {
            "Status: ready".to_string()
        } else {
            "Status: missing required tools".to_string()
        },
        String::new(),
    ];
    for item in checks {
        lines.push(format!(
            "{} {} — {}",
            if item.ok { "OK" } else { "MISSING" },
            item.name,
            item.detail
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;
    use uuid::Uuid;

    #[test]
    fn doctor_reports_missing_agent_runtime() {
        let missing = temp_dir().join(format!("missing-agent-{}", Uuid::new_v4()));
        let report = run(None, &missing, &missing);
        assert!(report
            .checks
            .iter()
            .any(|item| item.name == "lattice-agent" && !item.ok));
        assert!(report.summary.contains("Lattice TeX doctor"));
    }
}
