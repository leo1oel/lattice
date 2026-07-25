import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createCollabChatMessage,
  createShareRoomCode,
  createShareToken,
  defaultCollabRoom,
  formatCollabInvite,
  MAX_COLLAB_CHAT_MESSAGES,
  maybeSeedCollabText,
  normalizeCollabHost,
  observeCollabChatMessages,
  parseCollabInvite,
  peerColorForName,
  readCollabChatMessages,
  sendCollabChatMessage,
} from "./collab-session";

describe("collab session helpers", () => {
  it("normalizes host urls to a host:port form", () => {
    expect(normalizeCollabHost("https://example.partykit.dev/")).toBe("example.partykit.dev");
    expect(normalizeCollabHost("ws://localhost:1999")).toBe("localhost:1999");
    expect(normalizeCollabHost("  localhost:1999  ")).toBe("localhost:1999");
  });

  it("builds a stable default room from project and file", () => {
    expect(defaultCollabRoom("paper-id", "sections/intro.tex")).toBe("paper-id/sections/intro.tex");
    expect(defaultCollabRoom("", "")).toBe("project/main.tex");
  });

  it("creates short share room codes", () => {
    const code = createShareRoomCode();
    expect(code).toMatch(/^LT-[A-Z0-9]{6}$/);
  });

  it("formats and parses lattice invites", () => {
    const invite = formatCollabInvite("https://demo.partykit.dev/", "LT-ABC123");
    expect(invite).toBe("lattice:demo.partykit.dev/LT-ABC123");
    expect(parseCollabInvite(`Join me\n${invite}\nthanks`)).toEqual({
      host: "demo.partykit.dev",
      room: "LT-ABC123",
      token: "",
    });
    expect(parseCollabInvite("LT-ZZ99KK")?.room).toBe("LT-ZZ99KK");
  });

  it("round-trips the room token through the invite", () => {
    const token = createShareToken();
    expect(token).toMatch(/^[A-Za-z0-9\-_]{24}$/);
    const invite = formatCollabInvite("demo.partykit.dev", "LT-ABC123", token);
    expect(invite).toBe(`lattice:demo.partykit.dev/LT-ABC123#${token}`);
    expect(parseCollabInvite(`Join me\n${invite}\nthanks`)).toEqual({
      host: "demo.partykit.dev",
      room: "LT-ABC123",
      token,
    });
  });

  it("seeds only empty shared text once", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("latex");
    expect(maybeSeedCollabText(ytext, "hello")).toBe(true);
    expect(ytext.toString()).toBe("hello");
    expect(maybeSeedCollabText(ytext, "other")).toBe(false);
    expect(ytext.toString()).toBe("hello");
    expect(maybeSeedCollabText(ytext, "")).toBe(false);
  });

  it("assigns a stable peer color from the display name", () => {
    expect(peerColorForName("Ada")).toEqual(peerColorForName("Ada"));
    expect(peerColorForName("Ada").color).toMatch(/^#/);
  });

  it("builds UndoManager on a doc-bound pending text, not a detached Y.Text", () => {
    const doc = new Y.Doc();
    const pending = doc.getText("__lattice_pending__");
    expect(() => new Y.UndoManager(pending)).not.toThrow();
    expect(() => new Y.UndoManager(new Y.Text())).toThrow(/null|undefined|doc/i);
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
