//! One latexmk build per project at a time, abortable from the UI.

use super::build_log::{
    advice, is_stale_previous_invocation_log, log_conference_template, pages_written,
    parse_diagnostics, parse_format_diagnostics, skipped_recompile, trim_log,
};
use super::build_stall::{self, Progress};
use super::build_steps::BuildSteps;
use super::compile_root::{choose_compile_root, is_one_off_root};
use super::preamble_format::{self, Prepared};
use super::{
    arxiv, bib_log, compiled_document, diagnostic_paths, engine_mismatch, latexmk, prewarm,
    shown_pdf, synctex_missing,
};
use crate::commands;
use crate::latex::BuildResult;
use crate::models::{Diagnostic, ProjectManifest};
use crate::wide_event::{self, Failure};
use crate::{pdf_fonts, project};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

mod active;
pub(crate) use active::begin_active;
pub use active::{abort, is_running, ActiveBuild};
use active::{finish_active, stop_stalled, terminate, was_stalled, BuildSession};

/// Run `command` as this project's build and capture its output, reporting
/// whether it was cancelled. The error texts prefix the spawn/wait error.
///
/// Both pipes are read a line at a time as the process writes them, so the
/// passes latexmk announces reach `steps` while it runs; the step still open
/// when the process exits ends with it.
pub(super) fn run_tracked(
    command: Command, active: &ActiveBuild, steps: &BuildSteps, start_error: &str, wait_error: &str,
) -> Result<(Output, bool), String> {
    run_watched(command, active, steps, start_error, wait_error, build_stall::STALL_LIMIT)
}

fn run_watched(
    mut command: Command, active: &ActiveBuild, steps: &BuildSteps, start_error: &str,
    wait_error: &str, stall_limit: Duration,
) -> Result<(Output, bool), String> {
    commands::in_new_process_group(&mut command).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("{start_error}{error}"))?;
    let pid = child.id();
    match begin_active(active, pid) {
        // Stopped between two of the build's processes: this one ends at once.
        Ok(true) => terminate(pid),
        Ok(false) => {}
        Err(error) => {
            terminate(pid);
            let _ = child.wait_with_output();
            return Err(error);
        }
    }
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let progress = Progress::new();
    let (stdout, stderr) = std::thread::scope(|scope| {
        let stdout = scope.spawn(|| read_lines(stdout, steps, &progress));
        let stderr = scope.spawn(|| read_lines(stderr, steps, &progress));
        scope.spawn(|| progress.stalled_for(stall_limit).then(|| stop_stalled(active)));
        let read = (stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default());
        progress.finish();
        read
    });
    let status = child.wait().map_err(|error| format!("{wait_error}{error}"))?;
    steps.finish();
    Ok((Output { status, stdout, stderr }, finish_active(active)))
}

/// Everything `pipe` carries until it closes, each line shown to `steps` as it lands.
fn read_lines(pipe: Option<impl Read>, steps: &BuildSteps, progress: &Progress) -> Vec<u8> {
    let mut bytes = Vec::new();
    let Some(pipe) = pipe else { return bytes };
    let mut reader = BufReader::new(pipe);
    loop {
        let start = bytes.len();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => return bytes,
            Ok(_) => {
                progress.note(&bytes[start..]);
                steps.line(&bytes[start..]);
            }
        }
    }
}

pub fn clean(root: &Path) -> Result<String, String> {
    let manifest = project::read_manifest(root)?;
    let document = compiled_document(root, &manifest)?;
    let output =
        latexmk(root).arg("-c").arg(&document).output().map_err(|error| {
            format!("Could not start latexmk. Install MacTeX or TeX Live. {error}")
        })?;
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
    } else if error.contains(", the main document, is missing.") {
        Failure {
            kind: "root_document_missing",
            fix: "Set an existing .tex file as the main document, or build from it.",
        }
    } else if error.starts_with("The project changed") {
        Failure { kind: "project_changed", fix: "Build again in the project now open." }
    } else {
        Failure { kind: "build_error", fix: "Build again; if it repeats, report it with the log." }
    }
}

const ALREADY_RUNNING: &str = "A build is already running.";

/// The manifest names a main document that is not on disk (see
/// `project::open`, which replaces one it can): say which, and where to choose.
fn missing_root(document: &str) -> String {
    format!("{document}, the main document, is missing. Right-click another .tex file in the Project panel and choose Set as main document.")
}

