import { describe, expect, it } from "vitest";
import {
  applyOps,
  composeOps,
  diffToOps,
  OtDesyncError,
  OtDocument,
  transformBoth,
  transformCaret,
  transformSpan,
  type OtOp,
} from "./ot";

type Send = { version: number; ops: OtOp[] };

describe("diffToOps", () => {
  it.each([
    ["nothing when the text is unchanged", "same", "same", []],
    ["typing as a single insert at the caret", "hello world", "hello brave world", [{ p: 6, i: "brave " }]],
    ["deleting a selection as a single delete", "hello brave world", "hello world", [{ p: 6, d: "brave " }]],
    ["a replacement as a delete followed by an insert", "the quick fox", "the slow fox", [{ p: 4, d: "quick" }, { p: 4, i: "slow" }]],
    ["an edit at the very start", "body", "\\section{A}\nbody", [{ p: 0, i: "\\section{A}\n" }]],
    ["an edit at the very end", "body", "body\n", [{ p: 4, i: "\n" }]],
    ["deleting everything", "body", "", [{ p: 0, d: "body" }]],
    ["filling an empty document", "", "body", [{ p: 0, i: "body" }]],
    // The naive prefix/suffix walk must not overlap; "aa" → "aaa" is one insert.
    ["repeated text without inventing a bigger change", "aa", "aaa", [{ p: 2, i: "a" }]],
    ["a multi-line LaTeX edit", "\\begin{abstract}\nOne.\n\\end{abstract}\n", "\\begin{abstract}\nOne. Added.\n\\end{abstract}\n", [{ p: 21, i: " Added." }]],
  ])("describes %s, and the ops reproduce the change", (_label, before, after, ops) => {
    expect(diffToOps(before, after)).toEqual(ops);
    expect(applyOps(before, ops)).toBe(after);
  });
});

describe("applyOps", () => {
  it("applies a sequence in order, and refuses ops that do not fit rather than corrupting the text", () => {
    expect(applyOps("abcdef", [{ p: 1, d: "bc" }, { p: 1, i: "X" }])).toBe("aXdef");
    // A delete whose content disagrees means the local copy drifted.
    expect(applyOps("hello", [{ p: 0, d: "goodbye" }])).toBeNull();
    expect(applyOps("hello", [{ p: 99, i: "x" }])).toBeNull();
    expect(applyOps("hello", [{ p: -1, i: "x" }])).toBeNull();
  });
});

describe("transformCaret", () => {
  it.each([
    ["keeps its place when text is inserted above it", 10, { p: 0, i: "abc" }, 13],
    ["is left alone by an edit below it", 5, { p: 20, i: "abc" }, 5],
    ["is not dragged when someone types exactly at it", 5, { p: 5, i: "abc" }, 5],
    ["is pulled back when text above it is deleted", 10, { p: 0, d: "abc" }, 7],
    ["clamps to the start of a deletion that contained it", 5, { p: 3, d: "abcdef" }, 3],
  ])("%s", (_label, caret, op, expected) => expect(transformCaret(caret, [op])).toBe(expected));
});

describe("transformSpan", () => {
  // "0123456789", with a span over "345". Text typed at either edge lands
  // outside it: accepting a suggestion that swallowed it would change text
  // nobody proposed changing.
  const span = { from: 3, length: 3 };
  it.each([
    ["moves along for an insert before it", [{ p: 0, i: "ab" }], 5, 3],
    ["ignores an insert after it", [{ p: 9, i: "ab" }], 3, 3],
    ["keeps text typed at its start outside", [{ p: 3, i: "ab" }], 5, 3],
    ["keeps text typed at its end outside", [{ p: 6, i: "ab" }], 3, 3],
    ["grows around text typed inside it", [{ p: 4, i: "ab" }], 3, 5],
    ["pulls back when text before it is deleted", [{ p: 0, d: "01" }], 1, 3],
    ["shrinks when its tail is deleted", [{ p: 4, d: "45" }], 3, 1],
    ["shrinks when its head is deleted", [{ p: 3, d: "34" }], 3, 1],
    ["collapses when its text is deleted outright", [{ p: 3, d: "345" }], 3, 0],
    ["collapses inside a deletion that swallows it", [{ p: 1, d: "12345678" }], 1, 0],
    ["handles a deletion straddling its start", [{ p: 2, d: "234" }], 2, 1],
    ["applies a run of operations in order", [{ p: 0, i: "xx" }, { p: 0, d: "x" }], 4, 3],
    ["is untouched by an empty operation list", [], 3, 3],
  ] as const)("%s", (_label, ops, from, length) => {
    expect(transformSpan(span, [...ops])).toEqual({ from, length });
  });
});

