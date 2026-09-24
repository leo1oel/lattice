/**
 * What happens to a document when the writer moves to another file.
 *
 * A document that still owes Overleaf an operation cannot simply be dropped:
 * the answer is addressed to it and arrives on the channel whatever is on
 * screen, and leaving its room first sends both the acknowledgement and any
 * rejection somewhere nobody is listening. These cover that it is kept until
 * it settles, and that coming back to it resumes rather than starts over.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activateAppLocale } from "../i18n";
import { useOverleafRealtime } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const DOC_A = "doc-a";
const DOC_B = "doc-b";
const DOC_MD = "doc-md";

/** Feeds the hook the events the Rust side would emit. */
let emit: (payload: unknown) => void;

/** Every joinDoc the hook made, so the resumed-from version can be asserted. */
let joins: { docId: string; fromVersion: number | null }[];
/** Every applyOtUpdate. */
let sends: { docId: string; version: number; ops: unknown[] }[];
let leaves: string[];
/** Sends that went out as suggestions rather than as edits. */
let tracked: { docId: string; version: number; ops: unknown[] }[];
/** Documents whose anchors were re-read. */
let rangeReads: string[];
/** What Overleaf says this account is, for the tests that vary it. */
let account: { permission: string; trackChanges: boolean };
/** The public connection id returned by the connect call, when known. */
let connectionPublicId: string | null;
/** Simulate a server commit whose acknowledgement never reaches the command. */
let loseSendAck: boolean;
/** Permissions copied from realtime into the durable sync state. */
let permissionWrites: { permission: string; projectRoot: string }[];
/** Connection attempts, including automatic retries. */
let connectCalls: number;
/** Transient connection failures still to return before succeeding. */
let connectFailures: number;
let connectErrorMessage: string;
/** Project scope carried by document-level realtime calls. */
let scopedRealtimeCalls: { command: string; projectRoot: string; docId: string | null }[];
/** A join held open to reproduce updates arriving before its snapshot resolves. */
let deferredJoin: {
  docId: string;
  promise: Promise<ReturnType<typeof joinAnswer>>;
} | null;

function joinAnswer(docId: string, fromVersion: number | null = null) {
  if (docId === DOC_A && fromVersion === 10 && loseSendAck && sends.length) {
    return {
      text: "alpha edited",
      version: 11,
      comments: anchors.comments,
      changes: anchors.changes,
      caughtUp: [{
        version: 10,
        ops: sends[0]!.ops,
        source: "me",
      }],
      resumed: true,
    };
  }
  return {
    text: docId === DOC_A ? "alpha" : "beta",
    version: 10,
    comments: anchors.comments,
    changes: anchors.changes,
    caughtUp: [],
    resumed: false,
  };
}

/** Comment and suggestion anchors the server reports on joining. */
let anchors: { comments: unknown[]; changes: unknown[] };

