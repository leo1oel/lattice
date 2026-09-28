import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createCollabChatMessage,
  MAX_COLLAB_CHAT_MESSAGES,
  observeCollabChatMessages,
  readCollabChatMessages,
  sendCollabChatMessage,
  useCollabChat,
} from "./use-collab-chat";

const say = (doc: Y.Doc, authorId: string, body: string) =>
  sendCollabChatMessage(doc, createCollabChatMessage(authorId, authorId === "host-1" ? "Ada" : "Bo", body));
const bodies = (doc: Y.Doc) => readCollabChatMessages(doc).map((message) => message.body);

describe("collab chat document", () => {
  it("merges messages sent from two independent peers with no data loss", () => {
    // Two docs each writing offline, then syncing the way the provider would.
    // A Y.Array merge keeps both authors' messages, which a JSON blob in one
    // Y.Text (a whole-document rewrite) cannot guarantee.
    const [hostDoc, guestDoc] = [new Y.Doc(), new Y.Doc()];
    say(hostDoc, "host-1", "pushed the intro");
    say(guestDoc, "guest-1", "looking now");
    Y.applyUpdate(guestDoc, Y.encodeStateAsUpdate(hostDoc));
    Y.applyUpdate(hostDoc, Y.encodeStateAsUpdate(guestDoc));
    expect(bodies(hostDoc).sort()).toEqual(["looking now", "pushed the intro"]);
    expect(bodies(guestDoc).sort()).toEqual(["looking now", "pushed the intro"]);
  });

  it("hands a guest who joins late the whole backlog with the ordinary doc sync", () => {
    const hostDoc = new Y.Doc();
    say(hostDoc, "host-1", "first");
    say(hostDoc, "host-1", "second");
    const lateGuestDoc = new Y.Doc();
    Y.applyUpdate(lateGuestDoc, Y.encodeStateAsUpdate(hostDoc));
    expect(bodies(lateGuestDoc)).toEqual(["first", "second"]);
  });

  it("caps history to the newest N so a long session does not grow without bound", () => {
    const doc = new Y.Doc();
    const total = MAX_COLLAB_CHAT_MESSAGES + 5;
    for (let i = 0; i < total; i += 1) say(doc, "host-1", `message ${i}`);
    const messages = bodies(doc);
    expect(messages).toHaveLength(MAX_COLLAB_CHAT_MESSAGES);
    expect(messages[0]).toBe("message 5");
    expect(messages.at(-1)).toBe(`message ${total - 1}`);
  });

  it("drops malformed peer-written entries instead of throwing", () => {
    const doc = new Y.Doc();
    say(doc, "host-1", "a real message");
    doc.getArray("chat").push([{ id: "broken" }, "not even an object", null]);
    expect(bodies(doc)).toEqual(["a real message"]);
  });

  it("notifies observers on send and stops after unsubscribing", () => {
    const doc = new Y.Doc();
    let fired = 0;
    const stop = observeCollabChatMessages(doc, () => { fired += 1; });
    say(doc, "host-1", "hi");
    stop();
    say(doc, "host-1", "hi again");
    expect(fired).toBe(1);
  });

  it("falls back to Anonymous for a blank display name", () => {
    expect(createCollabChatMessage("host-1", "   ", "hi").authorName).toBe("Anonymous");
  });
});

describe("useCollabChat", () => {
  it("does not count the backlog a late-joining guest already finds on the doc as unread", () => {
    const doc = new Y.Doc();
    say(doc, "host-1", "already said this");

    const { result } = renderHook(() => useCollabChat({ doc, selfId: "guest-1", displayName: "Bo" }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.unread).toBe(0);
  });

  it("counts a message from someone else that arrives after mount, but not our own echo", () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useCollabChat({ doc, selfId: "host-1", displayName: "Ada" }));

    act(() => { say(doc, "guest-1", "checking now"); });
    expect(result.current.unread).toBe(1);

    act(() => { result.current.send("on it"); });
    // Our own message shows up in the list but never raises our own badge.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.unread).toBe(1);

    act(() => result.current.markRead());
    expect(result.current.unread).toBe(0);
  });

  it("resets when the doc is swapped out (leaving and rejoining a room)", async () => {
    const docA = new Y.Doc();
    say(docA, "guest-1", "in room A");
    const { result, rerender } = renderHook(
      ({ doc }) => useCollabChat({ doc, selfId: "host-1", displayName: "Ada" }),
      { initialProps: { doc: docA as Y.Doc | null } },
    );
    act(() => { say(docA, "guest-1", "new message"); });
    expect(result.current.unread).toBe(1);

    rerender({ doc: null });
    // Leaving clears on the next microtask rather than during the effect, so
    // the render it causes is not cascaded off the one that unmounted it.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.unread).toBe(0);
  });
});