/** Apply, throwing when the op does not fit — tests must never silently skip a bad op. */
function apply(document: string, op: OtOp[]): string {
  const result = applyOps(document, op);
  if (result === null) throw new Error(`op did not fit: ${JSON.stringify(op)} on ${JSON.stringify(document)}`);
  return result;
}

/**
 * The property the whole feature rests on: two people edit the same document
 * at once, each transforms the other's work, and both end up with the same
 * text. If this fails, concurrent editing corrupts documents.
 */
function expectConvergence(document: string, mine: OtOp[], theirs: OtOp[]): string {
  const [mineAfterTheirs, theirsAfterMine] = transformBoth(mine, theirs);
  const minePath = apply(apply(document, mine), theirsAfterMine);
  const theirPath = apply(apply(document, theirs), mineAfterTheirs);
  if (minePath !== theirPath) {
    throw new Error(`diverged: ${JSON.stringify({ document, mine, theirs, minePath, theirPath }, null, 2)}`);
  }
  return minePath;
}

describe("transformBoth", () => {
  it.each([
    ["shifts an insert that follows someone else's insert", "hello world", [{ p: 11, i: "!" }], [{ p: 0, i: ">> " }]],
    // Both type at position 5: whatever order is chosen, both machines must choose it.
    ["orders concurrent inserts at the same spot consistently", "abcdefgh", [{ p: 5, i: "MINE" }], [{ p: 5, i: "THEIRS" }]],
    ["moves an insert inside deleted text to the deletion point", "the quick brown fox", [{ p: 7, i: "X" }], [{ p: 4, d: "quick " }]],
    ["drops the overlapping part when both delete the same text", "abcdefgh", [{ p: 2, d: "cde" }], [{ p: 3, d: "def" }]],
    ["handles a delete entirely before another", "0123456789", [{ p: 0, d: "01" }], [{ p: 8, d: "89" }]],
    ["handles a delete entirely after another", "0123456789", [{ p: 8, d: "89" }], [{ p: 0, d: "01" }]],
    ["handles multi-component operations on both sides", "alpha beta gamma",
      [{ p: 0, d: "alpha" }, { p: 0, i: "ALPHA" }], [{ p: 11, d: "gamma" }, { p: 11, i: "GAMMA" }]],
    ["survives one side deleting everything", "some text here", [{ p: 0, d: "some text here" }], [{ p: 5, i: "XX" }]],
  ] as [string, string, OtOp[], OtOp[]][])("%s", (_label, document, mine, theirs) => {
    expectConvergence(document, mine, theirs);
  });

  it("keeps someone else's insert inside our delete, and makes an identical delete a no-op", () => {
    expect(expectConvergence("abcdef", [{ p: 1, d: "bcde" }], [{ p: 3, i: "KEEP" }])).toBe("aKEEPf");
    expect(expectConvergence("abcdefgh", [{ p: 2, d: "cde" }], [{ p: 2, d: "cde" }])).toBe("abfgh");
  });
});

describe("composeOps", () => {
  it.each([
    ["sequential inserts", "hello", [{ p: 5, i: " world" }], [{ p: 11, i: "!" }]],
    ["an insert followed by a delete elsewhere", "0123456789", [{ p: 10, i: "X" }], [{ p: 0, d: "01" }]],
  ] as [string, string, OtOp[], OtOp[]][])("combines %s into one equivalent operation", (_label, document, first, second) => {
    expect(apply(document, composeOps(first, second))).toBe(apply(apply(document, first), second));
  });

  it("merges adjacent typing into a single insert", () => {
    expect(composeOps([{ p: 0, i: "ab" }], [{ p: 2, i: "cd" }])).toEqual([{ p: 0, i: "abcd" }]);
  });
});

