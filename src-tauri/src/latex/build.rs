//! One latexmk build per project at a time, abortable from the UI.

use super::build_log::{
    advice, is_stale_previous_invocation_log, log_conference_template, parse_diagnostics,
    skipped_recompile, trim_log,
};
use super::{default_root_document, prewarm, synctex_missing};
use crate::commands;
use crate::latex::BuildResult;
use crate::models::Diagnostic;
use crate::wide_event::{self, Failure};
use crate::{pdf_fonts, project};
use std::fs;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

#[derive(Debug, Default)]
pub struct ActiveBuildState {
    pid: Option<u32>,
    cancelled: bool,
}

/// Shared handle for the in-flight latexmk process group. Each project owns
/// one, from `ProjectResources`'s derived `Default`.
pub type ActiveBuild = Arc<Mutex<ActiveBuildState>>;

/// Take the lock, recovering from poisoning.
///
/// The guarded state is two plain scalars, so a thread that panicked while
/// holding the lock cannot have left them half-written. `panic = "abort"` is
/// deliberately off, which makes a poisoned mutex reachable, and refusing it
/// made every later build answer "cancelled" for the rest of the session. The
/// warning is the only trace of whatever panicked, so it is not optional.
fn state(active: &ActiveBuild) -> MutexGuard<'_, ActiveBuildState> {
    active.lock().unwrap_or_else(|poisoned| {
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
        terminate(pid);
    }
    Ok(true)
}

/// latexmk and every pass it starts share the process group made at spawn.
fn terminate(pid: u32) {
    commands::signal_process_group(pid, libc::SIGTERM);
}

/// Register an already-running process as this project's build.
pub(crate) fn begin_active(active: &ActiveBuild, pid: u32) -> Result<(), String> {
    let mut guard = state(active);
    if guard.pid.is_some() {
        return Err(ALREADY_RUNNING.to_string());
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
    std::mem::take(&mut guard.cancelled)
}

/// Run `command` as this project's build and capture its output, reporting
/// whether it was cancelled. The error texts prefix the spawn/wait error.
pub(super) fn run_tracked(
    mut command: Command, active: &ActiveBuild, start_error: &str, wait_error: &str,
) -> Result<(Output, bool), String> {
    commands::in_new_process_group(&mut command).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn().map_err(|error| format!("{start_error}{error}"))?;
    let pid = child.id();
    if let Err(error) = begin_active(active, pid) {
        terminate(pid);
        let _ = child.wait_with_output();
        return Err(error);
    }
    let output = child.wait_with_output().map_err(|error| format!("{wait_error}{error}"))?;
    Ok((output, finish_active(active)))
}

pub fn clean(root: &Path) -> Result<String, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let output = commands::command("latexmk")
        .current_dir(root)
        .arg("-c")
        .arg(&document.path)
        .output()
        .map_err(|error| format!("Could not start latexmk. Install MacTeX or TeX Live. {error}"))?;
    let log = trim_log(&commands::combined_output(&output));
    if !output.status.success() {
        return Err(format!("latexmk could not clean the project.\n{log}"));
    }
    Ok(log)
}

/// What a build error (not a document error: those are a finished build's
/// diagnostics) means for whoever reads the log.
pub fn classify_build_error(error: &str) -> Failure {
    if error.starts_with("Could not start latexmk") {
        Failure {
            kind: "toolchain_missing",
            fix: "Install MacTeX or TeX Live (Settings → TeX), then build again.",
        }
    } else if error == ALREADY_RUNNING {
        Failure { kind: "build_busy", fix: "Wait for the running build, or stop it, then retry." }
    } else if error.starts_with("Root document not found") {
        Failure {
            kind: "root_document_missing",
            fix: "Open the main .tex file and build from it, or fix the compile root.",
        }
    } else if error.starts_with("The project changed") {
        Failure { kind: "project_changed", fix: "Build again in the project now open." }
    } else {
        Failure { kind: "build_error", fix: "Build again; if it repeats, report it with the log." }
    }
}

const ALREADY_RUNNING: &str = "A build is already running.";

pub fn build(
    root: &Path, force: bool, active: &ActiveBuild, open_document: Option<&str>,
) -> Result<BuildResult, String> {
    let result = build_passes(root, force, active, open_document)?;
    record_result(&result);
    Ok(result)
}

