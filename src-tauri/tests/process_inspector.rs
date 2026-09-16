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
    let all = snapshot(BIB_SANDBOX, &["-eo", "pid=,ppid=,command="]);
    assert!(
        all.status.success(),
        "{}",
        String::from_utf8_lossy(&all.stderr)
    );
    let all = String::from_utf8(all.stdout).unwrap();
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

    let selected = snapshot(BIB_SANDBOX, &["-p", &pid, "-o", "pid=,command="]);
    assert!(selected.status.success());
    assert_eq!(
        String::from_utf8(selected.stdout).unwrap(),
        format!("{pid} {identity}\n")
    );

    // Equal executable names are not identities: separate sleep instances
    // must differ, while repeated queries for the first instance stay equal.
    let sibling = Sleep(Command::new("/bin/sleep").arg("30").spawn().unwrap());
    let sibling_pid = sibling.0.id().to_string();
    let pids = format!("{pid},{sibling_pid}");
    let selected = snapshot(BIB_SANDBOX, &["-p", &pids, "-o", "pid=,command="]);
    assert!(selected.status.success());
    let selected = String::from_utf8(selected.stdout).unwrap();
    assert_eq!(selected.lines().count(), 2);
    assert!(selected
        .lines()
        .any(|line| line == format!("{pid} {identity}")));
    let sibling_row = selected
        .lines()
        .find(|line| line.starts_with(&format!("{sibling_pid} ")))
        .unwrap();
    assert_ne!(sibling_row.split_once(' ').unwrap().1, identity);

    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let gone = snapshot(BIB_SANDBOX, &["-p", &pid, "-o", "pid=,command="]);
    assert!(gone.status.success());
    assert!(gone.stdout.is_empty(), "a reaped child must be absent");
}

#[test]
fn denied_snapshot_is_an_error_not_a_successful_empty_process_table() {
    for args in [
        vec!["-eo", "pid=,ppid=,command="],
        vec!["-p", "1", "-o", "pid=,command="],
    ] {
        // Deny only process reads: dyld itself needs unrelated sysctls before
        // our entrypoint can run, so denying every sysctl tests the loader.
        let output = snapshot(
            "(version 1)(allow default)(deny sysctl-read (sysctl-name-regex #\"^kern[.]proc[.]\"))",
            &args,
        );
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Process snapshot failed:"));
    }
}

#[test]
fn malformed_query_does_not_launch_the_gui_or_report_empty_success() {
    let output = snapshot(BIB_SANDBOX, &["-p", "not-a-pid", "-o", "pid=,command="]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}