beforeEach(() => {
  joins = [];
  sends = [];
  leaves = [];
  tracked = [];
  rangeReads = [];
  permissionWrites = [];
  connectCalls = 0;
  connectFailures = 0;
  connectErrorMessage = "network unavailable";
  scopedRealtimeCalls = [];
  deferredJoin = null;
  connectionPublicId = "me";
  loseSendAck = false;
  account = { permission: "readAndWrite", trackChanges: false };
  anchors = { comments: [], changes: [] };
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    emit = (payload) => {
      act(() => {
        (handler as (event: { payload: unknown }) => void)({ payload });
      });
    };
    return () => undefined;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    if ([
      "overleaf_rt_join_doc",
      "overleaf_rt_leave_doc",
      "overleaf_rt_send_ops",
      "overleaf_rt_send_tracked_ops",
    ].includes(command)) {
      scopedRealtimeCalls.push({
        command,
        projectRoot: input.projectRoot as string,
        docId: (input.docId as string | undefined) ?? null,
      });
    }
    if (command === "overleaf_rt_connect") {
      connectCalls += 1;
      if (connectFailures > 0) {
        connectFailures -= 1;
        throw new Error(connectErrorMessage);
      }
      return {
        publicId: connectionPublicId,
        docs: [{ id: DOC_A, path: "a.tex" }, { id: DOC_B, path: "b.tex" }],
        entities: [],
        permission: account.permission,
        trackChanges: account.trackChanges,
        userId: "user-1",
      };
    }
    if (command === "overleaf_doc_ranges") {
      rangeReads.push(input.docId as string);
      return {
        comments: [],
        changes: [{
          id: "made-by-us",
          position: 0,
          text: "suggested",
          deletion: false,
          userId: "user-1",
          timestamp: null,
          hue: 100,
        }],
      };
    }
    if (command === "overleaf_rt_send_tracked_ops") {
      tracked.push({
        docId: input.docId as string,
        version: input.version as number,
        ops: input.ops as unknown[],
      });
      return undefined;
    }
    if (command === "overleaf_rt_join_doc") {
      const fromVersion = (input.fromVersion as number | null) ?? null;
      joins.push({
        docId: input.docId as string,
        fromVersion,
      });
      const pendingJoin = deferredJoin;
      if (pendingJoin && pendingJoin.docId === input.docId) return pendingJoin.promise;
      return joinAnswer(input.docId as string, fromVersion);
    }
    if (command === "overleaf_rt_send_ops") {
      sends.push({
        docId: input.docId as string,
        version: input.version as number,
        ops: input.ops as unknown[],
      });
      if (loseSendAck) throw new Error("ack lost");
      return undefined;
    }
    if (command === "overleaf_set_permission") {
      permissionWrites.push({
        permission: input.permission as string,
        projectRoot: input.projectRoot as string,
      });
      return undefined;
    }
    if (command === "overleaf_rt_leave_doc") {
      leaves.push(input.docId as string);
      return undefined;
    }
    return undefined;
  });
});

afterEach(() => {
  // Unmount while IPC still returns promises, before the global locale reset
  // can notify a mounted hook and re-run its translated effects.
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  vi.useRealTimers();
});

function mount(
  activeFile: string,
  onRemoteText: Parameters<typeof useOverleafRealtime>[0]["onRemoteText"] = () => undefined,
) {
  return renderHook(
    (file: string) => useOverleafRealtime({
      enabled: true,
      documents: true,
      projectRoot: "/tmp/project",
      activeFile: file,
      onRemoteText,
      readCaret: () => 0,
      onNotice: () => undefined,
    }),
    { initialProps: activeFile },
  );
}