/// The finished build's shape on its wide event. A document that did not
/// compile is `failed` — the build worked, the LaTeX did not — and is told
/// apart from an `error`, where Lattice could not build at all.
fn record_result(result: &BuildResult) {
    let count = |level: &str| result.diagnostics.iter().filter(|d| d.level == level).count();
    wide_event::record("root_document", result.root_document.as_str());
    wide_event::record("has_pdf", result.has_pdf);
    wide_event::record("errors", count("error"));
    wide_event::record("warnings", count("warning"));
    wide_event::record("log_bytes", result.log.len());
    let cancelled = result.diagnostics.iter().any(|d| d.code == Some("build-cancelled"));
    if cancelled {
        wide_event::outcome("cancelled");
    } else if !result.success {
        wide_event::outcome("failed");
        let first = result.diagnostics.iter().find(|d| d.level == "error");
        if let Some(code) = first.and_then(|diagnostic| diagnostic.code) {
            wide_event::record("first_error_code", code);
        }
    }
}

fn build_passes(
    root: &Path, force: bool, active: &ActiveBuild, open_document: Option<&str>,
) -> Result<BuildResult, String> {
    wide_event::record("force", force);
    // Overleaf's compile rule: the file open in the editor wins when it is a
    // compilable root itself (\documentclass) or names one via `% !TEX root`.
    // The winner is written back as the manifest default before latexmk runs,
    // so a chapter opened next still compiles this document, and everything
    // that resolves the default root (PDF preview, SyncTeX, clean) agrees on
    // what was built.
    if let Some(target) = open_document.and_then(|open| project::resolve_compile_root(root, open)) {
        project::set_compile_root(root, &target)?;
    }
    let started = Instant::now();
    if let Some(cancelled) = prewarm::prewarm_cold_pdf_build(root, force, active, started)? {
        return Ok(cancelled);
    }
    let mut result = run_latexmk(root, force, active, started)?;
    // After fixing missing packages, latexmk often reports "Nothing to do" while still
    // remembering the previous failed pass. Clean once and force a fresh run.
    if !result.success && is_stale_previous_invocation_log(&result.log) {
        let _ = clean(root);
        wide_event::record("stale_rebuild", true);
        result = run_latexmk(root, true, active, started)?;
        if !result.log.is_empty() {
            result.log = format!("Cleared a stale failed build, then rebuilt.\n\n{}", result.log);
        }
    }
    // A PDF built by anything else (the agent's own `latexmk -pdf`, say)
    // leaves latexmk with nothing to do, so `-synctex=1` never reaches the
    // engine and every click on the PDF answers "no SyncTeX data". Force the
    // one rebuild that writes it — only when the run really skipped
    // typesetting, so an engine that cannot produce SyncTeX is not compiled
    // twice on every build.
    if result.success && !force && skipped_recompile(&result.log) && synctex_missing(root) {
        wide_event::record("synctex_rebuild", true);
        result = run_latexmk(root, true, active, started)?;
    }
    Ok(result)
}

fn latexmk_pdf_default(engine: &str) -> &'static str {
    match project::latexmk_engine_arg(engine) {
        "-pdfxe" => "$pdf_mode ||= 5;",
        "-pdflua" => "$pdf_mode ||= 4;",
        _ => "$pdf_mode ||= 1;",
    }
}

