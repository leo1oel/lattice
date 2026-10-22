//! Suggestions ("track changes") on the wire: reading the ones a document
//! holds and the setting that decides whether edits become them, telling a
//! collaborator's suggestion apart from an ordinary edit, and sending our own.

use super::client::{change_id_seed, lock};
use super::codec::*;
use super::events::*;
use super::tests::{connect, mock_config, start_mock};
use super::*;
use serde_json::{json, Value};
use tauri::async_runtime as rt;

#[test]
fn tracked_changes_are_read_with_their_author_and_direction() {
    let changes = parse_tracked_changes(&json!({
        "changes": [
            {"id": "c1", "op": {"p": 12, "i": "café"},
             "metadata": {"user_id": "user-1", "ts": "2026-07-01T10:00:00.000Z"}},
            {"id": "c2", "op": {"p": 40, "d": "cut this"},
             "metadata": {"user_id": "user-2", "ts": "2026-07-01T11:00:00.000Z"}},
            {"id": "c3", "op": {"p": 5}},
        ],
        "comments": [],
    }));
    assert_eq!(changes.len(), 2, "an op that is neither is not a change");
    assert_eq!(
        changes[0],
        TrackedChange {
            id: "c1".into(),
            position: 12,
            text: "café".into(),
            deletion: false,
            user_id: Some("user-1".into()),
            timestamp: Some("2026-07-01T10:00:00.000Z".into()),
            hue: presence_hue(Some("user-1")),
        }
    );
    assert!(changes[1].deletion);
    assert_eq!(changes[1].text, "cut this");
    // Two authors, two colours.
    assert_ne!(changes[0].hue, changes[1].hue);
}

#[test]
fn track_changes_setting_is_read_per_account() {
    // One project-wide field: a flag for everyone, or a map naming the
    // accounts it is on for, with anonymous sessions under a literal key.
    // Absent entirely — the project owner has no such feature — is off.
    for (state, user, on) in [
        (Some(json!(true)), Some("user-1"), true),
        (Some(json!(false)), Some("user-1"), false),
        (Some(json!({"user-1": true, "user-2": false})), Some("user-1"), true),
        (Some(json!({"user-1": true})), Some("user-2"), false),
        (Some(json!({"__guests__": true})), None, true),
        (None, Some("user-1"), false),
    ] {
        assert_eq!(track_changes_for(state.as_ref(), user), on, "{state:?} for {user:?}");
    }
}

#[test]
fn change_id_seeds_are_fresh_and_the_right_shape() {
    // Eighteen hex characters, and never the same twice: reusing a seed
    // means minting duplicate change ids.
    let (first, second) = (change_id_seed(), change_id_seed());
    assert_eq!(first.len(), 18, "{first}");
    assert!(first.chars().all(|c| c.is_ascii_hexdigit()), "{first}");
    assert_ne!(first, second);
}

#[test]
fn a_collaborators_suggestion_is_told_apart_from_an_ordinary_edit() {
    // `meta.tc` is what makes an update a suggestion; its author is in
    // `meta.user_id`, and is coloured as their suggestions already are.
    let update = |meta: Value| {
        let mut events = doc_update_events(&json!({
            "doc": "doc-1", "v": 7, "op": [{"p": 4, "d": "quick "}], "meta": meta,
        }));
        assert_eq!(events.len(), 1);
        events.remove(0)
    };
    let suggested =
        update(json!({"source": "pub-2", "user_id": "user-2", "tc": "0123456789abcdef01"}));
    let RealtimeEvent::DocUpdate { ref suggested_by, ref ops, .. } = suggested else {
        panic!("{suggested:?}")
    };
    assert_eq!(ops, &vec![OtOp { p: 4, i: None, d: Some("quick ".into()), u: None }]);
    assert_eq!(
        suggested_by,
        &Some(Suggester { user_id: Some("user-2".into()), hue: presence_hue(Some("user-2")) })
    );
    let wire = serde_json::to_string(&suggested).unwrap();
    assert!(
        wire.ends_with(&format!(
            r#""suggestedBy":{{"userId":"user-2","hue":{}}}}}"#,
            presence_hue(Some("user-2"))
        )),
        "{wire}"
    );

    // An ordinary edit, or one with an empty seed, is not a suggestion and
    // says nothing about one on the wire.
    for meta in
        [json!({"source": "pub-2", "user_id": "user-2"}), json!({"source": "pub-2", "tc": ""})]
    {
        let plain = update(meta);
        assert!(matches!(plain, RealtimeEvent::DocUpdate { suggested_by: None, .. }), "{plain:?}");
        assert!(!serde_json::to_string(&plain).unwrap().contains("suggestedBy"));
    }
}

#[test]
fn our_edits_go_out_as_suggestions_only_when_asked() {
    let (host, state) = start_mock(false);
    let (client, _events) = connect(mock_config(&host, "overleaf_session2=test-cookie"));
    rt::block_on(client.join_doc("doc-1", None)).expect("joinDoc");
    let edit = |p| vec![OtOp { p, i: Some("!".into()), d: None, u: None }];
    for tracked in [true, false] {
        rt::block_on(client.send_ops("doc-1", 42, edit(1), tracked, Submission::default()))
            .expect("applyOtUpdate");
    }
    let frames = lock(&state).frames.clone();
    let updates: Vec<Value> = (frames.iter())
        .filter_map(|text| parse_frame(text).ok())
        .filter_map(|frame| parse_event(&frame.data).ok())
        .filter(|(name, _)| name == "applyOtUpdate")
        .map(|(_, args)| args[1].clone())
        .collect();
    assert_eq!(updates.len(), 2, "{updates:?}");
    // A suggestion carries a fresh seed for the ids of the changes it makes.
    let seed = updates[0]["meta"]["tc"].as_str().expect("a tracked update carries meta.tc");
    assert_eq!(seed.len(), 18, "{seed}");
    assert!(updates[1].get("meta").is_none(), "{:?}", updates[1]);
    client.shutdown();
}

#[test]
fn losing_the_project_is_named_so_the_app_stops_retrying() {
    // What the realtime server says when this account was removed from the
    // project, or the project was deleted.
    for rejected in ["not authorized", "Not authorized", "project not found"] {
        assert_eq!(rejection_message(rejected.into()), PROJECT_ACCESS_LOST, "{rejected}");
    }
    assert_eq!(rejection_message("invalid session".into()), SESSION_EXPIRED);
    // Anything else is passed on as the server said it.
    assert_eq!(rejection_message("rate limit hit".into()), "rate limit hit");
}
