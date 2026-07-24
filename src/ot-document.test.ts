import { describe, expect, it } from "vitest";
import { applyOps, type OtOp } from "./ot-ops";
import { transformOps } from "./ot-transform";
import { OtDesyncError, OtDocument } from "./ot-document";

/**
 * A stand-in for Overleaf's server: it holds the authoritative document,
 * applies operations in the order they arrive, and transforms each one against
 * whatever it has accepted since the version the client built it on — which is
 * exactly what the real server does.
 */
class FakeServer {
  text: string;
  version = 0;
  /** Every accepted op, so a late client's work can be caught up. */
  private history: OtOp[][] = [];

  constructor(text: string) {
    this.text = text;
  }

  submit(ops: OtOp[], version: number): { ops: OtOp[]; version: number } {
    let incoming = ops;
    // Transform against everything accepted since the client's version. The
    // client is "right" here because the server's own history takes priority.
    for (let index = version; index < this.history.length; index += 1) {
      incoming = transformOps(incoming, this.history[index], "right");
    }
    const next = applyOps(this.text, incoming);
    if (next === null) throw new Error("server rejected op");
    this.text = next;
    this.history.push(incoming);
    this.version = this.history.length;
    return { ops: incoming, version: this.version };
  }
}

/** One connected editor, driving an OtDocument against the fake server. */
class Peer {
  doc: OtDocument;
  constructor(readonly server: FakeServer, readonly name: string) {
    this.doc = new OtDocument(server.text, server.version);
  }

  /** Type: replace the local text and send if nothing is in flight. */
  type(text: string, deliver: (peer: Peer, ops: OtOp[], version: number) => void) {
    const { send } = this.doc.local(text);
    if (send) this.flush(send, deliver);
  }

  private flush(
    send: { version: number; ops: OtOp[] },
    deliver: (peer: Peer, ops: OtOp[], version: number) => void,
  ) {
    const accepted = this.server.submit(send.ops, send.version);
    // The server broadcasts to everyone else, then acknowledges us.
    deliver(this, accepted.ops, accepted.version);
    const next = this.doc.acknowledge();
    if (next.send) this.flush(next.send, deliver);
  }
}

describe("OtDocument", () => {
  it("sends the first edit immediately", () => {
    const doc = new OtDocument("hello", 3);
    const result = doc.local("hello world");
    expect(result.send).toEqual({ version: 3, ops: [{ p: 5, i: " world" }] });
    expect(doc.waiting).toBe(true);
  });

  it("holds later edits until the first is acknowledged, then sends one op", () => {
    const doc = new OtDocument("a", 1);
    doc.local("ab");
    // Two more keystrokes while waiting: they must not go out separately.
    expect(doc.local("abc").send).toBeNull();
    expect(doc.local("abcd").send).toBeNull();

    const next = doc.acknowledge();
    expect(next.send).toEqual({ version: 2, ops: [{ p: 2, i: "cd" }] });
    expect(doc.acknowledge().send).toBeNull();
    expect(doc.settled).toBe(true);
    expect(doc.version).toBe(3);
  });

  it("keeps local work when a remote edit lands first", () => {
    const doc = new OtDocument("hello world", 5);
    doc.local("hello brave world");            // insert at 6, in flight
    const result = doc.remote([{ p: 0, i: ">> " }], 6);
    // Their text is in, ours is still here, and neither overwrote the other.
    expect(result.text).toBe(">> hello brave world");
    expect(doc.text).toBe(">> hello brave world");
    expect(doc.version).toBe(6);
  });

  it("moves the caret with the text when someone edits above it", () => {
    const doc = new OtDocument("one\ntwo\nthree", 1);
    const { applied } = doc.remote([{ p: 0, i: "zero\n" }], 2);
    expect(OtDocument.caretAfter(8, applied)).toBe(13);
  });

  it("refuses an update that does not fit rather than writing wrong text", () => {
    const doc = new OtDocument("hello", 1);
    expect(() => doc.remote([{ p: 0, d: "goodbye" }], 2)).toThrow(OtDesyncError);
  });

  it("drops unsent work when reset to the server's copy", () => {
    const doc = new OtDocument("a", 1);
    doc.local("ab");
    doc.local("abc");
    doc.reset("server text", 9);
    expect(doc.text).toBe("server text");
    expect(doc.version).toBe(9);
    expect(doc.settled).toBe(true);
  });
});

