import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  mergeTextIntoYText,
  peerCaretOffsetsV2,
  peerCursorLocationV2,
  peerInitials,
  publishCollabCursorV2,
  readCollabPeers,
  type EditorCollabSession,
  waitForPeerCursorLocationV2,
} from "./collab-session";
import { Awareness } from "y-protocols/awareness";

describe("mergeTextIntoYText", () => {
  it.each([
    ["is a no-op for identical content", "same", "same"],
    ["edits only the changed span, preserving untouched regions", "alpha beta gamma", "alpha DELTA gamma"],
    ["treats a pure append as an insert with no deletion", "start", "start and more"],
  ])("%s", (_name, before, after) => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, before);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    mergeTextIntoYText(ytext, after);
    expect(ytext.toString()).toBe(after);
    // Identical content opens no transaction, so nothing goes on the wire.
    expect(updates).toHaveLength(before === after ? 0 : 1);
  });

  it("marks the transaction local so disk observers skip it", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "before");
    const origins: unknown[] = [];
    ytext.observe((_event, transaction) => { if (transaction.local) origins.push(transaction.origin); });
    mergeTextIntoYText(ytext, "after");
    expect(origins).toEqual(["lattice-local"]);
  });

  it("two clients appending concurrently converge with both chunks intact (JSON stays parseable)", () => {
    // Stand in for two peers each appending a comment to the shared JSON file:
    // both compute a minimal-span insert against the same base, then sync.
    const base = '{\n  "comments": [\n    { "id": "first" }\n  ]\n}\n';
    const host = new Y.Doc();
    host.getText("content").insert(0, base);
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    mergeTextIntoYText(host.getText("content"), base.replace("    { \"id\": \"first\" }\n", '    { "id": "first" },\n    { "id": "host-added" }\n'));
    mergeTextIntoYText(guest.getText("content"), base.replace("    { \"id\": \"first\" }\n", '    { "id": "first" },\n    { "id": "guest-added" }\n'));

    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));

    const onHost = host.getText("content").toString();
    expect(onHost).toBe(guest.getText("content").toString());
    expect(onHost).toContain('"id": "host-added"');
    expect(onHost).toContain('"id": "guest-added"');
    expect(() => JSON.parse(onHost)).not.toThrow();
  });

  it("a peer's edit outside the published span survives the merge", () => {
    const host = new Y.Doc();
    host.getText("content").insert(0, "line one\nline two\nline three\n");
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(host));

    // Peer edits line one; meanwhile the local publish rewrites line three.
    guest.getText("content").insert(0, "peer was here\n");
    mergeTextIntoYText(host.getText("content"), "line one\nline two\nlocal rewrite\n");

    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest));
    const merged = host.getText("content").toString();
    expect(merged).toContain("peer was here");
    expect(merged).toContain("local rewrite");
  });
});

describe("readCollabPeers", () => {
  it("lists everyone but us, in a stable order", () => {
    const states = new Map<number, unknown>([
      [7, { user: { name: "Zoe", color: "#f00" }, path: "main.tex" }],
      [1, { user: { name: "Alex", color: "#0f0" }, path: "intro.tex" }],
      [3, { user: { name: "Me", color: "#00f" }, path: "main.tex" }],
    ]);
    const peers = readCollabPeers(states, 3);
    expect(peers.map((peer) => peer.name)).toEqual(["Alex", "Zoe"]);
    expect(peers[0]).toEqual({ clientId: 1, name: "Alex", color: "#0f0", path: "intro.tex" });
  });

  it("survives a peer on an older build that announces nothing useful", () => {
    // Awareness records come from other clients, so nothing here is guaranteed.
    const states = new Map<number, unknown>([
      [3, { user: { name: "   " }, instanceId: "i3" }],
      [4, { user: { name: "Ada" }, path: 42 }],
    ]);
    const peers = readCollabPeers(states, 99);
    expect(peers).toHaveLength(2);
    expect(peers.map((peer) => peer.name)).toEqual(["Anonymous", "Ada"]);
    expect(peers.every((peer) => typeof peer.color === "string" && peer.color)).toBe(true);
    expect(peers[1].path).toBeNull();
  });

  it("ignores connections that never announced anyone", () => {
    // Awareness publishes `{}` for a client the moment it is constructed, and a
    // document opened only to mirror it to disk never announces over that. Each
    // such state used to render as its own "Anonymous" collaborator.
    const states = new Map<number, unknown>([
      [1, null],
      [2, {}],
      [5, { path: "main.tex" }],
      [6, { user: {} }],
      [7, { user: { name: "Ada" }, instanceId: "i7" }],
    ]);
    expect(readCollabPeers(states, 99).map((peer) => peer.name)).toEqual(["Ada"]);
  });
});

describe("peerInitials", () => {
  it.each([
    ["uses first and last initials for a full name", "Ada Lovelace", "AL"],
    ["uses first and last initials, skipping middle names", "Jean Luc Picard", "JP"],
    ["takes two letters from a single word", "robin", "RO"],
    ["never renders empty", "   ", "?"],
  ])("%s", (_name, name, initials) => {
    expect(peerInitials(name)).toBe(initials);
  });
});

