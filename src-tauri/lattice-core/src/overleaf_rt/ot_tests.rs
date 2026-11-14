//! The Tauri app's `src/overleaf/ot.test.ts`, ported: the expected values are
//! that suite's, worked out by hand from what each side typed and placed as
//! ShareJS's text type places them.

use super::*;

fn ins(p: usize, text: &str) -> OtOp {
    insert(p, text)
}

fn del(p: usize, text: &str) -> OtOp {
    delete(p, text)
}

/// Apply, panicking when the op does not fit: tests never skip a bad op.
fn apply(document: &str, op: &[OtOp]) -> String {
    apply_ops(document, op).unwrap_or_else(|| panic!("op did not fit: {op:?} on {document:?}"))
}

/// Two people edit at once, each transforms the other's work, and both end
/// up with the same text.
fn converge(document: &str, mine: &[OtOp], theirs: &[OtOp]) -> String {
    let (mine_after, theirs_after) = transform_both(mine, theirs);
    let mine_path = apply(&apply(document, mine), &theirs_after);
    let their_path = apply(&apply(document, theirs), &mine_after);
    assert_eq!(mine_path, their_path, "diverged on {document:?}: {mine:?} vs {theirs:?}");
    mine_path
}

#[test]
fn diff_to_ops_describes_each_change_and_reproduces_it() {
    let cases: Vec<(&str, &str, Vec<OtOp>)> = vec![
        ("same", "same", vec![]),
        ("hello world", "hello brave world", vec![ins(6, "brave ")]),
        ("hello brave world", "hello world", vec![del(6, "brave ")]),
        ("the quick fox", "the slow fox", vec![del(4, "quick"), ins(4, "slow")]),
        ("body", "\\section{A}\nbody", vec![ins(0, "\\section{A}\n")]),
        ("body", "body\n", vec![ins(4, "\n")]),
        ("body", "", vec![del(0, "body")]),
        ("", "body", vec![ins(0, "body")]),
        ("aa", "aaa", vec![ins(2, "a")]),
        (
            "\\begin{abstract}\nOne.\n\\end{abstract}\n",
            "\\begin{abstract}\nOne. Added.\n\\end{abstract}\n",
            vec![ins(21, " Added.")],
        ),
        // The two emoji share the first half of their UTF-16 pair.
        ("a \u{1F535} b", "a \u{1F534} b", vec![del(2, "\u{1F535}"), ins(2, "\u{1F534}")]),
        ("\u{1F600}", "\u{1D600}", vec![del(0, "\u{1F600}"), ins(0, "\u{1D600}")]),
    ];
    for (before, after, ops) in cases {
        assert_eq!(diff_to_ops(before, after), ops, "{before:?} → {after:?}");
        assert_eq!(apply_ops(before, &ops).as_deref(), Some(after));
    }
}

#[test]
fn surrogates_are_stored_as_overleaf_stores_them() {
    let (ops, replaced) = as_overleaf_stores(vec![del(0, "\u{1F535}"), ins(0, "x \u{1D538} y")]);
    assert!(replaced);
    assert_eq!(ops, vec![del(0, "\u{1F535}"), ins(0, "x \u{FFFD}\u{FFFD} y")]);
    let plain = vec![ins(1, "café — naïve")];
    assert_eq!(as_overleaf_stores(plain.clone()), (plain, false));
}

#[test]
fn apply_ops_refuses_what_does_not_fit() {
    assert_eq!(apply_ops("abcdef", &[del(1, "bc"), ins(1, "X")]).as_deref(), Some("aXdef"));
    assert_eq!(apply_ops("hello", &[del(0, "goodbye")]), None);
    assert_eq!(apply_ops("hello", &[ins(99, "x")]), None);
}

