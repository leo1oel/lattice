use crate::commands;
use crate::models::{BuildResult, Diagnostic};
use crate::project;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

pub fn build(root: &Path) -> Result<BuildResult, String> {
    let manifest = project::read_manifest(root)?;
    let document = manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        .ok_or_else(|| "The project has no root document.".to_string())?;
    let root_document = project::safe_path(root, &document.path)?;
    if !root_document.exists() {
        return Err(format!("Root document not found: {}", document.path));
    }

    let started = Instant::now();
    let mut command = Command::new(commands::resolve("latexmk"));
    command
        .current_dir(root)
        .arg("-pdf")
        .arg("-interaction=nonstopmode")
        .arg("-synctex=1")
        .arg("-file-line-error")
        .arg("-halt-on-error");
    if !manifest.trusted {
        command.arg("-no-shell-escape");
    }
    command.arg(&document.path);
    let output = command
        .output()
        .map_err(|error| format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let success = output.status.success();
    let pdf_path = root_document.with_extension("pdf");
    let pdf_base64 = if pdf_path.exists() {
        Some(STANDARD.encode(fs::read(pdf_path).map_err(|error| error.to_string())?))
    } else {
        None
    };

    Ok(BuildResult {
        success,
        pdf_base64,
        diagnostics: parse_diagnostics(&log),
        log: trim_log(&log),
        duration_ms: started.elapsed().as_millis(),
    })
}

fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    let file_line = Regex::new(r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(.+)$").unwrap();
    let warning = Regex::new(r"(?m)^(?:LaTeX|Package .+?) Warning:\s*(.+)$").unwrap();
    let mut diagnostics: Vec<Diagnostic> = file_line
        .captures_iter(log)
        .take(20)
        .map(|capture| Diagnostic {
            file: Some(capture[1].to_string()),
            line: capture[2].parse().ok(),
            level: "error".to_string(),
            message: capture[3].trim().to_string(),
        })
        .collect();
    diagnostics.extend(
        warning
            .captures_iter(log)
            .take(20)
            .map(|capture| Diagnostic {
                file: None,
                line: None,
                level: "warning".to_string(),
                message: capture[1].trim().to_string(),
            }),
    );
    diagnostics
}

fn trim_log(log: &str) -> String {
    const LIMIT: usize = 30_000;
    if log.len() <= LIMIT {
        log.to_string()
    } else {
        format!("…\n{}", &log[log.len() - LIMIT..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("lattice-latex-e2e-{}", Uuid::new_v4()))
    }

    #[test]
    #[ignore = "requires a local latexmk installation"]
    fn creates_and_builds_a_real_project() {
        let parent = temp_root();
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let result = build(&root).unwrap();
        assert!(result.success, "{}", result.log);
        assert!(result.pdf_base64.is_some());
        fs::remove_dir_all(parent).unwrap();
    }
}
