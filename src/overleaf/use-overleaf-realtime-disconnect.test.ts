/**
 * What a dropped connection does to the documents it was holding.
 *
 * Its rooms close with it, so leaving one afterwards fails: the Rust client
 * answers that the connection is closed, or that another one replaced it.
 * A document settled on Overleaf owes nothing, so it goes back to ordinary
 * sync; kept, it would stay out of every sync with no operation able to
 * reach it, and Overleaf's edits to it would never land here.
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  advance, backend, cleanupRealtimeBackend, DOC_A, DOC_B, emit, joinsOf, mountLive, resetRealtimeBackend, typeAndSend,
} from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(resetRealtimeBackend);
afterEach(cleanupRealtimeBackend);

/** Leaves fail between a disconnect and the next connect, as they do against the Rust client. */
function closeConnectionOnDisconnect() {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let closed = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "overleaf_rt_connect") closed = false;
    if (command === "overleaf_rt_leave_doc" && closed) throw new Error("The Overleaf realtime connection is closed.");
    return original(command, args);
  });
  return () => {
    closed = true;
    emit({ type: "disconnected", reason: "network changed" });
  };
}

describe("a dropped connection", () => {
  it("hands a settled document back to sync when the writer has moved on by the time it reconnects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onNotice = vi.fn();
    const view = await mountLive({ onRemoteText: () => true, onNotice });
    const disconnect = closeConnectionOnDisconnect();

    disconnect();
    view.rerender({ activeFile: "b.tex" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));

    expect(view.result.current.livePaths).toEqual(["b.tex"]);
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/hand this file back/));

    // Coming back joins it afresh on the new connection.
    view.rerender({ activeFile: "a.tex" });
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_A));
    expect(joinsOf(DOC_A).at(-1)).toEqual({ docId: DOC_A, fromVersion: null });
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  });

  it("rejoins the document still on screen once the channel is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive({ onRemoteText: () => true });
    const disconnect = closeConnectionOnDisconnect();

    disconnect();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    await waitFor(() => expect(joinsOf(DOC_A)).toHaveLength(2));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
  });

  it("keeps a document whose edit Overleaf has not acknowledged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.loseSendAck = true;
    const view = await mountLive({ onRemoteText: () => true });
    backend.joinsFail = true;
    await typeAndSend(view.result, "alpha edited");
    const disconnect = closeConnectionOnDisconnect();

    disconnect();
    view.rerender({ activeFile: "b.tex" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });

    expect(view.result.current.livePaths).toContain("a.tex");
  });

  // S6 in the implicit-state audit: Rust installs the new client and then
  // waits on the sync lease, as long as a full sync runs, before the connect
  // command returns. A socket that drops in that wait used to be swallowed:
  // the command's answer marked the channel live over a dead socket, and
  // nothing ever reconnected it.
  it("reconnects when the new socket drops before its connect command returns", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onNotice = vi.fn();
    const view = await mountLive({ onRemoteText: () => true, onNotice });
    const original = vi.mocked(invoke).getMockImplementation()!;
    let releaseConnect: (() => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_rt_connect" && invokeCount("overleaf_rt_connect") === 2) {
        await new Promise<void>((resolve) => { releaseConnect = resolve; });
      }
      return original(command, args);
    });

    emit({ type: "disconnected", reason: "network changed" });
    await advance(1_100);
    await waitFor(() => expect(releaseConnect).not.toBeNull());
    emit({ type: "disconnected", reason: "network changed again" });
    await act(async () => { releaseConnect!(); });

    expect(view.result.current.status).toBe("connecting");
    expect(onNotice).not.toHaveBeenCalledWith("Overleaf live editing reconnected.");
    // The next try backs off further than the first one did.
    await advance(1_500);
    expect(invokeCount("overleaf_rt_connect")).toBe(2);
    await advance(1_000);
    await waitFor(() => expect(invokeCount("overleaf_rt_connect")).toBe(3));
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(onNotice).toHaveBeenCalledWith("Overleaf live editing reconnected.");
  });
});

const invokeCount = (command: string) => vi.mocked(invoke).mock.calls.filter(([called]) => called === command).length;

describe("a failure that is not a dropped socket", () => {
  const target = { projectRoot: "/tmp/project", docId: DOC_A, path: "a.tex" };

  it("checks a comment anchor whose answer was lost instead of ending live editing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive({ onRemoteText: () => true });
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_rt_send_comment") throw new Error("Timed out waiting for Overleaf");
      return original(command, args);
    });

    await act(async () => {
      await expect(view.result.current.anchorComment(target, "thread-1", 0, "alpha")).rejects.toThrow(/Timed out/);
    });

    expect(view.result.current.status).toBe("live");
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "overleaf_rt_disconnect")).toBe(false);
    // The replay that settles the unknown outcome rejoins the document.
    await waitFor(() => expect(joinsOf(DOC_A).length).toBeGreaterThan(1));
  });

  it("reconnects after Overleaf rejects an update it addressed to no document", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive({ onRemoteText: () => true });
    const connects = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_rt_connect").length;
    expect(connects()).toBe(1);

    act(() => emit({ type: "otError", message: "Overleaf could not apply the update" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });

    await waitFor(() => expect(connects()).toBe(2));
    await waitFor(() => expect(view.result.current.status).toBe("live"));
  });
});
