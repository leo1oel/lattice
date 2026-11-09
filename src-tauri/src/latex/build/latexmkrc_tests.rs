//! A project's or user's latexmkrc cannot move the build's output out of
//! sight or turn the build into a watcher that never ends.

use super::*;
use crate::test_support::TempDir;
use std::time::Duration;

const HELLO: &str = "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n";

#[test]
fn every_latexmk_run_overrides_the_rc_output_and_previewer() {
    let command = latexmk(Path::new("."));
    let args: Vec<_> = command.get_args().filter_map(|arg| arg.to_str()).collect();
    for option in ["-outdir=.", "-auxdir=.", "-pv-", "-pvc-"] {
        assert!(args.contains(&option), "{option} missing from {args:?}");
    }
}

/// A project's `$out_dir` used to leave the PDF in `build/` while the
/// preview and SyncTeX read beside the document.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn a_project_rc_out_dir_still_builds_the_pdf_beside_the_document() {
    let root = TempDir::new("latexmkrc-project");
    project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
    root.write(".latexmkrc", "$out_dir = 'build';\n$aux_dir = 'build';\n");
    root.write("main.tex", HELLO);
    let result = run_latexmk(&root, false, &ActiveBuild::default(), &BuildSteps::silent()).unwrap();
    assert!(result.success && result.has_pdf, "{}", result.log);
    assert!(root.join("main.pdf").is_file());
    assert!(root.join("main.synctex.gz").is_file());
    assert!(root.join("main.log").is_file());
    assert!(!root.join("build/main.pdf").exists());
}

/// The user's own `~/.latexmkrc`, under a stand-in HOME: an `$out_dir`
/// moved the PDF away, and `$preview_continuous_mode` never let latexmk exit.
#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn a_users_rc_cannot_move_the_pdf_or_keep_the_build_running() {
    let rcs = [
        "$out_dir = 'out';\n",
        "$preview_continuous_mode = 1;\n$pdf_previewer = 'true';\n",
        "$preview_mode = 1;\n$pdf_previewer = 'true';\n",
    ];
    for rc in rcs {
        let home = TempDir::new("latexmkrc-home");
        home.write(".latexmkrc", rc);
        let root = TempDir::new("latexmkrc-global");
        root.write("main.tex", HELLO);
        let mut command = latexmk(&root);
        command
            .env("HOME", &*home)
            .args(["-interaction=nonstopmode", "-synctex=1", "-pdf", "main.tex"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        commands::in_new_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                commands::signal_process_group(child.id(), commands::KILL_SIGNAL);
                let _ = child.wait();
                panic!("latexmk was still running a minute in, under the rc {rc:?}");
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        assert!(status.success(), "{rc:?}");
        assert!(root.join("main.pdf").is_file(), "{rc:?}");
        assert!(root.join("main.synctex.gz").is_file(), "{rc:?}");
    }
}