fn run_latexmk(
    root: &Path, force: bool, active: &ActiveBuild, started: Instant,
) -> Result<BuildResult, String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?;
    let root_document = project::safe_path(root, &document.path)?;
    if !root_document.exists() {
        return Err(format!("Root document not found: {}", document.path));
    }

    let mut command = commands::command("latexmk");
    command.current_dir(root).args([
        "-interaction=nonstopmode",
        "-synctex=1",
        "-file-line-error",
        "-halt-on-error",
    ]);
    if project::has_latexmkrc(root) {
        // An rc file may only define asset rules, leaving latexmk's default
        // DVI target active. -e runs after rc loading: supply a PDF default
        // without overriding an explicitly configured PDF pipeline.
        command.arg("-e").arg(latexmk_pdf_default(&manifest.engine));
    } else {
        command.arg(project::latexmk_engine_arg(&manifest.engine));
    }
    if force {
        command.arg("-g");
    }
    if !manifest.trusted {
        command.arg("-no-shell-escape");
    }
    command.arg(&document.path);
    wide_event::record("engine", manifest.engine.as_str());
    wide_event::add("latexmk_runs", 1);

    let step = wide_event::step("latexmk");
    let (output, cancelled) = run_tracked(
        command,
        active,
        "Could not start latexmk. Install MacTeX or TeX Live. ",
        "latexmk exited unexpectedly: ",
    )?;
    drop(step);
    let log = commands::combined_output(&output);
    if cancelled {
        return Ok(cancelled_build(started, &log, &document.path));
    }

    let success = output.status.success();
    let pdf_path = root_document.with_extension("pdf");
    let pdf_bytes = if pdf_path.exists() {
        Some(fs::read(&pdf_path).map_err(|error| error.to_string())?)
    } else {
        None
    };
    if let Some(pdf) = &pdf_bytes {
        wide_event::record("pdf_bytes", pdf.len());
    }
    let mut diagnostics = parse_diagnostics(&log);
    // latexmk's output is TeX's terminal, which leaves out what fontspec
    // notes only in the log file.
    let tex_log = fs::read_to_string(root_document.with_extension("log")).unwrap_or_default();
    if let Some(mut warning) =
        pdf_bytes.as_deref().filter(|_| success).and_then(|pdf| font_warning(pdf, &tex_log, &log))
    {
        warning.file = Some(document.path.clone());
        diagnostics.push(warning);
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

/// A warning when a conference document typeset in the wrong fonts, with
/// what in the build caused it.
///
/// Only when the TeX log shows what replaced Times or the PDF scan is
/// conclusive: inconclusive scans false-alarm on compressed pdfTeX object
/// streams. And only for a document that loaded a conference template — the
/// expectation ("this should be Times") comes from those templates, not from
/// the project, so a plain `article` asking for `lmodern` in a NeurIPS-created
/// project is left alone.
fn font_warning(pdf: &[u8], tex_log: &str, latexmk_output: &str) -> Option<Diagnostic> {
    let venue =
        log_conference_template(tex_log).or_else(|| log_conference_template(latexmk_output))?;
    let report = pdf_fonts::inspect_pdf_bytes(pdf);
    let cause = pdf_fonts::times_problem(&report, tex_log)?;
    let detail = pdf_fonts::not_times_detail(venue, &report.fonts, cause);
    let up_to_date = skipped_recompile(latexmk_output);
    let message = if up_to_date {
        format!(
            "{detail} — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts."
        )
    } else {
        detail
    };
    let mut params =
        vec![("venue", venue), ("fonts", report.fonts.as_str()), ("cause", cause.code())];
    if up_to_date {
        params.push(("upToDate", "true"));
    }
    Some(advice("warning", "pdf-fonts-not-times", &params, message))
}

/// Someone stopped this build. Keep what latexmk had already written: a build
/// is usually stopped *because* it was stuck, and the last thing it printed is
/// the only clue about where.
pub(super) fn cancelled_build(
    started: Instant, partial_log: &str, root_document: &str,
) -> BuildResult {
    let elapsed = started.elapsed();
    let seconds = format!("{:.1}", elapsed.as_secs_f32());
    let message = format!("Build stopped after {seconds}s. The log below is how far it got.");
    BuildResult {
        success: false,
        has_pdf: false,
        diagnostics: vec![advice("error", "build-cancelled", &[("seconds", &seconds)], message)],
        log: if partial_log.trim().is_empty() {
            "Build cancelled before latexmk produced any output.".to_string()
        } else {
            trim_log(partial_log)
        },
        duration_ms: elapsed.as_millis(),
        root_document: root_document.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn build_errors_are_classified_with_a_fix() {
        let kind = |error: &str| classify_build_error(error).kind;
        assert_eq!(
            kind("Could not start latexmk. Install MacTeX or TeX Live. No such file"),
            "toolchain_missing"
        );
        assert_eq!(kind(ALREADY_RUNNING), "build_busy");
        assert_eq!(kind("Root document not found: main.tex"), "root_document_missing");
        assert_eq!(kind("The project changed before its build could start."), "project_changed");
        assert_eq!(kind("latexmk exited unexpectedly: signal"), "build_error");
    }

    #[test]
    #[ignore = "requires latexmk and a working pdfLaTeX installation"]
    fn asset_only_rc_builds_pdf_and_resolves_references() {
        let root = TempDir::new("latex");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write(".latexmkrc", "# Asset rules, no engine selection.\n");
        // The repair agent forced PDF output inside a DVI-targeted build.
        // Both citation and label resolution must converge, not just emit a PDF.
        let main = concat!(
            "\\pdfoutput=1\n\\documentclass{article}\n\\begin{document}\n",
            "See Section~\\ref{sec:test} and \\cite{paper}.\n",
            "\\section{Test}\\label{sec:test}\n",
            "\\begin{thebibliography}{1}\\bibitem{paper}A reference.\\end{thebibliography}\n",
            "\\end{document}\n",
        );
        root.write("main.tex", main);
        let result = run_latexmk(&root, false, &ActiveBuild::default(), Instant::now()).unwrap();
        assert!(result.success && result.has_pdf, "{}", result.log);
        let log = fs::read_to_string(root.join("main.log")).unwrap();
        assert!(!log.contains("undefined"), "{log}");
        assert!(!log.contains("Rerun to get"), "{log}");
        let database = fs::read_to_string(root.join("main.fdb_latexmk")).unwrap();
        assert!(database.contains("[\"pdflatex\"]"), "{database}");
    }

    #[test]
    #[ignore = "requires latexmk"]
    fn rc_pdf_pipeline_takes_priority_over_selected_engine() {
        let root = TempDir::new("latex");
        for (engine, fallback) in [("pdf", 1), ("xelatex", 5), ("lualatex", 4)] {
            for configured in [0, 1, 2, 3, 4, 5] {
                root.write(".latexmkrc", format!("$pdf_mode = {configured};\n"));
                let output = commands::command("latexmk")
                    .current_dir(&root)
                    .arg("-e")
                    .arg(latexmk_pdf_default(engine))
                    .arg("-e")
                    .arg("print qq(LATTICE_MODE=$pdf_mode\\n); exit 0;")
                    .output()
                    .unwrap();
                let expected = if configured == 0 { fallback } else { configured };
                assert!(output.status.success());
                assert!(String::from_utf8_lossy(&output.stdout)
                    .contains(&format!("LATTICE_MODE={expected}\n")));
            }
        }
    }

    #[test]
    #[ignore = "requires latexmk"]
    fn a_latexmkrc_playwright_failure_reaches_the_build_result_as_a_diagnostic() {
        // The user path: latexmk, run the way Lattice runs it, stops in the rc
        // file before any engine pass. A stale PDF from an earlier build is
        // still on disk, as it was for the report.
        let parent = TempDir::new("latex");
        let root = project::create(&parent, "Playwright probes").unwrap();
        fs::write(root.join("main.pdf"), b"%PDF-1.5 stale").unwrap();
        let traceback = super::super::build_log::PLAYWRIGHT_RC_FAILURE;
        fs::write(root.join("playwright-error.txt"), traceback.split("Latexmk:").next().unwrap())
            .unwrap();
        fs::write(
            root.join(".latexmkrc"),
            "system('cat playwright-error.txt >&2; exit 1') == 0\n  or die \"Probe SVG conversion failed\\n\";\n",
        )
        .unwrap();
        let result = build(&root, false, &ActiveBuild::default(), None).unwrap();
        assert!(!result.success, "{}", result.log);
        assert!(result.log.contains("problem with rc file"), "{}", result.log);
        assert_eq!(result.diagnostics.len(), 1, "{:?}", result.diagnostics);
        let message = &result.diagnostics[0].message;
        assert!(message.contains("-m playwright install chromium"), "{message}");
    }

    #[test]
    #[ignore = "requires a local latexmk installation"]
    fn creates_and_builds_a_real_project() {
        let parent = TempDir::new("latex");
        let root = project::create(&parent, "R&D_100%").unwrap();
        let result = build(&root, false, &ActiveBuild::default(), None).unwrap();
        assert!(result.success, "{}", result.log);
        assert_eq!(result.root_document, "main.tex");
        assert!(super::super::read_compiled_pdf(&root).unwrap().starts_with(b"%PDF-"));
    }

    #[test]
    fn a_poisoned_build_lock_does_not_masquerade_as_a_cancelled_build() {
        let active = ActiveBuild::default();
        // An unrelated panic taken while this lock is held poisons it for the
        // rest of the session; that must not turn every later build into
        // "cancelled".
        let poisoner = Arc::clone(&active);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison the build lock");
        })
        .join();
        assert!(active.lock().is_err(), "the lock should now be poisoned");

        assert!(!finish_active(&active), "a poisoned lock is not a cancellation");
        assert!(!abort(&active).unwrap(), "nothing is running, so there is nothing to abort");

        // And the state machine is still usable afterwards. No pid is aborted
        // here on purpose: abort() signals a whole process group, and a made-up
        // pid would signal whatever real group happens to hold that number.
        begin_active(&active, std::process::id()).unwrap();
        assert!(
            begin_active(&active, std::process::id()).is_err(),
            "a second build is still refused while one is registered",
        );
        assert!(!finish_active(&active), "an uncancelled build reports its own result");
    }

    #[test]
    fn stopping_a_build_keeps_what_latexmk_had_already_printed() {
        let partial = "Running 'pdflatex ...'\nProcessing figures/large.pdf\n";
        let stopped = cancelled_build(Instant::now(), partial, "main.tex");

        assert!(!stopped.success && !stopped.has_pdf);
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
}