describe("guarded remote delivery", () => {
  it("never checkpoints a rejected fresh snapshot, including after a duplicate ack", async () => {
    const view = mount("a.tex", () => false);
    await waitFor(() => expect(leaves).toContain(DOC_A));
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({ checkpoint: null }));
    expect(view.result.current.liveFile).toBe(false);
  });

  it.each([false, true])("serializes reopening and retains ownership on failed leave (%s)", async (failed) => {
    const view = mount("a.tex");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    const original = vi.mocked(invoke).getMockImplementation()!;
    let finishLeave!: () => void;
    vi.mocked(invoke).mockImplementation((command, args) => command === "overleaf_rt_leave_doc"
      && (args as { docId: string }).docId === DOC_A
      ? new Promise((resolve, reject) => {
        finishLeave = () => failed ? reject(new Error("disk write failed")) : resolve(undefined);
      })
      : original(command, args));
    view.rerender("b.tex");
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
    expect(view.result.current.livePaths).toContain("a.tex");
    view.rerender("a.tex");
    await act(async () => {});
    expect(joins.filter((join) => join.docId === DOC_A)).toHaveLength(1);
    await act(async () => finishLeave());
    expect(view.result.current.livePaths).toContain("a.tex");
    await waitFor(() => expect(joins.filter((join) => join.docId === DOC_A)).toHaveLength(failed ? 1 : 2));
    const receipts = vi.mocked(invoke).mock.calls
      .filter(([command, args]) => command === "overleaf_rt_join_doc" && (args as { docId: string }).docId === DOC_A)
      .map(([, args]) => (args as { receipt: string }).receipt);
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      docId: DOC_A, receipt: receipts[0],
    }));
    if (!failed) expect(receipts[1]).not.toBe(receipts[0]);
    vi.mocked(invoke).mockImplementation(original);
  });

  it("does not promote text after an out-of-band reservation until a full reset", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = mount("a.tex");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    act(() => { expect(view.result.current.reserveOperation()).not.toBeNull(); });
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await act(async () => {
      view.result.current.pushLocal("alpha later");
      vi.advanceTimersByTime(300);
    });
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves).toContain(DOC_A));
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      checkpoint: { text: "alpha", version: 10 },
    }));
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    act(() => view.result.current.resumePaths(["a.tex"]));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await act(async () => {
      view.result.current.pushLocal("alpha after reset");
      vi.advanceTimersByTime(300);
    });
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves).toHaveLength(2));
    expect(invoke).toHaveBeenLastCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      checkpoint: { text: "alpha after reset", version: 11 },
    }));
  });

  it.each([
    { mixed: false, reopen: false }, { mixed: true, reopen: false },
    { mixed: false, reopen: true }, { mixed: true, reopen: true },
  ])("only checkpoints applied catch-up (mixed: $mixed, reopen: $reopen)", async ({ mixed, reopen }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = mount("a.tex", (text) => !text.startsWith("peer "));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_rt_join_doc" && (args as { docId: string }).docId === DOC_A) {
        return {
          ...joinAnswer(DOC_A), resumed: true, version: mixed ? 12 : 11,
          caughtUp: [
            { version: 10, ops: [{ p: 5, i: " human" }], source: "me" },
            ...(mixed ? [{ version: 11, ops: [{ p: 0, i: "peer " }], source: "peer" }] : []),
          ],
        };
      }
      return original(command, args);
    });
    loseSendAck = !reopen;
    await act(async () => {
      view.result.current.pushLocal("alpha human");
      vi.advanceTimersByTime(300);
    });
    if (reopen) {
      view.rerender("b.tex");
      await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
      view.rerender("a.tex");
      await waitFor(() => expect(joins.filter((join) => join.docId === DOC_B)).toHaveLength(1));
      await act(async () => {});
    }
    if (!mixed) act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves).toContain(DOC_A));
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      checkpoint: mixed ? { text: "alpha", version: 10 } : { text: "alpha human", version: 11 },
    }));
  });

  it("checkpoints a final debounced edit only after its draining acknowledgement", async () => {
    const view = mount("a.tex");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    act(() => view.result.current.pushLocal("alpha final"));
    view.rerender("b.tex");
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(leaves).not.toContain(DOC_A);
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves).toContain(DOC_A));
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      docId: DOC_A, checkpoint: { text: "alpha final", version: 11 },
    }));
  });

  it.each([false, true])("checkpoints acknowledged human text before handoff (track changes: %s)", async (trackChanges) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.trackChanges = trackChanges;
    const view = mount("a.tex");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await act(async () => {
      view.result.current.pushLocal("alpha human");
      vi.advanceTimersByTime(300);
    });
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves).toContain(DOC_A));
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      docId: DOC_A, checkpoint: { text: "alpha human", version: 11 },
    }));
  });

  it("hands external writes to sync, drains owned operations, and rejoins only after reconciliation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onNeedsSync = vi.fn();
    const view = renderHook(() => useOverleafRealtime({
      enabled: true, documents: true, projectRoot: "/tmp/project", activeFile: "a.tex",
      readCaret: () => 0, onRemoteText: () => true, onNotice: vi.fn(), onNeedsSync,
    }));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await act(async () => {
      view.result.current.pushLocal("alpha local");
      vi.advanceTimersByTime(300);
    });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
    expect(onNeedsSync).toHaveBeenCalledWith(["a.tex"]);
    const joined = joins.length;
    act(() => view.result.current.resumePaths(["a.tex"]));
    expect(joins).toHaveLength(joined);
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    expect(joins).toHaveLength(joined);
    act(() => view.result.current.resumePaths(["a.tex"]));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(joins).toHaveLength(joined + 1);
    view.unmount();
  });

  it("serializes disk applies and does not send intermediate snapshots back to Overleaf", async () => {
    let finish!: () => void;
    const seen: string[] = [];
    const bases: string[] = [];
    const view = mount("a.tex", async (text, _caret, context) => {
      seen.push(text);
      bases.push(context.baseContent);
      if (text === "alpha one") await new Promise<void>((resolve) => { finish = resolve; });
    });
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 5, i: " one" }], source: "peer" });
    await waitFor(() => expect(seen).toEqual(["alpha", "alpha one"]));
    emit({ type: "docUpdate", docId: DOC_A, version: 11, ops: [{ p: 9, i: " two" }], source: "peer" });
    act(() => view.result.current.pushLocal("alpha one"));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.reserveOperation()).toBeNull();
    expect(view.result.current.settledVersion()).toBeNull();
    expect(seen).toEqual(["alpha", "alpha one"]);
    await act(async () => finish());
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(seen).toEqual(["alpha", "alpha one", "alpha one two"]);
    expect(bases).toEqual(["alpha", "alpha", "alpha one"]);
    expect(sends).toEqual([]);
    expect(view.result.current.settledVersion()).toBe(12);
    view.unmount();
  });

  it("falls back without accepting a stale snapshot on reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let buffer = "alpha";
    const view = mount("a.tex", (text) => text === buffer);
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    emit({ type: "disconnected", reason: "network changed" });
    buffer = "agent revision while offline";
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    await waitFor(() => expect(joins.length).toBeGreaterThan(1));
    await waitFor(() => expect(view.result.current.detail).toMatch(/outside live editing/));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual([]);
    expect(sends).toEqual([]);
    expect(buffer).toBe("agent revision while offline");
    view.unmount();
  });

  it("invalidates an in-flight apply across a file switch and reopen", async () => {
    let finish!: () => void;
    let oldIsCurrent = () => true;
    const view = mount("a.tex", async (text, _caret, context) => {
      if (text === "alpha one") {
        oldIsCurrent = context.isCurrent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return false;
      }
    });
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 5, i: " one" }], source: "peer" });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.rerender("b.tex");
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
    view.rerender("a.tex");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(oldIsCurrent()).toBe(false);
    await act(async () => finish());
    expect(view.result.current.docId).toBe(DOC_A);
    expect(view.result.current.liveFile).toBe(true);
    view.unmount();
  });

  it("retains unacknowledged operations when a disk conflict falls back to sync", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = mount("a.tex", (text) => text === "alpha");
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await act(async () => {
      view.result.current.pushLocal("alpha local");
      vi.advanceTimersByTime(300);
    });
    expect(sends).toHaveLength(1);
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 0, i: "remote " }], source: "peer" });
    await waitFor(() => expect(view.result.current.detail).toMatch(/outside live editing/));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
    expect(leaves).not.toContain(DOC_A);
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    expect(leaves).toContain(DOC_A);
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      docId: DOC_A, checkpoint: { text: "alpha", version: 10 },
    }));
    view.unmount();
  });
});

