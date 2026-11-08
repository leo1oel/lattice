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
