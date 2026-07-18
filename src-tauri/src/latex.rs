use crate::commands;
use crate::models::{BuildResult, Diagnostic, SyncTexTarget};
use crate::project;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::fs;
use std::path::Path;
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
    let mut command = commands::command("latexmk");
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

pub fn save_pdf(path: &Path, pdf_base64: &str) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("Choose where to save the PDF.".to_string());
    }
    let destination = match path.extension().and_then(|extension| extension.to_str()) {
        None => path.with_extension("pdf"),
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => path.to_path_buf(),
        Some(_) => return Err("The exported paper must use the .pdf extension.".to_string()),
    };
    let bytes = STANDARD
        .decode(pdf_base64)
        .map_err(|error| format!("The compiled PDF could not be decoded: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

pub fn inverse_search(root: &Path, page: u32, x: f64, y: f64) -> Result<SyncTexTarget, String> {
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("Invalid PDF source position.".to_string());
    }
    let manifest = project::read_manifest(root)?;
    let document = manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        .ok_or_else(|| "The project has no root document.".to_string())?;
    let pdf_path = Path::new(&document.path).with_extension("pdf");
    if !root.join(&pdf_path).is_file() {
        return Err("Build the project before locating PDF source.".to_string());
    }
    let output = commands::command("synctex")
        .current_dir(root)
        .arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x:.3}:{y:.3}:{}", pdf_path.display()))
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "SyncTeX could not locate this PDF position. {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let (input, line) = parse_synctex_edit(&String::from_utf8_lossy(&output.stdout))?;
    let absolute = if Path::new(&input).is_absolute() {
        Path::new(&input).to_path_buf()
    } else {
        root.join(&input)
    };
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_input = absolute.canonicalize().map_err(|error| error.to_string())?;
    let relative = canonical_input
        .strip_prefix(&canonical_root)
        .map_err(|_| "SyncTeX returned a source file outside this project.".to_string())?;
    Ok(SyncTexTarget {
        path: relative.to_string_lossy().to_string(),
        line,
    })
}

fn parse_synctex_edit(output: &str) -> Result<(String, u32), String> {
    let input = output
        .lines()
        .find_map(|line| line.strip_prefix("Input:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "No LaTeX source was found for this PDF position.".to_string())?;
    let line = output
        .lines()
        .find_map(|value| value.strip_prefix("Line:"))
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "SyncTeX returned an invalid source line.".to_string())?;
    Ok((input.to_string(), line))
}

fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    let file_line = Regex::new(r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(.+)$").unwrap();
    let warning = Regex::new(r"(?m)^(?:LaTeX|Package .+?) Warning:\s*(.+)$").unwrap();
    let missing_command =
        Regex::new(r"(?m)^(?:sh:\s*)?([A-Za-z0-9_+.-]+): command not found$").unwrap();
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
    if let Some(capture) = missing_command.captures(log) {
        diagnostics.push(Diagnostic {
            file: None,
            line: None,
            level: "error".to_string(),
            message: format!(
                "The LaTeX tool '{}' was not found. Install MacTeX or TeX Live, then restart Lattice.",
                &capture[1]
            ),
        });
    }
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
    fn parses_inverse_synctex_locations() {
        let output = "SyncTeX result begin\nOutput:main.pdf\nInput:/tmp/paper/main.tex\nLine:33\nColumn:-1\nSyncTeX result end\n";
        assert_eq!(
            parse_synctex_edit(output).unwrap(),
            ("/tmp/paper/main.tex".to_string(), 33)
        );
    }

    #[test]
    #[ignore = "requires a local latexmk installation"]
    fn creates_and_builds_a_real_project() {
        let parent = temp_root();
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "R&D_100%").unwrap();
        let result = build(&root).unwrap();
        assert!(result.success, "{}", result.log);
        assert!(result.pdf_base64.is_some());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn explains_a_missing_latex_child_command() {
        let diagnostics = parse_diagnostics("sh: pdflatex: command not found\n");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("pdflatex"));
    }

    #[test]
    fn saves_a_compiled_pdf_to_the_chosen_path() {
        let directory = temp_root();
        fs::create_dir_all(&directory).unwrap();
        let encoded = STANDARD.encode(b"%PDF-1.7\ntest");
        let destination = save_pdf(&directory.join("paper"), &encoded).unwrap();
        assert_eq!(Path::new(&destination).extension().unwrap(), "pdf");
        assert_eq!(fs::read(destination).unwrap(), b"%PDF-1.7\ntest");
        assert!(save_pdf(&directory.join("paper.txt"), &encoded).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