describe("two editors on one document", () => {
  /** Deliver an accepted op to every peer except its author. */
  function broadcast(peers: Peer[]) {
    return (author: Peer, ops: OtOp[], version: number) => {
      for (const peer of peers) {
        if (peer !== author) peer.doc.remote(ops, version);
      }
    };
  }

  it("converges when both type in different places", () => {
    const server = new FakeServer("alpha beta gamma");
    const a = new Peer(server, "a");
    const b = new Peer(server, "b");
    const deliver = broadcast([a, b]);

    a.type("ALPHA beta gamma", deliver);
    b.type("ALPHA beta GAMMA", deliver);

    expect(a.doc.text).toBe(server.text);
    expect(b.doc.text).toBe(server.text);
  });

  it("converges when both type in the same place at once", () => {
    const server = new FakeServer("the fox");
    const a = new Peer(server, "a");
    const b = new Peer(server, "b");

    // Both edit before either has heard from the server — the real race.
    const aSend = a.doc.local("the quick fox").send!;
    const bSend = b.doc.local("the brown fox").send!;

    const aAccepted = server.submit(aSend.ops, aSend.version);
    b.doc.remote(aAccepted.ops, aAccepted.version);
    a.doc.acknowledge();

    const bAccepted = server.submit(bSend.ops, bSend.version);
    a.doc.remote(bAccepted.ops, bAccepted.version);
    b.doc.acknowledge();

    expect(a.doc.text).toBe(server.text);
    expect(b.doc.text).toBe(server.text);
    // Nobody's words were dropped.
    expect(server.text).toContain("quick");
    expect(server.text).toContain("brown");
  });

  it("keeps everything typed while waiting for an acknowledgement", () => {
    const server = new FakeServer("start");
    const a = new Peer(server, "a");
    const b = new Peer(server, "b");

    const aSend = a.doc.local("start A1").send!;
    // A keeps typing before the server answers.
    expect(a.doc.local("start A1 A2").send).toBeNull();

    const bSend = b.doc.local("B0 start").send!;
    const bAccepted = server.submit(bSend.ops, bSend.version);
    a.doc.remote(bAccepted.ops, bAccepted.version);
    b.doc.acknowledge();

    const aAccepted = server.submit(aSend.ops, aSend.version);
    b.doc.remote(aAccepted.ops, aAccepted.version);
    const queued = a.doc.acknowledge().send!;
    const queuedAccepted = server.submit(queued.ops, queued.version);
    b.doc.remote(queuedAccepted.ops, queuedAccepted.version);
    a.doc.acknowledge();

    expect(a.doc.text).toBe(server.text);
    expect(b.doc.text).toBe(server.text);
    expect(server.text).toContain("A1");
    expect(server.text).toContain("A2");
    expect(server.text).toContain("B0");
  });

  it("survives a long session with edits and updates interleaved", () => {
    // Deterministic PRNG so a failure is reproducible.
    let state = 0x1234_5678;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };

    const server = new FakeServer("line one\nline two\nline three\n");
    const a = new Peer(server, "a");
    const b = new Peer(server, "b");
    const peers = [a, b];
    // The server hands every accepted operation to everyone, in one order.
    // A peer seeing its own comes back treats it as the acknowledgement, which
    // is what keeps versions in step even when a peer is behind.
    type Delivery = { ops: OtOp[]; version: number; author: Peer };
    const queues = new Map<Peer, Delivery[]>([[a, []], [b, []]]);

    const submit = (author: Peer, send: { ops: OtOp[]; version: number }) => {
      const accepted = server.submit(send.ops, send.version);
      for (const peer of peers) {
        queues.get(peer)!.push({ ...accepted, author });
      }
    };

    const deliverOne = (peer: Peer) => {
      const next = queues.get(peer)!.shift();
      if (!next) return;
      if (next.author === peer) {
        const after = peer.doc.acknowledge();
        if (after.send) submit(peer, after.send);
      } else {
        peer.doc.remote(next.ops, next.version);
      }
    };

    for (let round = 0; round < 400; round += 1) {
      const peer = peers[Math.floor(random() * peers.length)];
      if (random() < 0.55) {
        const at = Math.floor(random() * (peer.doc.text.length + 1));
        const next = peer.doc.text.slice(0, at) + "x" + peer.doc.text.slice(at);
        const { send } = peer.doc.local(next);
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

    expect(a.doc.settled).toBe(true);
    expect(b.doc.settled).toBe(true);
    expect(a.doc.text).toBe(server.text);
    expect(b.doc.text).toBe(server.text);
  });
});