pub fn build(
    root: &Path, force: bool, active: &ActiveBuild, open_document: Option<&str>, steps: &BuildSteps,
) -> Result<BuildResult, String> {
    let session = BuildSession::open(active);
    let mut result = build_passes(root, force, active, open_document, steps)?;
    drop(session);
    result.one_off = is_one_off_root(root);
    result.steps = steps.take();
    result.synctex = result.has_pdf.then(|| !synctex_missing(root));
    if shown_pdf::settle(root, &result.root_document, result.has_pdf) {
        wide_event::record("shown_pdf_restored", true);
    }
    result.outputs = arxiv::written_by_build(root, &result.root_document);
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
    wide_event::record("passes", result.steps.len());
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
    root: &Path, force: bool, active: &ActiveBuild, open_document: Option<&str>, steps: &BuildSteps,
) -> Result<BuildResult, String> {
    wide_event::record("force", force);
    choose_compile_root(root, open_document)?;
    // A Clean rebuild starts the preamble format over too. The reruns below
    // that force latexmk keep it: they are not about the preamble.
    if force {
        preamble_format::discard(root);
    }
    if let Some(cancelled) = prewarm::prewarm_cold_pdf_build(root, force, active, steps)? {
        return Ok(cancelled);
    }
    let mut result = run_latexmk(root, force, active, steps)?;
    // After fixing missing packages, latexmk often reports "Nothing to do" while still
    // remembering the previous failed pass. Clean once and force a fresh run.
    if !result.success && is_stale_previous_invocation_log(&result.log) {
        let _ = clean(root);
        wide_event::record("stale_rebuild", true);
        result = run_latexmk(root, true, active, steps)?;
        // At the end: a failed log is read and copied from its top, where
        // this note used to stand in for the error that followed it.
        if !result.log.is_empty() {
            result.log.push_str("\n\nLattice cleared a stale failed build, then rebuilt.");
        }
    }
    // A document written for pdfLaTeX (arXiv's `\pdfoutput=1`) under XeLaTeX
    // or LuaLaTeX. When nothing in the project wants the engine it has, switch
    // and build again now; the note says so and carries the undo.
    if let Some(switch) = engine_mismatch::automatic_switch(root, &result) {
        let pdf = project::ManifestSettings {
            engine: Some("pdf".to_string()),
            ..project::ManifestSettings::default()
        };
        project::update_manifest_settings(root, pdf)?;
        wide_event::record("engine_switched_from", switch.previous.as_str());
        result = run_latexmk(root, force, active, steps)?;
        result.diagnostics.insert(0, switch.note());
    }
    // A PDF built by anything else (the agent's own `latexmk -pdf`, say)
    // leaves latexmk with nothing to do, so `-synctex=1` never reaches the
    // engine and every click on the PDF answers "no SyncTeX data". Force the
    // one rebuild that writes it — only when the run really skipped
    // typesetting, so an engine that cannot produce SyncTeX is not compiled
    // twice on every build.
    if result.success && !force && skipped_recompile(&result.log) && synctex_missing(root) {
        wide_event::record("synctex_rebuild", true);
        result = run_latexmk(root, true, active, steps)?;
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

/// How latexmk typesets the project's documents: its engine, and whether
/// they may run shell commands.
pub(super) fn engine_args(root: &Path, manifest: &ProjectManifest) -> Vec<&'static str> {
    let mut args = if project::has_latexmkrc(root) {
        // An rc file may only define asset rules, leaving latexmk's default
        // DVI target active. -e runs after rc loading: supply a PDF default
        // without overriding an explicitly configured PDF pipeline.
        vec!["-e", latexmk_pdf_default(&manifest.engine)]
    } else {
        vec![project::latexmk_engine_arg(&manifest.engine)]
    };
    if !manifest.trusted {
        args.push("-no-shell-escape");
    }
    args
}

/// What a LaTeX error does to the build.
///
/// By default TeX carries on past it, as Overleaf does: every error in the
/// document is reported at once, and the PDF and SyncTeX map of the pages
/// that did typeset are written. `-f` lets latexmk finish its passes too
/// (BibTeX, the reruns for references), so those pages read as they will
/// once the error is fixed rather than full of "??". latexmk's rerun limit
/// still bounds the passes, and run again with nothing changed it answers
/// that the last run failed rather than typesetting again. Stop on first
/// error restores `-halt-on-error`, after which pdfTeX writes no PDF at all.
fn error_mode(manifest: &ProjectManifest) -> &'static str {
    if manifest.stop_on_first_error {
        "-halt-on-error"
    } else {
        "-f"
    }
}

