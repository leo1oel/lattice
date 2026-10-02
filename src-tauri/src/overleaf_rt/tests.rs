use super::client::{change_id_seed, lock, merge_cookies};
use super::codec::*;
use super::events::*;
use super::tree::{parse_project, NodeKind, Tree};
use super::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime as rt;
use tiny_http::Response;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocket};
use tokio_tungstenite::tungstenite::Message;

type Events = Arc<Mutex<Vec<RealtimeEvent>>>;

fn insert(p: usize, text: &str) -> OtOp {
    OtOp { p, i: Some(text.into()), d: None, u: None }
}

fn delete(p: usize, text: &str) -> OtOp {
    OtOp { p, i: None, d: Some(text.into()), u: None }
}

/// Polls `ready` for up to `secs` seconds.
fn wait_until(secs: u64, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !ready() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// The first recorded event `pick` accepts, waiting up to `secs` for one.
fn wait_for<T>(
    events: &Events, secs: u64, mut pick: impl FnMut(&RealtimeEvent) -> Option<T>,
) -> Option<T> {
    let mut found = None;
    wait_until(secs, || {
        found = lock(events).iter().find_map(&mut pick);
        found.is_some()
    });
    found
}

fn connect(config: RealtimeConfig) -> (RealtimeClient, Events) {
    let events = Events::default();
    let sink = events.clone();
    let client =
        rt::block_on(RealtimeClient::connect(config, move |event| lock(&sink).push(event)))
            .expect("connect");
    (client, events)
}

#[test]
fn unknown_permission_fails_closed_for_direct_edits() {
    use Permission::*;
    for (permission, write, suggest) in [
        (Owner, true, true),
        (ReadAndWrite, true, true),
        (Review, false, true),
        (ReadOnly, false, false),
        (Unknown, false, false),
    ] {
        assert_eq!(permission.can_write(), write, "{permission:?}");
        assert_eq!(permission.can_suggest(), suggest, "{permission:?}");
    }
}

// -- frame codec ------------------------------------------------------------

/// Each row is pinned in both directions: the exact wire bytes we encode, and
/// every field read back. Payloadless frames drop the payload separator.
#[test]
fn frames_round_trip_every_field_and_keep_colons_in_the_payload() {
    let join = r#"{"name":"joinDoc","args":["doc-1",{"encodeRanges":true}]}"#;
    let update = r#"{"name":"otUpdateApplied","args":[{"doc":"a:b","op":[{"p":0,"i":"12:34"}]}]}"#;
    for (raw, kind, id, endpoint, data) in [
        (format!("5:::{join}"), FRAME_EVENT, "", "", join),
        (format!("5:7+::{join}"), FRAME_EVENT, "7+", "", join),
        (format!("5:12+:/chat:{join}"), FRAME_EVENT, "12+", "/chat", join),
        (format!("5:::{update}"), FRAME_EVENT, "", "", update),
        // A URL-shaped payload is the classic colon trap.
        ("3:1::https://example.com:8080/x".into(), 3, "1", "", "https://example.com:8080/x"),
        ("2::".into(), FRAME_HEARTBEAT, "", "", ""),
        ("1::".into(), FRAME_CONNECT, "", "", ""),
        ("0::".into(), FRAME_DISCONNECT, "", "", ""),
        ("8::".into(), FRAME_NOOP, "", "", ""),
    ] {
        assert_eq!(encode_frame(kind, id, endpoint, data), raw);
        let frame = parse_frame(&raw).expect("parses");
        let fields = (frame.kind, frame.id.as_str(), frame.endpoint.as_str(), frame.data.as_str());
        assert_eq!(fields, (kind, id, endpoint, data), "{raw}");
    }
}

#[test]
fn updates_name_earlier_submissions_only_when_resending() {
    let ops = vec![insert(5, "hello")];
    let first =
        Update { doc: "doc-1", op: ops.clone(), v: 42, meta: None, dup_if_source: &[], hash: None };
    // Overleaf validates updates with a strict schema: a first submission
    // must not carry an empty `dupIfSource` it never asked for.
    assert_eq!(
        serde_json::to_value(&first).expect("serializes"),
        json!({"doc": "doc-1", "op": [{"p": 5, "i": "hello"}], "v": 42})
    );
    let earlier = ["P.old".to_string()];
    let resend = Update {
        doc: "doc-1",
        op: ops,
        v: 42,
        meta: None,
        dup_if_source: &earlier,
        hash: Some("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"),
    };
    let resend = serde_json::to_value(&resend).expect("serializes");
    assert_eq!(resend["dupIfSource"], json!(["P.old"]));
    assert_eq!(resend["hash"], json!("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"));
}

#[test]
fn parse_frame_rejects_malformed_input_without_panicking() {
    for raw in ["", "5", "5:1", "::", ":::", "x::", "9::", "255::", "300::", "-1::", "5 ::", "🙂::"]
    {
        let parsed = parse_frame(raw);
        assert!(parsed.is_err(), "expected {raw:?} to be rejected, got {parsed:?}");
    }
}

#[test]
fn parse_ack_reads_ids_and_arguments_and_rejects_garbage() {
    let (id, args) = parse_ack(r#"1+[null,["line1","line2"],42,[],{}]"#).expect("parses");
    assert_eq!(id, 1);
    assert_eq!(args.len(), 5);
    assert!(args[0].is_null());
    assert_eq!((&args[1], &args[2]), (&json!(["line1", "line2"]), &json!(42)));
    for (raw, expected) in [
        ("10+[null]", (10, vec![Value::Null])),
        ("1234+[]", (1234, Vec::new())),
        // Acks without arguments.
        ("7", (7, Vec::new())),
        ("7+", (7, Vec::new())),
    ] {
        assert_eq!(parse_ack(raw).expect("parses"), expected, "{raw}");
    }
    for raw in ["", "+[]", "abc+[]", "1+[not json"] {
        assert!(parse_ack(raw).is_err(), "{raw}");
    }
}

#[test]
fn parse_event_reads_name_and_args() {
    let parsed = parse_event(r#"{"name":"otUpdateApplied","args":[{"doc":"d"}]}"#).expect("parses");
    assert_eq!(parsed, ("otUpdateApplied".to_string(), vec![json!({"doc":"d"})]));
    assert_eq!(parse_event(r#"{"name":"connect"}"#).expect("parses"), ("connect".into(), vec![]));
    assert!(parse_event("not json").is_err());
    assert!(parse_event(r#"{"args":[]}"#).is_err());
}

// -- handshake --------------------------------------------------------------

#[test]
fn parse_handshake_reads_the_sid_and_heartbeat_and_rejects_other_bodies() {
    for (body, sid, heartbeat) in [
        ("d4Xk3hQ2sJ0aBcDe:60:60:websocket,xhr-polling", "d4Xk3hQ2sJ0aBcDe", 60),
        ("testsid:25:60:websocket\n", "testsid", 25),
        // Heartbeat may legitimately be blank ("no heartbeat").
        ("abc::60:websocket", "abc", 0),
    ] {
        assert_eq!(parse_handshake(body).expect("parses"), (sid.to_string(), heartbeat));
    }
    for body in [
        "",
        "<!DOCTYPE html><html>login</html>",
        "sid:60",
        "sid:soon:60:websocket",
        // The websocket transport must actually be on offer.
        "sid:60:60:xhr-polling",
    ] {
        assert!(parse_handshake(body).is_err(), "{body}");
    }
}

#[test]
fn origins_switch_scheme_for_websockets() {
    assert_eq!(normalize_origin("https://www.overleaf.com/").unwrap(), "https://www.overleaf.com");
    assert_eq!(ws_origin("https://www.overleaf.com"), "wss://www.overleaf.com");
    assert_eq!(ws_origin("http://127.0.0.1:8080"), "ws://127.0.0.1:8080");
    assert!(normalize_origin("overleaf.com").is_err());
    assert!(normalize_origin("  ").is_err());
}

#[test]
fn cookies_from_the_handshake_join_the_ones_we_had() {
    // A new cookie is appended, an existing one is replaced in place, and
    // anything without a name is ignored.
    let handed_back = ["ol-affinity=instance-7; Path=/; HttpOnly", "other=2; Path=/", "; Path=/"];
    assert_eq!(
        merge_cookies("overleaf_session2=abc; other=1", &handed_back.map(String::from)),
        "overleaf_session2=abc; other=2; ol-affinity=instance-7"
    );
    assert_eq!(merge_cookies("session=x", &[]), "session=x");
}

// -- payload shapes ---------------------------------------------------------

/// Pins the JSON the app will actually see, fields included: an enum's
/// `rename_all` covers only the variant names, so the payload fields need
/// `rename_all_fields` too or the app receives snake_case keys. Ops leave out
/// their empty halves; the untracked update we emit (no `meta`) is pinned by
/// the mock round trip's wire bytes.
#[test]
fn realtime_events_serialize_with_a_type_tag() {
    let doc = DocEntry { id: "doc-1".into(), path: "sections/intro.tex".into() };
    for (event, expected) in [
        (
            RealtimeEvent::ProjectJoined {
                root_folder_id: "root-1".into(),
                docs: vec![doc],
                permission: Permission::ReadAndWrite,
            },
            r#"{"type":"projectJoined","rootFolderId":"root-1","docs":[{"id":"doc-1","path":"sections/intro.tex"}],"permission":"readAndWrite"}"#,
        ),
        (
            RealtimeEvent::DocUpdate {
                doc_id: "doc-1".into(),
                version: 43,
                ops: vec![insert(9, "!"), delete(0, "x")],
                source: Some("pub-2".into()),
            },
            r#"{"type":"docUpdate","docId":"doc-1","version":43,"ops":[{"p":9,"i":"!"},{"p":0,"d":"x"}],"source":"pub-2"}"#,
        ),
        (
            RealtimeEvent::Connected { public_id: "pub-1".into() },
            r#"{"type":"connected","publicId":"pub-1"}"#,
        ),
        (RealtimeEvent::ThreadsChanged, r#"{"type":"threadsChanged"}"#),
        (
            chat("msg-1", "ready for review", "Ada Lovelace", 1_700_000_000_000),
            r#"{"type":"chatMessage","id":"msg-1","content":"ready for review","authorName":"Ada Lovelace","authorEmail":"ada@example.edu","timestamp":1700000000000}"#,
        ),
    ] {
        assert_eq!(serde_json::to_string(&event).unwrap(), expected);
    }
}

fn chat(id: &str, content: &str, author_name: &str, timestamp: i64) -> RealtimeEvent {
    RealtimeEvent::ChatMessage {
        id: id.into(),
        content: content.into(),
        author_name: author_name.into(),
        author_email: Some("ada@example.edu".into()),
        timestamp,
    }
}

#[test]
fn chat_messages_read_either_name_spelling() {
    let expected = chat("msg-1", "hello", "Ada Lovelace", 1_700_000_000_000);
    for message in [
        json!({"id": "msg-1", "content": "hello", "timestamp": 1_700_000_000_000i64,
               "user": {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.edu"}}),
        json!({"_id": "msg-1", "content": "hello", "timestamp": 1_700_000_000_000i64,
               "user": {"firstName": "Ada", "lastName": "Lovelace", "email": "ada@example.edu"}}),
    ] {
        assert_eq!(chat_event(&message), Some(expected.clone()));
    }
    // No name at all falls back to the address rather than showing blank.
    let anonymous =
        json!({"id": "msg-2", "content": "hi", "user": {"email": "someone@example.edu"}});
    assert!(matches!(chat_event(&anonymous),
        Some(RealtimeEvent::ChatMessage { author_name, .. }) if author_name == "someone@example.edu"));
}

#[test]
fn ack_bodies_separate_errors_from_payloads() {
    let ok = vec![Value::Null, json!(["a"]), json!(3)];
    assert_eq!(ack_body(&ok, "joinDoc").unwrap(), &ok[1..]);
    // Server omitted the error slot entirely.
    let shifted = vec![json!(["a"]), json!(3)];
    assert_eq!(ack_body(&shifted, "joinDoc").unwrap(), &shifted[..]);
    // String and {message} errors both surface.
    assert!(ack_body(&[json!("boom")], "joinDoc").unwrap_err().contains("boom"));
    assert!(ack_body(&[json!({"message":"nope"})], "joinDoc").unwrap_err().contains("nope"));
    // A project payload is not an error even though it is an object.
    assert!(ack_body(&[json!({"rootFolder":[]})], "joinProject").is_ok());
}

// -- project tree -----------------------------------------------------------

fn project_tree() -> Value {
    json!({
        "_id": "proj-1",
        "name": "Paper",
        "rootFolder": [{
            "_id": "root-1",
            "name": "rootFolder",
            "docs": [{"_id": "doc-1", "name": "main.tex"}],
            "fileRefs": [{"_id": "file-1", "name": "figure.png"}],
            "folders": [{
                "_id": "folder-1",
                "name": "sections",
                "docs": [{"_id": "doc-2", "name": "intro.tex"}],
                "fileRefs": [],
                "folders": [{
                    "_id": "folder-2",
                    "name": "deep",
                    "docs": [{"_id": "doc-3", "name": "nested.tex"}],
                    "fileRefs": [],
                    "folders": []
                }]
            }]
        }]
    })
}

fn project_docs() -> Vec<DocEntry> {
    [("doc-1", "main.tex"), ("doc-3", "sections/deep/nested.tex"), ("doc-2", "sections/intro.tex")]
        .map(|(id, path)| DocEntry { id: id.into(), path: path.into() })
        .to_vec()
}

fn parsed_tree() -> Tree {
    let ack = vec![Value::Null, project_tree(), json!("owner"), json!(2)];
    parse_project(ack_body(&ack, "joinProject").expect("no error slot")).expect("parses").0
}

#[test]
fn parse_project_flattens_nested_folders_into_entities_with_ids() {
    let tree = parsed_tree();
    assert_eq!(tree.root, "root-1");
    // Path order, so the list is stable however the tree is walked.
    assert_eq!(tree.docs(), project_docs());

    // Deleting a file over there needs its id; nothing in the REST surface
    // hands ids out, so the tree is the only place they exist. Folders are
    // listed too, because deleting one is its own endpoint.
    let entities = tree.entities();
    let has = |path: &str, kind: &str, id: Option<&str>| {
        entities.iter().any(|e| e.path == path && e.kind == kind && id.is_none_or(|id| e.id == id))
    };
    assert!(has("sections", "folder", None));
    assert!(has("main.tex", "doc", Some("doc-1")));
    // The root is not something anyone can act on, and has no path.
    assert!(entities.iter().all(|entity| !entity.path.is_empty() && entity.id != tree.root));
}

#[test]
fn the_tree_follows_renames_moves_and_deletes_by_id_alone() {
    // Overleaf's tree events carry ids and nothing else: a rename does not
    // say where the entity is, and a deleted folder arrives as one event for
    // the folder rather than one per file inside it.
    let mut tree = parsed_tree();

    // A file created in the browser becomes editable here immediately.
    tree.insert_entity("folder-1", &json!({"_id": "doc-4", "name": "results.tex"}), NodeKind::Doc);
    assert!(tree.docs().iter().any(|doc| doc.id == "doc-4" && doc.path == "sections/results.tex"));

    // Renaming a folder reindexes everything beneath it.
    assert!(tree.rename("folder-1", "chapters"));
    assert_eq!(tree.path_of("doc-2").as_deref(), Some("chapters/intro.tex"));
    assert_eq!(tree.path_of("doc-3").as_deref(), Some("chapters/deep/nested.tex"));

    // Moving one does too, and to the root means no folder in the path.
    assert!(tree.move_to("folder-2", tree.root.clone().as_str()));
    assert_eq!(tree.path_of("doc-3").as_deref(), Some("deep/nested.tex"));

    // Moving into a folder we have never heard of is refused rather than
    // silently orphaning the entity.
    assert!(!tree.move_to("doc-2", "folder-unknown"));
    assert_eq!(tree.path_of("doc-2").as_deref(), Some("chapters/intro.tex"));

    // Deleting a folder takes its contents with it…
    assert!(tree.remove("folder-1"));
    assert_eq!(tree.path_of("doc-2"), None);
    assert!(tree.docs().iter().all(|doc| doc.id != "doc-4"));
    // …and the file that had been moved out of it survives.
    assert_eq!(tree.path_of("doc-3").as_deref(), Some("deep/nested.tex"));

    // Deleting something already gone is not an event worth reporting.
    assert!(!tree.remove("folder-1"));
    assert!(!tree.rename("doc-2", "whatever.tex"));
}

#[test]
fn parse_project_reports_missing_pieces() {
    for body in [
        vec![],
        vec![json!({})],
        vec![json!({"rootFolder": []})],
        vec![json!({"rootFolder": [{"name": "x"}]})],
    ] {
        assert!(parse_project(&body).is_err(), "{body:?}");
    }
}

// -- inbound parsing --------------------------------------------------------

#[test]
fn document_text_is_unpacked_from_overleafs_transport_encoding() {
    // Overleaf sends `unescape(encodeURIComponent(text))`: the UTF-8 bytes
    // reinterpreted one per code point. Reading that as-is gives mojibake,
    // and makes our character offsets count bytes while Overleaf counts
    // characters — which puts every later operation in the wrong place.
    let packed = |text: &str| -> String { text.as_bytes().iter().map(|b| *b as char).collect() };
    for original in ["第三节需要引用", "café — naïve", "\\section{Résultats}", "emoji: \u{1F600}"]
    {
        assert_eq!(decode_packed_utf8(&packed(original)), original);
    }
    for untouched in [
        // ASCII is its own packing.
        "\\documentclass{article}",
        // Text that was never packed is left alone rather than mangled: not
        // every deployment encodes, and decoding twice is the same bug in
        // reverse.
        "已经是正常文本",
        // Bytes that are not valid UTF-8 are not a packing either.
        "\u{00ff}\u{00fe}",
    ] {
        assert_eq!(decode_packed_utf8(untouched), untouched);
    }
}

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
fn presence_reads_both_shapes_and_colours_by_account() {
    // The broadcast and the roster describe the same person with different
    // keys; getting either wrong shows a nameless ghost with no cursor.
    let broadcast = parse_presence_broadcast(&json!({
        "row": 42, "column": 36, "doc_id": "doc-1",
        "id": "P.abc", "user_id": "user-1",
        "email": "ada@example.edu", "name": "Ada Lovelace",
    }))
    .expect("parses");
    assert_eq!(
        broadcast,
        PresenceUser {
            id: "P.abc".into(),
            user_id: Some("user-1".into()),
            name: "Ada Lovelace".into(),
            email: Some("ada@example.edu".into()),
            doc_id: Some("doc-1".into()),
            row: Some(42),
            column: Some(36),
            hue: presence_hue(Some("user-1")),
        }
    );
    let roster = parse_presence_roster(&json!({
        "client_id": "P.abc", "connected": true, "client_age": 1.02,
        "user_id": "user-1", "first_name": "Ada", "last_name": "Lovelace",
        "email": "ada@example.edu", "last_updated_at": "1753300000000",
        "cursorData": {"row": 42, "column": 36, "doc_id": "doc-1"},
    }));
    // Same person, same colour, whichever way we heard about them.
    assert_eq!(roster, Some(broadcast));

    // Someone who has never moved has no cursor at all.
    let idle = parse_presence_roster(&json!({
        "client_id": "P.def", "connected": true, "user_id": "user-2", "first_name": "Sam",
    }))
    .expect("parses");
    assert_eq!((idle.name.as_str(), idle.doc_id, idle.row), ("Sam", None, None));

    // A hash whose entry has expired is not a person to show.
    assert!(parse_presence_roster(&json!({"client_id": "P.ghi", "connected": false})).is_none());

    // Anonymous users share one hue and carry no account.
    let anonymous =
        parse_presence_broadcast(&json!({"id": "P.jkl", "user_id": "anonymous-user", "name": ""}))
            .expect("parses");
    assert_eq!((anonymous.user_id, anonymous.hue), (None, 100));
}

#[test]
fn presence_hues_match_overleafs_own_palette() {
    // Reproduces `getHueForUserId`: md5 of the account id, first eight hex
    // digits, modulo 320, with the band Overleaf keeps for "you" skipped.
    // Anything else and the same collaborator is two colours across the
    // two apps.
    assert_eq!(presence_hue(None), 100);
    let digest = format!("{:x}", md5::compute(b"anonymous-user"));
    assert_eq!(
        presence_hue(Some("anonymous-user")),
        u32::from_str_radix(&digest[..8], 16).unwrap() % 320
    );
    for id in ["user-1", "5f2c1b3a4d5e6f7a8b9c0d1e", "ada@example.edu"] {
        let hue = presence_hue(Some(id));
        assert!(hue < 360, "{id} produced {hue}");
        // The reserved band is 180..220 exclusive; nothing may land there.
        assert!(!(180..=219).contains(&hue) || hue == 180, "{id} landed on {hue}");
    }
}

#[test]
fn comment_operations_never_reach_the_text_stream() {
    let events = doc_update_events(&json!({
        "doc": "doc-1",
        "v": 44,
        "op": [{"p": 5, "i": "hello"}, {"p": 12, "c": "quoted span", "t": "thread-9"}, {"p": 20, "d": "gone"}],
        "meta": {"source": "pub-2"},
    }));
    // The comment op is gone from the text; transformed as an edit it would
    // come back as an empty delete.
    let range =
        CommentRange { thread_id: "thread-9".into(), position: 12, quote: "quoted span".into() };
    assert_eq!(
        events,
        vec![
            RealtimeEvent::DocUpdate {
                doc_id: "doc-1".into(),
                version: 44,
                ops: vec![insert(5, "hello"), delete(20, "gone")],
                source: Some("pub-2".into()),
            },
            RealtimeEvent::CommentAnchored { doc_id: "doc-1".into(), range },
        ]
    );

    // Our own update coming back carries no operation at all. That is the
    // acknowledgement, and it must not be mistaken for an empty edit.
    assert_eq!(
        doc_update_events(&json!({"doc": "doc-1", "v": 46})),
        vec![RealtimeEvent::DocAck { doc_id: "doc-1".into(), version: 46 }]
    );

    // A comment on its own still moves the version, so the update goes out
    // with no ops rather than not at all.
    let only_comment = doc_update_events(
        &json!({"doc": "doc-1", "v": 45, "op": [{"p": 0, "c": "x", "t": "thread-10"}]}),
    );
    assert_eq!(only_comment.len(), 2);
    assert!(matches!(&only_comment[0],
        RealtimeEvent::DocUpdate { version: 45, ops, .. } if ops.is_empty()));
}

// -- end to end against a mock socket.io 0.9 server -------------------------

/// A local HTTP server handing each request to `handle`, by its base URL.
pub(crate) fn serve_http(mut handle: impl FnMut(tiny_http::Request) + Send + 'static) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind the mock server");
    let port = server.server_addr().to_ip().expect("an IP listener").port();
    std::thread::spawn(move || server.incoming_requests().for_each(&mut handle));
    format!("http://127.0.0.1:{port}")
}

fn header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.to_string())
}

/// `line` is a whole `Name: value` header line.
fn with_header<R: Read>(response: Response<R>, line: &str) -> Response<R> {
    response.with_header(line.parse::<tiny_http::Header>().expect("a header line"))
}

/// One HTTP request the mock saw: its URL, `Cookie` and `Origin`.
type Seen = (String, Option<String>, Option<String>);

#[derive(Default)]
struct MockState {
    /// The handshake, then the websocket upgrade.
    requests: Vec<Seen>,
    frames: Vec<String>,
    /// Newer Overleaf: join from the handshake query and push the project
    /// down, never answering a `joinProject` ask.
    push_join: bool,
}

/// The mock's host, and what it has seen.
fn start_mock(push_join: bool) -> (String, Arc<Mutex<MockState>>) {
    start_mock_with(push_join, 60)
}

/// A mock that names `heartbeat` seconds as its heartbeat timeout.
fn start_mock_with(push_join: bool, heartbeat: u64) -> (String, Arc<Mutex<MockState>>) {
    let state = Arc::new(Mutex::new(MockState { push_join, ..MockState::default() }));
    let seen = state.clone();
    let host = serve_http(move |request| {
        let url = request.url().to_string();
        let upgrade = url.contains("/socket.io/1/websocket/");
        let (cookie, origin) = (header(&request, "Cookie"), header(&request, "Origin"));
        lock(&seen).requests.push((url, cookie, origin));
        if !upgrade {
            // Load balancers pin the realtime session with a cookie of their
            // own; the upgrade has to carry it back or it lands on another
            // instance.
            let body = Response::from_string(format!("testsid:{heartbeat}:60:websocket"));
            let body = with_header(body, "Set-Cookie: ol-affinity=instance-7; Path=/; HttpOnly");
            let _ = request.respond(with_header(body, "Content-Type: text/plain"));
            return;
        }
        let Some(key) = header(&request, "Sec-WebSocket-Key") else { return };
        let accept = format!("Sec-WebSocket-Accept: {}", derive_accept_key(key.as_bytes()));
        let stream = request.upgrade("websocket", with_header(Response::empty(101), &accept));
        let seen = seen.clone();
        std::thread::spawn(move || {
            serve_websocket(WebSocket::from_raw_socket(stream, Role::Server, None), seen)
        });
    });
    (host, state)
}

fn mock_config(host: &str, cookie: &str) -> RealtimeConfig {
    let (host, cookie) = (host.to_string(), cookie.to_string());
    RealtimeConfig { user_id: None, host, cookie, project_id: "proj-1".to_string() }
}

fn event_frame(name: &str, args: Value) -> String {
    encode_frame(FRAME_EVENT, "", "", &json!({"name": name, "args": args}).to_string())
}

fn ack_frame(id: &str, args: Value) -> String {
    encode_frame(FRAME_ACK, "", "", &format!("{id}+{args}"))
}

fn serve_websocket<S: Read + Write>(mut ws: WebSocket<S>, state: Arc<Mutex<MockState>>) {
    let push_join = lock(&state).push_join;
    let send = |ws: &mut WebSocket<S>, frame: String| ws.send(Message::text(frame));
    let _ = send(&mut ws, encode_frame(FRAME_CONNECT, "", "", ""));
    let _ = if push_join {
        let join =
            json!([{"publicId": "pub-1", "project": project_tree(), "permissionsLevel": "owner"}]);
        send(&mut ws, event_frame("joinProjectResponse", join))
    } else {
        send(&mut ws, event_frame("connectionAccepted", json!([null, "pub-1"])))
    };
    while let Ok(message) = ws.read() {
        let text = match message {
            Message::Text(text) => text.as_str().to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        lock(&state).frames.push(text.clone());
        let Ok(frame) = parse_frame(&text) else { continue };
        if frame.kind != FRAME_EVENT {
            continue;
        }
        let Ok((name, _)) = parse_event(&frame.data) else { continue };
        let id = frame.id.trim_end_matches('+').to_string();
        let sent = match name.as_str() {
            // A server that pushed the project ignores the ask entirely,
            // which is exactly the case the client has to survive.
            "joinProject" if push_join => Ok(()),
            "joinProject" => {
                send(&mut ws, ack_frame(&id, json!([null, project_tree(), "owner", 2])))
            }
            "joinDoc" => {
                let ranges = json!({"comments": [{"id": "change-1", "op": {"p": 4, "c": "one", "t": "thread-1"}}],
                                    "changes": []});
                let ack = send(
                    &mut ws,
                    ack_frame(&id, json!([null, ["line one", "line two"], 42, [], ranges])),
                );
                // Unsolicited update from another collaborator...
                let update = json!([{"doc": "doc-1", "v": 43, "op": [{"p": 9, "i": "!"}],
                                     "meta": {"source": "someone-else"}}]);
                let _ = send(&mut ws, event_frame("otUpdateApplied", update));
                // ...and a heartbeat the client has to echo.
                let _ = send(&mut ws, encode_frame(FRAME_HEARTBEAT, "", "", ""));
                ack
            }
            "applyOtUpdate" | "leaveDoc" => send(&mut ws, ack_frame(&id, json!([null]))),
            _ => Ok(()),
        };
        if sent.is_err() {
            break;
        }
    }
}

#[test]
fn a_server_that_goes_quiet_past_its_heartbeat_timeout_is_reported_lost() {
    // The mock never sends a heartbeat after joining: a half-open socket.
    let (host, _state) = start_mock_with(false, 1);
    let (_client, events) = connect(mock_config(&host, "overleaf_session2=test-cookie"));
    let lost = wait_for(&events, 5, |event| match event {
        RealtimeEvent::Disconnected { reason } => Some(reason.clone()),
        _ => None,
    });
    assert!(lost.is_some_and(|reason| reason.contains("sent nothing")), "{:?}", lock(&events));
}

#[test]
fn joins_a_project_the_server_pushes_without_being_asked() {
    let (host, _state) = start_mock(true);
    let (client, events) = connect(mock_config(&host, "overleaf_session2=test-cookie"));

    // Same result as the ask-and-wait path: the tree, and our own id.
    assert_eq!(client.project().root_folder_id, "root-1");
    assert_eq!(client.project().docs, project_docs());
    assert_eq!(client.public_id(), "pub-1");
    let connected = RealtimeEvent::Connected { public_id: "pub-1".into() };
    assert_eq!(lock(&events).first(), Some(&connected));
    client.shutdown();
}

#[test]
fn talks_the_whole_protocol_to_a_mock_server() {
    let (host, state) = start_mock(false);
    let (client, events) = connect(mock_config(&host, "overleaf_session2=test-cookie"));

    // The session cookie rides on both the handshake and the upgrade.
    {
        let state = lock(&state);
        let [(handshake, cookie, _), (upgrade, ws_cookie, ws_origin)] = &state.requests[..] else {
            panic!("expected a handshake and an upgrade, got {:?}", state.requests);
        };
        assert!(handshake.starts_with("/socket.io/1/?projectId=proj-1&t="), "{handshake}");
        assert_eq!(cookie.as_deref(), Some("overleaf_session2=test-cookie"));
        let upgrade_path = "/socket.io/1/websocket/testsid?projectId=proj-1&t=";
        assert!(upgrade.starts_with(upgrade_path), "{upgrade}");
        // The handshake's own cookie rides along, or the upgrade would reach
        // an instance that never issued this session id.
        let pinned = "overleaf_session2=test-cookie; ol-affinity=instance-7";
        assert_eq!(ws_cookie.as_deref(), Some(pinned));
        assert_eq!(ws_origin.as_deref(), Some(host.as_str()));
    }
    assert_eq!(client.public_id(), "pub-1");

    // connectionAccepted arrives before the joinProject ack, so the event
    // order is Connected → ProjectJoined.
    let joined = RealtimeEvent::ProjectJoined {
        root_folder_id: "root-1".into(),
        docs: project_docs(),
        permission: Permission::Owner,
    };
    assert_eq!(
        lock(&events)[..2],
        [RealtimeEvent::Connected { public_id: "pub-1".into() }, joined]
    );

    let joined = rt::block_on(client.join_doc("doc-1", None)).expect("joinDoc");
    assert_eq!((joined.text.as_str(), joined.version), ("line one\nline two", 42));
    // Comment anchors ride in with the document, keyed by thread id.
    let anchor = CommentRange { thread_id: "thread-1".into(), position: 4, quote: "one".into() };
    assert_eq!(joined.comments, vec![anchor]);

    rt::block_on(client.send_ops(
        "doc-1",
        42,
        vec![insert(5, "hello")],
        false,
        Submission::default(),
    ))
    .expect("applyOtUpdate");
    rt::block_on(client.leave_doc("doc-1")).expect("leaveDoc");

    // The unsolicited otUpdateApplied reaches the callback, carrying its
    // source so the app can recognise its own echo.
    let update = wait_for(&events, 10, |event| {
        matches!(event, RealtimeEvent::DocUpdate { .. }).then(|| event.clone())
    });
    let expected = RealtimeEvent::DocUpdate {
        doc_id: "doc-1".into(),
        version: 43,
        ops: vec![insert(9, "!")],
        source: Some("someone-else".into()),
    };
    assert_eq!(update, Some(expected));

    // The server's `2::` gets echoed back.
    assert!(wait_until(10, || lock(&state).frames.iter().any(|frame| frame == "2::")));

    // Exact wire bytes, in order, for everything we emit.
    let frames = lock(&state).frames.clone();
    let events_only: Vec<&str> =
        frames.iter().map(String::as_str).filter(|f| f.starts_with("5:")).collect();
    assert_eq!(
        events_only,
        [
            r#"5:1+::{"name":"joinProject","args":[{"project_id":"proj-1"}]}"#,
            // The -1 is the positional `fromVersion`: the server reads the
            // version from the second argument and the options from the
            // third, so passing only the options gets them read as a version
            // and quietly turns every join into a full one.
            r#"5:2+::{"name":"joinDoc","args":["doc-1",-1,{"encodeRanges":true}]}"#,
            // No `meta`: Overleaf fills it in, and rejects the update if we do.
            r#"5:3+::{"name":"applyOtUpdate","args":["doc-1",{"doc":"doc-1","op":[{"p":5,"i":"hello"}],"v":42}]}"#,
            r#"5:4+::{"name":"leaveDoc","args":["doc-1"]}"#,
        ]
    );

    client.shutdown();
    let disconnected = wait_for(&events, 10, |event| {
        matches!(event, RealtimeEvent::Disconnected { .. }).then_some(())
    });
    assert!(disconnected.is_some(), "timed out waiting for the Disconnected event");
}

#[test]
fn connect_rejects_bad_configuration_and_reports_a_dead_session_instead_of_hanging() {
    let login_page = serve_http(|request| {
        let login = Response::from_string("<!DOCTYPE html><html>login</html>");
        let _ = request.respond(with_header(login, "Content-Type: text/html"));
    });
    for (host, cookie, error) in [
        ("overleaf.com", "c=1", "http://"),
        ("https://www.overleaf.com", "  ", "Not connected to Overleaf"),
        (login_page.as_str(), "overleaf_session2=stale", SESSION_EXPIRED),
    ] {
        let outcome = rt::block_on(RealtimeClient::connect(mock_config(host, cookie), |_| {}));
        let message = outcome.expect_err(host);
        assert!(message.contains(error), "{host}: {message}");
    }
}

// -- against the real Overleaf ----------------------------------------------
//
// The mock server proves the protocol is implemented; only these prove it is
// the protocol Overleaf actually speaks. They use the session the app already
// stored, and several of them write. Run them by hand against a sacrificial
// project (see docs/overleaf-protocol.md):
//
// OVERLEAF_E2E_PROJECT=<project root> OVERLEAF_E2E_DOC=<path> \
//   cargo test --manifest-path src-tauri/Cargo.toml \
//   overleaf_rt::tests::connects_to_the_real_overleaf -- --ignored --nocapture

/// `(config dir, project root)` for the live tests: the app's own settings
/// folder unless `OVERLEAF_E2E_CONFIG` names another.
pub(crate) fn live_project() -> (PathBuf, PathBuf) {
    let root = std::env::var("OVERLEAF_E2E_PROJECT").expect("set OVERLEAF_E2E_PROJECT");
    let config = std::env::var("OVERLEAF_E2E_CONFIG").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join("Library/Application Support")
            .join(crate::app_identity::identifier())
    });
    (config, PathBuf::from(root))
}

/// One live connection to the linked project, recording every event.
struct Live {
    config: PathBuf,
    root: PathBuf,
    client: RealtimeClient,
    events: Events,
}

impl Live {
    fn connect() -> Self {
        let (config, root) = live_project();
        let (host, cookie, project_id, user_id) =
            crate::overleaf::realtime_config(&config, &root).expect("a linked project");
        let (client, events) = connect(RealtimeConfig { user_id, host, cookie, project_id });
        Live { config, root, client, events }
    }

    /// The document named by `OVERLEAF_E2E_DOC`.
    fn target(&self) -> DocEntry {
        let target = std::env::var("OVERLEAF_E2E_DOC").expect("set OVERLEAF_E2E_DOC");
        let docs = &self.client.project().docs;
        docs.iter()
            .find(|doc| doc.path == target)
            .cloned()
            .unwrap_or_else(|| panic!("no document named {target}"))
    }

    fn join(&self, doc_id: &str) -> JoinedDoc {
        rt::block_on(self.client.join_doc(doc_id, None)).expect("joinDoc")
    }

    fn leave(&self, doc_id: &str) {
        rt::block_on(self.client.leave_doc(doc_id)).expect("leaveDoc");
    }

    /// Leave and join again, reading the text back from the server rather
    /// than trusting our own bookkeeping.
    fn rejoin(&self, doc_id: &str) -> JoinedDoc {
        self.leave(doc_id);
        self.join(doc_id)
    }

    fn send(&self, doc_id: &str, version: i64, op: OtOp) {
        rt::block_on(self.client.send_ops(doc_id, version, vec![op], false, Submission::default()))
            .expect("send ops");
    }

    /// Whether Overleaf acknowledged our update on `doc_id` applied at `at`.
    fn acked(&self, doc_id: &str, at: i64, secs: u64) -> bool {
        wait_for(&self.events, secs, |event| {
            matches!(event, RealtimeEvent::DocAck { doc_id: id, version } if id == doc_id && *version == at)
                .then_some(())
        })
        .is_some()
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.client.shutdown();
    }
}

#[test]
#[ignore = "talks to overleaf.com with the signed-in session"]
fn connects_to_the_real_overleaf() {
    let live = Live::connect();
    let project = live.client.project();
    println!("root folder: {}", project.root_folder_id);
    for doc in &project.docs {
        println!("  doc {} -> {}", doc.id, doc.path);
    }
    assert!(!project.docs.is_empty(), "Overleaf reported no documents");
    // Whatever the session file holds, an account id has to come back.
    let user_id = project.user_id.as_deref().expect("our own Overleaf account id");
    assert_eq!(user_id.len(), 24, "an Overleaf account id is a Mongo ObjectId");
    let joined = live.join(&project.docs[0].id);
    println!(
        "joined {} at v{} ({} comments)",
        project.docs[0].path,
        joined.version,
        joined.comments.len()
    );
    assert!(joined.version >= 0);
}

/// Sends a real operation to a real document and checks it comes back.
///
/// This is the part the mock cannot prove: that the ops we build are the ops
/// Overleaf accepts, that it echoes them with our own id, and that the version
/// advances the way the state machine assumes. It inserts, then deletes, the
/// same text, leaving the document exactly as it found it.
#[test]
#[ignore = "edits a document on overleaf.com with the signed-in session"]
fn edits_a_document_through_the_real_overleaf() {
    let live = Live::connect();
    let doc = live.target();
    let joined = live.join(&doc.id);

    // Non-ASCII on purpose: Overleaf packs its snapshots as UTF-8 bytes
    // reinterpreted per code point, and a client that does not unpack them
    // writes mojibake to disk and counts offsets in bytes.
    let probe = "café第三节";
    live.send(&doc.id, joined.version, insert(0, probe));
    assert!(live.acked(&doc.id, joined.version, 15), "Overleaf never acknowledged the insert");

    // Read it back before removing it: this is the assertion that the
    // snapshot decoding is right, not just that the round trip completes.
    let midway = live.rejoin(&doc.id);
    assert!(midway.text.starts_with(probe), "expected {probe:?} at the start");

    live.send(&doc.id, midway.version, delete(0, probe));
    assert!(live.acked(&doc.id, midway.version, 15), "Overleaf never acknowledged the delete");
    assert_eq!(live.rejoin(&doc.id).text, joined.text, "the document did not come back unchanged");
}

/// Two clients on one document, to pin down what the version in a
/// collaborator's update actually means.
///
/// The acknowledgement `{doc, v}` and the broadcast `{doc, op, v}` both carry
/// the version the operation applied *at*, so both sides move to `v + 1`.
/// Reading either differently leaves the watcher a version behind, which the
/// server silently absorbs by transforming their next operation a second time
/// — the text lands in the wrong place and nothing reports an error.
#[test]
#[ignore = "edits a document on overleaf.com from two connections"]
fn a_collaborators_update_carries_the_version_it_applied_at() {
    let (writer, watcher) = (Live::connect(), Live::connect());
    let doc = writer.target();
    let joined = writer.join(&doc.id);
    let started_at = joined.version;
    let watching_from = watcher.join(&doc.id).version;
    assert_eq!(watching_from, started_at, "both should start from the same version");

    // Non-ASCII deliberately: whether a collaborator's operations are packed
    // like document lines decides whether their text arrives as mojibake and
    // at byte offsets instead of character ones.
    let probe = "\n% lattice probe caf\u{e9}\u{7b2c}\u{4e09}\u{8282}\n";
    writer.send(&doc.id, started_at, insert(0, probe));

    let acked_at = wait_for(&writer.events, 20, |event| match event {
        RealtimeEvent::DocAck { doc_id, version } if *doc_id == doc.id => Some(*version),
        _ => None,
    });
    let broadcast = wait_for(&watcher.events, 20, |event| match event {
        RealtimeEvent::DocUpdate { doc_id, version, ops, .. } if *doc_id == doc.id => {
            Some((*version, ops.first().and_then(|op| op.i.clone())))
        }
        _ => None,
    });
    let (broadcast_at, inserted) = broadcast.expect("the update the watcher was sent");
    let inserted = inserted.as_deref();
    assert_eq!(inserted, Some(probe), "a collaborator's text should arrive as it was typed");
    let acked_at = acked_at.expect("the writer's own acknowledgement");
    assert_eq!(acked_at, started_at, "the ack names the version applied at");
    assert_eq!(
        broadcast_at, started_at,
        "so does the broadcast — a watcher that stores this as its own version ends up one behind the sender",
    );

    writer.send(&doc.id, started_at + 1, delete(0, probe));
    std::thread::sleep(Duration::from_secs(2));
    watcher.client.shutdown();
    assert_eq!(writer.rejoin(&doc.id).text, joined.text, "the document should be unchanged");
}

/// One connection, two documents, and an answer owed on the first.
///
/// Moving between files keeps a document that still has an operation
/// outstanding, rather than leaving its room and losing the reply. That only
/// works if the server keeps talking to us about a document after we have
/// joined another on the same socket, which nothing documents.
#[test]
#[ignore = "edits a document on overleaf.com"]
fn an_answer_still_arrives_after_joining_another_document() {
    let live = Live::connect();
    let first = live.target();
    let docs = &live.client.project().docs;
    let second =
        docs.iter().find(|doc| doc.id != first.id).expect("a second document in the project");

    let joined = live.join(&first.id);
    let probe = "\n% lattice two-document probe\n";
    live.send(&first.id, joined.version, insert(0, probe));
    // Straight to the other file, without leaving the first — exactly what
    // the app does when someone clicks away mid-sentence.
    live.join(&second.id);
    let acked = live.acked(&first.id, joined.version, 20);
    assert!(
        acked,
        "the first document's acknowledgement should still reach us after joining the second"
    );

    live.send(&first.id, joined.version + 1, delete(0, probe));
    std::thread::sleep(Duration::from_secs(2));
    live.leave(&second.id);
    assert_eq!(live.rejoin(&first.id).text, joined.text, "the document should be unchanged");
}

/// Rejoining a document we were editing is only lossless if the server hands
/// back what happened while we were away — and asking for it needs the version
/// in the positional slot `joinDoc(docId, fromVersion, options)`. Put it in the
/// options object instead and the server answers with a full document and no
/// replay, and nothing anywhere reports a problem.
#[test]
#[ignore = "edits a document on overleaf.com from two connections"]
fn rejoining_a_document_replays_what_was_missed() {
    let (writer, returner) = (Live::connect(), Live::connect());
    let doc = writer.target();
    let known = returner.join(&doc.id).version;
    returner.leave(&doc.id);

    // Move the document on while we are away.
    let ahead = writer.join(&doc.id);
    let probe = "\n% lattice rejoin probe\n";
    writer.send(&doc.id, ahead.version, insert(0, probe));
    std::thread::sleep(Duration::from_secs(2));

    // Joining from scratch says nothing about what we missed.
    let fresh = returner.join(&doc.id);
    assert!(fresh.caught_up.is_empty() && !fresh.resumed);
    assert!(fresh.version > known, "the document moved while we were away");
    returner.leave(&doc.id);

    // Joining from the version we had replays it.
    let resumed =
        rt::block_on(returner.client.join_doc(&doc.id, Some(known))).expect("resumed join");
    assert!(resumed.resumed);
    assert_eq!(resumed.caught_up.len(), 1, "one update happened while away");
    let missed = &resumed.caught_up[0];
    assert_eq!(missed.version, known, "the version it applied at");
    assert_eq!(missed.ops.len(), 1);
    assert_eq!(missed.ops[0].i.as_deref(), Some(probe));
    assert!(missed.source.is_some(), "who sent it, so our own work is not applied twice");
    returner.leave(&doc.id);

    writer.send(&doc.id, ahead.version + 1, delete(0, probe));
    std::thread::sleep(Duration::from_secs(1));
}

/// Creates a comment thread on a real document, then edits, resolves, reopens
/// and deletes it — the whole path a reviewer takes.
///
/// Overleaf splits a comment in two: the conversation behind REST, the anchor
/// on the editing channel. Only doing both makes the span show as commented,
/// and only the real service reveals things like the 411 a bodyless POST earns.
#[test]
#[ignore = "creates and deletes a comment on overleaf.com"]
fn comments_on_a_real_document() {
    use crate::overleaf::{
        comment_anchors, delete_message, delete_thread, edit_message, reply_to_thread,
        resolve_thread, threads,
    };
    let live = Live::connect();
    let (config, root) = (&live.config, &live.root);
    let doc = live.target();
    let joined = live.join(&doc.id);
    let thread =
        |id: &str| threads(config, root).expect("read threads").into_iter().find(|t| t.id == id);

    // A thread id is minted by the client, not the server; both halves of the
    // call have to agree on it.
    let thread_id = format!("{:08x}{:016x}", 1_780_000_000u32, 0x5eedc0ffee1234u64);
    let quote: String = joined.text.chars().take(12).collect();
    reply_to_thread(config, root, &thread_id, "Lattice check: please ignore")
        .expect("post the first message");
    rt::block_on(live.client.send_comment(&doc.id, joined.version, 0, &quote, &thread_id))
        .expect("anchor the comment");

    // The project-wide ranges endpoint is the only thing that can name the
    // file a comment lives in without joining every document in turn, and
    // resolving or deleting a thread needs exactly that.
    let anchors = comment_anchors(config, root).expect("comment anchors");
    let anchor =
        anchors.iter().find(|anchor| anchor.thread_id == thread_id).expect("our comment's anchor");
    assert_eq!(
        (anchor.doc_id.as_str(), anchor.quote.as_str(), anchor.position),
        (doc.id.as_str(), quote.as_str(), 0)
    );

    let made = thread(&thread_id).expect("the thread we just made");
    assert_eq!(made.messages.len(), 1);
    assert_eq!(made.messages[0].content, "Lattice check: please ignore");
    assert!(made.messages[0].mine, "our own message should read as ours");
    assert!(!made.resolved);

    // Editing and deleting a single message, which Overleaf routes separately
    // from the thread itself.
    reply_to_thread(config, root, &thread_id, "and a reply").expect("reply");
    let with_reply = thread(&thread_id).expect("still there");
    assert_eq!(with_reply.messages.len(), 2);
    let (first, reply) = (&with_reply.messages[0].id, &with_reply.messages[1].id);
    edit_message(config, root, &thread_id, first, "edited by Lattice")
        .expect("edit the first message");
    delete_message(config, root, &thread_id, reply).expect("delete the reply");
    let after = thread(&thread_id).expect("still there");
    assert_eq!(after.messages.len(), 1, "the reply should be gone");
    assert_eq!(after.messages[0].content, "edited by Lattice");

    reply_to_thread(config, root, &thread_id, "and a reply").expect("reply");
    resolve_thread(config, root, &doc.id, &thread_id, true).expect("resolve");
    let resolved = thread(&thread_id).expect("still there");
    assert!(resolved.resolved, "the thread should read as resolved");
    assert_eq!(resolved.messages.len(), 2);

    resolve_thread(config, root, &doc.id, &thread_id, false).expect("reopen");
    delete_thread(config, root, &doc.id, &thread_id).expect("delete");
    assert!(thread(&thread_id).is_none(), "the thread should be gone");
}

/// Suggests an edit on a real document, reads it back as a tracked change,
/// then rejects it — the whole review loop against the real service.
#[test]
#[ignore = "suggests and withdraws an edit on overleaf.com"]
fn tracks_a_change_on_the_real_overleaf() {
    let live = Live::connect();
    let doc = live.target();
    let before = live.join(&doc.id);

    let probe = "SUGGESTED café";
    rt::block_on(live.client.send_ops(
        &doc.id,
        before.version,
        vec![insert(0, probe)],
        true,
        Submission::default(),
    ))
    .expect("suggest an edit");
    std::thread::sleep(Duration::from_secs(2));

    let again = live.rejoin(&doc.id);
    let mine =
        again.changes.iter().find(|change| change.text == probe).expect("our suggestion, tracked");
    assert!(!mine.deletion);
    assert!(again.text.starts_with(probe), "the text carries it meanwhile");

    // Rejecting undoes it, and takes the tracked change with it.
    rt::block_on(live.client.reject_changes(&doc.id, again.version, std::slice::from_ref(mine)))
        .expect("reject");
    std::thread::sleep(Duration::from_secs(2));
    let settled = live.rejoin(&doc.id);
    assert_eq!(settled.text, before.text, "the document should be as we found it");
    assert!(
        !settled.changes.iter().any(|change| change.id == mine.id),
        "the suggestion should be gone, not merely undone"
    );
}

/// Reads the real project's roster and publishes a position, which is the
/// only thing that makes us visible to a browser already looking at it.
#[test]
#[ignore = "talks to overleaf.com with the signed-in session"]
fn appears_present_on_the_real_overleaf() {
    let live = Live::connect();
    let doc = live.target();
    live.join(&doc.id);
    rt::block_on(live.client.update_position(&doc.id, 0, 0)).expect("updatePosition");

    let users = rt::block_on(live.client.connected_users()).expect("the roster");
    for user in &users {
        println!(
            "  {} {:?} hue {} doc {:?} at {:?}:{:?}",
            user.id, user.name, user.hue, user.doc_id, user.row, user.column
        );
    }
    let me = live.client.public_id();
    assert!(users.iter().any(|user| user.id == me), "we should be in the roster as {me}");
    // Our own broadcast comes back to us, which is how the app learns to
    // filter itself out.
    let echoed = lock(&live.events)
        .iter()
        .any(|event| matches!(event, RealtimeEvent::PresenceUpdated { user } if user.id == me));
    println!("our own position echoed back: {echoed}");
}
