//! The build as a whole: how its errors are classed, the log it reads, rc
//! files, the preamble format, and a build stopped or left holding its lock.

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
    let result = run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent()).unwrap();
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
        build(&root, false, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
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
        build(&root, false, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
    assert!(result.success, "{}", result.log);
    assert_eq!(result.root_document, "main.tex");
    assert!(super::super::read_compiled_pdf(&root).unwrap().starts_with(b"%PDF-"));
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and mylatexformat"]
fn a_build_from_the_preamble_format_reports_what_the_plain_build_does() {
    let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/iclr-2026");
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
            run_latexmk_with(&root, false, &ActiveBuild::default(), &steps, use_format).unwrap();
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
        let mut messages: Vec<_> = result.diagnostics.iter().map(|d| d.message.clone()).collect();
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
    root.write("main.tex", "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n");
    let build = || run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent());
    assert!(build().unwrap().success);
    let format = preamble_format::format_file(&root).unwrap();
    fs::write(&format, b"not a format").unwrap();

    root.write("main.tex", "\\documentclass{article}\n\\begin{document}\nHey\n\\end{document}\n");
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
