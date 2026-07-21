use crate::commands;
use crate::models::{BuildResult, Diagnostic, PdfSyncTarget, SyncTexTarget};
use crate::pdf_fonts;
use crate::project;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Default)]
pub struct ActiveBuildState {
    pid: Option<u32>,
    cancelled: bool,
}

/// Shared handle for the in-flight latexmk process group.
pub type ActiveBuild = Arc<Mutex<ActiveBuildState>>;

pub fn new_active_build() -> ActiveBuild {
    Arc::new(Mutex::new(ActiveBuildState::default()))
}

pub fn abort(active: &ActiveBuild) -> Result<bool, String> {
    let mut guard = active
        .lock()
        .map_err(|_| "Build state is unavailable.".to_string())?;
    if guard.pid.is_none() && !guard.cancelled {
        return Ok(false);
    }
    guard.cancelled = true;
    if let Some(pid) = guard.pid.take() {
        terminate_process_group(pid);
    }
    Ok(true)
}

fn terminate_process_group(pid: u32) {
    #[cfg(unix)]
    {
        // latexmk children share this group when process_group(0) is set at spawn.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

fn begin_active(active: &ActiveBuild, pid: u32) -> Result<(), String> {
    let mut guard = active
        .lock()
        .map_err(|_| "Build state is unavailable.".to_string())?;
    if guard.pid.is_some() {
        return Err("A build is already running.".to_string());
    }
    guard.pid = Some(pid);
    guard.cancelled = false;
    Ok(())
}

fn finish_active(active: &ActiveBuild) -> bool {
    let Ok(mut guard) = active.lock() else {
        return true;
    };
    guard.pid = None;
    let cancelled = guard.cancelled;
    guard.cancelled = false;
    cancelled
}

fn default_root_document(
    manifest: &crate::models::ProjectManifest,
) -> Result<&crate::models::RootDocument, String> {
    manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        .ok_or_else(|| "The project has no root document.".to_string())
}

pub fn clean(root: &Path) -> Result<String, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let mut command = commands::command("latexmk");
    command.current_dir(root).arg("-c").arg(&document.path);
    let output = command
        .output()
        .map_err(|error| format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(format!(
            "latexmk could not clean the project.\n{}",
            trim_log(&log)
        ));
    }
    Ok(trim_log(&log))
}

pub fn build(root: &Path, force: bool, active: &ActiveBuild) -> Result<BuildResult, String> {
    let started = Instant::now();
    let mut result = run_latexmk(root, force, active, started)?;
    // After fixing missing packages, latexmk often reports "Nothing to do" while still
    // remembering the previous failed pass. Clean once and force a fresh run.
    if !result.success && is_stale_previous_invocation_log(&result.log) {
        let _ = clean(root);
        result = run_latexmk(root, true, active, started)?;
        if !result.log.is_empty() {
            result.log = format!(
                "Cleared a stale failed build, then rebuilt.\n\n{}",
                result.log
            );
        }
    }
    Ok(result)
}

fn is_stale_previous_invocation_log(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    lower.contains("error in previous invocation")
        || (lower.contains("nothing to do")
            && lower.contains("gave an error in previous"))
}

fn run_latexmk(
    root: &Path,
    force: bool,
    active: &ActiveBuild,
    started: Instant,
) -> Result<BuildResult, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let root_document = project::safe_path(root, &document.path)?;
    if !root_document.exists() {
        return Err(format!("Root document not found: {}", document.path));
    }

    let mut command = commands::command("latexmk");
    command
        .current_dir(root)
        .arg("-interaction=nonstopmode")
        .arg("-synctex=1")
        .arg("-file-line-error")
        .arg("-halt-on-error")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Prefer project latexmkrc when present; otherwise pass Lattice's selected engine.
    if !project::has_latexmkrc(root) {
        command.arg(project::latexmk_engine_arg(&manifest.engine));
    }
    if force {
        command.arg("-g");
    }
    if !manifest.trusted {
        command.arg("-no-shell-escape");
    }
    command.arg(&document.path);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command.spawn().map_err(|error| {
        format!("Could not start latexmk. Install MacTeX or TeX Live. {error}")
    })?;
    let pid = child.id();
    if let Err(error) = begin_active(active, pid) {
        terminate_process_group(pid);
        let _ = child.wait_with_output();
        return Err(error);
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("latexmk exited unexpectedly: {error}"))?;
    if finish_active(active) {
        return Ok(cancelled_build(started));
    }

    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let success = output.status.success();
    let pdf_path = root_document.with_extension("pdf");
    let pdf_bytes = if pdf_path.exists() {
        Some(fs::read(&pdf_path).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let pdf_base64 = pdf_bytes.as_ref().map(|bytes| STANDARD.encode(bytes));
    let mut diagnostics = parse_diagnostics(&log);
    if success {
        if let Some(bytes) = pdf_bytes.as_deref() {
            let report = pdf_fonts::inspect_pdf_bytes(bytes);
            // Only warn on conclusive failures (e.g. Computer Modern). Inconclusive
            // scans used to false-alarm on compressed pdfTeX object streams.
            if report.conclusive && !report.ok_for_conference {
                let skipped_rebuild = log.to_ascii_lowercase().contains("nothing to do")
                    || log.to_ascii_lowercase().contains("up-to-date");
                let message = if skipped_rebuild {
                    format!(
                        "{} — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts.",
                        report.detail
                    )
                } else {
                    report.detail
                };
                diagnostics.push(Diagnostic {
                    file: Some(document.path.clone()),
                    line: None,
                    column: None,
                    end_line: None,
                    end_column: None,
                    level: "warning".to_string(),
                    message,
                });
            }
        }
    }

    Ok(BuildResult {
        success,
        pdf_base64,
        diagnostics,
        log: trim_log(&log),
        duration_ms: started.elapsed().as_millis(),
    })
}

fn cancelled_build(started: Instant) -> BuildResult {
    BuildResult {
        success: false,
        pdf_base64: None,
        diagnostics: vec![Diagnostic {
            file: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            level: "error".to_string(),
            message: "Build cancelled.".to_string(),
        }],
        log: "Build cancelled.".to_string(),
        duration_ms: started.elapsed().as_millis(),
    }
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
    let document = default_root_document(&manifest)?;
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

pub fn forward_search(
    root: &Path,
    path: &str,
    line: u32,
    column: u32,
) -> Result<PdfSyncTarget, String> {
    if line == 0 {
        return Err("Choose a source line before locating it in the PDF.".to_string());
    }
    let relative = project::safe_path(root, path)?
        .strip_prefix(root)
        .map_err(|_| "Source path is outside this project.".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let pdf_path = Path::new(&document.path).with_extension("pdf");
    if !root.join(&pdf_path).is_file() {
        return Err("Build the project before locating source in the PDF.".to_string());
    }
    let column = if column == 0 { 0 } else { column.saturating_sub(1) };
    let output = commands::command("synctex")
        .current_dir(root)
        .arg("view")
        .arg("-i")
        .arg(format!("{line}:{column}:{relative}"))
        .arg("-o")
        .arg(pdf_path.display().to_string())
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "SyncTeX could not locate this source line. {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_synctex_view(&String::from_utf8_lossy(&output.stdout))?
        .into_iter()
        .next()
        .ok_or_else(|| "SyncTeX returned no PDF location for this line.".to_string())
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

fn parse_synctex_view(output: &str) -> Result<Vec<PdfSyncTarget>, String> {
    let mut targets = Vec::new();
    for block in output.split("SyncTeX result begin").skip(1) {
        let body = block
            .split("SyncTeX result end")
            .next()
            .unwrap_or(block);
        let page = field_u32(body, "Page:")?;
        let x = field_f64(body, "h:").or_else(|_| field_f64(body, "x:"))?;
        let y = field_f64(body, "v:").or_else(|_| field_f64(body, "y:"))?;
        let width = field_f64(body, "W:").unwrap_or(24.0).max(1.0);
        let height = field_f64(body, "H:").unwrap_or(12.0).max(1.0);
        if page == 0 {
            continue;
        }
        targets.push(PdfSyncTarget {
            page,
            x,
            y,
            width,
            height,
        });
    }
    if targets.is_empty() {
        return Err("No PDF location was found for this source line.".to_string());
    }
    Ok(targets)
}

fn field_u32(block: &str, prefix: &str) -> Result<u32, String> {
    block
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| format!("SyncTeX output is missing {prefix}"))
}

fn field_f64(block: &str, prefix: &str) -> Result<f64, String> {
    block
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .and_then(|value| value.trim().parse().ok())
        .filter(|value: &f64| value.is_finite())
        .ok_or_else(|| format!("SyncTeX output is missing {prefix}"))
}

fn normalize_log_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"').replace('\\', "/");
    let without_dot = trimmed.strip_prefix("./").unwrap_or(&trimmed);
    if let Some((_, relative)) = without_dot.rsplit_once("/./") {
        return relative.to_string();
    }
    without_dot.to_string()
}

/// Map a missing `.sty` basename to the TeX Live package name for `tlmgr install`.
/// File names often differ from CTAN/TeX Live package ids (e.g. `algorithm.sty` → `algorithms`).
fn tlmgr_package_for_sty(sty: &str) -> &str {
    match sty {
        "algorithm.sty" | "algorithmic.sty" => "algorithms",
        "algpseudocode.sty" => "algorithmicx",
        other => other.strip_suffix(".sty").unwrap_or(other),
    }
}

fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    // Latexmk concatenates every pass; first-pass "undefined citation/ref" noise
    // should not inflate the warning count after a successful final run.
    let log = last_typeset_pass(log);
    let file_line = Regex::new(r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(.+)$").unwrap();
    let warning = Regex::new(r"(?m)^(?:LaTeX|Package .+?) Warning:\s*(.+)$").unwrap();
    let warning_on_line = Regex::new(
        r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(?:Package|LaTeX|Class) .+? Warning:\s*(.+)$",
    )
    .unwrap();
    let missing_command =
        Regex::new(r"(?m)^(?:sh:\s*)?([A-Za-z0-9_+.-]+): command not found$").unwrap();
    let mut diagnostics: Vec<Diagnostic> = file_line
        .captures_iter(log)
        .take(40)
        .map(|capture| {
            let message = capture[3].trim().to_string();
            let level = if message.to_ascii_lowercase().contains("warning") {
                "warning"
            } else {
                "error"
            };
            Diagnostic {
                file: Some(normalize_log_path(&capture[1])),
                line: capture[2].parse().ok(),
                column: None,
                end_line: None,
                end_column: None,
                level: level.to_string(),
                message,
            }
        })
        .collect();
    for capture in warning_on_line.captures_iter(log).take(40) {
        let candidate = Diagnostic {
            file: Some(normalize_log_path(&capture[1])),
            line: capture[2].parse().ok(),
            column: None,
            end_line: None,
            end_column: None,
            level: "warning".to_string(),
            message: capture[3].trim().to_string(),
        };
        push_unique_diagnostic(&mut diagnostics, candidate);
    }
    if let Some(capture) = missing_command.captures(log) {
        diagnostics.push(Diagnostic {
            file: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            level: "error".to_string(),
            message: format!(
                "The LaTeX tool '{}' was not found. Install MacTeX or TeX Live, then restart Lattice.",
                &capture[1]
            ),
        });
    }
    let missing_sty = Regex::new(r"(?m)! LaTeX Error: File `([^']+\.sty)' not found\.").unwrap();
    if let Some(capture) = missing_sty.captures(log) {
        let sty = capture[1].to_string();
        let pkg = tlmgr_package_for_sty(&sty);
        push_unique_diagnostic(
            &mut diagnostics,
            Diagnostic {
                file: None,
                line: None,
                column: None,
                end_line: None,
                end_column: None,
                level: "error".to_string(),
                message: format!(
                    "Missing LaTeX package `{sty}`. BasicTeX is missing extras for this template — in Terminal run: sudo tlmgr install {pkg}   (or: sudo tlmgr install collection-latexextra collection-fontsrecommended)"
                ),
            },
        );
    }
    if is_stale_previous_invocation_log(log) {
        push_unique_diagnostic(
            &mut diagnostics,
            Diagnostic {
                file: None,
                line: None,
                column: None,
                end_line: None,
                end_column: None,
                level: "error".to_string(),
                message: "Stale failed build. Use Clean rebuild (Shift-click Build), or delete aux files and build again.".to_string(),
            },
        );
    }
    for capture in warning.captures_iter(log).take(40) {
        let message = capture[1].trim().to_string();
        if is_pass_noise_warning(&message) {
            continue;
        }
        push_unique_diagnostic(
            &mut diagnostics,
            Diagnostic {
                file: None,
                line: None,
                column: None,
                end_line: None,
                end_column: None,
                level: "warning".to_string(),
                message,
            },
        );
    }
    diagnostics
}

fn last_typeset_pass(log: &str) -> &str {
    let mut start = 0usize;
    for engine in ["pdflatex", "xelatex", "lualatex", "latex"] {
        let needle = format!("Running '{engine}");
        if let Some(index) = log.rfind(&needle) {
            start = start.max(index);
        }
    }
    &log[start..]
}

fn is_pass_noise_warning(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("rerun to get")
        || lower.contains("may have changed")
        || lower.contains("there were undefined citations")
        || lower.contains("there were undefined references")
        // Fresh / empty projects always trip this; not actionable until a .bib entry exists.
        || lower.contains("empty `thebibliography'")
        || lower.contains("empty thebibliography")
        // Default Lattice builds use -no-shell-escape; epstopdf always complains.
        || lower.contains("shell escape feature is not enabled")
}

fn push_unique_diagnostic(diagnostics: &mut Vec<Diagnostic>, candidate: Diagnostic) {
    let duplicate = diagnostics.iter().any(|item| {
        item.file == candidate.file
            && item.line == candidate.line
            && item.message == candidate.message
    });
    if !duplicate {
        diagnostics.push(candidate);
    }
}

fn trim_log(log: &str) -> String {
    const LIMIT: usize = 30_000;
    // Drop latexmk's startup banner ("Rc files read: NONE", version, initial setup).
    // It is not a Lattice warning and crowds the Log tab when something else is wrong.
    let trimmed = strip_latexmk_preamble(log);
    if trimmed.len() <= LIMIT {
        trimmed
    } else {
        format!("…\n{}", &trimmed[trimmed.len() - LIMIT..])
    }
}

fn strip_latexmk_preamble(log: &str) -> String {
    let mut start = 0usize;
    for marker in [
        "This is pdfTeX",
        "This is XeTeX",
        "This is LuaTeX",
        "This is TeX",
        "LaTeX2e",
    ] {
        if let Some(index) = log.find(marker) {
            if start == 0 || index < start {
                start = index;
            }
        }
    }
    if start == 0 {
        if let Some(index) = log.find("Running '") {
            start = index;
        }
    }
    log[start..].trim_start().to_string()
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
    fn parses_forward_synctex_single_result() {
        let output = concat!(
            "SyncTeX result begin\nOutput:main.pdf\nPage:3\n",
            "x:154.230\ny:487.120\nh:154.230\nv:487.120\nW:306.142\nH:11.200\n",
            "before:\noffset:0\nmiddle:\nafter:\nSyncTeX result end\n"
        );
        let results = parse_synctex_view(output).unwrap();
        assert_eq!(results.len(), 1);
        let target = &results[0];
        assert_eq!(target.page, 3);
        assert!((target.x - 154.230).abs() < 0.001);
        assert!((target.y - 487.120).abs() < 0.001);
        assert!((target.width - 306.142).abs() < 0.001);
    }

    #[test]
    fn parses_forward_synctex_multiple_results() {
        let output = concat!(
            "SyncTeX result begin\nOutput:main.pdf\nPage:2\n",
            "h:100.0\nv:200.0\nW:300.0\nH:12.0\nbefore:\noffset:0\nmiddle:\nafter:\n",
            "SyncTeX result end\n",
            "SyncTeX result begin\nOutput:main.pdf\nPage:2\n",
            "h:100.0\nv:220.0\nW:300.0\nH:12.0\nbefore:\noffset:0\nmiddle:\nafter:\n",
            "SyncTeX result end\n"
        );
        let results = parse_synctex_view(output).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].page, 2);
    }

    #[test]
    fn rejects_empty_forward_synctex_output() {
        assert!(parse_synctex_view("no results here").is_err());
    }

    #[test]
    #[ignore = "requires a local latexmk installation"]
    fn creates_and_builds_a_real_project() {
        let parent = temp_root();
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "R&D_100%").unwrap();
        let result = build(&root, false, &new_active_build()).unwrap();
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
    fn maps_algorithm_sty_to_algorithms_tlmgr_package() {
        let diagnostics = parse_diagnostics(
            "! LaTeX Error: File `algorithm.sty' not found.\n",
        );
        assert!(
            diagnostics.iter().any(|item| {
                item.message.contains("algorithm.sty") && item.message.contains("tlmgr install algorithms")
            }),
            "expected algorithms package hint, got {diagnostics:?}"
        );
    }

    #[test]
    fn normalizes_file_paths_and_classifies_warnings() {
        let diagnostics = parse_diagnostics(
            "./chapters/intro.tex:12: Undefined control sequence.\n\
             /Users/me/paper/./main.tex:40: Package natbib Warning: Citation undefined.\n\
             LaTeX Warning: Reference `fig:x' on page 1 undefined.\n",
        );
        assert_eq!(diagnostics[0].file.as_deref(), Some("chapters/intro.tex"));
        assert_eq!(diagnostics[0].level, "error");
        assert_eq!(diagnostics[1].file.as_deref(), Some("main.tex"));
        assert_eq!(diagnostics[1].level, "warning");
        assert!(diagnostics
            .iter()
            .any(|item| item.file.is_none() && item.level == "warning"));
    }

    #[test]
    fn ignores_first_pass_noise_after_a_clean_final_run() {
        let log = "\
------------\n\
Running 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n\
------------\n\
Package natbib Warning: Citation `lei2025scalability' on page 1 undefined on input line 22.\n\
LaTeX Warning: Reference `fig:native-umm' on page 1 undefined on input line 24.\n\
LaTeX Warning: There were undefined references.\n\
Package rerunfilecheck Warning: File `main.out' has changed.\n\
(rerunfilecheck)                Rerun to get outlines right\n\
------------\n\
Running 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n\
------------\n\
Output written on main.pdf (2 pages, 84371 bytes).\n\
Latexmk: All targets (main.pdf) are up-to-date\n";
        let diagnostics = parse_diagnostics(log);
        assert!(
            diagnostics.is_empty(),
            "expected no diagnostics from clean final pass, got {diagnostics:?}"
        );
    }

    #[test]
    fn detects_stale_previous_invocation_logs() {
        assert!(is_stale_previous_invocation_log(
            "Latexmk: Nothing to do for 'main.tex'.\n\
             pdflatex: gave an error in previous invocation of latexmk.\n"
        ));
        assert!(!is_stale_previous_invocation_log(
            "Latexmk: All targets (main.pdf) are up-to-date\n"
        ));
    }

    #[test]
    fn ignores_empty_bibliography_warning_on_fresh_projects() {
        let log = "\
Rc files read:\n\
  NONE\n\
Latexmk: This is Latexmk, John Collins, 31 Jan. 2024. Version 4.83.\n\
------------\n\
Running 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n\
------------\n\
This is pdfTeX, Version 3.141592653-2.6-1.40.26\n\
Package natbib Warning: Empty `thebibliography' environment on input line 8.\n\
Output written on main.pdf (1 page, 54838 bytes).\n\
Latexmk: All targets (main.pdf) are up-to-date\n";
        assert!(parse_diagnostics(log).is_empty());
        let trimmed = trim_log(log);
        assert!(!trimmed.contains("Rc files read"));
        assert!(trimmed.contains("This is pdfTeX") || trimmed.contains("Package natbib"));
    }

    #[test]
    fn ignores_epstopdf_shell_escape_noise() {
        let log = "\
------------\n\
Running 'pdflatex  -interaction=nonstopmode -no-shell-escape \"main.tex\"'\n\
------------\n\
Package epstopdf Warning: Shell escape feature is not enabled.\n\
Package natbib Warning: Empty `thebibliography' environment on input line 8.\n\
Output written on main.pdf (1 page, 54890 bytes).\n\
Latexmk: All targets (main.pdf) are up-to-date\n";
        assert!(
            parse_diagnostics(log).is_empty(),
            "fresh BasicTeX NeurIPS template should not surface noise warnings"
        );
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
