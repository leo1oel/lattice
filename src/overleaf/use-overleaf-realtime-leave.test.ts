/**
 * Leaving a project before the window moves (#1208). `open_project` points
 * the window at the next project and drops this one's connection, so the
 * project switch hands every live document back first: the typing still in
 * the send debounce goes out, its acknowledgement comes back, and the leave
 * writes the OT checkpoint that the next sync merges against.
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCalls } from "../platform/tauri-test-mocks";
import { LEAVE_WAIT_MS } from "./overleaf-realtime-leave";
import {
  backend, cleanupRealtimeBackend, DOC_A, emit, joinsOf, mountLive, resetRealtimeBackend, sends,
} from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(resetRealtimeBackend);
afterEach(() => {
  cleanupRealtimeBackend();
  vi.useRealTimers();
});

const [A, B] = ["/tmp/project", "/tmp/project-b"];
const leavesFor = (root: string) => invokeCalls("overleaf_rt_leave_doc").filter((call) => call.projectRoot === root);
/** As `open_project` does: the window moves first, and React re-renders with the new project after. */
const switchTo = (view: Awaited<ReturnType<typeof mountLive>>, root: string) => {
  backend.windowRoot = root;
  view.rerender({ projectRoot: root });
};

describe("leaving a project before the window switches", () => {
  it("sends the unsent typing and checkpoints the document while the window still shows it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.windowRoot = A;
    const onNotice = vi.fn();
    const view = await mountLive({ projectRoot: A, onRemoteText: () => true, onNotice });
    act(() => view.result.current.pushLocal("alpha edited"));
    expect(sends()).toHaveLength(0);

    let left = false;
    const leaving = view.result.current.leaveProject().then(() => { left = true; });
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(invokeCalls("overleaf_rt_send_ops")[0]).toMatchObject({ projectRoot: A, docId: DOC_A, version: 10 });
    // Nothing leaves before Overleaf has acknowledged it: the checkpoint is only what both sides hold.
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(leavesFor(A)).toHaveLength(0);
    expect(left).toBe(false);

    await act(async () => { emit({ type: "docAck", docId: DOC_A, version: 10 }, A); });
    await act(async () => { await leaving; });
    expect(leavesFor(A)).toEqual([expect.objectContaining({
      docId: DOC_A, checkpoint: expect.objectContaining({ text: "alpha edited", version: 11 }),
    })]);
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));

    switchTo(view, B);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(leavesFor(A)).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("stops waiting for an acknowledgement that never comes, and the switch goes ahead", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.windowRoot = A;
    const onNotice = vi.fn();
    const view = await mountLive({ projectRoot: A, onRemoteText: () => true, onNotice });
    act(() => view.result.current.pushLocal("alpha edited"));

    const leaving = view.result.current.leaveProject();
    await waitFor(() => expect(sends()).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEAVE_WAIT_MS + 100);
      await leaving;
    });
    // Still owed an answer, so still held: ordinary sync keeps away from it.
    expect(leavesFor(A)).toHaveLength(0);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);

    switchTo(view, B);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/hand this file back/));
  });

  it("joins the open document again when the switch fails after leaving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.windowRoot = A;
    const view = await mountLive({ projectRoot: A, onRemoteText: () => true });

    await act(async () => { await view.result.current.leaveProject(); });
    expect(view.result.current.liveFile).toBe(false);
    expect(leavesFor(A)).toHaveLength(1);

    act(() => view.result.current.rejoin());
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(joinsOf(DOC_A)).toHaveLength(2);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
  });
});
