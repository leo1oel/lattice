//! Stop reaches a build wherever it is, including between two of its processes.

use super::*;
use std::time::Duration;

fn sleeper() -> Command {
    let mut command = Command::new("sleep");
    command.arg("5");
    command
}

fn run(active: &ActiveBuild) -> (bool, Duration) {
    let started = Instant::now();
    let (_, cancelled) =
        run_tracked(sleeper(), active, &BuildSteps::silent(), "start: ", "wait: ").unwrap();
    (cancelled, started.elapsed())
}

#[test]
fn a_stop_between_two_processes_stops_the_next_one() {
    let active = ActiveBuild::default();
    let session = BuildSession::open(&active);
    // No process is running: latexmk has exited and its rerun has not started.
    assert_eq!(abort(&active), Ok(true));
    let (cancelled, took) = run(&active);
    assert!(cancelled);
    assert!(took < Duration::from_secs(3), "the next process ran for {took:?}");
    // And every process after it, until the build ends.
    assert!(run(&active).0);
    drop(session);
}

#[test]
fn a_stop_ends_with_its_build() {
    let active = ActiveBuild::default();
    let session = BuildSession::open(&active);
    assert_eq!(abort(&active), Ok(true));
    drop(session);
    let mut command = Command::new("true");
    command.arg("x");
    let (_, cancelled) =
        run_tracked(command, &active, &BuildSteps::silent(), "start: ", "wait: ").unwrap();
    assert!(!cancelled);
}

#[test]
fn a_stop_with_no_build_running_is_not_recorded() {
    let active = ActiveBuild::default();
    assert_eq!(abort(&active), Ok(false));
    let mut command = Command::new("true");
    command.arg("x");
    let (_, cancelled) =
        run_tracked(command, &active, &BuildSteps::silent(), "start: ", "wait: ").unwrap();
    assert!(!cancelled);
}

#[test]
fn a_build_between_two_processes_counts_as_running() {
    let active = ActiveBuild::default();
    assert!(!is_running(&active));
    let session = BuildSession::open(&active);
    // A restart now would cut off the rerun still to come.
    assert!(is_running(&active));
    drop(session);
    assert!(!is_running(&active));
}
