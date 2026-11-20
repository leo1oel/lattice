//! Leaving a live document writes its OT checkpoint as the merge base, and a
//! project switch is the last moment it can (#1208). `AppState::set_root`
//! drops the old project's realtime ownership, so a leave sent after the
//! window moved is refused and the base stays at the last ZIP sync. Coming
//! back, the live edits then sit on both sides of a base that has neither,
//! and a co-author's edit next to them conflicts instead of merging.

use super::{agreed_text, checkpoint_realtime_text, RealtimeCheckpoint};
use crate::app_state::AppState;
use crate::overleaf::sync::sync;
use crate::overleaf::test_support::*;
use crate::test_support::TempDir;
use std::collections::BTreeSet;

const BEFORE_LIVE: &str = "Intro. Methods are here.\n";
const LIVE: &str = "Intro. Methods are here. We add a sentence.\n";

#[tokio::test]
async fn the_leave_checkpoints_only_while_the_window_still_shows_the_project() {
    let root =
        linked_root(&[("main.tex", LIVE.as_bytes())], &[("main.tex", BEFORE_LIVE.as_bytes())]);
    let elsewhere = TempDir::new("overleaf-next-project");
    let state = AppState::from_environment();
    state.bind_window("main", root.to_path_buf()).unwrap();
    let join = |receipt: &str| {
        let project = state.project(&root);
        let mut realtime = project.realtime().unwrap();
        realtime.begin(root.to_path_buf());
        realtime.joined_paths.insert("doc".into(), "main.tex".into());
        realtime.join_receipts.insert("doc".into(), receipt.into());
    };
    let leave = |receipt: &str, text: &str| {
        let checkpoint = RealtimeCheckpoint { text: text.into(), version: 7 };
        let project = state.project(&root);
        let realtime = project.realtime().unwrap();
        realtime.checkpoint_before_leave(&root, "doc", receipt, Some(&checkpoint))
    };

    join("first");
    leave("first", LIVE).unwrap();
    assert_eq!(agreed_text(&root, "main.tex").as_deref(), Some(LIVE));

    join("second");
    state.set_root("main", elsewhere.to_path_buf()).await.unwrap();
    let late = leave("second", "Text typed after the switch.\n").unwrap_err();
    assert!(late.contains("ownership changed"), "{late}");
    assert_eq!(agreed_text(&root, "main.tex").as_deref(), Some(LIVE));
}

/// The third row of #1208's table: a co-author edits the sentence before the
/// one typed live. Against the checkpoint it is their edit alone; against the
/// base the last ZIP sync left, both sides changed the same paragraph.
#[test]
fn a_return_after_a_live_session_merges_against_the_checkpoint() {
    let theirs = "Intro changed. Methods are here. We add a sentence.\n";
    let run = |checkpointed: bool| {
        let server = Mock::project(&[("main.tex", theirs.as_bytes())]).serve();
        let (config, root) = linked(
            &server,
            &[("main.tex", LIVE.as_bytes())],
            &[("main.tex", BEFORE_LIVE.as_bytes())],
        );
        if checkpointed {
            checkpoint_realtime_text(&root, "main.tex", LIVE).unwrap();
        }
        let result = sync(&config, &root, &BTreeSet::new(), None).unwrap();
        let text = String::from_utf8(read_local(&root, "main.tex").unwrap()).unwrap();
        (result, text)
    };

    let (result, text) = run(true);
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert_eq!(text, theirs);
    assert!(!text.contains("<<<<<<<"));

    let (result, text) = run(false);
    assert!(!result.conflicts.is_empty(), "the stale base merged cleanly: {text}");
}
