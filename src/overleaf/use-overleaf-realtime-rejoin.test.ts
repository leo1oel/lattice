/**
 * Coming back to live editing after regular sync reconciled a file, while a
 * co-author keeps typing in it. The join's snapshot is then always a little
 * ahead of the text the sync agreed on; requiring the buffer to match it
 * exactly meant rejoining failed for as long as the co-author typed (the
 * collaboration audit's F1).
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyOverleafRemoteText } from "../app/overleaf-remote-text";
import type { AcceptExpectation } from "../app/use-document-store";
import { invokeCalls } from "../platform/tauri-test-mocks";
import { applyOps, type OtOp } from "./ot";
import { cleanupRealtimeBackend, mount, resetRealtimeBackend, sends } from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/** What the last sync agreed a.tex held, and what Overleaf holds once the co-author typed on. */
const AGREED = "Merged by the sync.\n";
const AHEAD = "Merged by the sync. The co-author kept typing.\n";

let disk: string;
let join: { text: string; agreed: string | null };

beforeEach(() => {
  resetRealtimeBackend();
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const fields = (args ?? {}) as Record<string, unknown>;
    if (command === "overleaf_rt_join_doc") {
      return { text: join.text, version: 10, comments: [], changes: [], caughtUp: [], resumed: false, agreed: join.agreed };
    }
    if (command === "write_project_file") {
      if (fields.expectedContent !== disk) throw new Error("The file changed on disk.");
      disk = fields.content as string;
      return undefined;
    }
    return base(command, args as never);
  });
});
afterEach(cleanupRealtimeBackend);

function editor(text: string, saved = text) {
  const state = { text, saved };
  disk = saved;
  return {
    state,
    deps: {
      projectRef: { current: { root: "/tmp/project" } as never },
      projectOperationGenerationRef: { current: 1 },
      activeFileRef: { current: "a.tex" },
      sourceRef: { get current() { return state.text; } },
      savedSourceRef: { get current() { return state.saved; } },
      accept: (path: string, content: string, expect: AcceptExpectation) => {
        if (path !== "a.tex" || (expect.saved !== undefined && state.saved !== expect.saved)) return false;
        if (expect.text !== undefined && state.text !== expect.text) return false;
        const shown = expect.show ? expect.show(state.text) : content;
        if (shown === null) return false;
        Object.assign(state, { text: shown, saved: content });
        return true;
      },
    },
  };
}

async function joinWith(buffer: ReturnType<typeof editor>) {
  const needsSync = vi.fn();
  const view = mount({ onRemoteText: (text, context) => applyOverleafRemoteText(buffer.deps, text, context), onNeedsSync: needsSync });
  await waitFor(() => expect(invokeCalls("overleaf_rt_join_doc")).toHaveLength(1));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { view, needsSync };
}

describe("joining a document Overleaf moved on from since the last sync", () => {
  it("takes Overleaf's text when the buffer still holds what the sync agreed", async () => {
    join = { text: AHEAD, agreed: AGREED };
    const buffer = editor(AGREED);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(needsSync).not.toHaveBeenCalled();
    expect([buffer.state.text, buffer.state.saved, disk]).toEqual([AHEAD, AHEAD, AHEAD]);
  });

  it("sends the buffer's own work when Overleaf still holds what the sync agreed", async () => {
    join = { text: AGREED, agreed: AGREED };
    const buffer = editor("Merged by the sync. Typed during the sync.\n", AGREED);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(needsSync).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await act(async () => {
      view.result.current.pushLocal(buffer.state.text);
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(sends()).toEqual([expect.objectContaining({ ops: [{ p: 19, i: " Typed during the sync." }] })]));
  });

  // Both typed through the sync window. Expected texts are written out by
  // hand; at a tie the writer's insert lands first, as ShareJS places a
  // client's own operation against one the server applied before it.
  it.each([
    [
      "the same paragraph", AGREED, AHEAD, "Merged by the sync. Typed during the sync.\n",
      "Merged by the sync. Typed during the sync. The co-author kept typing.\n",
    ],
    [
      "different paragraphs", "First paragraph.\n\nSecond paragraph.\n",
      "First paragraph.\n\nSecond paragraph, by the co-author.\n",
      "First paragraph, by the writer.\n\nSecond paragraph.\n",
      "First paragraph, by the writer.\n\nSecond paragraph, by the co-author.\n",
    ],
  ])("merges both sides' typing live when both moved on in %s", async (_label, agreed, ahead, typed, merged) => {
    join = { text: ahead, agreed };
    const buffer = editor(typed, agreed);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(needsSync).not.toHaveBeenCalled();
    expect([buffer.state.text, disk]).toEqual([merged, merged]);
    expect(disk).not.toContain("<<<<<<<");
    vi.useFakeTimers();
    await act(async () => {
      view.result.current.pushLocal(buffer.state.text);
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(applyOps(ahead, sends()[0]!.ops as OtOp[])).toBe(merged);
  });

  it("still leaves it to sync when nothing was agreed", async () => {
    join = { text: AHEAD, agreed: null };
    const buffer = editor("Merged by the sync. Typed during the sync.\n", AGREED);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(needsSync).toHaveBeenCalledWith(["a.tex"]));
    expect(view.result.current.liveFile).toBe(false);
    expect(buffer.state.text).toBe("Merged by the sync. Typed during the sync.\n");
  });

  it("never takes Overleaf's text over a disk the editor has not caught up with", async () => {
    join = { text: AHEAD, agreed: AGREED };
    const buffer = editor(AGREED);
    disk = "An agent rewrote the file.\n";
    const { needsSync } = await joinWith(buffer);
    await waitFor(() => expect(needsSync).toHaveBeenCalledWith(["a.tex"]));
    expect(disk).toBe("An agent rewrote the file.\n");
    expect(buffer.state.text).toBe(AGREED);
  });
});
