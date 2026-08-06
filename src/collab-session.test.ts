import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createCollabChatMessage,
  MAX_COLLAB_CHAT_MESSAGES,
  mergeTextIntoYText,
  normalizeCollabHost,
  observeCollabChatMessages,
  peerCaretOffsetsV2,
  peerColorForName,
  peerCursorLocationV2,
  publishCollabCursorV2,
  readCollabChatMessages,
  sendCollabChatMessage,
  type EditorCollabSession,
  waitForPeerCursorLocationV2,
} from "./collab-session";
import { Awareness } from "y-protocols/awareness";

describe("mergeTextIntoYText", () => {
  it("is a no-op for identical content", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "same");
    const before = Y.encodeStateAsUpdate(doc);
    mergeTextIntoYText(ytext, "same");
    expect(ytext.toString()).toBe("same");
    // No transaction, so no new update beyond the initial insert.
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("edits only the changed span, preserving untouched regions", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "alpha beta gamma");
    mergeTextIntoYText(ytext, "alpha DELTA gamma");
    expect(ytext.toString()).toBe("alpha DELTA gamma");
  });

  it("treats a pure append as an insert with no deletion", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "start");
    mergeTextIntoYText(ytext, "start and more");
    expect(ytext.toString()).toBe("start and more");
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

