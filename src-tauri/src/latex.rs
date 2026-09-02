use crate::commands;
use crate::models::{BuildResult, Diagnostic, PdfSyncTarget, SyncTexTarget};
use crate::pdf_fonts;
use crate::project;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Default)]
pub struct ActiveBuildState {
    pid: Option<u32>,
    cancelled: bool,
}

/// Shared handle for the in-flight latexmk process group.
pub type ActiveBuild = Arc<Mutex<ActiveBuildState>>;

/// A build handle standing on its own. Each project owns one, and outside the
/// tests they come from `ProjectResources`'s derived `Default`.
#[cfg(test)]
pub fn new_active_build() -> ActiveBuild {
    Arc::new(Mutex::new(ActiveBuildState::default()))
}

/// Take the lock, recovering from poisoning.
///
/// The guarded state is two plain scalars, so a thread that panicked while
/// holding this lock cannot have left them half-written — there is nothing to
/// protect against by refusing the lock forever. Refusing it was actively
/// harmful: `panic = "abort"` is deliberately off in this crate so an unrelated
/// panic never kills the app with unsaved edits, which makes a poisoned mutex a
/// reachable state, and every build after that answered "cancelled" for the
/// rest of the session.
fn state(active: &ActiveBuild) -> std::sync::MutexGuard<'_, ActiveBuildState> {
    active.lock().unwrap_or_else(|poisoned| {
        // Recovering silently would leave the panic that caused this invisible,
        // and it is the only trace of it: whatever panicked did so on a thread
        // whose failure nothing else reports. A build report that says
        // "cancelled" with no cancellation is how this surfaced to users, and
        // this line is what makes the next one diagnosable from the app log.
        log::warn!("Build state lock was poisoned by an earlier panic; recovering it");
        poisoned.into_inner()
    })
}

pub fn abort(active: &ActiveBuild) -> Result<bool, String> {
    let mut guard = state(active);
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

/// Register an already-running process as this project's build.
///
/// For tests that need a build in flight without launching latexmk. They must
/// still hand over a process they own — abort signals a whole process group.
#[cfg(test)]
pub fn begin_for_test(active: &ActiveBuild, pid: u32) -> Result<(), String> {
    begin_active(active, pid)
}

fn begin_active(active: &ActiveBuild, pid: u32) -> Result<(), String> {
    let mut guard = state(active);
    if guard.pid.is_some() {
        return Err("A build is already running.".to_string());
    }
    guard.pid = Some(pid);
    guard.cancelled = false;
    Ok(())
}

/// Returns whether this build was cancelled — never anything else. Reporting a
/// build the user never stopped as cancelled hides its real outcome, log and
/// all, which is what an unavailable lock used to do here.
fn finish_active(active: &ActiveBuild) -> bool {
    let mut guard = state(active);
    guard.pid = None;
    let cancelled = guard.cancelled;
    guard.cancelled = false;
    cancelled
}

fn run_tracked_command(
    mut command: Command,
    active: &ActiveBuild,
    start_error: &str,
    wait_error: &str,
) -> Result<(Output, bool), String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("{start_error}{error}"))?;
    let pid = child.id();
    if let Err(error) = begin_active(active, pid) {
        terminate_process_group(pid);
        let _ = child.wait_with_output();
        return Err(error);
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("{wait_error}{error}"))?;
    Ok((output, finish_active(active)))
}

fn default_root_document(
    manifest: &crate::models::ProjectManifest,
) -> Result<&crate::models::RootDocument, String> {
    manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        // Not a failure the reader caused: a folder of notes has nothing to
        // compile, and the way forward is to add a .tex, not to read an error.
        .ok_or_else(|| {
            "This project has no LaTeX document to build yet. Add a .tex file, or set one as the root document in project settings."
                .to_string()
        })
}

fn compiled_pdf_path(root: &Path) -> Result<PathBuf, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    Ok(project::safe_path(root, &document.path)?.with_extension("pdf"))
}