#[test]
fn spans_move_with_the_text_and_keep_edge_typing_outside() {
    let cases: Vec<(Vec<OtOp>, (usize, usize))> = vec![
        (vec![ins(0, "ab")], (5, 3)),
        (vec![ins(9, "ab")], (3, 3)),
        (vec![ins(3, "ab")], (5, 3)),
        (vec![ins(6, "ab")], (3, 3)),
        (vec![ins(4, "ab")], (3, 5)),
        (vec![del(0, "01")], (1, 3)),
        (vec![del(4, "45")], (3, 1)),
        (vec![del(3, "34")], (3, 1)),
        (vec![del(3, "345")], (3, 0)),
        (vec![del(1, "12345678")], (1, 0)),
        (vec![del(2, "234")], (2, 1)),
        (vec![ins(0, "xx"), del(0, "x")], (4, 3)),
        (vec![], (3, 3)),
    ];
    for (ops, expected) in cases {
        assert_eq!(transform_span(3, 3, &ops), expected, "{ops:?}");
    }
}

#[test]
fn concurrent_operations_converge() {
    let cases: Vec<(&str, Vec<OtOp>, Vec<OtOp>)> = vec![
        ("hello world", vec![ins(11, "!")], vec![ins(0, ">> ")]),
        ("abcdefgh", vec![ins(5, "MINE")], vec![ins(5, "THEIRS")]),
        ("the quick brown fox", vec![ins(7, "X")], vec![del(4, "quick ")]),
        ("abcdefgh", vec![del(2, "cde")], vec![del(3, "def")]),
        ("0123456789", vec![del(0, "01")], vec![del(8, "89")]),
        ("0123456789", vec![del(8, "89")], vec![del(0, "01")]),
        (
            "alpha beta gamma",
            vec![del(0, "alpha"), ins(0, "ALPHA")],
            vec![del(11, "gamma"), ins(11, "GAMMA")],
        ),
        ("some text here", vec![del(0, "some text here")], vec![ins(5, "XX")]),
    ];
    for (document, mine, theirs) in cases {
        converge(document, &mine, &theirs);
    }
    assert_eq!(converge("abcdef", &[del(1, "bcde")], &[ins(3, "KEEP")]), "aKEEPf");
    assert_eq!(converge("abcdefgh", &[del(2, "cde")], &[del(2, "cde")]), "abfgh");
}

#[test]
fn rebasing_keeps_both_sides_typing() {
    let (base, remote_text) = ("one two three", "one 2 three");
    let remote = diff_to_ops(base, remote_text);
    assert_eq!(
        rebase_onto(base, "ONE two THREE", &remote, remote_text, None).as_deref(),
        Some("ONE 2 THREE")
    );
    let replaced = [del(4, "two"), ins(4, "2")];
    assert_eq!(
        rebase_onto(base, "one twLo three", &replaced, remote_text, None).as_deref(),
        Some("one L2 three")
    );
    assert_eq!(
        rebase_onto(base, "one twLo three", &replaced, remote_text, Some(&[ins(6, "L")]))
            .as_deref(),
        Some("one L2 three")
    );
    assert_eq!(
        rebase_onto(base, "one two three four", &[ins(0, "zero ")], "zero one two three", None)
            .as_deref(),
        Some("zero one two three four")
    );
    assert_eq!(
        rebase_onto(base, "one three", &[ins(4, "2 ")], "one 2 two three", None).as_deref(),
        Some("one 2 three")
    );
    assert_eq!(
        rebase_onto(base, "one two! three", &[ins(7, "?")], "one two? three", None).as_deref(),
        Some("one two!? three")
    );
    assert_eq!(
        rebase_onto("aa", "aaa", &[ins(1, "X")], "aXa", Some(&[ins(0, "a")])).as_deref(),
        Some("aaXa")
    );
    assert_eq!(
        rebase_onto("aa", "aaa", &[ins(1, "X")], "aXa", Some(&[ins(0, "b")])).as_deref(),
        Some("aXaa")
    );
}

#[test]
fn precise_ops_narrow_a_line_to_its_changed_characters() {
    assert_eq!(
        precise_ops("AAAA BBBB CCCC", "AAA_ BBBB _CCC"),
        vec![del(3, "A"), ins(3, "_"), del(10, "C"), ins(10, "_")]
    );
    assert_eq!(
        apply_ops("one two three", &precise_ops("one two three", "ONE two THREE")).as_deref(),
        Some("ONE two THREE")
    );
}

