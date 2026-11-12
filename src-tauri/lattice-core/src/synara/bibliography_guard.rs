//! The bibliography write guard the agent sidecar runs inside.
//!
//! The prompt tells providers to use Lattice's bibliography tools, but prompt
//! text is not an authorization boundary. On macOS the complete sidecar runs
//! inside one Seatbelt profile, so in-process agents, provider CLIs, scripts,
//! and delayed descendants all inherit the same .bib write denial; the trusted
//! parent app brokers the three allowed bibliography mutations. No other
//! platform has a guard yet, and there the agent does not start: it fails
//! closed, with a notice, rather than running with the guarantee silently gone.

use std::path::Path;
use std::process::Command;

#[cfg(target_os = "macos")]
pub(crate) const BIBLIOGRAPHY_SANDBOX_PROFILE: &str = concat!(
    "(version 1)\n",
    "(allow default)\n",
    "(deny file-write* (regex #\".*[.][bB][iI][bB]$\"))",
);
/// Whether this platform can keep the sidecar from writing `.bib` files
/// itself. Without the guard the agent could write unverified references
/// straight into a bibliography, so it stays off.
pub(super) const AVAILABLE: bool = cfg!(target_os = "macos");
/// The `unsupported` state's message: English for logs and copied reports;
/// the agent surfaces show their own localized notice for the state.
pub(super) const MISSING: &str = "The built-in agent is off on this platform until Lattice \
     can keep it from editing bibliography (.bib) files directly.";

/// The sidecar's launch: `node` inside the guard, with Lattice's own `ps`
/// replacement (`process_inspector`), which works only inside it.
#[cfg(target_os = "macos")]
pub(super) fn command(node: &Path, home_dir: &Path, executable: &Path) -> Result<Command, String> {
    let inspector = crate::process_inspector::install_launcher(home_dir, executable)?;
    crate::process_inspector::verify_launcher(&inspector)?;
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-p")
        .arg(BIBLIOGRAPHY_SANDBOX_PROFILE)
        .arg(node)
        // Children inherit this profile. A second sandbox-exec can fail
        // sandbox_apply on older macOS before Codex even starts.
        .env("LATTICE_BIBLIOGRAPHY_SANDBOX", "1")
        .env("SYNARA_PROCESS_PS_PATH", inspector);
    Ok(command)
}

/// No guard, so no launch. `ensure_ready` stops first; this keeps an
/// unguarded sidecar from starting by any other path.
#[cfg(not(target_os = "macos"))]
pub(super) fn command(
    _node: &Path, _home_dir: &Path, _executable: &Path,
) -> Result<Command, String> {
    Err(MISSING.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    fn run_bibliography_sandbox(script: &str, args: &[&PathBuf]) -> bool {
        Command::new("/usr/bin/sandbox-exec")
            .args(["-p", BIBLIOGRAPHY_SANDBOX_PROFILE, "/bin/sh", "-c", script, "sandbox-test"])
            .args(args)
            .status()
            .expect("run sandboxed command")
            .success()
    }

    #[test]
    fn bibliography_sandbox_blocks_direct_and_indirect_bib_writes() {
        let root = TempDir::new("bib-sandbox");
        let path = |name: &str| root.join(name);
        let (bibliography, uppercase, ordinary) = (
            root.write("references.bib", "original"),
            root.write("OTHER.BIB", "uppercase"),
            root.write("ordinary.txt", "ordinary"),
        );
        let (replacement, renamed, alias) =
            (path("replacement.tmp"), path("renamed.tmp"), path("alias.txt"));
        let (bib_alias, hardlink_alias) = (path("alias.bib"), path("hardlink.txt"));
        crate::test_support::symlink(&bibliography, &alias).expect("symlink to bibliography");

        let attempts: [(&str, &[&PathBuf]); 9] = [
            ("printf changed >> \"$1\"", &[&bibliography]),
            ("printf changed > \"$1\"", &[&bibliography]),
            ("rm \"$1\"", &[&bibliography]),
            ("printf replacement > \"$1\" && mv -f \"$1\" \"$2\"", &[&replacement, &bibliography]),
            (
                "mv \"$1\" \"$2\" && printf changed > \"$2\" && mv \"$2\" \"$1\"",
                &[&bibliography, &renamed],
            ),
            ("printf changed > \"$1\"", &[&uppercase]),
            ("ln \"$1\" \"$2\" && printf changed > \"$2\"", &[&bibliography, &hardlink_alias]),
            ("printf changed > \"$1\"", &[&alias]),
            ("ln -s \"$1\" \"$2\" && printf changed > \"$2\"", &[&ordinary, &bib_alias]),
        ];
        for (script, args) in attempts {
            assert!(!run_bibliography_sandbox(script, args), "sandbox allowed: {script}");
        }

        assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
        assert_eq!(fs::read_to_string(&uppercase).unwrap(), "uppercase");
        assert!(run_bibliography_sandbox("printf changed > \"$1\"", &[&ordinary]));
        assert_eq!(fs::read_to_string(&ordinary).unwrap(), "changed");

        // Background descendants that outlive the sandboxed shell inherit it.
        assert!(run_bibliography_sandbox(
            "(sleep 0.05; printf changed > \"$1\") >/dev/null 2>&1 &",
            &[&bibliography],
        ));
        thread::sleep(Duration::from_millis(150));
        assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    }
}