function v2SessionWithCaret(text: string, caretIndex: number | null) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  const awareness = new Awareness(doc);
  if (caretIndex !== null) {
    const head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, caretIndex));
    awareness.states.set(999, {
      cursor: { head },
      user: { name: "Bo", color: "#1971c2" },
    });
  }
  const session = { doc, ytext, activePath: "paper.md", provider: { awareness } } as unknown as EditorCollabSession;
  return { session, awareness };
}

/** Where the caret `awareness` publishes for this client lands in `doc`'s text. */
function localCaretIndex(awareness: Awareness, doc: Y.Doc) {
  const cursor = awareness.getLocalState()?.cursor as { head?: unknown } | undefined;
  expect(cursor?.head).toBeTruthy();
  return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor!.head), doc);
}

describe("v2 peer caret helpers", () => {
  it("waits for a cross-file peer's real awareness id and resolves its line", async () => {
    vi.useFakeTimers();
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", null);
    const pending = waitForPeerCursorLocationV2(session, "peer-instance");
    const head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, 9));

    awareness.states.set(777, { instanceId: "peer-instance", cursor: { head }, user: { name: "Bo" } });
    awareness.emit("change", [{ added: [777], updated: [], removed: [] }, "remote"]);

    await expect(pending).resolves.toEqual({ path: "paper.md", line: 3 });
  });

  it("stops waiting when a peer has no cursor in the opened file", async () => {
    vi.useFakeTimers();
    const { session, awareness } = v2SessionWithCaret("one\ntwo", null);
    const off = vi.spyOn(awareness, "off");
    const pending = waitForPeerCursorLocationV2(session, "missing", 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeNull();
    expect(off).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("publishes a visual editor caret in the format remote peers resolve", () => {
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", null);
    awareness.setLocalState({ user: { name: "Ada", color: "#1971c2" }, path: "paper.md" });

    publishCollabCursorV2(session, 9);

    expect(localCaretIndex(awareness, session.doc)).toMatchObject({ type: session.ytext, index: 9 });
    expect(awareness.getLocalState()).toMatchObject({ user: { name: "Ada" }, path: "paper.md" });
  });

  it("coalesces rapid visual caret moves to the latest position per frame", async () => {
    vi.useFakeTimers();
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", null);
    awareness.setLocalState({ user: { name: "Ada" }, path: "paper.md" });
    const publish = vi.spyOn(awareness, "setLocalStateField");

    publishCollabCursorV2(session, 1);
    publishCollabCursorV2(session, 2);
    publishCollabCursorV2(session, 4);
    publishCollabCursorV2(session, 9);
    expect(publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(localCaretIndex(awareness, session.doc)?.index).toBe(9);

    publishCollabCursorV2(session, 9);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("discards a pending caret frame when the session switches files", async () => {
    vi.useFakeTimers();
    const { session, awareness: awarenessA } = v2SessionWithCaret("file a", null);
    awarenessA.setLocalState({ path: "a.md" });
    publishCollabCursorV2(session, 1);
    publishCollabCursorV2(session, 5);

    // The session object is live: the controller swaps its doc/text/provider in place.
    const { session: sessionB, awareness: awarenessB } = v2SessionWithCaret("file b content", null);
    awarenessB.setLocalState({ path: "b.md" });
    Object.assign(session, { ...sessionB, activePath: "b.md" });
    publishCollabCursorV2(session, 3);

    await vi.advanceTimersByTimeAsync(20);
    expect(localCaretIndex(awarenessB, sessionB.doc)?.index).toBe(3);
  });

  it("resolves a remote caret to an offset with identity, skipping self", () => {
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", 5);
    awareness.setLocalState({ cursor: { head: null } });
    const carets = peerCaretOffsetsV2(session);
    expect(carets).toHaveLength(1);
    expect(carets[0]).toMatchObject({ clientId: 999, name: "Bo", color: "#1971c2", index: 5 });
  });

  it("maps a peer caret to path and 1-based line for avatar follow", () => {
    const { session } = v2SessionWithCaret("one\ntwo\nthree", 5);
    expect(peerCursorLocationV2(session, 999)).toEqual({ path: "paper.md", line: 2 });
    expect(peerCursorLocationV2(session, 123)).toBeNull();
  });

  it("skips peers without a cursor or with a caret on a different text", () => {
    const { session, awareness } = v2SessionWithCaret("hello", 2);
    awareness.states.set(1000, { user: { name: "NoCaret" } });
    const otherDoc = new Y.Doc();
    const otherText = otherDoc.getText("content");
    otherText.insert(0, "elsewhere");
    awareness.states.set(1001, {
      cursor: { head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(otherText, 1)) },
      user: { name: "WrongDoc" },
    });
    const carets = peerCaretOffsetsV2(session);
    expect(carets.map((caret) => caret.name)).toEqual(["Bo"]);
    expect(peerCursorLocationV2(session, 1000)).toBeNull();
    expect(peerCursorLocationV2(session, 1001)).toBeNull();
  });
});