#[test]
fn composing_matches_applying_in_turn_and_merges_adjacent_typing() {
    assert_eq!(compose_ops(&[ins(0, "ab")], &[ins(2, "cd")]), vec![ins(0, "abcd")]);
    for (document, first, second) in [
        ("hello", vec![ins(5, " world")], vec![ins(11, "!")]),
        ("0123456789", vec![ins(10, "X")], vec![del(0, "01")]),
    ] {
        assert_eq!(
            apply(document, &compose_ops(&first, &second)),
            apply(&apply(document, &first), &second)
        );
    }
    let ops = [del(0, "a"), ins(0, "x")];
    assert_eq!(apply(&apply("ab", &ops), &invert_ops(&ops)), "ab");
}

/// The same deterministic PRNG as the TypeScript suite.
struct Random(u32);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.0) / 4_294_967_296.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() * bound as f64) as usize
    }
}

const ALPHABET: &[u8] = b"abcdefgh\n";

fn random_text(random: &mut Random, length: usize) -> String {
    (0..length).map(|_| ALPHABET[random.below(ALPHABET.len())] as char).collect()
}

fn random_op(random: &mut Random, document: &str) -> Vec<OtOp> {
    let mut op = Vec::new();
    let mut current = document.to_string();
    for _ in 0..1 + random.below(3) {
        let component = if !current.is_empty() && random.next() < 0.5 {
            let p = random.below(current.len());
            let length = 1 + random.below(4.min(current.len() - p));
            del(p, &current[p..p + length])
        } else {
            let p = random.below(current.len() + 1);
            let length = 1 + random.below(3);
            ins(p, &random_text(random, length))
        };
        current = apply(&current, std::slice::from_ref(&component));
        op.push(component);
    }
    op
}

#[test]
fn random_concurrent_edits_converge() {
    for seed in [0x5eed, 0xbeef, 0x1234, 0xfeed, 0xabcd] {
        let mut random = Random(seed);
        for _ in 0..4000 {
            let length = random.below(24);
            let document = random_text(&mut random, length);
            let mine = random_op(&mut random, &document);
            let theirs = random_op(&mut random, &document);
            converge(&document, &mine, &theirs);
        }
    }
}

#[test]
fn random_sequential_edits_compose() {
    let mut random = Random(0xc0ffee);
    for round in 0..2000 {
        let length = random.below(24);
        let document = random_text(&mut random, length);
        let first = random_op(&mut random, &document);
        let middle = apply(&document, &first);
        let second = random_op(&mut random, &middle);
        assert_eq!(
            apply(&document, &compose_ops(&first, &second)),
            apply(&middle, &second),
            "round {round}"
        );
    }
}

/// A stand-in for Overleaf's server: applies operations in arrival order,
/// transforming each (as the left side) against everything accepted since
/// the version it was built on, and answers with the version it applied AT,
/// as overleaf.com does.
struct FakeServer {
    history: Vec<Vec<OtOp>>,
    text: String,
    texts: Vec<String>,
}

impl FakeServer {
    fn new(text: &str) -> Self {
        Self { history: Vec::new(), text: text.into(), texts: vec![text.into()] }
    }

    fn version(&self) -> i64 {
        self.history.len() as i64
    }

    fn submit(&mut self, send: &OtSend) -> OtSend {
        let mut incoming = send.ops.clone();
        for accepted in &self.history[send.version as usize..] {
            incoming = transform_both(&incoming, accepted).0;
        }
        self.text = apply(&self.text, &incoming);
        let applied_at = self.version();
        self.history.push(incoming.clone());
        self.texts.push(self.text.clone());
        OtSend { version: applied_at, ops: incoming }
    }
}

fn join(server: &FakeServer) -> OtDocument {
    OtDocument::new(server.text.clone(), server.version())
}