// ---- Randomised proof ------------------------------------------------------

/** Deterministic PRNG, so a failure is always reproducible from its seed. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = "abcdefgh\n";

const randomText = (random: () => number, length: number) =>
  Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join("");

const randomDocument = (random: () => number) => randomText(random, Math.floor(random() * 24));

/** A random operation of one to three components, valid against `document`. */
function randomOp(random: () => number, document: string): OtOp[] {
  const op: OtOp[] = [];
  let current = document;
  for (let count = 1 + Math.floor(random() * 3); count > 0; count -= 1) {
    let component: OtOp;
    if (current.length > 0 && random() < 0.5) {
      const p = Math.floor(random() * current.length);
      component = { p, d: current.slice(p, p + 1 + Math.floor(random() * Math.min(4, current.length - p))) };
    } else {
      const p = Math.floor(random() * (current.length + 1));
      component = { p, i: randomText(random, 1 + Math.floor(random() * 3)) };
    }
    op.push(component);
    current = apply(current, [component]);
  }
  return op;
}

describe("convergence under random concurrent edits", () => {
  // Several seeds, because each explores a different corner of the space —
  // overlapping deletes, inserts inside deletions, ops that split in two.
  it.each([0x5eed, 0xbeef, 0x1234, 0xfeed, 0xabcd])("converges (seed %i)", (seed) => {
    const random = makeRandom(seed);
    for (let round = 0; round < 4000; round += 1) {
      const document = randomDocument(random);
      expectConvergence(document, randomOp(random, document), randomOp(random, document));
    }
  });

  it("composes a run of sequential edits into an equivalent operation", () => {
    const random = makeRandom(0xc0ffee);
    for (let round = 0; round < 2000; round += 1) {
      const document = randomDocument(random);
      const first = randomOp(random, document);
      const middle = apply(document, first);
      const second = randomOp(random, middle);
      expect(apply(document, composeOps(first, second)), `round ${round}`).toBe(apply(middle, second));
    }
  });
});

/**
 * A stand-in for Overleaf's server: it holds the authoritative document,
 * applies operations in the order they arrive, and transforms each one against
 * whatever it has accepted since the version the client built it on — which is
 * exactly what the real server does.
 */
class FakeServer {
  /** Every accepted op, so a late client's work can be caught up. */
  private history: OtOp[][] = [];

  constructor(public text: string) {}

  get version() { return this.history.length; }

  submit({ ops, version }: Send): Send {
    // Transform against everything accepted since the client's version; the
    // server's own history takes priority.
    let incoming = ops;
    for (const accepted of this.history.slice(version)) incoming = transformBoth(accepted, incoming)[1];
    this.text = apply(this.text, incoming);
    // The version reported back is the one the operation applied AT, not the
    // one the document moved to — measured against overleaf.com, where a
    // document at v40 answers an accepted operation with v40 to the sender and
    // broadcasts v40 to everyone else. This modelled it as v41 for a while,
    // which is why a real off-by-one in `remote` went unnoticed here.
    const appliedAt = this.history.length;
    this.history.push(incoming);
    return { ops: incoming, version: appliedAt };
  }
}

/** One connected editor, starting from the server's current copy. */
const join = (server: FakeServer) => new OtDocument(server.text, server.version);

/** A server holding `text`, and two editors joined to it. */
function twoEditors(text: string) {
  const server = new FakeServer(text);
  return { server, a: join(server), b: join(server) };
}

/** Every editor ends on exactly the server's text. */
const expectConverged = (server: FakeServer, ...docs: OtDocument[]) => {
  for (const doc of docs) expect(doc.text).toBe(server.text);
};

/**
 * The server accepts `send` from `author`, broadcasts it to `others`, then
 * acknowledges the author. Answers with whatever the author can send next.
 */
function roundTrip(server: FakeServer, author: OtDocument, others: OtDocument[], send: Send) {
  const accepted = server.submit(send);
  for (const other of others) other.remote(accepted.ops, accepted.version);
  return author.acknowledge().send;
}