describe("collab session helpers", () => {
  it("normalizes host urls to a host:port form", () => {
    expect(normalizeCollabHost("https://example.partykit.dev/")).toBe("example.partykit.dev");
    expect(normalizeCollabHost("ws://localhost:1999")).toBe("localhost:1999");
    expect(normalizeCollabHost("  localhost:1999  ")).toBe("localhost:1999");
  });

  it("assigns a stable peer color from the display name", () => {
    expect(peerColorForName("Ada")).toEqual(peerColorForName("Ada"));
    expect(peerColorForName("Ada").color).toMatch(/^#/);
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

describe("v2 peer caret helpers", () => {
  it("waits for a cross-file peer's real awareness id and resolves its line", async () => {
    vi.useFakeTimers();
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", null);
    const pending = waitForPeerCursorLocationV2(session, "peer-instance");
    const head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, 9));

    awareness.states.set(777, { instanceId: "peer-instance", cursor: { head }, user: { name: "Bo" } });
    awareness.emit("change", [{ added: [777], updated: [], removed: [] }, "remote"]);

    await expect(pending).resolves.toEqual({ path: "paper.md", line: 3 });
    vi.useRealTimers();
  });

  it("stops waiting when a peer has no cursor in the opened file", async () => {
    vi.useFakeTimers();
    const { session, awareness } = v2SessionWithCaret("one\ntwo", null);
    const off = vi.spyOn(awareness, "off");
    const pending = waitForPeerCursorLocationV2(session, "missing", 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeNull();
    expect(off).toHaveBeenCalledWith("change", expect.any(Function));
    vi.useRealTimers();
  });

  it("publishes a visual editor caret in the format remote peers resolve", () => {
    const { session, awareness } = v2SessionWithCaret("one\ntwo\nthree", null);
    awareness.setLocalState({ user: { name: "Ada", color: "#1971c2" }, path: "paper.md" });

    publishCollabCursorV2(session, 9);

    const cursor = awareness.getLocalState()?.cursor as { head?: unknown } | undefined;
    expect(cursor?.head).toBeTruthy();
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(cursor!.head),
      session.doc,
    );
    expect(absolute).toMatchObject({ type: session.ytext, index: 9 });
    expect(awareness.getLocalState()).toMatchObject({
      user: { name: "Ada" },
      path: "paper.md",
    });
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
    const cursor = awareness.getLocalState()?.cursor as { head: unknown };
    expect(Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(cursor.head),
      session.doc,
    )?.index).toBe(9);

    publishCollabCursorV2(session, 9);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("discards a pending caret frame when the session switches files", async () => {
    vi.useFakeTimers();
    const { session, awareness: awarenessA } = v2SessionWithCaret("file a", null);
    awarenessA.setLocalState({ path: "a.md" });
    publishCollabCursorV2(session, 1);
    publishCollabCursorV2(session, 5);

    const docB = new Y.Doc();
    const textB = docB.getText("content");
    textB.insert(0, "file b content");
    const awarenessB = new Awareness(docB);
    awarenessB.setLocalState({ path: "b.md" });
    const mutable = session as unknown as {
      doc: Y.Doc;
      ytext: Y.Text;
      activePath: string;
      provider: { awareness: Awareness };
    };
    mutable.doc = docB;
    mutable.ytext = textB;
    mutable.activePath = "b.md";
    mutable.provider = { awareness: awarenessB };
    publishCollabCursorV2(session, 3);

    await vi.advanceTimersByTimeAsync(20);
    const cursor = awarenessB.getLocalState()?.cursor as { head: unknown };
    expect(Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(cursor.head),
      docB,
    )?.index).toBe(3);
    vi.useRealTimers();
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


describe("collab chat", () => {
  it("merges messages sent from two independent peers with no data loss", () => {
    // Two Y.Docs standing in for host and guest, each writing offline, then
    // syncing the way y-partyserver would: apply each side's update to the
    // other. A Y.Array merge must keep both authors' messages rather than one
    // side's write clobbering the other's, which is exactly what a JSON blob
    // in a single Y.Text (the editor-comments approach) cannot guarantee.
    const hostDoc = new Y.Doc();
    const guestDoc = new Y.Doc();
    sendCollabChatMessage(hostDoc, createCollabChatMessage("host-1", "Ada", "pushed the intro"));
    sendCollabChatMessage(guestDoc, createCollabChatMessage("guest-1", "Bo", "looking now"));

    Y.applyUpdate(guestDoc, Y.encodeStateAsUpdate(hostDoc));
    Y.applyUpdate(hostDoc, Y.encodeStateAsUpdate(guestDoc));

    const onHost = readCollabChatMessages(hostDoc).map((m) => m.body).sort();
    const onGuest = readCollabChatMessages(guestDoc).map((m) => m.body).sort();
    expect(onHost).toEqual(["looking now", "pushed the intro"]);
    expect(onGuest).toEqual(["looking now", "pushed the intro"]);
  });

  it("a guest who joins late receives the whole backlog, unsorted-insert order included", () => {
    // Simulates the "arrived late" case: the room already has a history by
    // the time a second doc first syncs, with no separate history fetch — the
    // backlog is just whatever state the CRDT hands over.
    const hostDoc = new Y.Doc();
    sendCollabChatMessage(hostDoc, createCollabChatMessage("host-1", "Ada", "first"));
    sendCollabChatMessage(hostDoc, createCollabChatMessage("host-1", "Ada", "second"));

    const lateGuestDoc = new Y.Doc();
    Y.applyUpdate(lateGuestDoc, Y.encodeStateAsUpdate(hostDoc));

    expect(readCollabChatMessages(lateGuestDoc).map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("caps history to the newest N so a long session does not grow without bound", () => {
    const doc = new Y.Doc();
    const total = MAX_COLLAB_CHAT_MESSAGES + 5;
    for (let i = 0; i < total; i += 1) {
      sendCollabChatMessage(doc, createCollabChatMessage("host-1", "Ada", `message ${i}`));
    }
    const messages = readCollabChatMessages(doc);
    expect(messages).toHaveLength(MAX_COLLAB_CHAT_MESSAGES);
    // The oldest 5 were trimmed; the newest one is always kept.
    expect(messages[0].body).toBe("message 5");
    expect(messages[messages.length - 1].body).toBe(`message ${total - 1}`);
  });

  it("drops malformed entries instead of throwing, the way readCollabPeers treats untrusted state", () => {
    const doc = new Y.Doc();
    sendCollabChatMessage(doc, createCollabChatMessage("host-1", "Ada", "a real message"));
    // Someone on an older/newer build (or a mid-write race) leaves a
    // structurally incomplete entry directly on the array.
    doc.getArray("chat").push([{ id: "broken" }, "not even an object", null]);
    expect(() => readCollabChatMessages(doc)).not.toThrow();
    const messages = readCollabChatMessages(doc);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("a real message");
  });

  it("notifies observers on send and stops after unsubscribing", () => {
    const doc = new Y.Doc();
    let fired = 0;
    const stop = observeCollabChatMessages(doc, () => { fired += 1; });
    sendCollabChatMessage(doc, createCollabChatMessage("host-1", "Ada", "hi"));
    expect(fired).toBe(1);
    stop();
    sendCollabChatMessage(doc, createCollabChatMessage("host-1", "Ada", "hi again"));
    expect(fired).toBe(1);
  });

  it("falls back to Anonymous for a blank display name", () => {
    expect(createCollabChatMessage("host-1", "   ", "hi").authorName).toBe("Anonymous");
  });
});