/// The server accepts `send` from `author`, broadcasts it to `others`, then
/// acknowledges the author; whatever the author can send next.
fn round_trip(
    server: &mut FakeServer, author: &mut OtDocument, others: &mut [&mut OtDocument], send: &OtSend,
) -> Option<OtSend> {
    let accepted = server.submit(send);
    for other in others.iter_mut() {
        other.remote(&accepted.ops, accepted.version).unwrap();
    }
    author.acknowledge(None).unwrap()
}

#[test]
fn edits_wait_for_the_acknowledgement_then_go_as_one() {
    let mut doc = OtDocument::new("a", 1);
    assert_eq!(doc.local("ab").send, Some(OtSend { version: 1, ops: vec![ins(1, "b")] }));
    assert!(doc.waiting());
    let held = doc.local("abc");
    assert_eq!((held.send, held.ops), (None, vec![ins(2, "c")]));
    assert_eq!(doc.local("abcd").send, None);
    assert_eq!(
        doc.acknowledge(None).unwrap(),
        Some(OtSend { version: 2, ops: vec![ins(2, "cd")] })
    );
    assert_eq!(doc.acknowledge(None).unwrap(), None);
    assert!(doc.settled());
    assert_eq!(doc.version(), 3);
}

#[test]
fn a_repeated_acknowledgement_is_ignored_and_one_from_the_future_refused() {
    let mut doc = OtDocument::new("a", 7);
    doc.local("ab");
    assert_eq!(doc.acknowledge(Some(7)).unwrap(), None);
    assert_eq!(doc.version(), 8);
    doc.local("abc");
    assert_eq!(doc.acknowledge(Some(7)).unwrap(), None);
    assert!(doc.waiting());
    assert_eq!(doc.version(), 8);
    assert_eq!(doc.acknowledge(Some(11)), Err(OtDesync::AckAhead { version: 11, current: 8 }));
}

#[test]
fn a_remote_edit_keeps_local_work_and_its_redelivery_is_ignored() {
    let mut doc = OtDocument::new("hello world", 5);
    doc.local("hello brave world");
    assert_eq!(doc.remote(&[ins(0, ">> ")], 5).unwrap(), vec![ins(0, ">> ")]);
    assert_eq!(doc.text(), ">> hello brave world");
    assert_eq!(doc.version(), 6);
    assert_eq!(doc.remote(&[ins(0, ">> ")], 5).unwrap(), vec![]);
    assert_eq!((doc.text(), doc.version()), (">> hello brave world", 6));
}

#[test]
fn updates_from_the_future_or_that_do_not_fit_are_refused() {
    assert_eq!(
        OtDocument::new("hello", 4).remote(&[ins(0, "x")], 6),
        Err(OtDesync::UpdateAhead { version: 6, current: 4 })
    );
    assert_eq!(
        OtDocument::new("hello", 4).remote(&[del(0, "goodbye")], 4),
        Err(OtDesync::DidNotFit)
    );
}

#[test]
fn queued_work_cancelled_by_an_identical_edit_is_dropped() {
    let mut doc = OtDocument::new("hello world", 10);
    assert!(doc.local("hello worldX").send.is_some());
    assert_eq!(doc.local("hello X").send, None);
    doc.remote(&[del(6, "world")], 10).unwrap();
    assert_eq!(doc.acknowledge(Some(11)).unwrap(), None);
    assert_eq!((doc.text(), doc.version(), doc.settled()), ("hello X", 12, true));
    assert_eq!(doc.local("hello X!").send, Some(OtSend { version: 12, ops: vec![ins(7, "!")] }));
}