fn run_latexmk(
    root: &Path, force: bool, active: &ActiveBuild, steps: &BuildSteps,
) -> Result<BuildResult, String> {
    run_latexmk_with(root, force, active, steps, true)
}

fn run_latexmk_with(
    root: &Path, force: bool, active: &ActiveBuild, steps: &BuildSteps, use_format: bool,
) -> Result<BuildResult, String> {
    let manifest = project::read_manifest(root)?;
    let document = compiled_document(root, &manifest)?;
    let root_document = project::safe_path(root, &document)?;
    if !root_document.exists() {
        return Err(missing_root(&document));
    }
    let prepared = if use_format {
        preamble_format::prepare(root, &manifest, &document, &root_document, active, steps)
    } else {
        Prepared::Plain
    };
    let format = match prepared {
        Prepared::Ready(format) => Some(format),
        Prepared::Plain => None,
        Prepared::Cancelled(log) => return Ok(cancelled_build(steps.started(), &log, &document)),
    };

    let mut command = latexmk(root);
    command.args(["-interaction=nonstopmode", "-synctex=1", "-file-line-error"]);
    command.arg(error_mode(&manifest));
    command.args(engine_args(root, &manifest));
    if let Some(format) = &format {
        command.arg(format.latexmk_arg());
    }
    if force {
        command.arg("-g");
    }
    command.arg(&document);
    wide_event::record("engine", manifest.engine.as_str());
    wide_event::add("latexmk_runs", 1);

    let step = wide_event::step("latexmk");
    let (output, cancelled) = run_tracked(
        command,
        active,
        steps,
        "Could not start latexmk. Install MacTeX or TeX Live. ",
        "latexmk exited unexpectedly: ",
    )?;
    drop(step);
    let log = commands::combined_output(&output);
    if cancelled {
        if was_stalled(active) {
            return Ok(build_stall::stalled_build(steps.started(), &log, &document));
        }
        return Ok(cancelled_build(steps.started(), &log, &document));
    }

    let success = output.status.success();
    // Whatever went wrong, the plain build decides: a document error fails it
    // too, and the format stays; a build only the format broke passes, and
    // the format is never used for these inputs again. Forced, because
    // latexmk does not count a changed command as a reason to run again and
    // would only repeat that the last run failed.
    if let Some(format) = format.as_ref().filter(|_| !success) {
        wide_event::record("preamble_format", "retried_plain");
        let plain = run_latexmk_with(root, true, active, steps, false)?;
        if plain.success {
            format.reject();
        }
        return Ok(plain);
    }
    let pdf_path = root_document.with_extension("pdf");
    let pdf_bytes = if pdf_path.exists() {
        Some(fs::read(&pdf_path).map_err(|error| error.to_string())?)
    } else {
        None
    };
    if let Some(pdf) = &pdf_bytes {
        wide_event::record("pdf_bytes", pdf.len());
    }
    // A build from the preamble format never loads the preamble, so what
    // loading it reported comes from when the format was made.
    let mut diagnostics = match &format {
        Some(format) => parse_format_diagnostics(&format.output, &log),
        None => parse_diagnostics(&log),
    };
    diagnostics.extend(bib_log::bibliography_diagnostics(&root_document));
    super::cjk_text::mark_ctex_missing(&mut diagnostics, crate::doctor::tex_file_installed);
    diagnostic_paths::locate_in_project(root, &document, &mut diagnostics);
    // latexmk's output is TeX's terminal, which leaves out what fontspec
    // notes only in the log file.
    let mut tex_log = fs::read_to_string(root_document.with_extension("log")).unwrap_or_default();
    if let Some(format) = &format {
        tex_log.insert_str(0, &format.log);
    }
    if let Some(mut warning) =
        pdf_bytes.as_deref().filter(|_| success).and_then(|pdf| font_warning(pdf, &tex_log, &log))
    {
        warning.file = Some(document.clone());
        diagnostics.push(warning);
    }
    Ok(BuildResult {
        success,
        has_pdf: pdf_bytes.is_some(),
        diagnostics,
        log: trim_log(&log),
        duration_ms: steps.started().elapsed().as_millis(),
        root_document: document.clone(),
        one_off: false,
        venue: log_conference_template(&tex_log).or_else(|| log_conference_template(&log)),
        steps: Vec::new(),
        pages: pages_written(&tex_log),
        synctex: None,
        outputs: Vec::new(),
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
        one_off: false,
        venue: None,
        steps: Vec::new(),
        pages: None,
        synctex: None,
        outputs: Vec::new(),
    }
}

#[cfg(test)]
mod diagnostics_tests;
#[cfg(test)]
mod error_mode_tests;
#[cfg(test)]
mod latexmkrc_tests;
#[cfg(test)]
mod stall_tests;
#[cfg(test)]
mod stop_tests;

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
        assert_eq!(kind(&missing_root("main.tex")), "root_document_missing");
        assert_eq!(kind("The project changed before its build could start."), "project_changed");
        assert_eq!(kind("latexmk exited unexpectedly: signal"), "build_error");
    }

    #[test]
    fn every_latexmk_run_writes_its_log_unwrapped() {
        let command = latexmk(Path::new("."));
        let wide = command.get_envs().any(|(name, value)| {
            name == "max_print_line" && value.is_some_and(|value| value == "10000")
        });
        assert!(wide);
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
        let result =
            run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent()).unwrap();
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
        let traceback = super::super::rc_failure::PLAYWRIGHT_RC_FAILURE;
        fs::write(root.join("playwright-error.txt"), traceback.split("Latexmk:").next().unwrap())
            .unwrap();
        fs::write(
            root.join(".latexmkrc"),
            "system('cat playwright-error.txt >&2; exit 1') == 0\n  or die \"Probe SVG conversion failed\\n\";\n",
        )
        .unwrap();
        let result =
            build(&root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
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
        let result =
            build(&root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
        assert!(result.success, "{}", result.log);
        assert_eq!(result.root_document, "main.tex");
        assert!(super::super::read_compiled_pdf(&root).unwrap().starts_with(b"%PDF-"));
    }

    #[test]
    #[ignore = "requires latexmk, pdfLaTeX and mylatexformat"]
    fn a_build_from_the_preamble_format_reports_what_the_plain_build_does() {
        let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("templates/iclr-2026");
        let build = |use_format| {
            let root = TempDir::new("latex");
            project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
            for file in ["iclr2026_conference.sty", "iclr2026_conference.bst"] {
                fs::copy(template.join(file), root.join(file)).unwrap();
            }
            let main = fs::read_to_string(template.join("main.tex")).unwrap();
            root.write("main.tex", main.replace("LATTICE_PROJECT_TITLE", "A Paper"));
            let steps = BuildSteps::silent();
            let result =
                run_latexmk_with(&root, false, &ActiveBuild::default(), &steps, use_format)
                    .unwrap();
            let log = fs::read_to_string(root.join("main.log")).unwrap();
            (result, steps.take(), log.contains("CUSTOMISED FORMAT"))
        };
        let (plain, _, plain_format) = build(false);
        let (formatted, steps, from_format) = build(true);
        assert!(!plain_format && from_format, "only the second build ran from the format");
        assert_eq!(steps[0].tool, preamble_format::STEP);
        assert!(plain.success && formatted.success, "{}", formatted.log);
        assert_eq!(formatted.venue, Some("ICLR"));
        assert_eq!((formatted.venue, formatted.pages), (plain.venue, plain.pages));
        let messages = |result: &BuildResult| {
            let mut messages: Vec<_> =
                result.diagnostics.iter().map(|d| d.message.clone()).collect();
            messages.sort();
            messages
        };
        assert_eq!(messages(&formatted), messages(&plain));
    }

    #[test]
    #[ignore = "requires latexmk, pdfLaTeX and mylatexformat"]
    fn a_build_only_the_preamble_format_breaks_is_built_plain_and_the_format_dropped() {
        let root = TempDir::new("latex");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
        );
        let build = || run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent());
        assert!(build().unwrap().success);
        let format = preamble_format::format_file(&root).unwrap();
        fs::write(&format, b"not a format").unwrap();

        root.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\nHey\n\\end{document}\n",
        );
        let result = build().unwrap();
        assert!(result.success, "{}", result.log);
        assert!(!format.exists(), "the format that broke the build is gone");
        assert!(build().unwrap().success);
        assert!(!format.exists(), "and is not made again for the same inputs");
    }

    #[test]
    fn a_poisoned_build_lock_does_not_masquerade_as_a_cancelled_build() {
        let active = ActiveBuild::default();
        // An unrelated panic taken while this lock is held poisons it for the
        // rest of the session; that must not turn every later build into
        // "cancelled".
        let poisoner = std::sync::Arc::clone(&active);
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