describe("OtDocument", () => {
  it("sends the first edit immediately, then holds later edits until it is acknowledged and sends one op", () => {
    const doc = new OtDocument("a", 1);
    expect(doc.local("ab").send).toEqual({ version: 1, ops: [{ p: 1, i: "b" }] });
    expect(doc.waiting).toBe(true);
    // Two more keystrokes while waiting: they must not go out separately.
    expect(doc.local("abc").send).toBeNull();
    expect(doc.local("abcd").send).toBeNull();

    expect(doc.acknowledge().send).toEqual({ version: 2, ops: [{ p: 2, i: "cd" }] });
    expect(doc.acknowledge().send).toBeNull();
    expect(doc.settled).toBe(true);
    expect(doc.version).toBe(3);
  });

  it("ignores a repeated acknowledgement and refuses one from the future", () => {
    // Overleaf acknowledges with the version the operation applied at, and can
    // repeat it if an update was retried. Acting on the repeat would clear an
    // operation that is genuinely still in flight.
    const doc = new OtDocument("a", 7);
    doc.local("ab");
    expect(doc.acknowledge(7).send).toBeNull();
    expect(doc.version).toBe(8);

    doc.local("abc");
    // A stale repeat of the previous ack: ignored, ours stays in flight.
    expect(doc.acknowledge(7).send).toBeNull();
    expect(doc.waiting).toBe(true);
    expect(doc.version).toBe(8);

    // An acknowledgement past our version means the two histories disagree.
    expect(() => doc.acknowledge(11)).toThrow(OtDesyncError);
  });

  it("keeps local work when a remote edit lands first, moves the caret with it, and ignores its redelivery", () => {
    const doc = new OtDocument("hello world", 5);
    doc.local("hello brave world"); // insert at 6, in flight
    // Their text is in, ours is still here, and neither overwrote the other.
    const { text, applied } = doc.remote([{ p: 0, i: ">> " }], 5);
    expect(text).toBe(">> hello brave world");
    expect(doc.text).toBe(">> hello brave world");
    expect(transformCaret(8, applied)).toBe(11);
    // Their operation applied at 5, so the document is now at 6 — the same
    // step `acknowledge` takes for our own work.
    expect(doc.version).toBe(6);
    // Socket.IO can deliver the same frame twice; applying it again would
    // duplicate their text.
    expect(doc.remote([{ p: 0, i: ">> " }], 5).applied).toEqual([]);
    expect([doc.text, doc.version]).toEqual([">> hello brave world", 6]);
  });

  it.each([
    ["from the future rather than applying it out of order", [{ p: 0, i: "x" }], 6],
    ["that does not fit rather than writing wrong text", [{ p: 0, d: "goodbye" }], 4],
  ] as [string, OtOp[], number][])("refuses an update %s", (_label, ops, version) => {
    expect(() => new OtDocument("hello", 4).remote(ops, version)).toThrow(OtDesyncError);
  });

  it("drops unsent work when reset to the server's copy", () => {
    const doc = new OtDocument("a", 1);
    doc.local("ab");
    doc.local("abc");
    doc.reset("server text", 9);
    expect([doc.text, doc.version, doc.settled]).toEqual(["server text", 9, true]);
  });
});

