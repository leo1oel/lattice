#![cfg(target_os = "macos")]

use std::process::{Child, Command, Output};

const FLAG: &str = "--lattice-process-snapshot";
const BIB_SANDBOX: &str =
    "(version 1)(allow default)(deny file-write* (regex #\".*[.][bB][iI][bB]$\"))";

fn snapshot(profile: &str, args: &[&str]) -> Output {
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, env!("CARGO_BIN_EXE_research-writer"), FLAG])
        .args(args)
        .output()
        .unwrap()
}

/// A snapshot that must succeed inside the bibliography sandbox, as text.
fn sandboxed_snapshot(args: &[&str]) -> String {
    let output = snapshot(BIB_SANDBOX, args);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

struct Sleep(Child);

impl Drop for Sleep {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn signed_app_entrypoint_inspects_real_processes_inside_bibliography_sandbox() {
    let mut child = Sleep(Command::new("/bin/sleep").arg("30").spawn().unwrap());
    let pid = child.0.id().to_string();
    let parent = std::process::id().to_string();
    let all = sandboxed_snapshot(&["-eo", "pid=,ppid=,command="]);
    let row = all
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>())
        .find(|fields| fields[0] == pid)
        .expect("child in snapshot");
    assert_eq!(row.len(), 3);
    assert_eq!(row[1], parent);
    assert!(row[2].starts_with("lattice-process:"));
    assert_ne!(row[2], "lattice-process:0:0");
    let identity = row[2].to_string();

    let selected = sandboxed_snapshot(&["-p", &pid, "-o", "pid=,command="]);
    assert_eq!(selected, format!("{pid} {identity}\n"));

    // Equal executable names are not identities: separate sleep instances
    // must differ, while repeated queries for the first instance stay equal.
    let sibling = Sleep(Command::new("/bin/sleep").arg("30").spawn().unwrap());
    let sibling_pid = sibling.0.id().to_string();
    let pids = format!("{pid},{sibling_pid}");
    let selected = sandboxed_snapshot(&["-p", &pids, "-o", "pid=,command="]);
    assert_eq!(selected.lines().count(), 2);
    assert!(selected.lines().any(|line| line == format!("{pid} {identity}")));
    let sibling_row =
        selected.lines().find(|line| line.starts_with(&format!("{sibling_pid} "))).unwrap();
    assert_ne!(sibling_row.split_once(' ').unwrap().1, identity);

    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let gone = sandboxed_snapshot(&["-p", &pid, "-o", "pid=,command="]);
    assert!(gone.is_empty(), "a reaped child must be absent");
}

#[test]
fn failed_snapshots_are_errors_not_a_successful_empty_process_table() {
    // Deny only process reads: dyld itself needs unrelated sysctls before
    // our entrypoint can run, so denying every sysctl tests the loader.
    let denied =
        "(version 1)(allow default)(deny sysctl-read (sysctl-name-regex #\"^kern[.]proc[.]\"))";
    let failed = (1, "Process snapshot failed:");
    for (profile, args, (code, error)) in [
        (denied, vec!["-eo", "pid=,ppid=,command="], failed),
        (denied, vec!["-p", "1", "-o", "pid=,command="], failed),
        // A malformed query must not launch the GUI either.
        (BIB_SANDBOX, vec!["-p", "not-a-pid", "-o", "pid=,command="], (2, "Invalid process IDs")),
    ] {
        let output = snapshot(profile, &args);
        assert_eq!(output.status.code(), Some(code), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains(error), "{args:?}");
    }
}
