import { createElement } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeCalls, mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { useOverleafPresence, type PresenceUser } from "./use-overleaf-presence";
import { OverleafPresenceAvatars } from "./overleaf-presence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const peer = (overrides: Partial<PresenceUser> = {}): PresenceUser => ({
  id: "conn-2", userId: "user-2", name: "Ada Lovelace", email: "ada@example.edu", docId: "doc-1", row: 4, column: 2, hue: 200, ...overrides,
});

/** Flush the microtask queue enough times for a chained `invoke().then()` to land. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let emit: (payload: unknown) => void;
let connectedUsers: PresenceUser[];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  emit = mockListen();
  connectedUsers = [peer(), peer({ id: "self-1", name: "Robin" })];
  mockInvoke({ overleaf_rt_connected_users: () => connectedUsers, overleaf_rt_update_position: undefined });
});

type Options = Parameters<typeof useOverleafPresence>[0];

function mountPresence(overrides: Partial<Options> = {}) {
  return renderHook((props: Partial<Options>) => useOverleafPresence({
    projectRoot: "/tmp/project",
    docId: "doc-1",
    selfId: "self-1",
    readCaret: () => ({ row: 0, column: 0 }),
    ...props,
  }), { initialProps: overrides });
}

const inProject = (payload: Record<string, unknown>, projectRoot = "/tmp/project") => emit({ projectRoot, ...payload });

describe("useOverleafPresence roster", () => {
  it.each([
    ["removes someone once they leave", { type: "presenceLeft", id: "conn-2" }],
    ["clears the roster once the channel reports disconnected", { type: "disconnected", reason: "network" }],
  ])("seeds from connected_users, drops our own entry, and %s", async (_label, event) => {
    const { result } = mountPresence();
    await flush();
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_connected_users", { projectRoot: "/tmp/project" });
    expect(result.current.peers.map((entry) => entry.id)).toEqual(["conn-2"]);

    inProject(event);
    expect(result.current.peers).toHaveLength(0);
  });

  it("filters our own presenceUpdated echo", async () => {
    connectedUsers = [];
    const { result } = mountPresence();
    await flush();
    inProject({ type: "presenceUpdated", user: peer({ id: "self-1", name: "Robin" }) });
    expect(result.current.peers).toHaveLength(0);
    inProject({ type: "presenceUpdated", user: peer({ id: "conn-3", name: "Grace Hopper" }) });
    expect(result.current.peers.map((entry) => entry.id)).toEqual(["conn-3"]);
  });

  it.each(["presenceUpdated", "presenceLeft", "disconnected"])(
    "ignores a previous project's %s after switching between linked projects",
    async (type) => {
      const { result, rerender } = mountPresence({ projectRoot: "/project-A", docId: null });
      await flush();
      const currentPeer = peer({ id: "connection-B", docId: "document-B" });
      connectedUsers = [currentPeer];
      rerender({ projectRoot: "/project-B", docId: null });
      await flush();
      expect(result.current.peers).toEqual([currentPeer]);

      inProject({ type, user: peer({ id: "connection-A", docId: "document-A" }), id: currentPeer.id }, "/project-A");
      expect(result.current.peers).toEqual([currentPeer]);

      // A current-project event still works, including for the same account.
      inProject({ type: "presenceLeft", id: currentPeer.id }, "/project-B");
      expect(result.current.peers).toEqual([]);
    },
  );

  it("keeps the avatar toolbar scoped when the same collaborator has connections in two projects", async () => {
    function Toolbar({ projectRoot }: { projectRoot: string }) {
      const { peers } = useOverleafPresence({
        projectRoot, docId: null, selfId: "self-1", readCaret: () => ({ row: 0, column: 0 }),
      });
      return createElement(OverleafPresenceAvatars, { peers, pathForDoc: (id) => id, onJump: () => {} });
    }
    const view = render(createElement(Toolbar, { projectRoot: "/project-A" }));
    await flush();
    expect(view.getAllByRole("button")).toHaveLength(1);
    connectedUsers = [peer({ id: "connection-B", docId: "document-B" })];
    view.rerender(createElement(Toolbar, { projectRoot: "/project-B" }));
    await flush();
    inProject({ type: "presenceUpdated", user: peer({ docId: "document-A" }) }, "/project-A");
    expect(view.getAllByRole("button")).toHaveLength(1);
    expect(view.getByRole("button")).toHaveAttribute("title", "Ada Lovelace · document-B — click to jump there");
    view.unmount();
  });

  it("clears collaborators and ignores stale events after leaving a linked project", async () => {
    const { result, rerender } = mountPresence({ projectRoot: "/tmp/overleaf-project" });
    await flush();
    expect(result.current.peers).toHaveLength(1);

    rerender({ projectRoot: null, docId: null, selfId: null });
    expect(result.current.peers).toHaveLength(0);
    inProject({ type: "presenceUpdated", user: peer({ id: "late-peer" }) }, "/tmp/overleaf-project");
    expect(result.current.peers).toHaveLength(0);
  });
});

describe("useOverleafPresence publish", () => {
  beforeEach(() => {
    connectedUsers = [];
    vi.useFakeTimers();
  });

  const sentPositions = () => invokeCalls("overleaf_rt_update_position") as Array<{ row: number; column: number }>;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("publishes once immediately when a document is joined, even at 0:0 before any move, then the live caret on the keepalive", async () => {
    let caret = { row: 0, column: 0 };
    mountPresence({ readCaret: () => caret });
    await act(async () => { await Promise.resolve(); });
    expect(sentPositions()).toEqual([{ projectRoot: "/tmp/project", docId: "doc-1", row: 0, column: 0 }]);

    caret = { row: 7, column: 3 };
    await advance(4 * 60 * 1000);
    expect(sentPositions()).toHaveLength(2);
    expect(sentPositions().at(-1)).toEqual({ projectRoot: "/tmp/project", docId: "doc-1", row: 7, column: 3 });
  });

  it("debounces at 500ms when someone else is present, 5 minutes when alone", async () => {
    const { result } = mountPresence();
    await act(async () => { await Promise.resolve(); });
    // A keepalive tick can land inside these windows too, so assert on which
    // position went out rather than on a raw call count.
    const sent = (row: number, column: number) => sentPositions().some((p) => p.row === row && p.column === column);

    // Alone: Overleaf's own client is this patient once nobody can see the caret.
    act(() => result.current.publish(1, 2));
    await advance(5 * 60 * 1000 - 1);
    expect(sent(1, 2)).toBe(false);
    await advance(2);
    expect(sent(1, 2)).toBe(true);

    // Someone else joins: the debounce is now the quick 500ms one.
    inProject({ type: "presenceUpdated", user: peer() });
    act(() => result.current.publish(3, 4));
    await advance(499);
    expect(sent(3, 4)).toBe(false);
    await advance(2);
    expect(sent(3, 4)).toBe(true);
  });
});
