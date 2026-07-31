import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useOverleafPresence, type PresenceUser } from "./use-overleaf-presence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function peer(overrides: Partial<PresenceUser> = {}): PresenceUser {
  return {
    id: "conn-2",
    userId: "user-2",
    name: "Ada Lovelace",
    email: "ada@example.edu",
    docId: "doc-1",
    row: 4,
    column: 2,
    hue: 200,
    ...overrides,
  };
}

/** Flush the microtask queue enough times for a chained `invoke().then()` to land. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOverleafPresence roster", () => {
  let emit: ((event: { payload: unknown }) => void) | null;
  let connectedUsers: PresenceUser[];

  beforeEach(() => {
    emit = null;
    connectedUsers = [peer(), peer({ id: "self-1", name: "Leo" })];
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      emit = handler as (event: { payload: unknown }) => void;
      return () => {};
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_rt_connected_users") return connectedUsers;
      if (command === "overleaf_rt_update_position") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("seeds from connected_users and drops our own entry", async () => {
    const { result } = renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_connected_users", {
      projectRoot: "/tmp/project",
    });
    expect(result.current.peers).toHaveLength(1);
    expect(result.current.peers[0].id).toBe("conn-2");
  });

  it("removes someone once they leave", async () => {
    const { result } = renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await flush();
    expect(result.current.peers).toHaveLength(1);

    await act(async () => {
      emit?.({ payload: { type: "presenceLeft", id: "conn-2" } });
    });
    expect(result.current.peers).toHaveLength(0);
  });

  it("filters our own presenceUpdated echo", async () => {
    connectedUsers = [];
    const { result } = renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await flush();
    expect(result.current.peers).toHaveLength(0);

    await act(async () => {
      emit?.({ payload: { type: "presenceUpdated", user: peer({ id: "self-1", name: "Leo" }) } });
    });
    expect(result.current.peers.some((entry) => entry.id === "self-1")).toBe(false);

    await act(async () => {
      emit?.({ payload: { type: "presenceUpdated", user: peer({ id: "conn-3", name: "Grace Hopper" }) } });
    });
    expect(result.current.peers.map((entry) => entry.id)).toEqual(["conn-3"]);
  });

  it("clears the roster once the channel reports disconnected", async () => {
    const { result } = renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await flush();
    expect(result.current.peers).toHaveLength(1);

    await act(async () => {
      emit?.({ payload: { type: "disconnected", reason: "network" } });
    });
    expect(result.current.peers).toHaveLength(0);
  });
});

describe("useOverleafPresence publish", () => {
  let emit: ((event: { payload: unknown }) => void) | null;

  beforeEach(() => {
    emit = null;
    vi.useFakeTimers();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      emit = handler as (event: { payload: unknown }) => void;
      return () => {};
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_rt_connected_users") return [];
      if (command === "overleaf_rt_update_position") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function updatePositionCalls() {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_rt_update_position");
  }

  it("publishes once immediately when a document is joined, even before any move", async () => {
    renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const calls = updatePositionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      row: 0,
      column: 0,
    });
  });

  it("debounces at 500ms when someone else is present, 5 minutes when alone", async () => {
    const { result } = renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 0, column: 0 }),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    // A keepalive tick can land inside these windows too (it fires on its own
    // 4-minute clock regardless of the debounce), so assert on which position
    // went out rather than on a raw call count.
    const sentPositions = () => updatePositionCalls().map(([, args]) => args as { row: number; column: number });

    act(() => result.current.publish(1, 2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    });
    // Alone (no peers), so the move to (1, 2) should not have gone out yet
    // even after nearly five minutes — Overleaf's own client is exactly this
    // patient once nobody else is around to see the caret move.
    expect(sentPositions().some((p) => p.row === 1 && p.column === 2)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(sentPositions().some((p) => p.row === 1 && p.column === 2)).toBe(true);

    // Someone else joins: the debounce should now be the quick 500ms one.
    await act(async () => {
      emit?.({ payload: { type: "presenceUpdated", user: peer() } });
    });
    act(() => result.current.publish(3, 4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(sentPositions().some((p) => p.row === 3 && p.column === 4)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(sentPositions().some((p) => p.row === 3 && p.column === 4)).toBe(true);
  });

  it("re-publishes on the keepalive interval", async () => {
    renderHook(() => useOverleafPresence({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      selfId: "self-1",
      readCaret: () => ({ row: 7, column: 3 }),
    }));
    await act(async () => {
      await Promise.resolve();
    });
    const before = updatePositionCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    });
    const calls = updatePositionCalls();
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1][1]).toEqual({
      projectRoot: "/tmp/project",
      docId: "doc-1",
      row: 7,
      column: 3,
    });
  });
});
