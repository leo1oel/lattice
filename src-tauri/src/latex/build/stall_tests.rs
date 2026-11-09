use super::*;

#[test]
fn a_process_that_only_repeats_errors_is_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "while :; do echo './m.tex:1: Error'; sleep 0.05; done"]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (_, cancelled) =
        run_watched(command, &active, &steps, "", "", Duration::from_millis(400)).unwrap();
    assert!(cancelled);
    assert!(was_stalled(&active));
}

#[test]
fn a_run_shipping_pages_on_one_line_is_not_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        "printf '(./main.aux)'; for page in 1 2 3 4 5 6 7 8 9 10; do sleep 0.15; printf ' [%s]' $page; done",
    ]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (output, cancelled) =
        run_watched(command, &active, &steps, "", "", Duration::from_millis(600)).unwrap();
    assert!(!cancelled);
    assert!(!was_stalled(&active));
    assert!(String::from_utf8_lossy(&output.stdout).ends_with("[10]"));
}

#[test]
fn a_silent_process_is_stopped() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "sleep 30"]);
    let active = ActiveBuild::default();
    let steps = BuildSteps::silent();
    let (_, cancelled) =
        run_watched(command, &active, &steps, "", "", Duration::from_millis(300)).unwrap();
    assert!(cancelled);
}

#[test]
fn a_stall_nobody_reported_does_not_colour_the_next_build() {
    let active = ActiveBuild::default();
    active::stop_stalled(&active);
    drop(BuildSession::open(&active));
    assert!(!was_stalled(&active));
}