function mountProject(projectRoot: string) {
  return renderHook(
    (root: string) => useOverleafRealtime({
      enabled: true,
      documents: true,
      projectRoot: root,
      activeFile: "a.tex",
      onRemoteText: () => undefined,
      readCaret: () => 0,
      onNotice: () => undefined,
    }),
    { initialProps: projectRoot },
  );
}

describe("connection ownership", () => {
  it("explains the regular-sync fallback in the selected language", async () => {
    const { result } = mount("presentation.html");
    await waitFor(() => expect(result.current.detail).toBe(
      "Overleaf doesn’t support live editing for this file, so it will use regular sync.",
    ));

    await act(async () => activateAppLocale("zh-CN"));
    await waitFor(() => expect(result.current.detail).toBe(
      "Overleaf 不支持实时编辑此文件，将改用常规同步。",
    ));
  });

  it("uses an explicit global disconnect when live mode is disabled without a root", async () => {
    renderHook(() => useOverleafRealtime({
      enabled: false,
      documents: true,
      projectRoot: null,
      activeFile: "",
      onRemoteText: () => undefined,
      readCaret: () => 0,
      onNotice: () => undefined,
    }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "overleaf_rt_disconnect",
      { projectRoot: null },
    ));
  });

  it("keeps delayed document cleanup scoped to the project that owned it", async () => {
    const { result, rerender } = mountProject("/tmp/project-a");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(scopedRealtimeCalls).toContainEqual({
      command: "overleaf_rt_join_doc",
      projectRoot: "/tmp/project-a",
      docId: DOC_A,
    });

    rerender("/tmp/project-b");
    await waitFor(() => expect(scopedRealtimeCalls).toContainEqual({
      command: "overleaf_rt_leave_doc",
      projectRoot: "/tmp/project-a",
      docId: DOC_A,
    }));
    await waitFor(() => expect(scopedRealtimeCalls).toContainEqual({
      command: "overleaf_rt_join_doc",
      projectRoot: "/tmp/project-b",
      docId: DOC_A,
    }));
  });

  it("reconnects with backoff after the live channel closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(connectCalls).toBe(1);

    emit({ type: "disconnected", reason: "network changed" });
    await waitFor(() => expect(result.current.status).toBe("connecting"));
    expect(result.current.permission).toBe("unknown");
    expect(result.current.canWrite).toBe(false);
    expect(result.current.detail).toMatch(/reconnecting in 1s/i);

    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    await waitFor(() => expect(connectCalls).toBe(2));
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.detail).toBeNull();
  });

  it("retries a transient initial failure but does not loop on an expired session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    connectFailures = 1;
    const transient = mount("a.tex");
    await waitFor(() => expect(transient.result.current.status).toBe("connecting"));
    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    await waitFor(() => expect(transient.result.current.status).toBe("live"));
    expect(connectCalls).toBe(2);
    transient.unmount();

    connectCalls = 0;
    connectFailures = 1;
    connectErrorMessage = "Overleaf session expired. Reconnect in Settings.";
    const expired = mount("a.tex");
    await waitFor(() => expect(expired.result.current.status).toBe("error"));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(connectCalls).toBe(1);
  });
});

