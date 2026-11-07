//! Unprivileged `ps` replacement for the Synara sidecar.
//!
//! Synara inspects its process tree with `ps`, but the sidecar runs inside the
//! bibliography sandbox where copying Apple's setuid `/bin/ps` does not work.
//! Instead a tiny shell launcher re-enters Lattice's own signed executable in
//! [`FLAG`] mode, which runs before Tauri initialization, inherits the
//! sandbox, and prints the process table through `process_inspector.c`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) const FLAG: &str = "--lattice-process-snapshot";

unsafe extern "C" {
    fn lattice_process_snapshot(with_parent: i32, pids: *const i32, pid_count: usize) -> i32;
}

fn query(args: &[String]) -> Result<(bool, Vec<i32>), &'static str> {
    if args == ["-eo", "pid=,ppid=,command="] {
        return Ok((true, Vec::new()));
    }
    if args.len() == 4 && args[0] == "-p" && args[2] == "-o" && args[3] == "pid=,command=" {
        let pids = args[1]
            .split(',')
            .map(|pid| pid.parse::<i32>().ok().filter(|pid| *pid > 0))
            .collect::<Option<Vec<_>>>()
            .ok_or("Invalid process IDs")?;
        return Ok((false, pids));
    }
    Err("Unsupported process snapshot arguments")
}

pub(crate) fn run_if_requested() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return;
    }
    let (with_parent, pids) = query(&args.collect::<Vec<_>>()).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    // SAFETY: the native function reads exactly pid_count entries, borrows the
    // slice only for this call, and uses SDK definitions for the kernel ABI.
    let error =
        unsafe { lattice_process_snapshot(i32::from(with_parent), pids.as_ptr(), pids.len()) };
    if error != 0 {
        eprintln!("Process snapshot failed: {}", std::io::Error::from_raw_os_error(error));
        std::process::exit(1);
    }
    std::process::exit(0);
}

/// Install `<home>/process-tools/ps`, a launcher that re-enters `executable`
/// in snapshot mode. Keep the executable inside the signed bundle: copying
/// Apple's /bin/ps without setuid can pass signature verification but still
/// die on launch.
pub(crate) fn install_launcher(home: &Path, executable: &Path) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let executable = executable
        .to_str()
        .ok_or("The app executable path is not valid UTF-8")?
        .replace('\'', "'\\''");
    let script = format!("#!/bin/sh\nexec '{executable}' {FLAG} \"$@\"\n");
    let directory = home.join("process-tools");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not prepare process tools: {error}"))?;
    let temporary = directory.join(format!("ps-{}", uuid::Uuid::new_v4()));
    let destination = directory.join("ps");
    let result = (|| -> std::io::Result<()> {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        output.write_all(script.as_bytes())?;
        output.set_permissions(fs::Permissions::from_mode(0o755))?;
        fs::rename(&temporary, &destination)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not prepare unprivileged process inspector: {error}"));
    }
    Ok(destination)
}

/// Check actual execution under the provider sandbox, not just signatures.
/// Fail at startup with an actionable error, before a chat is quarantined.
pub(crate) fn verify_launcher(launcher: &Path) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", crate::synara::BIBLIOGRAPHY_SANDBOX_PROFILE])
        .arg(launcher)
        .args(["-p", &std::process::id().to_string(), "-o", "pid=,command="])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the process inspector: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Process inspector startup check did not complete: {result:?}"
                ));
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read the process inspector result: {error}"))?;
    let expected = format!("{} lattice-process:", std::process::id());
    if !output.status.success() || !output.stdout.starts_with(expected.as_bytes()) {
        return Err(format!(
            "Process inspector startup check failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_two_synara_snapshot_formats() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(query(&args(&["-eo", "pid=,ppid=,command="])), Ok((true, vec![])));
        assert_eq!(
            query(&args(&["-p", "31,72", "-o", "pid=,command="])),
            Ok((false, vec![31, 72]))
        );
        for pids in ["", "0", "-1", "31,", "31,abc", "2147483648"] {
            assert!(query(&args(&["-p", pids, "-o", "pid=,command="])).is_err());
        }
        assert!(query(&args(&["-eo", "pid="])).is_err());
        assert!(query(&[]).is_err());
    }

    #[test]
    fn launcher_preserves_paths_and_replaces_legacy_binary() {
        use std::os::unix::fs::PermissionsExt;

        let home = crate::test_support::TempDir::new("process tools'");
        home.write("process-tools/ps", "legacy system binary");
        let executable = home.write("Lattice's executable", "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let launcher = install_launcher(&home, &executable).unwrap();
        assert_eq!(fs::metadata(&launcher).unwrap().permissions().mode() & 0o7777, 0o755);
        let output = Command::new(&launcher).args(["-eo", "pid=,ppid=,command="]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "--lattice-process-snapshot\n-eo\npid=,ppid=,command=\n"
        );
        // A non-query executable must fail preflight, even if it exits zero.
        assert!(verify_launcher(&launcher).is_err());
        assert_eq!(install_launcher(&home, &executable).unwrap(), launcher);
    }
}