#[test]
fn an_in_flight_edit_cancelled_by_a_replay_settles_and_later_work_goes_fresh() {
    let mut doc = OtDocument::new("hello world", 10);
    doc.local("hello ");
    doc.note_submitted(Some("p1"));
    doc.remote(&[del(6, "world")], 10).unwrap();
    assert_eq!(doc.resend(), None);
    assert_eq!((doc.text(), doc.version(), doc.settled()), ("hello ", 11, true));
    assert!(doc.submitted_via().is_empty());
    assert_eq!(doc.local("hello !").send, Some(OtSend { version: 11, ops: vec![ins(6, "!")] }));

    let mut doc = OtDocument::new("hello world", 10);
    doc.local("hello ");
    doc.note_submitted(Some("p1"));
    doc.local("hello !");
    doc.remote(&[del(6, "world")], 10).unwrap();
    assert_eq!(
        doc.resend(),
        Some(Resend { version: 11, ops: vec![ins(6, "!")], dup_if_source: vec![] })
    );
    assert_eq!(doc.acknowledge(Some(11)).unwrap(), None);
    assert_eq!((doc.text(), doc.version(), doc.settled()), ("hello !", 12, true));
}

#[test]
fn an_emoji_is_kept_as_overleaf_stores_it() {
    let mut doc = OtDocument::new("note: ", 3);
    let stored = vec![ins(6, "\u{FFFD}\u{FFFD} done")];
    let typed = doc.local("note: \u{1F535} done");
    assert_eq!(
        typed,
        LocalEdit {
            send: Some(OtSend { version: 3, ops: stored.clone() }),
            replaced: true,
            ops: stored
        }
    );
    assert_eq!(doc.text(), "note: \u{FFFD}\u{FFFD} done");
    doc.acknowledge(Some(3)).unwrap();
    let next = doc.local("note: \u{FFFD}\u{FFFD} done!");
    assert_eq!(
        (next.send, next.replaced),
        (Some(OtSend { version: 4, ops: vec![ins(13, "!")] }), false)
    );
}

#[test]
fn the_server_text_excludes_unacknowledged_work() {
    let mut doc = OtDocument::new("fox", 7);
    doc.local("quick fox");
    doc.local("quick fox!");
    assert_eq!(doc.server_text(), "fox");
    doc.remote(&[ins(3, " runs")], 7).unwrap();
    assert_eq!((doc.server_text(), doc.text()), ("fox runs", "quick fox! runs"));
    doc.acknowledge(Some(8)).unwrap();
    assert_eq!(doc.server_text(), "quick fox runs");
    doc.acknowledge(Some(9)).unwrap();
    assert_eq!(
        (doc.server_text(), doc.text(), doc.version()),
        ("quick fox! runs", "quick fox! runs", 10)
    );
    doc.reset("over", 12);
    assert_eq!((doc.server_text(), doc.settled()), ("over", true));
}

#[test]
fn two_editors_typing_in_one_place_converge() {
    let mut server = FakeServer::new("the fox");
    let (mut a, mut b) = (join(&server), join(&server));
    let a_send = a.local("the quick fox").send.unwrap();
    let b_send = b.local("the brown fox").send.unwrap();
    round_trip(&mut server, &mut a, &mut [&mut b], &a_send);
    round_trip(&mut server, &mut b, &mut [&mut a], &b_send);
    assert_eq!((a.text(), b.text()), (server.text.as_str(), server.text.as_str()));
    assert!(server.text.contains("quick") && server.text.contains("brown"));
}

#[test]
fn everything_typed_while_waiting_is_kept() {
    let mut server = FakeServer::new("start");
    let (mut a, mut b) = (join(&server), join(&server));
    let a_send = a.local("start A1").send.unwrap();
    assert_eq!(a.local("start A1 A2").send, None);
    let b_send = b.local("B0 start").send.unwrap();
    round_trip(&mut server, &mut b, &mut [&mut a], &b_send);
    let queued = round_trip(&mut server, &mut a, &mut [&mut b], &a_send).unwrap();
    round_trip(&mut server, &mut a, &mut [&mut b], &queued);
    assert_eq!((a.text(), b.text()), (server.text.as_str(), server.text.as_str()));
    for typed in ["A1", "A2", "B0"] {
        assert!(server.text.contains(typed));
    }
}