describe("switching files with work in flight", () => {
  it("keeps an update that arrives while a newly uploaded Markdown document is joining", async () => {
    let resolveJoin!: (joined: ReturnType<typeof joinAnswer>) => void;
    deferredJoin = {
      docId: DOC_MD,
      promise: new Promise((resolve) => { resolveJoin = resolve; }),
    };
    const remoteTexts: string[] = [];
    const { result } = mount("notes.md", (text) => { remoteTexts.push(text); });
    await waitFor(() => expect(result.current.status).toBe("live"));

    emit({
      type: "treeChanged",
      docs: [
        { id: DOC_A, path: "a.tex" },
        { id: DOC_B, path: "b.tex" },
        { id: DOC_MD, path: "notes.md" },
      ],
      entities: [],
    });
    await waitFor(() => expect(joins).toContainEqual({ docId: DOC_MD, fromVersion: null }));

    // Overleaf can emit an edit after joining the room but before the join
    // command's snapshot has crossed the IPC boundary back to React.
    emit({
      type: "docUpdate",
      docId: DOC_MD,
      version: 10,
      ops: [{ p: 5, i: " online" }],
      source: "someone-else",
    });
    resolveJoin({
      text: "notes",
      version: 10,
      comments: [],
      changes: [],
      caughtUp: [],
      resumed: false,
    });

    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(remoteTexts.at(-1)).toBe("notes online");
  });

  it("keeps the document until Overleaf answers, then leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(joins).toEqual([{ docId: DOC_A, fromVersion: null }]);

    // Type, and let the send debounce fire so an operation is outstanding.
    act(() => result.current.pushLocal("alpha edited"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0].docId).toBe(DOC_A);

    // Move to the other file before the answer arrives.
    rerender("b.tex");
    await waitFor(() => expect(joins).toHaveLength(2));
    expect(leaves).not.toContain(DOC_A);
    expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]);

    // The answer still arrives, and only then is the room given up.
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves).toContain(DOC_A));
    await waitFor(() => expect(result.current.livePaths).toEqual(["b.tex"]));
  });

  it("keeps the last path for a held document removed from the tree, but follows a rename", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.pushLocal("alpha edited"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    rerender("b.tex");
    await waitFor(() => expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]));

    // A collaborator deletes the path while its last edit is still awaiting
    // an answer. Losing the old lookup here would let REST own a.tex.
    emit({
      type: "treeChanged",
      docs: [{ id: DOC_B, path: "b.tex" }],
      entities: [],
    });
    expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]);

    // If the same entity id returns at a new path, that authoritative path
    // replaces the remembered one.
    emit({
      type: "treeChanged",
      docs: [
        { id: DOC_A, path: "renamed.tex" },
        { id: DOC_B, path: "b.tex" },
      ],
      entities: [],
    });
    expect(result.current.livePaths).toEqual(["b.tex", "renamed.tex"]);
  });

  it("sends what the debounce was still holding rather than dropping it", async () => {
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    // Typed and switched away inside the debounce window.
    act(() => result.current.pushLocal("alpha typed fast"));
    rerender("b.tex");

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0].docId).toBe(DOC_A);
    expect(sends[0].ops).not.toHaveLength(0);
  });

  it("leaves a settled document straight away", async () => {
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    rerender("b.tex");
    await waitFor(() => expect(leaves).toContain(DOC_A));
    expect(sends).toHaveLength(0);
  });

  it("resumes from the version it held when coming back to a file", async () => {
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.pushLocal("alpha edited"));
    rerender("b.tex");
    await waitFor(() => expect(sends).toHaveLength(1));

    // Back to the first file while it is still held.
    rerender("a.tex");
    await waitFor(() => expect(joins).toHaveLength(3));
    expect(joins[2]).toEqual({ docId: DOC_A, fromVersion: 10 });
  });

  it("does not reset unsettled local work when Overleaf cannot replay it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemoteText = vi.fn();
    const { result, rerender } = mount("a.tex", onRemoteText);
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.pushLocal("alpha local"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    rerender("b.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    rerender("a.tex");
    await waitFor(() => expect(joins).toContainEqual({ docId: DOC_A, fromVersion: 10 }));

    // The default mock answer says resumed:false. Taking its "alpha" snapshot
    // here would discard "alpha local", so the file stays held and paused.
    await waitFor(() => expect(result.current.liveFile).toBe(false));
    expect(result.current.livePaths).toEqual(["a.tex"]);
    expect(onRemoteText.mock.calls.map(([text]) => text)).toEqual(["alpha", "beta"]);
    expect(result.current.detail).toMatch(/paused/i);
  });
});