// Two draft passes are only a net win when normal passes would repeatedly
// encode a substantial graphics payload. Small projects keep the direct path.
const DRAFT_PREWARM_GRAPHICS_THRESHOLD: u64 = 8 * 1024 * 1024;
const DRAFT_PREWARM_ARTIFACTS: [&str; 20] = [
    "aux",
    "bbl",
    "bcf",
    "blg",
    "fdb_latexmk",
    "fls",
    "idx",
    "ilg",
    "ind",
    "lof",
    "log",
    "lot",
    "nav",
    "out",
    "pdf",
    "run.xml",
    "snm",
    "synctex",
    "synctex.gz",
    "toc",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DraftBibliography {
    None,
    Bibtex,
    Unsupported,
}

fn draft_bibliography(aux: &str) -> DraftBibliography {
    if aux.contains("\\abx@aux") || aux.contains("\\@input{") {
        return DraftBibliography::Unsupported;
    }
    let has_data = aux.lines().any(|line| line.starts_with("\\bibdata{"));
    let has_style = aux.lines().any(|line| line.starts_with("\\bibstyle{"));
    match (has_data, has_style) {
        (false, false) => DraftBibliography::None,
        (true, true) => DraftBibliography::Bibtex,
        _ => DraftBibliography::Unsupported,
    }
}

fn draft_prewarm_candidate(
    root: &Path,
    root_document: &Path,
    document_path: &str,
    manifest: &crate::models::ProjectManifest,
    force: bool,
) -> bool {
    if force
        || manifest.trusted
        || manifest.engine != "pdf"
        || project::has_latexmkrc(root)
        || Path::new(document_path).components().count() != 1
    {
        return false;
    }
    DRAFT_PREWARM_ARTIFACTS
        .iter()
        .all(|extension| !root_document.with_extension(extension).exists())
}

fn has_large_graphics_payload(root: &Path) -> bool {
    let mut directories = vec![root.to_path_buf()];
    let mut bytes = 0_u64;

    while let Some(directory) = directories.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                directories.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let path = entry.path();
            let is_graphics = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "eps" | "jb2" | "jbig2" | "jpeg" | "jpg" | "pdf" | "png"
                    )
                });
            if !is_graphics {
                continue;
            }

            bytes = bytes.saturating_add(entry.metadata().map_or(0, |metadata| metadata.len()));
            if bytes >= DRAFT_PREWARM_GRAPHICS_THRESHOLD {
                return true;
            }
        }
    }

    false
}

fn append_command_log(log: &mut String, output: &Output) {
    if !log.is_empty() {
        log.push('\n');
    }
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    log.push_str(&String::from_utf8_lossy(&output.stderr));
}

fn remove_draft_prewarm_artifacts(root_document: &Path) {
    for extension in DRAFT_PREWARM_ARTIFACTS {
        let _ = fs::remove_file(root_document.with_extension(extension));
    }
}

