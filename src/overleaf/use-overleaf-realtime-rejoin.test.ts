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
import { DOC_A, cleanupRealtimeBackend, emit, mount, resetRealtimeBackend, sends } from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/** What the last sync agreed a.tex held, and what Overleaf holds once the co-author typed on. */
const AGREED = "Merged by the sync.\n";
const AHEAD = "Merged by the sync. The co-author kept typing.\n";

let disk: string;
let join: { text: string; agreed: string | null };
/** Leaving a document fails, so the hook keeps holding it. */
let leaveFails: boolean;

beforeEach(() => {
  resetRealtimeBackend();
  leaveFails = false;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const fields = (args ?? {}) as Record<string, unknown>;
    if (command === "overleaf_rt_join_doc") {
      return { text: join.text, version: 10, comments: [], changes: [], caughtUp: [], resumed: false, agreed: join.agreed };
    }
    if (command === "overleaf_rt_leave_doc" && leaveFails) throw new Error("the server did not answer");
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

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

async function joinWith(buffer: ReturnType<typeof editor>) {
  const needsSync = vi.fn();
  const view = mount({ onRemoteText: (text, context) => applyOverleafRemoteText(buffer.deps, text, context), onNeedsSync: needsSync });
  await waitFor(() => expect(invokeCalls("overleaf_rt_join_doc")).toHaveLength(1));
  await settle();
  return { view, needsSync };
}

/** The writer leaves a.tex for a file Overleaf does not hold as a document, and the buffer saved there. */
async function leaveFor(view: Awaited<ReturnType<typeof joinWith>>["view"], buffer: ReturnType<typeof editor>, saved: string) {
  view.rerender({ activeFile: "notes.txt" });
  await waitFor(() => expect(invokeCalls("overleaf_rt_leave_doc")).toHaveLength(1));
  await settle();
  Object.assign(buffer.state, { text: saved, saved });
  disk = saved;
}

async function returnTo(view: Awaited<ReturnType<typeof joinWith>>["view"]) {
  view.rerender({ activeFile: "a.tex" });
  await waitFor(() => expect(invokeCalls("overleaf_rt_join_doc")).toHaveLength(2));
  await settle();
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

  it("takes Overleaf's text as it is when the buffer already shows it, however old the agreed text", async () => {
    join = { text: AHEAD, agreed: AGREED };
    const buffer = editor(AHEAD);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(needsSync).not.toHaveBeenCalled();
    expect([buffer.state.text, disk]).toEqual([AHEAD, AHEAD]);
  });

  it("leaves it to sync when both moved on since the agreed text, which is no proof nothing was shared since", async () => {
    join = { text: AHEAD, agreed: AGREED };
    const buffer = editor("Merged by the sync. Typed during the sync.\n", AGREED);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(needsSync).toHaveBeenCalledWith(["a.tex"]));
    expect(view.result.current.liveFile).toBe(false);
    expect([buffer.state.text, disk]).toEqual(["Merged by the sync. Typed during the sync.\n", AGREED]);
  });

  // The writer's edit went out as they left the file, a co-author's
  // operation reached Overleaf before it, and the writer came back before any
  // sync. The checkpoint is the writer's text with the edit, acknowledged by
  // then: the text from before it would make a merge type the edit twice,
  // and coming back used to hand the file to regular sync for that reason.
  it("takes Overleaf's text on return, never typing the writer's edit twice, when it went out as they left", async () => {
    const shared = "Shared.";
    const mine = "Shared. Mine.";
    const both = "Theirs. Shared. Mine.";
    join = { text: shared, agreed: null };
    const buffer = editor(shared);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    act(() => view.result.current.pushLocal(mine));
    view.rerender({ activeFile: "notes.txt" });
    await waitFor(() => expect(sends()).toEqual([expect.objectContaining({ version: 10, ops: [{ p: 7, i: " Mine." }] })]));
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 0, i: "Theirs. " }], source: "peer" });
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    await waitFor(() => expect(invokeCalls("overleaf_rt_leave_doc")).toHaveLength(1));
    const checkpoint = (invokeCalls("overleaf_rt_leave_doc")[0]!.checkpoint as { text: string } | null)?.text ?? null;
    expect(checkpoint).toBe(mine);
    Object.assign(buffer.state, { text: mine, saved: mine });
    disk = mine;
    join = { text: both, agreed: checkpoint };
    await returnTo(view);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(needsSync).not.toHaveBeenCalled();
    expect([buffer.state.text, disk]).toEqual([both, both]);
    expect(sends()).toHaveLength(1);
  });

  // Both typed while the document was held. Expected texts are written out
  // by hand; at a tie the writer's insert lands first, as ShareJS places a
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
  ])("merges both sides' typing live from the held document's settled local copy in %s", async (_label, shared, ahead, typed, merged) => {
    join = { text: shared, agreed: null };
    const buffer = editor(shared);
    const { view, needsSync } = await joinWith(buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    leaveFails = true;
    await leaveFor(view, buffer, typed);
    join = { text: ahead, agreed: null };
    await returnTo(view);
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