describe("an acknowledgement whose outcome is not known", () => {
  it("keeps a draining path out of ordinary sync after the timeout, until a late ack", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.pushLocal("alpha edited"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    rerender("b.tex");
    await waitFor(() => expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(leaves).not.toContain(DOC_A);
    expect(result.current.livePaths).toContain("a.tex");

    // A late answer proves the operation landed. Only now may ordinary sync
    // own the old path again.
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves).toContain(DOC_A));
    await waitFor(() => expect(result.current.livePaths).toEqual(["b.tex"]));
  });

  it("rejoins from the trusted version after a lost send ack and never retransmits blindly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loseSendAck = true;
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    await act(async () => {
      result.current.pushLocal("alpha edited");
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(joins).toContainEqual({ docId: DOC_A, fromVersion: 10 }));
    expect(sends).toHaveLength(1);

    // Catch-up identified our committed operation, so switching can release
    // the settled room rather than uploading the file through REST.
    rerender("b.tex");
    await waitFor(() => expect(leaves).toContain(DOC_A));
    await waitFor(() => expect(result.current.livePaths).toEqual(["b.tex"]));
  });

  it("does not apply catch-up while its own public id is unknown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    connectionPublicId = null;
    loseSendAck = true;
    const onRemoteText = vi.fn();
    const { result } = mount("a.tex", onRemoteText);
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(onRemoteText).toHaveBeenLastCalledWith("alpha", 0, expect.objectContaining({
      projectRoot: "/tmp/project", path: "a.tex", baseContent: "alpha",
    }));

    await act(async () => {
      result.current.pushLocal("alpha edited");
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(joins).toContainEqual({ docId: DOC_A, fromVersion: 10 }));

    // The replay says source "me", but without our public id Lattice cannot
    // prove that means us. Applying it as remote would duplicate " edited".
    expect(onRemoteText).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(1);
    expect(result.current.livePaths).toEqual(["a.tex"]);
    expect(result.current.detail).toMatch(/paused/i);
  });
});