describe("two editors on one document", () => {
  it("converges when both type in the same place at once", () => {
    const { server, a, b } = twoEditors("the fox");
    // Both edit before either has heard from the server — the real race.
    const aSend = a.local("the quick fox").send!;
    const bSend = b.local("the brown fox").send!;
    roundTrip(server, a, [b], aSend);
    roundTrip(server, b, [a], bSend);

    expectConverged(server, a, b);
    // Nobody's words were dropped.
    for (const typed of ["quick", "brown"]) expect(server.text).toContain(typed);
  });

  it("keeps everything typed while waiting for an acknowledgement", () => {
    const { server, a, b } = twoEditors("start");
    const aSend = a.local("start A1").send!;
    // A keeps typing before the server answers.
    expect(a.local("start A1 A2").send).toBeNull();

    roundTrip(server, b, [a], b.local("B0 start").send!);
    const queued = roundTrip(server, a, [b], aSend)!;
    roundTrip(server, a, [b], queued);

    expectConverged(server, a, b);
    for (const typed of ["A1", "A2", "B0"]) expect(server.text).toContain(typed);
  });

  it("survives a long session with edits and updates interleaved", () => {
    const random = makeRandom(0x1234_5678);
    const { server, a, b } = twoEditors("line one\nline two\nline three\n");
    const peers = [a, b];
    // The server hands every accepted operation to everyone, in one order.
    // A peer seeing its own comes back treats it as the acknowledgement, which
    // is what keeps versions in step even when a peer is behind.
    const queues = new Map(peers.map((peer) => [peer, [] as (Send & { author: OtDocument })[]]));
    const submit = (author: OtDocument, send: Send) => {
      const accepted = server.submit(send);
      for (const peer of peers) queues.get(peer)!.push({ ...accepted, author });
    };
    const deliverOne = (peer: OtDocument) => {
      const next = queues.get(peer)!.shift();
      if (!next) return;
      if (next.author === peer) {
        const after = peer.acknowledge().send;
        if (after) submit(peer, after);
      } else {
        peer.remote(next.ops, next.version);
      }
    };

    for (let round = 0; round < 400; round += 1) {
      const peer = peers[Math.floor(random() * peers.length)]!;
      if (random() < 0.55) {
        const at = Math.floor(random() * (peer.text.length + 1));
        const { send } = peer.local(peer.text.slice(0, at) + "x" + peer.text.slice(at));
        if (send) submit(peer, send);
      } else {
        deliverOne(peer);
      }
    }

    // Drain: keep delivering until nothing is queued and nothing is in flight.
    for (let guard = 0; guard < 10_000; guard += 1) {
      const busy = peers.find((peer) => queues.get(peer)!.length > 0);
      if (!busy) break;
      deliverOne(busy);
    }

    for (const peer of peers) expect(peer.settled).toBe(true);
    expectConverged(server, ...peers);
  });
});

/**
 * Coming back to a file we were editing. The server replays what it did while
 * we were away rather than only saying where it ended up, and the difference
 * is whether work that never reached it survives the trip.
 */
describe("resuming a document from a known version", () => {
  it("keeps unsent work while replaying what was missed", () => {
    const doc = new OtDocument("hello", 4);
    const send = doc.local("hello there").send!;
    expect(send.version).toBe(4);
    // We leave before the answer arrives. Meanwhile a collaborator edits, and
    // our own operation lands too.
    const result = doc.catchUp([
      { version: 4, ops: send.ops, mine: true },
      { version: 5, ops: [{ p: 0, i: ">> " }], mine: false },
    ]);
    expect(result.text).toBe(">> hello there");
    expect(doc.version).toBe(6);
    expect(doc.settled).toBe(true);
  });

  it("carries work typed after the unanswered operation", () => {
    const doc = new OtDocument("a", 1);
    const first = doc.local("ab").send!;
    // Queued behind the one in flight.
    expect(doc.local("abc").send).toBeNull();

    // The acknowledgement released the queued work, which is now ready to go.
    const result = doc.catchUp([{ version: 1, ops: first.ops, mine: true }]);
    expect(result.send?.version).toBe(2);
    expect(doc.text).toBe("abc");
  });

  it("moves the caret past everything replayed", () => {
    const doc = new OtDocument("one\ntwo", 3);
    const result = doc.catchUp([
      { version: 3, ops: [{ p: 0, i: "zero\n" }], mine: false },
      { version: 4, ops: [{ p: 0, i: "!\n" }], mine: false },
    ]);
    // A caret on "two" started at 4 and is now past both insertions.
    expect(transformCaret(4, result.applied)).toBe(4 + "zero\n".length + "!\n".length);
    expect(doc.version).toBe(5);
  });

  it("transforms a collaborator's replayed work against our own unsent work", () => {
    const doc = new OtDocument("fox", 7);
    doc.local("quick fox"); // in flight, inserted at 0
    doc.catchUp([{ version: 7, ops: [{ p: 3, i: " runs" }], mine: false }]);
    // Their insertion was after "fox", which our text pushed along; both are
    // present and neither overwrote the other.
    expect(doc.text).toBe("quick fox runs");
  });
});
