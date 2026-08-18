import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { useCollabChat } from "./use-collab-chat";
import { createCollabChatMessage, sendCollabChatMessage } from "./collab-session";

describe("useCollabChat", () => {
  it("does not count the backlog a late-joining guest already finds on the doc as unread", () => {
    const doc = new Y.Doc();
    sendCollabChatMessage(doc, createCollabChatMessage("host-1", "Ada", "already said this"));

    const { result } = renderHook(() => useCollabChat({ doc, selfId: "guest-1", displayName: "Bo" }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.unread).toBe(0);
  });

  it("counts a message from someone else that arrives after mount, but not our own echo", () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useCollabChat({ doc, selfId: "host-1", displayName: "Ada" }));

    act(() => {
      sendCollabChatMessage(doc, createCollabChatMessage("guest-1", "Bo", "checking now"));
    });
    expect(result.current.unread).toBe(1);

    act(() => {
      result.current.send("on it");
    });
    // Our own message shows up in the list but never raises our own badge.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.unread).toBe(1);

    act(() => result.current.markRead());
    expect(result.current.unread).toBe(0);
  });

  it("resets when the doc is swapped out (leaving and rejoining a room)", async () => {
    const docA = new Y.Doc();
    sendCollabChatMessage(docA, createCollabChatMessage("guest-1", "Bo", "in room A"));
    const { result, rerender } = renderHook(
      ({ doc }) => useCollabChat({ doc, selfId: "host-1", displayName: "Ada" }),
      { initialProps: { doc: docA as Y.Doc | null } },
    );
    act(() => {
      sendCollabChatMessage(docA, createCollabChatMessage("guest-1", "Bo", "new message"));
    });
    expect(result.current.unread).toBe(1);

    rerender({ doc: null });
    // Leaving clears on the next microtask rather than during the effect, so
    // the render it causes is not cascaded off the one that unmounted it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.unread).toBe(0);
  });
});