describe("an error in one document", () => {
  it("is ignored when it belongs to a document we are not holding", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    emit({ type: "otError", docId: "some-other-doc", message: "nope" });
    expect(result.current.status).toBe("live");
    expect(result.current.liveFile).toBe(true);
  });

  it("stops that file without taking the connection with it", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    emit({ type: "otError", docId: DOC_A, message: "rejected" });
    await waitFor(() => expect(result.current.liveFile).toBe(false));
    // Chat, presence and the file tree ride this same connection, and one
    // file's rejection says nothing about any of them.
    expect(result.current.status).toBe("live");
    expect(leaves).toContain(DOC_A);
    expect(result.current.detail).toMatch(/rejected/);
  });
});

describe("returning to a document that is still draining", () => {
  it("does not give up its room when the drain timer would have fired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.pushLocal("alpha edited"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));

    rerender("b.tex");
    await waitFor(() => expect(joins).toHaveLength(2));
    rerender("a.tex");
    await waitFor(() => expect(joins).toHaveLength(3));

    // The mock cannot replay the outstanding edit, so the document stays
    // paused rather than resetting it. Well past the old drain timeout, its
    // path is still protected from ordinary sync.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(leaves).not.toContain(DOC_A);
    expect(result.current.liveFile).toBe(false);
    expect(result.current.livePaths).toContain("a.tex");
  });
});

describe("settled guards around REST mutations", () => {
  it("treats debounced and in-flight typing as unsettled, and reload never overwrites it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemoteText = vi.fn();
    const { result } = mount("a.tex", onRemoteText);
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(result.current.settledVersion()).toBe(10);

    // Still inside the 250 ms debounce: OtDocument itself is settled, but the
    // editor already holds local text that a reload must not replace.
    act(() => result.current.pushLocal("alpha debounced"));
    expect(result.current.settledVersion()).toBeNull();
    act(() => result.current.reload());
    expect(joins).toHaveLength(1);
    expect(onRemoteText).toHaveBeenCalledTimes(1);

    // Once flushed, the same guard is carried by OtDocument's in-flight op.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(result.current.settledVersion()).toBeNull();
    act(() => result.current.reload());
    expect(joins).toHaveLength(1);
    expect(onRemoteText).toHaveBeenCalledTimes(1);

    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(result.current.settledVersion()).toBe(11));
  });
});

describe("what typing goes out as", () => {
  async function typeInto(result: { current: { pushLocal: (text: string) => void } }) {
    await act(async () => {
      result.current.pushLocal("alpha edited");
      vi.advanceTimersByTime(300);
    });
  }

  it("sends ordinary edits when suggesting is off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    await typeInto(result);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(tracked).toHaveLength(0);
  });

  it("always sends ordinary edits even when Overleaf's legacy setting is on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.trackChanges = true;
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));

    await typeInto(result);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(tracked).toHaveLength(0);
  });

  it("keeps sending ordinary edits when the legacy setting changes mid-session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    emit({ type: "trackChangesToggled", on: true });
    await waitFor(() => expect(result.current.trackChanges).toBe(true));
    await typeInto(result);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(tracked).toHaveLength(0);
  });

  it("does not send text changes for a comment-only reviewer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.permission = "review";
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(result.current.canWrite).toBe(false);

    await typeInto(result);
    expect(sends).toHaveLength(0);
    expect(tracked).toHaveLength(0);
  });

  it("does not let a viewer type at all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.permission = "readOnly";
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    await typeInto(result);
    expect(sends).toHaveLength(0);
    expect(tracked).toHaveLength(0);
  });

  it("fails closed while Overleaf has not named a permission", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.permission = "unknown";
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(result.current.canWrite).toBe(false);

    await typeInto(result);
    expect(sends).toHaveLength(0);
    expect(tracked).toHaveLength(0);
    expect(permissionWrites).not.toContainEqual(expect.objectContaining({
      permission: "unknown",
    }));
  });
});

