//! The shipped installer scripts run against a bash stub of tlmgr. Unix
//! only: the stub is a bash script marked executable.

use super::*;
use std::fs;

/// A stand-in for tlmgr in `dir` that records each command line in
/// `calls`. `update --all` prints tlmgr's counter lines, which pad the
/// current number to the width of the total (`[ 1/12, …]`), and after
/// each one records what STATUS then says in `statuses`; with
/// `fail_update_all` it fails the way an unreachable repository does.
/// Every run first records what STATUS says in `stages`.
struct StubTlmgr {
    path: std::path::PathBuf,
    calls: std::path::PathBuf,
    statuses: std::path::PathBuf,
    stages: std::path::PathBuf,
}

impl StubTlmgr {
    fn new(dir: &Path, root: &Path, fail_update_all: bool) -> Self {
        let calls = dir.join("calls");
        let statuses = dir.join("statuses");
        let stages = dir.join("stages");
        let update_all = if fail_update_all {
            "echo 'tlmgr: TLPDB::from_file could not get texlive.tlpdb' >&2\n    exit 1".to_string()
        } else {
            format!(
                "last=\"$(cat {status})\"\n    \
                 for n in 1 12; do\n      \
                 printf '[%2d/12, ??:??/??:??] update: package%d\\n' \"$n\" \"$n\"\n      \
                 for _ in $(seq 300); do\n        \
                 current=\"$(cat {status})\"\n        \
                 [[ \"$current\" != \"$last\" ]] && break\n        \
                 sleep 0.01\n      \
                 done\n      \
                 printf '%s\\n' \"$current\" >> {statuses}\n      \
                 last=\"$current\"\n    \
                 done",
                status = shell_quote(&root.join("status").to_string_lossy()),
                statuses = shell_quote(&statuses.to_string_lossy()),
            )
        };
        let script = format!(
            "#!/bin/bash\nprintf '%s\\n' \"$*\" >> {calls}\ncat {status} >> {stages}\ncase \"$*\" in\n  *'update --all')\n    {update_all}\n    ;;\nesac\n",
            calls = shell_quote(&calls.to_string_lossy()),
            status = shell_quote(&root.join("status").to_string_lossy()),
            stages = shell_quote(&stages.to_string_lossy()),
        );
        let path = dir.join("tlmgr");
        fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        Self { path, calls, statuses, stages }
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path).unwrap_or_default().lines().map(String::from).collect()
    }
}

/// Runs an installer script the way `privileged_command` does.
fn run_installer(script: &str) -> std::process::Output {
    std::process::Command::new("/bin/bash").arg("-c").arg(script).output().unwrap()
}

#[test]
fn package_update_script_updates_tlmgr_then_every_package_with_progress() {
    let workspace = crate::test_support::TempDir::new("package-update-test");
    let root = workspace.join("root");
    let tlmgr = StubTlmgr::new(&workspace, &root, false);

    let output = run_installer(&package_update_script(&root, &tlmgr.path));

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(StubTlmgr::lines(&tlmgr.calls), ["update --self", "update --all"]);
    // Every counter line, padded or not, moves the progress the app polls.
    assert_eq!(
        StubTlmgr::lines(&tlmgr.statuses),
        ["updating-packages 1 12", "updating-packages 12 12"]
    );
    assert!(output.stdout.is_empty() && output.stderr.is_empty());
    assert!(!root.exists());
}

#[test]
fn package_update_script_reports_a_failed_update_with_tlmgrs_words() {
    let workspace = crate::test_support::TempDir::new("package-update-failure-test");
    let root = workspace.join("root");
    let tlmgr = StubTlmgr::new(&workspace, &root, true);

    let output = run_installer(&package_update_script(&root, &tlmgr.path));

    assert!(!output.status.success());
    // The configured repository, then each fallback mirror.
    let calls = StubTlmgr::lines(&tlmgr.calls);
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert!(calls[1..].iter().all(|call| call.ends_with("update --all")), "{calls:?}");
    let error = package_update_error(&String::from_utf8_lossy(&output.stderr));
    assert!(
        error.starts_with(&format!(
            "{PACKAGE_UPDATE_FAILED}\nUpdating the installed LaTeX packages failed.\n"
        )),
        "{error}"
    );
    assert!(error.contains("could not get texlive.tlpdb"), "{error}");
    assert!(!root.exists());
}

/// The BasicTeX install as shipped, with INSTALL_BASE 0 and TEXBIN a
/// folder holding only the stub tlmgr. The prelude's contract for a step
/// that may fail without failing the install, and the intent's: a failed
/// package update leaves the install going on to the required packages
/// and exiting 0, and its warning reaches the original stdout, not LOG
/// or stderr.
#[test]
fn basic_tex_install_goes_on_after_a_failed_package_update_and_warns() {
    let workspace = crate::test_support::TempDir::new("basic-tex-warning-test");
    let root = workspace.join("root");
    let texbin = workspace.join("texbin");
    fs::create_dir(&texbin).unwrap();
    let tlmgr = StubTlmgr::new(&texbin, &root, true);
    let shipped = basic_tex_script(&workspace.join("BasicTeX.pkg"), &root, false);
    let system_texbin = "TEXBIN=\"/Library/TeX/texbin\"\n";
    assert_eq!(shipped.matches(system_texbin).count(), 1);
    let script = shipped
        .replace(system_texbin, &format!("TEXBIN={}\n", shell_quote(&texbin.to_string_lossy())));
    assert!(!script.contains("/Library/TeX"));

    let output = run_installer(&script);

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
    let calls = StubTlmgr::lines(&tlmgr.calls);
    assert_eq!(calls.first().map(String::as_str), Some("update --self"), "{calls:?}");
    assert!(calls.last().is_some_and(|call| call.starts_with("install latexmk ")), "{calls:?}");
    // update --self, update --all from each repository, then the install.
    let stages = StubTlmgr::lines(&tlmgr.stages);
    assert_eq!(stages.len(), 5, "{stages:?}");
    assert!(stages[..4].iter().all(|stage| stage == "updating-base"), "{stages:?}");
    assert_eq!(stages[4], "installing-packages");
    let warning = install_warning(&String::from_utf8_lossy(&output.stdout)).unwrap();
    assert!(
        warning.starts_with(&format!(
            "{BASE_UPDATE_FAILED}\nUpdating the installed LaTeX packages failed.\n"
        )),
        "{warning}"
    );
    assert!(warning.contains("could not get texlive.tlpdb"), "{warning}");
    assert!(!root.exists());
}
