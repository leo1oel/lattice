import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useOverleafChat } from "./use-overleaf-chat";
import { useOverleafPresence, type PresenceUser } from "./use-overleaf-presence";

/**
 * A stand-in for Tauri's event routing with more than one window, faithful to
 * tauri 2.11 (`manager/mod.rs::emit_to` + `event/listener.rs::match_any_or_filter`):
 * an event sent with `emit_to(label, …)` reaches every listener whose target
 * names that label AND every listener registered for `Any`, whichever window
 * registered it. `listen()` from `@tauri-apps/api/event` registers `Any` unless
 * given a target; a string target becomes `AnyLabel`.
 */
const bus = vi.hoisted(() => {
  type Target = { kind: "Any" } | { kind: "AnyLabel"; label: string };
  type Listener = {
    window: string;
    event: string;
    target: Target;
    handler: (event: { payload: unknown }) => void;
  };
  const listeners: Listener[] = [];
  const delivered: { from: string; to: string }[] = [];
  return {
    currentWindow: "main",
    listeners,
    delivered,
    emitTo(label: string, event: string, payload: unknown) {
      for (const listener of [...listeners]) {
        if (listener.event !== event) continue;
        const matches = listener.target.kind === "Any" || listener.target.label === label;
        if (!matches) continue;
        delivered.push({ from: label, to: listener.window });
        listener.handler({ payload });
      }
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: bus.currentWindow }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (
    event: string,
    handler: (event: { payload: unknown }) => void,
    options?: { target?: string | { kind: "Any" } | { kind: "AnyLabel"; label: string } },
  ) => {
    const target = typeof options?.target === "string"
      ? { kind: "AnyLabel" as const, label: options.target }
      : options?.target ?? { kind: "Any" as const };
    const listener = { window: bus.currentWindow, event, target, handler };
    bus.listeners.push(listener);
    return () => {
      const index = bus.listeners.indexOf(listener);
      if (index >= 0) bus.listeners.splice(index, 1);
    };
  }),
}));

const ROOT_A = "/Users/me/paper-a";
const ROOT_B = "/Users/me/paper-b";

/** Render a hook as if it lived in the named window. */
function inWindow<T>(label: string, hook: () => T) {
  bus.currentWindow = label;
  return renderHook(hook);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function viewer(): PresenceUser {
  return {
    id: "conn-ada",
    userId: "user-ada",
    name: "Ada Lovelace",
    email: "ada@example.edu",
    docId: "doc-a-main",
    row: 3,
    column: 1,
    hue: 200,
  };
}

describe("Overleaf live events across two windows", () => {
  beforeEach(() => {
    bus.listeners.length = 0;
    bus.delivered.length = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return { email: "me@example.edu" };
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("shows someone viewing project A only in the window linked to project A", async () => {
    const presence = { projectRoot: null, docId: null, selfId: null, readCaret: () => ({ row: 0, column: 0 }) };
    const windowA = inWindow("project-a", () => useOverleafPresence({ ...presence, projectRoot: ROOT_A }));
    const windowB = inWindow("project-b", () => useOverleafPresence({ ...presence, projectRoot: ROOT_B }));
    await settle();

    // The backend forwards project A's connection to the window that opened it.
    await act(async () => {
      bus.emitTo("project-a", "overleaf-realtime", {
        projectRoot: ROOT_A,
        type: "presenceUpdated",
        user: viewer(),
      });
    });

    expect(windowA.result.current.peers.map((peer) => peer.name)).toEqual(["Ada Lovelace"]);
    expect(windowB.result.current.peers).toEqual([]);
    // Not merely discarded on arrival: window B never hears project A's channel.
    expect(bus.delivered.filter((hop) => hop.from !== hop.to)).toEqual([]);
  });

  it("keeps project A's chat out of the window linked to project B", async () => {
    const windowA = inWindow("project-a", () => useOverleafChat({ enabled: true, projectRoot: ROOT_A }));
    const windowB = inWindow("project-b", () => useOverleafChat({ enabled: true, projectRoot: ROOT_B }));
    await settle();

    await act(async () => {
      bus.emitTo("project-a", "overleaf-realtime", {
        projectRoot: ROOT_A,
        type: "chatMessage",
        id: "msg-1",
        content: "Looking at section 2 now",
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.edu",
        timestamp: 1_700_000_000_000,
      });
    });

    expect(windowA.result.current.messages.map((message) => message.content))
      .toEqual(["Looking at section 2 now"]);
    expect(windowA.result.current.unread).toBe(1);
    expect(windowB.result.current.messages).toEqual([]);
    expect(windowB.result.current.unread).toBe(0);
    expect(bus.delivered.filter((hop) => hop.from !== hop.to)).toEqual([]);
  });
});