#[test]
fn a_long_interleaved_session_converges() {
    let mut random = Random(0x1234_5678);
    let mut server = FakeServer::new("line one\nline two\nline three\n");
    let mut peers = [join(&server), join(&server)];
    // Every accepted operation goes to everyone, in one order; a peer seeing
    // its own come back takes it as the acknowledgement.
    let mut queues: [Vec<(OtSend, usize)>; 2] = [Vec::new(), Vec::new()];
    let mut checks = 0;
    let submit = |server: &mut FakeServer,
                  queues: &mut [Vec<(OtSend, usize)>; 2],
                  author: usize,
                  send: &OtSend| {
        let accepted = server.submit(send);
        for queue in queues.iter_mut() {
            queue.push((accepted.clone(), author));
        }
    };
    let deliver = |server: &mut FakeServer,
                   queues: &mut [Vec<(OtSend, usize)>; 2],
                   peers: &mut [OtDocument; 2],
                   peer: usize,
                   checks: &mut usize| {
        if queues[peer].is_empty() {
            return;
        }
        let (next, author) = queues[peer].remove(0);
        if author == peer {
            if let Some(after) = peers[peer].acknowledge(None).unwrap() {
                submit(server, queues, peer, &after);
            }
        } else {
            peers[peer].remote(&next.ops, next.version).unwrap();
        }
        assert_eq!(peers[peer].server_text(), server.texts[peers[peer].version() as usize]);
        *checks += 1;
    };
    for _ in 0..400 {
        let peer = random.below(2);
        if random.next() < 0.55 {
            let text: Vec<u16> = peers[peer].text().encode_utf16().collect();
            let at = random.below(text.len() + 1);
            let next = format!(
                "{}x{}",
                String::from_utf16_lossy(&text[..at]),
                String::from_utf16_lossy(&text[at..])
            );
            if let Some(send) = peers[peer].local(&next).send {
                submit(&mut server, &mut queues, peer, &send);
            }
        } else {
            deliver(&mut server, &mut queues, &mut peers, peer, &mut checks);
        }
    }
    for _ in 0..10_000 {
        let Some(busy) = (0..2).find(|peer| !queues[*peer].is_empty()) else {
            break;
        };
        deliver(&mut server, &mut queues, &mut peers, busy, &mut checks);
    }
    for peer in &peers {
        assert!(peer.settled());
        assert_eq!(peer.text(), server.text);
    }
    assert!(checks > 100);
}

#[test]
fn resuming_replays_what_was_missed_and_keeps_unsent_work() {
    let mut doc = OtDocument::new("hello", 4);
    let send = doc.local("hello there").send.unwrap();
    assert_eq!(send.version, 4);
    doc.catch_up(&[
        Replayed { version: 4, ops: send.ops, mine: true },
        Replayed { version: 5, ops: vec![ins(0, ">> ")], mine: false },
    ])
    .unwrap();
    assert_eq!((doc.text(), doc.version(), doc.settled()), (">> hello there", 6, true));

    let mut doc = OtDocument::new("a", 1);
    let first = doc.local("ab").send.unwrap();
    assert_eq!(doc.local("abc").send, None);
    let (_, send) = doc.catch_up(&[Replayed { version: 1, ops: first.ops, mine: true }]).unwrap();
    assert_eq!(send.map(|send| send.version), Some(2));
    assert_eq!(doc.text(), "abc");

    let mut doc = OtDocument::new("one\ntwo", 3);
    let (applied, _) = doc
        .catch_up(&[
            Replayed { version: 3, ops: vec![ins(0, "zero\n")], mine: false },
            Replayed { version: 4, ops: vec![ins(0, "!\n")], mine: false },
        ])
        .unwrap();
    assert_eq!(apply_ops("one\ntwo", &applied).as_deref(), Some(doc.text()));
    assert_eq!((doc.text(), doc.version()), ("!\nzero\none\ntwo", 5));

    let mut doc = OtDocument::new("fox", 7);
    doc.local("quick fox");
    doc.catch_up(&[Replayed { version: 7, ops: vec![ins(3, " runs")], mine: false }]).unwrap();
    assert_eq!(doc.text(), "quick fox runs");
}