describe("durable sync permission", () => {
  it("records a known realtime permission in SyncState", async () => {
    account.permission = "readOnly";
    mount("a.tex");
    await waitFor(() => expect(permissionWrites).toContainEqual({
      permission: "readOnly",
      projectRoot: "/tmp/project",
    }));
  });

  it("never writes an unknown permission into SyncState", async () => {
    account.permission = "unknown";
    mount("a.tex");
    await waitFor(() => expect(joins).toHaveLength(1));
    expect(permissionWrites).not.toContainEqual(expect.objectContaining({
      permission: "unknown",
    }));
  });

  it("never persists project A's permission after switching to project B", async () => {
    account.permission = "readOnly";
    const { rerender } = mountProject("/tmp/project-a");
    await waitFor(() => expect(permissionWrites).toContainEqual({
      permission: "readOnly",
      projectRoot: "/tmp/project-a",
    }));

    permissionWrites = [];
    account.permission = "owner";
    rerender("/tmp/project-b");
    await waitFor(() => expect(permissionWrites).toContainEqual({
      permission: "owner",
      projectRoot: "/tmp/project-b",
    }));
    expect(permissionWrites).not.toContainEqual({
      permission: "readOnly",
      projectRoot: "/tmp/project-b",
    });
  });
});

/**
 * Overleaf says where comments and suggestions sit when the document is
 * joined and never mentions them again. Rejecting a suggestion is built from
 * its position, so one that has drifted does not merely draw in the wrong
 * place — it rewrites text nobody proposed touching.
 */
describe("anchors as the text moves", () => {
  beforeEach(() => {
    anchors = {
      comments: [{ threadId: "t1", position: 20, quote: "quoted" }],
      changes: [{
        id: "c1",
        position: 10,
        text: "suggested",
        deletion: false,
        userId: "them",
        timestamp: null,
        hue: 200,
      }],
    };
  });

  it("moves them along when a collaborator types above", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.changes).toHaveLength(1));

    emit({
      type: "docUpdate",
      docId: DOC_A,
      version: 10,
      ops: [{ p: 0, i: "12345" }],
      source: "someone-else",
    });

    await waitFor(() => expect(result.current.changes[0].position).toBe(15));
    expect(result.current.comments[0].position).toBe(25);
  });

  it("moves them along when we type above them ourselves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.changes).toHaveLength(1));

    await act(async () => {
      result.current.pushLocal("XXalpha");
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => expect(result.current.changes[0].position).toBe(12));
    expect(result.current.comments[0].position).toBe(22);
  });

  it("drops a suggestion whose text was deleted outright", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.changes).toHaveLength(1));

    emit({
      type: "docUpdate",
      docId: DOC_A,
      version: 10,
      ops: [{ p: 10, d: "suggested" }],
      source: "someone-else",
    });

    // Nothing left to accept or reject; offering a button that would act on
    // whatever moved into its place is worse than offering none.
    await waitFor(() => expect(result.current.changes).toHaveLength(0));
  });
});

describe("legacy suggesting state", () => {
  it("does not turn a new edit into a suggestion or refresh suggestion ranges", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.trackChanges = true;
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));

    await act(async () => {
      result.current.pushLocal("alpha edited");
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(tracked).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(rangeReads).toHaveLength(0);
  });

  it("is not read back for an ordinary edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    await act(async () => {
      result.current.pushLocal("alpha edited");
      vi.advanceTimersByTime(1300);
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(rangeReads).toHaveLength(0);
  });
});

describe("turning suggesting on when the channel is not carrying it", () => {
  it("reflects what we just set, rather than waiting to be told", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.trackChanges).toBe(false));

    // The setting is changed over REST and succeeds regardless of the
    // channel; nothing else would move this.
    act(() => result.current.noteTrackChanges(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));
  });

  it("still follows the channel when it does say so", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    act(() => result.current.noteTrackChanges(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));
    // Somebody with permission turned it off for us at the other end.
    emit({ type: "trackChangesToggled", on: false });
    await waitFor(() => expect(result.current.trackChanges).toBe(false));
  });
});