fn run_draft_pdflatex(
    root: &Path,
    document_path: &str,
    active: &ActiveBuild,
) -> Result<(Output, bool), String> {
    let mut command = commands::command("pdflatex");
    command
        .current_dir(root)
        .arg("-draftmode")
        .arg("-interaction=nonstopmode")
        .arg("-synctex=0")
        .arg("-file-line-error")
        .arg("-halt-on-error")
        .arg("-no-shell-escape")
        .arg(document_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_tracked_command(
        command,
        active,
        "Could not start the pdfLaTeX draft prewarm: ",
        "The pdfLaTeX draft prewarm stopped unexpectedly: ",
    )
}

fn run_draft_bibtex(
    root: &Path,
    document_path: &str,
    active: &ActiveBuild,
) -> Result<(Output, bool), String> {
    let stem = Path::new(document_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The root document does not have a valid BibTeX name.".to_string())?;
    let mut command = commands::command("bibtex");
    command
        .current_dir(root)
        .arg(stem)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_tracked_command(
        command,
        active,
        "Could not start the BibTeX draft prewarm: ",
        "The BibTeX draft prewarm stopped unexpectedly: ",
    )
}

/// Prime a cold conventional pdfLaTeX project without writing throwaway PDFs.
///
/// The visible output is still produced by the unchanged latexmk path below,
/// which remains responsible for convergence and may run as many normal passes
/// as it needs. This only replaces its earliest full-output passes with cheaper
/// draft passes, and deliberately declines custom or stateful build setups.
fn prewarm_cold_pdf_build(
    root: &Path,
    force: bool,
    active: &ActiveBuild,
    started: Instant,
) -> Result<Option<BuildResult>, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let root_document = project::safe_path(root, &document.path)?;
    if !draft_prewarm_candidate(root, &root_document, &document.path, &manifest, force)
        || !commands::available("pdflatex")
        || !commands::available("bibtex")
        || !has_large_graphics_payload(root)
    {
        return Ok(None);
    }

    let prewarm_started = Instant::now();
    let mut log = String::new();
    let Ok((first, cancelled)) = run_draft_pdflatex(root, &document.path, active) else {
        remove_draft_prewarm_artifacts(&root_document);
        return Ok(None);
    };
    append_command_log(&mut log, &first);
    if cancelled {
        return Ok(Some(cancelled_build(started, &log, &document.path)));
    }
    if !first.status.success() {
        remove_draft_prewarm_artifacts(&root_document);
        return Ok(None);
    }

    let aux_path = root_document.with_extension("aux");
    let bibliography = fs::read_to_string(&aux_path)
        .ok()
        .map(|aux| draft_bibliography(&aux))
        .unwrap_or(DraftBibliography::Unsupported);
    if bibliography == DraftBibliography::Unsupported {
        remove_draft_prewarm_artifacts(&root_document);
        return Ok(None);
    }
    if bibliography == DraftBibliography::Bibtex {
        let Ok((bibtex, cancelled)) = run_draft_bibtex(root, &document.path, active) else {
            remove_draft_prewarm_artifacts(&root_document);
            return Ok(None);
        };
        append_command_log(&mut log, &bibtex);
        if cancelled {
            return Ok(Some(cancelled_build(started, &log, &document.path)));
        }
        if !bibtex.status.success() {
            remove_draft_prewarm_artifacts(&root_document);
            return Ok(None);
        }
    }

    let Ok((second, cancelled)) = run_draft_pdflatex(root, &document.path, active) else {
        remove_draft_prewarm_artifacts(&root_document);
        return Ok(None);
    };
    append_command_log(&mut log, &second);
    if cancelled {
        return Ok(Some(cancelled_build(started, &log, &document.path)));
    }
    if !second.status.success() {
        remove_draft_prewarm_artifacts(&root_document);
        return Ok(None);
    }

    log::info!(
        target: "lattice::latex",
        "Draft-prewarmed {} in {:.1}s; latexmk will produce and verify the final PDF",
        document.path,
        prewarm_started.elapsed().as_secs_f32()
    );
    Ok(None)
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

pub fn build(
    root: &Path,
    force: bool,
    active: &ActiveBuild,
    open_document: Option<&str>,
) -> Result<BuildResult, String> {
    // Overleaf's compile rule: the file open in the editor wins when it is a
    // compilable root itself (\documentclass) or names one via `% !TEX root`.
    // The winner is written back as the manifest default before latexmk runs,
    // so a chapter opened next still compiles this document, and everything
    // that resolves the default root (PDF preview, SyncTeX, clean) agrees on
    // what was built.
    if let Some(open) = open_document {
        if let Some(target) = project::resolve_compile_root(root, open) {
            project::set_compile_root(root, &target)?;
        }
    }
    let started = Instant::now();
    if let Some(cancelled) = prewarm_cold_pdf_build(root, force, active, started)? {
        return Ok(cancelled);
    }
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
    // A PDF built by anything else leaves latexmk with nothing to do, and
    // `-synctex=1` never reaches the engine that way. The agent compiles with a
    // plain `latexmk -pdf` of its own, so a project it had been working in
    // answered every click on the PDF with "no SyncTeX data" — and pressing
    // Build, which is what that message asks for, changed nothing. Force the
    // one rebuild that writes it. Skipped when the run really did typeset
    // (SyncTeX would exist) so an engine that cannot produce it is not
    // compiled twice on every build.
    if result.success && !force && skipped_recompile(&result.log) && synctex_missing(root) {
        result = run_latexmk(root, true, active, started)?;
    }
    Ok(result)
}

fn skipped_recompile(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    lower.contains("nothing to do") || lower.contains("up-to-date")
}

/// Whether the compiled PDF is missing the SyncTeX file that pairs with it.
fn synctex_missing(root: &Path) -> bool {
    let Ok(pdf) = compiled_pdf_path(root) else {
        return false;
    };
    if !pdf.is_file() {
        return false;
    }
    !pdf.with_extension("synctex.gz").is_file() && !pdf.with_extension("synctex").is_file()
}

fn is_stale_previous_invocation_log(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    lower.contains("error in previous invocation")
        || (lower.contains("nothing to do") && lower.contains("gave an error in previous"))
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

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))?;
    let pid = child.id();
    if let Err(error) = begin_active(active, pid) {
        terminate_process_group(pid);
        let _ = child.wait_with_output();
        return Err(error);
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("latexmk exited unexpectedly: {error}"))?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if finish_active(active) {
        return Ok(cancelled_build(started, &log, &document.path));
    }

    let success = output.status.success();
    let pdf_path = root_document.with_extension("pdf");
    let pdf_bytes = if pdf_path.exists() {
        Some(fs::read(&pdf_path).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let mut diagnostics = parse_diagnostics(&log);
    if success {
        if let Some(bytes) = pdf_bytes.as_deref() {
            let report = pdf_fonts::inspect_pdf_bytes(bytes);
            // Only warn on conclusive failures (e.g. Computer Modern). Inconclusive
            // scans used to false-alarm on compressed pdfTeX object streams.
            //
            // And only for a document that actually typeset a conference
            // template. The expectation being checked ("this should be Times")
            // comes from those templates, not from the project: a plain
            // `article` asking for `lmodern` in a NeurIPS-created project got
            // told its deliberate font choice was wrong, on every build.
            if report.conclusive && !report.ok_for_conference && log_loads_conference_template(&log)
            {
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
        has_pdf: pdf_bytes.is_some(),
        diagnostics,
        log: trim_log(&log),
        duration_ms: started.elapsed().as_millis(),
        root_document: document.path.clone(),
    })
}

/// Someone stopped this build. Keep what latexmk had already written: a build
/// is usually stopped *because* it was stuck, and the last thing it printed is
/// the only clue about where — throwing the log away left the person who
/// stopped it with nothing to act on but the word "cancelled".
fn cancelled_build(started: Instant, partial_log: &str, root_document: &str) -> BuildResult {
    let elapsed = started.elapsed();
    let trimmed = partial_log.trim();
    BuildResult {
        success: false,
        has_pdf: false,
        diagnostics: vec![Diagnostic {
            file: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            level: "error".to_string(),
            message: format!(
                "Build stopped after {:.1}s. The log below is how far it got.",
                elapsed.as_secs_f32()
            ),
        }],
        log: if trimmed.is_empty() {
            "Build cancelled before latexmk produced any output.".to_string()
        } else {
            trim_log(partial_log)
        },
        duration_ms: elapsed.as_millis(),
        root_document: root_document.to_string(),
    }
}

pub fn read_compiled_pdf(root: &Path) -> Result<Vec<u8>, String> {
    let path = compiled_pdf_path(root)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("The compiled PDF could not be read: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    Ok(bytes)
}

pub fn save_pdf(path: &Path, bytes: &[u8]) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("Choose where to save the PDF.".to_string());
    }
    let destination = match path.extension().and_then(|extension| extension.to_str()) {
        None => path.with_extension("pdf"),
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => path.to_path_buf(),
        Some(_) => return Err("The exported paper must use the .pdf extension.".to_string()),
    };

    if !bytes.starts_with(b"%PDF-") {
        return Err("The compiled output is not a valid PDF.".to_string());
    }
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

/// Shown for either direction: without the map there is nothing to match.
const NO_SYNCTEX_DATA: &str = "This PDF has no SyncTeX data, so Lattice cannot match it to the \
    source. A PDF compiled outside Lattice leaves it out, and latexmk then reports nothing to do \
    — press Build once to write it.";

/// Turn a failed `synctex` run into one sentence a writer can act on.
///
/// synctex answers every failure by printing its entire command-line manual to
/// stderr — around fifty lines of `-o page:x:y:file` grammar. Forwarding that
/// verbatim put the whole manual page inside the editor's error strip. The one
/// failure that actually happens has a cause worth naming instead: a PDF built
/// by another tool carries no `.synctex.gz`, because Lattice's own build is
/// what passes `-synctex=1`.
fn synctex_failure(stderr: &str, lead: &str) -> String {
    if stderr.contains("No SyncTeX available") {
        return NO_SYNCTEX_DATA.to_string();
    }
    let reason = stderr
        .lines()
        .take_while(|line| !line.trim_start().starts_with("usage:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let reason = reason.trim();
    if reason.is_empty() {
        return lead.to_string();
    }
    // Any other synctex failure is still a tool message, not prose: keep it
    // short enough to read at a glance rather than growing the strip again.
    let mut short = reason.chars().take(200).collect::<String>();
    if reason.chars().count() > 200 {
        short.push('…');
    }
    format!("{lead} {short}")
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
    // Missing SyncTeX data is not "this line is not in the PDF": the whole map
    // is absent, and every line would answer the same. Say so once here rather
    // than sending the reader looking for a paragraph that is on the page.
    if synctex_missing(root) {
        return Err(NO_SYNCTEX_DATA.to_string());
    }
    let output = commands::command("synctex")
        .current_dir(root)
        .arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x:.3}:{y:.3}:{}", pdf_path.display()))
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(synctex_failure(
            &String::from_utf8_lossy(&output.stderr),
            "SyncTeX could not locate this PDF position.",
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
    // Clicking a reference lands in the generated .bbl; redirect to the .bib entry
    // the writer can actually edit. Fall through to the .bbl if we can't resolve it.
    if relative.extension().and_then(|value| value.to_str()) == Some("bbl") {
        if let Ok(Some(target)) = project::bib_target_for_bbl(root, relative, line) {
            return Ok(target);
        }
    }
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
) -> Result<Option<PdfSyncTarget>, String> {
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
    // Missing SyncTeX data is not "this line is not in the PDF": the whole map
    // is absent, and every line would answer the same. Say so once here rather
    // than sending the reader looking for a paragraph that is on the page.
    if synctex_missing(root) {
        return Err(NO_SYNCTEX_DATA.to_string());
    }
    let mut lookup_path = relative.clone();
    let mut lookup_line = line;
    let mut lookup_column = if column == 0 {
        0
    } else {
        column.saturating_sub(1)
    };
    if Path::new(&relative)
        .extension()
        .and_then(|value| value.to_str())
        == Some("bib")
    {
        let bbl_path = Path::new(&document.path).with_extension("bbl");
        let Some(target) =
            project::bbl_target_for_bib(root, Path::new(&relative), &bbl_path, line)?
        else {
            return Err("This bibliography entry is not included in the compiled PDF.".to_string());
        };
        lookup_path = target.path;
        lookup_line = target.line;
        lookup_column = 0;
    }
    let output = commands::command("synctex")
        .current_dir(root)
        .arg("view")
        .arg("-i")
        .arg(format!("{lookup_line}:{lookup_column}:{lookup_path}"))
        .arg("-o")
        .arg(pdf_path.display().to_string())
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(synctex_failure(
            &String::from_utf8_lossy(&output.stderr),
            "SyncTeX could not locate this source line.",
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    first_synctex_view_target(&stdout)
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
    let mut saw_result = false;
    for block in output.split("SyncTeX result begin").skip(1) {
        saw_result = true;
        let body = block.split("SyncTeX result end").next().unwrap_or(block);
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
    if !saw_result {
        return Err("SyncTeX output contained no result block.".to_string());
    }
    Ok(targets)
}

fn first_synctex_view_target(output: &str) -> Result<Option<PdfSyncTarget>, String> {
    // A successful `synctex view` prints only its version banner when the
    // source line has no PDF node (common for declarations in .sty files).
    // That is a valid no-match, not malformed SyncTeX data.
    if !output.contains("SyncTeX result begin") {
        return Ok(None);
    }
    Ok(parse_synctex_view(output)?.into_iter().next())
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

/// Conference styles (NeurIPS/ICML/ICLR/CVPR) are not on CTAN — `tlmgr install` can
/// never provide them. Their author kits distribute them in the project folder,
/// so a "not found" means the project copy is missing, not the TeX installation.
/// Whether this build loaded one of the conference templates.
///
/// The log names every style it reads, so the document that was actually
/// typeset answers this — the project manifest cannot. A project created as
/// NeurIPS holds whatever its author later writes in it, including documents
/// that are not submissions at all.
fn log_loads_conference_template(log: &str) -> bool {
    let styles = Regex::new(r"([A-Za-z0-9_\-]+\.sty)").unwrap();
    let loaded = styles
        .captures_iter(log)
        .any(|capture| conference_template_venue(&capture[1]).is_some());
    loaded
}

fn conference_template_venue(sty: &str) -> Option<&'static str> {
    let lower = sty.to_ascii_lowercase();
    if lower.starts_with("neurips") || lower.starts_with("nips") {
        Some("NeurIPS")
    } else if lower.starts_with("icml") {
        Some("ICML")
    } else if lower.starts_with("iclr") {
        Some("ICLR")
    } else if lower.starts_with("cvpr") {
        Some("CVPR")
    } else {
        None
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
    let missing_dependency = Regex::new(
        r"(?m)(?:!\s*)?LaTeX Error: File [`']([^`']+\.(?:sty|cls|bst|bbx|cbx))[`'] not found\.",
    )
    .unwrap();
    if let Some(capture) = missing_dependency.captures(log) {
        let missing_file = capture[1].to_string();
        let message = if let Some(venue) = conference_template_venue(&missing_file) {
            format!(
                "Missing style file `{missing_file}`. It is part of the {venue} template and belongs next to main.tex — TeX Live cannot install it. Sync or copy it back from another copy of the project."
            )
        } else {
            format!(
                "Missing LaTeX dependency `{missing_file}`. BasicTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package."
            )
        };
        push_unique_diagnostic(
            &mut diagnostics,
            Diagnostic {
                file: None,
                line: None,
                column: None,
                end_line: None,
                end_column: None,
                level: "error".to_string(),
                message,
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
    // Only the file-less warning loop above consulted the noise list, but the
    // same warnings also arrive with a `file:line:` prefix through the other two
    // patterns. Filter once at the end so every producer is covered. LaTeX's
    // terminal boilerplate is also suppressed: the preceding error is the
    // actionable cause, while "Emergency stop" only says compilation ended.
    diagnostics.retain(|diagnostic| {
        let lower = diagnostic.message.trim().to_ascii_lowercase();
        let terminal_error = lower == "emergency stop."
            || lower.starts_with("fatal error occurred")
            || lower.starts_with("no output pdf file produced")
            || lower.starts_with("==> fatal error occurred");
        !terminal_error
            && (diagnostic.level == "error" || !is_pass_noise_warning(&diagnostic.message))
    });
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

pub(crate) fn is_pass_noise_warning(message: &str) -> bool {
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
        // hyperref fires this for every \section without a label. Nothing to act
        // on, and a normal paper produces one per heading.
        || lower.contains("ignoring empty anchor")
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
        return trimmed;
    }
    // Byte offsets, and a latexmk log is full of accented text and of U+FFFD
    // from lossy decoding, so the cut has to be moved to a character boundary
    // — landing inside one panicked after the PDF had already been read,
    // losing a build that had in fact succeeded.
    let mut start = trimmed.len() - LIMIT;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &trimmed[start..])
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
    fn a_poisoned_build_lock_does_not_masquerade_as_a_cancelled_build() {
        let active = new_active_build();
        // `panic = "abort"` is off in this crate, so an unrelated panic taken
        // while this lock is held poisons it for the rest of the session. That
        // used to make every later build answer "cancelled", hiding its real
        // result from the user with no way back but restarting the app.
        let poisoner = Arc::clone(&active);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison the build lock");
        })
        .join();
        assert!(active.lock().is_err(), "the lock should now be poisoned");

        assert!(
            !finish_active(&active),
            "a poisoned lock is not a cancellation"
        );
        assert!(
            !abort(&active).unwrap(),
            "nothing is running, so there is nothing to abort"
        );

        // And the state machine is still usable afterwards. No pid is aborted
        // here on purpose: abort() signals a whole process group, and a made-up
        // pid would signal whatever real group happens to hold that number.
        begin_active(&active, std::process::id()).unwrap();
        assert!(
            begin_active(&active, std::process::id()).is_err(),
            "a second build is still refused while one is registered",
        );
        assert!(
            !finish_active(&active),
            "an uncancelled build reports its own result"
        );
    }

    #[test]
    fn stopping_a_build_keeps_what_latexmk_had_already_printed() {
        // A build is usually stopped because it was stuck, so the last thing it
        // printed is the only clue about where it stuck.
        let partial = "Running 'pdflatex ...'\nProcessing figures/large.pdf\n";
        let stopped = cancelled_build(Instant::now(), partial, "main.tex");

        assert!(!stopped.success);
        assert!(!stopped.has_pdf);
        assert!(stopped.log.contains("Processing figures/large.pdf"));
        assert_eq!(stopped.diagnostics.len(), 1);
        assert!(
            stopped.diagnostics[0].message.contains("stopped after"),
            "the message should say it was stopped, not read as a failure: {}",
            stopped.diagnostics[0].message,
        );

        // And a build stopped before latexmk said anything still explains itself.
        let immediate = cancelled_build(Instant::now(), "   \n", "main.tex");
        assert!(immediate.log.contains("before latexmk produced any output"));
    }

    #[test]
    fn draft_prewarm_only_accepts_conventional_bibliographies() {
        assert_eq!(draft_bibliography("\\relax\n"), DraftBibliography::None);
        assert_eq!(
            draft_bibliography("\\citation{paper}\n\\bibdata{references}\n\\bibstyle{plain}\n"),
            DraftBibliography::Bibtex
        );
        assert_eq!(
            draft_bibliography("\\abx@aux@refcontext{nty/global//global/global/global}\n"),
            DraftBibliography::Unsupported
        );
        assert_eq!(
            draft_bibliography("\\@input{chapters/results.aux}\n"),
            DraftBibliography::Unsupported
        );
        assert_eq!(
            draft_bibliography("\\bibdata{references}\n"),
            DraftBibliography::Unsupported
        );
    }

    #[test]
    fn draft_prewarm_requires_a_large_graphics_payload() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("notes.txt"), vec![0; 1024]).unwrap();
        assert!(!has_large_graphics_payload(&root));

        let image = fs::File::create(root.join("figure.pdf")).unwrap();
        image.set_len(DRAFT_PREWARM_GRAPHICS_THRESHOLD).unwrap();
        assert!(has_large_graphics_payload(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn draft_prewarm_is_only_for_pristine_simple_pdftex_projects() {
        let parent = temp_root();
        let root = parent.join("paper");
        fs::create_dir_all(&root).unwrap();
        let root_document = root.join("main.tex");
        fs::write(&root_document, "\\documentclass{article}\n").unwrap();
        let manifest = project::default_manifest("paper");

        assert!(draft_prewarm_candidate(
            &root,
            &root_document,
            "main.tex",
            &manifest,
            false
        ));
        assert!(!draft_prewarm_candidate(
            &root,
            &root_document,
            "main.tex",
            &manifest,
            true
        ));

        let mut trusted = manifest.clone();
        trusted.trusted = true;
        assert!(!draft_prewarm_candidate(
            &root,
            &root_document,
            "main.tex",
            &trusted,
            false
        ));

        fs::write(root.join("main.aux"), "generated").unwrap();
        assert!(!draft_prewarm_candidate(
            &root,
            &root_document,
            "main.tex",
            &manifest,
            false
        ));
        fs::remove_file(root.join("main.aux")).unwrap();
        fs::write(root.join("latexmkrc"), "$pdf_mode = 1;").unwrap();
        assert!(!draft_prewarm_candidate(
            &root,
            &root_document,
            "main.tex",
            &manifest,
            false
        ));
        fs::remove_dir_all(parent).unwrap();
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
    fn treats_a_successful_synctex_banner_as_no_forward_match() {
        let output = "This is SyncTeX command line utility, version 1.5\n";
        assert!(first_synctex_view_target(output).unwrap().is_none());
    }

    #[test]
    fn treats_a_zero_page_as_no_forward_synctex_match() {
        let output = concat!(
            "SyncTeX result begin\nOutput:main.pdf\nPage:0\n",
            "h:0.0\nv:0.0\nW:0.0\nH:0.0\nSyncTeX result end\n"
        );
        assert!(parse_synctex_view(output).unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_forward_synctex_result() {
        assert!(
            parse_synctex_view("SyncTeX result begin\nPage:not-a-page\nSyncTeX result end")
                .is_err()
        );
    }

    #[test]
    #[ignore = "requires a local latexmk installation"]
    fn creates_and_builds_a_real_project() {
        let parent = temp_root();
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "R&D_100%").unwrap();
        let result = build(&root, false, &new_active_build(), None).unwrap();
        assert!(result.success, "{}", result.log);
        assert_eq!(result.root_document, "main.tex");
        assert!(read_compiled_pdf(&root).unwrap().starts_with(b"%PDF-"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    #[ignore = "requires a local latexmk and bibtex installation"]
    fn forward_searches_from_a_bib_entry_through_the_generated_bbl() {
        let parent = temp_root();
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "Bibliography sync").unwrap();
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\
             \\begin{document}\n\
             See \\cite{smith2020}.\n\
             \\bibliographystyle{plain}\n\
             \\bibliography{references}\n\
             \\end{document}\n",
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{smith2020,\n\
             title = {A Useful Paper},\n\
             author = {Smith, Jane},\n\
             year = {2020}\n\
             }\n",
        )
        .unwrap();

        let result = build(&root, true, &new_active_build(), None).unwrap();
        assert!(result.success, "{}", result.log);
        let target = forward_search(&root, "references.bib", 3, 0)
            .unwrap()
            .expect("the generated bibliography item should have a PDF position");
        assert_eq!(target.page, 1);
        assert!(target.x.is_finite() && target.y.is_finite());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn explains_a_missing_latex_child_command() {
        let diagnostics = parse_diagnostics("sh: pdflatex: command not found\n");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("pdflatex"));
    }

    #[test]
    fn offers_to_resolve_a_missing_tex_dependency() {
        let diagnostics = parse_diagnostics("! LaTeX Error: File `algorithm.sty' not found.\n");
        assert!(
            diagnostics.iter().any(|item| {
                item.message.contains("algorithm.sty")
                    && item.message.contains("Install missing package")
            }),
            "expected a dependency repair hint, got {diagnostics:?}"
        );
    }

    #[test]
    fn hides_latex_terminal_noise_when_reporting_a_build_failure() {
        let diagnostics = parse_diagnostics(
            "./main.tex:8: Emergency stop.\n\
             ./main.tex:8:  ==> Fatal error occurred, no output PDF file produced!\n",
        );
        assert!(diagnostics.is_empty(), "got: {diagnostics:?}");
    }

    #[test]
    fn recognizes_missing_classes_and_bibliography_styles() {
        for missing in [
            "acmart.cls",
            "plainnat.bst",
            "authoryear.bbx",
            "numeric.cbx",
        ] {
            let diagnostics = parse_diagnostics(&format!(
                "./main.tex:3: LaTeX Error: File `{missing}' not found.\n"
            ));
            let hint = diagnostics
                .iter()
                .find(|item| item.message.starts_with("Missing LaTeX dependency"))
                .unwrap_or_else(|| {
                    panic!("expected a dependency repair hint for {missing}, got {diagnostics:?}")
                });
            assert!(
                hint.message
                    .starts_with(&format!("Missing LaTeX dependency `{missing}`.")),
                "dependency name must not retain a log quote: {}",
                hint.message
            );
        }
    }

    #[test]
    fn a_pdf_someone_else_built_still_gets_its_synctex_written() {
        // latexmk's answer when the PDF is already current.
        assert!(skipped_recompile("Latexmk: Nothing to do for 'main.tex'."));
        assert!(skipped_recompile(
            "Latexmk: All targets (main.pdf) are up-to-date"
        ));
        // A run that actually typeset must not be repeated.
        assert!(!skipped_recompile("Latexmk: applying rule 'pdflatex'..."));
    }

    #[test]
    fn names_the_cause_instead_of_reprinting_the_synctex_manual() {
        // What synctex actually writes when the PDF has no companion data.
        let stderr = "SyncTeX ERROR: No SyncTeX available for lambda_gpu_proposal.pdf\n\
             usage: synctex <subcommand> [options] [args]\n\
             -o page:x:y:file\n       specify the page and coordinates\n";
        let message = synctex_failure(stderr, "SyncTeX could not locate this PDF position.");
        assert!(
            !message.contains("usage:") && !message.contains("page:x:y:file"),
            "must not paste synctex's manual into the UI: {message}"
        );
        assert!(
            message.contains("Build"),
            "must say how to fix it: {message}"
        );
    }

    #[test]
    fn keeps_other_synctex_failures_short_and_without_the_manual() {
        let stderr = "SyncTeX ERROR: cannot open the file\nusage: synctex <subcommand>\n-o page";
        let message = synctex_failure(stderr, "SyncTeX could not locate this source line.");
        assert_eq!(
            message,
            "SyncTeX could not locate this source line. SyncTeX ERROR: cannot open the file"
        );
    }

    #[test]
    fn conference_font_expectations_only_apply_to_conference_documents() {
        // A grant proposal that asks for Latin Modern on purpose.
        let plain = "(./lambda_gpu_proposal.tex (/usr/local/texlive/2026basic/texmf-dist/tex/latex/lm/lmodern.sty\n\
             (/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/microtype.sty";
        assert!(!log_loads_conference_template(plain));

        for style in [
            "neurips.sty",
            "neurips_2026.sty",
            "icml2026.sty",
            "iclr2026_conference.sty",
            "cvpr.sty",
        ] {
            let log = format!("(./main.tex (./{style}\nPackage: whatever\n");
            assert!(
                log_loads_conference_template(&log),
                "{style} should count as a conference template"
            );
        }
    }

    #[test]
    fn does_not_send_users_to_tlmgr_for_conference_template_styles() {
        // Conference author-kit styles are not on CTAN; `tlmgr install neurips`
        // fails and strands the user (they "installed everything" already).
        for sty in [
            "neurips.sty",
            "neurips_2026.sty",
            "icml2026.sty",
            "iclr2026_conference.sty",
            "cvpr.sty",
        ] {
            let diagnostics =
                parse_diagnostics(&format!("! LaTeX Error: File `{sty}' not found.\n"));
            let hint = diagnostics
                .iter()
                .find(|item| item.message.contains(sty))
                .unwrap_or_else(|| panic!("expected a hint for {sty}, got {diagnostics:?}"));
            assert!(
                !hint.message.contains("Install missing package"),
                "must not suggest tlmgr for {sty}: {}",
                hint.message
            );
            assert!(
                hint.message.contains("next to main.tex"),
                "must point at the project folder for {sty}: {}",
                hint.message
            );
        }
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
    fn ignores_hyperref_empty_anchor_noise_in_every_log_shape() {
        // hyperref reports this once per unlabelled heading, in two shapes: bare,
        // and prefixed with `file:line:`. The prefixed shape is parsed by a
        // different pattern, which used to bypass the noise filter entirely.
        let log = "\
------------\n\
Running 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n\
------------\n\
Package hyperref Warning: Ignoring empty anchor on input line 42.\n\
./main.tex:57: Package hyperref Warning: Ignoring empty anchor on input line 57.\n\
Output written on main.pdf (1 page, 54890 bytes).\n\
Latexmk: All targets (main.pdf) are up-to-date\n";
        assert!(
            parse_diagnostics(log).is_empty(),
            "hyperref empty-anchor warnings should not reach the diagnostics panel"
        );
    }

    #[test]
    fn still_reports_real_errors_that_mention_a_noise_phrase() {
        let log = "\
------------\n\
Running 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n\
------------\n\
./main.tex:12: Undefined control sequence while ignoring empty anchor handling.\n";
        let diagnostics = parse_diagnostics(log);
        assert_eq!(diagnostics.len(), 1, "got: {diagnostics:?}");
        assert_eq!(diagnostics[0].level, "error");
    }

    #[test]
    fn saves_a_compiled_pdf_to_the_chosen_path() {
        let directory = temp_root();
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"%PDF-1.7\ntest";
        let destination = save_pdf(&directory.join("paper"), bytes).unwrap();
        assert_eq!(Path::new(&destination).extension().unwrap(), "pdf");
        assert_eq!(fs::read(destination).unwrap(), b"%PDF-1.7\ntest");
        assert!(save_pdf(&directory.join("paper.txt"), bytes).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
