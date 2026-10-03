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
import { activateAppLocale } from "../i18n";
import { invokeCalls, mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { overleafDocHash } from "./overleaf-realtime-model";
import { useOverleafRealtime } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const DOC_A = "doc-a";
const DOC_B = "doc-b";
const DOC_MD = "doc-md";

/** What the mocked backend answers; reset before each test, varied by the tests that need to. */
const freshBackend = () => ({
  /** What Overleaf says this account may do. */
  permission: "readAndWrite",
  /** The public connection id returned by the connect call, when known. */
  publicId: "me" as string | null,
  /** Simulate a server commit whose acknowledgement never reaches the command. */
  loseSendAck: false,
  /** Joins fail, as they do while the socket that carried a send is going down. */
  joinsFail: false,
  /** The lost send never reached Overleaf at all, so a replay holds nothing of ours. */
  lostSendMissing: false,
  /** Transient connection failures still to return before succeeding, and what they say. */
  connectFailures: 0,
  connectError: "network unavailable",
  /** A join held open to reproduce updates arriving before its snapshot resolves. */
  deferredJoin: null as { docId: string; promise: Promise<unknown> } | null,
  /** Comment and suggestion anchors the server reports on joining. */
  anchors: { comments: [] as unknown[], changes: [] as unknown[] },
});
let backend: ReturnType<typeof freshBackend>;
/** Feeds the hook the events the Rust side would emit. */
let emit: (payload: unknown) => void;

/** Every join, reduced to the version it resumed from. */
const joins = () => invokeCalls("overleaf_rt_join_doc").map(({ docId, fromVersion }) => ({ docId, fromVersion: fromVersion ?? null }));
const joinsOf = (docId: string) => joins().filter((join) => join.docId === docId);
const sends = () => invokeCalls("overleaf_rt_send_ops") as { docId: string; version: number; ops: unknown[] }[];
const leaves = () => invokeCalls("overleaf_rt_leave_doc").map(({ docId }) => docId);
const expectLeft = (fields: Record<string, unknown>) =>
  expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining(fields));

function joinAnswer(docId: string, fromVersion: number | null = null) {
  const { anchors } = backend;
  if (backend.joinsFail) throw new Error("the connection is closing");
  if (docId === DOC_A && fromVersion === 10 && backend.lostSendMissing && sends().length) {
    return { text: "alpha", version: 10, ...anchors, caughtUp: [], resumed: true };
  }
  if (docId === DOC_A && fromVersion === 10 && backend.loseSendAck && sends().length) {
    return { text: "alpha edited", version: 11, ...anchors, caughtUp: [{ version: 10, ops: sends()[0]!.ops, source: "me" }], resumed: true };
  }
  // The lost send did land: that is the server's copy from now on.
  if (docId === DOC_A && backend.loseSendAck && !backend.lostSendMissing && sends().length) {
    return { text: "alpha edited", version: 11, ...anchors, caughtUp: [], resumed: fromVersion === 11 };
  }
  return { text: docId === DOC_A ? "alpha" : "beta", version: 10, ...anchors, caughtUp: [], resumed: false };
}

beforeEach(() => {
  backend = freshBackend();
  emit = mockListen();
  mockInvoke({
    overleaf_rt_connect: () => {
      if (backend.connectFailures > 0) {
        backend.connectFailures -= 1;
        throw new Error(backend.connectError);
      }
      return { publicId: backend.publicId, docs: [{ id: DOC_A, path: "a.tex" }, { id: DOC_B, path: "b.tex" }], entities: [], permission: backend.permission };
    },
    overleaf_rt_join_doc: ({ docId, fromVersion }: { docId: string; fromVersion: number | null }) =>
      backend.deferredJoin?.docId === docId ? backend.deferredJoin.promise : joinAnswer(docId, fromVersion ?? null),
    overleaf_rt_send_ops: () => { if (backend.loseSendAck) throw new Error("ack lost"); },
    overleaf_rt_leave_doc: undefined,
    overleaf_rt_disconnect: undefined,
    overleaf_set_permission: undefined,
  });
});

afterEach(() => {
  // Unmount while IPC still returns promises, before the global locale reset
  // can notify a mounted hook and re-run its translated effects.
  cleanup();
  vi.mocked(invoke).mockReset();
});

type Options = Parameters<typeof useOverleafRealtime>[0];

/** Live on a.tex in /tmp/project; `rerender` takes only the props that change. */
function mount(overrides: Partial<Options> = {}) {
  return renderHook((props: Partial<Options>) => useOverleafRealtime({
    enabled: true,
    documents: true,
    projectRoot: "/tmp/project",
    activeFile: "a.tex",
    onRemoteText: () => undefined,
    readCaret: () => 0,
    onNotice: () => undefined,
    ...overrides,
    ...props,
  }), { initialProps: {} });
}

type Hook = ReturnType<typeof mount>["result"];

/** Type `text` and let the send debounce fire, so an operation goes out. Needs fake timers. */
async function typeAndSend(result: Hook, text: string) {
  await act(async () => {
    result.current.pushLocal(text);
    vi.advanceTimersByTime(300);
  });
}

const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

/** Mount on a.tex and wait until it is live. */
async function mountLive(overrides: Partial<Options> = {}) {
  const view = mount(overrides);
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  return view;
}

describe("guarded remote delivery", () => {
  it("never checkpoints a rejected fresh snapshot, including after a duplicate ack", async () => {
    const view = mount({ onRemoteText: () => false });
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    expectLeft({ checkpoint: null });
    expect(view.result.current.liveFile).toBe(false);
  });

  it.each([false, true])("serializes reopening and retains ownership on failed leave (%s)", async (failed) => {
    const view = await mountLive();
    const original = vi.mocked(invoke).getMockImplementation()!;
    let finishLeave!: () => void;
    vi.mocked(invoke).mockImplementation((command, args) => command === "overleaf_rt_leave_doc"
      && (args as { docId: string }).docId === DOC_A
      ? new Promise((resolve, reject) => {
        finishLeave = () => failed ? reject(new Error("disk write failed")) : resolve(undefined);
      })
      : original(command, args));
    view.rerender({ activeFile: "b.tex" });
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
    // A settled document is left straight away, with nothing sent first.
    expect(leaves()).toContain(DOC_A);
    expect(sends()).toHaveLength(0);
    expect(view.result.current.livePaths).toContain("a.tex");
    view.rerender({ activeFile: "a.tex" });
    await act(async () => {});
    expect(joinsOf(DOC_A)).toHaveLength(1);
    await act(async () => finishLeave());
    expect(view.result.current.livePaths).toContain("a.tex");
    await waitFor(() => expect(joinsOf(DOC_A)).toHaveLength(failed ? 1 : 2));
    const receipts = invokeCalls("overleaf_rt_join_doc").filter(({ docId }) => docId === DOC_A).map(({ receipt }) => receipt);
    expectLeft({ docId: DOC_A, receipt: receipts[0] });
    if (!failed) expect(receipts[1]).not.toBe(receipts[0]);
    vi.mocked(invoke).mockImplementation(original);
  });

  it("does not promote text after an out-of-band reservation until a full reset, then checkpoints acknowledged human text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive();
    act(() => { expect(view.result.current.reserveOperation()).not.toBeNull(); });
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await typeAndSend(view.result, "alpha later");
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    expectLeft({ checkpoint: { text: "alpha", version: 10 } });
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    act(() => view.result.current.resumePaths(["a.tex"]));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    await typeAndSend(view.result, "alpha after reset");
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves()).toHaveLength(2));
    // A debounced send can land after the leave under load, so check the leave itself, not call order.
    expect(invokeCalls("overleaf_rt_leave_doc").at(-1)).toEqual(expect.objectContaining({
      docId: DOC_A, checkpoint: { text: "alpha after reset", version: 11 },
    }));
  });

  it.each([
    { mixed: false, reopen: false }, { mixed: true, reopen: false },
    { mixed: false, reopen: true }, { mixed: true, reopen: true },
  ])("only checkpoints applied catch-up (mixed: $mixed, reopen: $reopen)", async ({ mixed, reopen }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive({ onRemoteText: (text) => !text.startsWith("peer ") });
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
    backend.loseSendAck = !reopen;
    await typeAndSend(view.result, "alpha human");
    if (reopen) {
      view.rerender({ activeFile: "b.tex" });
      await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
      view.rerender({ activeFile: "a.tex" });
      await waitFor(() => expect(joinsOf(DOC_B)).toHaveLength(1));
      await act(async () => {});
    }
    if (!mixed) act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    expectLeft({ checkpoint: mixed ? { text: "alpha", version: 10 } : { text: "alpha human", version: 11 } });
  });

  it("hands external writes to sync, drains owned operations, and rejoins only after reconciliation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onNeedsSync = vi.fn();
    const view = await mountLive({ onRemoteText: () => true, onNotice: vi.fn(), onNeedsSync });
    await typeAndSend(view.result, "alpha local");
    act(() => view.result.current.suspendPaths(["a.tex"]));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
    expect(onNeedsSync).toHaveBeenCalledWith(["a.tex"]);
    const joined = joins().length;
    act(() => view.result.current.resumePaths(["a.tex"]));
    expect(joins()).toHaveLength(joined);
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    expect(joins()).toHaveLength(joined);
    act(() => view.result.current.resumePaths(["a.tex"]));
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(joins()).toHaveLength(joined + 1);
  });

  it("serializes disk applies and does not send intermediate snapshots back to Overleaf", async () => {
    let finish!: () => void;
    const seen: string[] = [];
    const bases: string[] = [];
    const view = await mountLive({
      onRemoteText: async (text, _caret, context) => {
        seen.push(text);
        bases.push(context.baseContent);
        if (text === "alpha one") await new Promise<void>((resolve) => { finish = resolve; });
      },
    });
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
    expect(sends()).toEqual([]);
    expect(view.result.current.settledVersion()).toBe(12);
  });

  it("falls back without accepting a stale snapshot on reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let buffer = "alpha";
    const view = await mountLive({ onRemoteText: (text) => text === buffer });
    emit({ type: "disconnected", reason: "network changed" });
    buffer = "agent revision while offline";
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    await waitFor(() => expect(joins().length).toBeGreaterThan(1));
    await waitFor(() => expect(view.result.current.detail).toMatch(/outside live editing/));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual([]);
    expect(sends()).toEqual([]);
    expect(buffer).toBe("agent revision while offline");
  });

  it("invalidates an in-flight apply across a file switch and reopen", async () => {
    let finish!: () => void;
    let oldIsCurrent = () => true;
    const view = await mountLive({
      onRemoteText: async (text, _caret, context) => {
        if (text !== "alpha one") return;
        oldIsCurrent = context.isCurrent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return false;
      },
    });
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 5, i: " one" }], source: "peer" });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.rerender({ activeFile: "b.tex" });
    await waitFor(() => expect(view.result.current.docId).toBe(DOC_B));
    view.rerender({ activeFile: "a.tex" });
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(oldIsCurrent()).toBe(false);
    await act(async () => finish());
    expect(view.result.current.docId).toBe(DOC_A);
    expect(view.result.current.liveFile).toBe(true);
  });

  it("retains unacknowledged operations when a disk conflict falls back to sync", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountLive({ onRemoteText: (text) => text === "alpha" });
    await typeAndSend(view.result, "alpha local");
    expect(sends()).toHaveLength(1);
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: [{ p: 0, i: "remote " }], source: "peer" });
    await waitFor(() => expect(view.result.current.detail).toMatch(/outside live editing/));
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual(["a.tex"]);
    expect(leaves()).not.toContain(DOC_A);
    emit({ type: "docAck", docId: DOC_A, version: 11 });
    await waitFor(() => expect(view.result.current.livePaths).toEqual([]));
    expect(leaves()).toContain(DOC_A);
    expectLeft({ docId: DOC_A, checkpoint: { text: "alpha", version: 10 } });
  });
});

describe("connection ownership", () => {
  it("explains the regular-sync fallback in the selected language", async () => {
    const { result } = mount({ activeFile: "presentation.html" });
    await waitFor(() => expect(result.current.detail).toBe(
      "Overleaf doesn’t support live editing for this file, so it will use regular sync.",
    ));

    await act(async () => activateAppLocale("zh-CN"));
    await waitFor(() => expect(result.current.detail).toBe("Overleaf 不支持实时编辑此文件，将改用常规同步。"));
  });

  it("uses an explicit global disconnect when live mode is disabled without a root", async () => {
    mount({ enabled: false, projectRoot: null, activeFile: "" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_rt_disconnect", { projectRoot: null }));
  });

  it("keeps delayed document cleanup scoped to the project that owned it", async () => {
    const { result, rerender } = mount({ projectRoot: "/tmp/project-a" });
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    const scoped = (command: string, projectRoot: string) =>
      expect(invokeCalls(command)).toContainEqual(expect.objectContaining({ projectRoot, docId: DOC_A }));
    scoped("overleaf_rt_join_doc", "/tmp/project-a");

    rerender({ projectRoot: "/tmp/project-b" });
    await waitFor(() => scoped("overleaf_rt_leave_doc", "/tmp/project-a"));
    await waitFor(() => scoped("overleaf_rt_join_doc", "/tmp/project-b"));
  });

  it("reconnects with backoff after the live channel closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(invokeCalls("overleaf_rt_connect")).toHaveLength(1);

    emit({ type: "disconnected", reason: "network changed" });
    await waitFor(() => expect(result.current.status).toBe("connecting"));
    expect(result.current.permission).toBe("unknown");
    expect(result.current.canWrite).toBe(false);
    expect(result.current.detail).toMatch(/reconnecting in 1s/i);

    await advance(1_100);
    await waitFor(() => expect(invokeCalls("overleaf_rt_connect")).toHaveLength(2));
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.detail).toBeNull();
  });

  it("retries a transient initial failure but does not loop on an expired session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.connectFailures = 1;
    const transient = mount();
    await waitFor(() => expect(transient.result.current.status).toBe("connecting"));
    await advance(1_100);
    await waitFor(() => expect(transient.result.current.status).toBe("live"));
    expect(invokeCalls("overleaf_rt_connect")).toHaveLength(2);
    transient.unmount();

    vi.mocked(invoke).mockClear();
    backend.connectFailures = 1;
    backend.connectError = "Overleaf session expired. Reconnect in Settings.";
    const expired = mount();
    await waitFor(() => expect(expired.result.current.status).toBe("error"));
    await advance(60_000);
    expect(invokeCalls("overleaf_rt_connect")).toHaveLength(1);
  });
});

describe("switching files with work in flight", () => {
  it("keeps an update that arrives while a newly uploaded Markdown document is joining", async () => {
    let resolveJoin!: (joined: ReturnType<typeof joinAnswer>) => void;
    backend.deferredJoin = { docId: DOC_MD, promise: new Promise((resolve) => { resolveJoin = resolve; }) };
    const remoteTexts: string[] = [];
    const { result } = mount({ activeFile: "notes.md", onRemoteText: (text) => { remoteTexts.push(text); } });
    await waitFor(() => expect(result.current.status).toBe("live"));

    const docs = [{ id: DOC_A, path: "a.tex" }, { id: DOC_B, path: "b.tex" }, { id: DOC_MD, path: "notes.md" }];
    emit({ type: "treeChanged", docs, entities: [] });
    await waitFor(() => expect(joins()).toContainEqual({ docId: DOC_MD, fromVersion: null }));

    // Overleaf can emit an edit after joining the room but before the join
    // command's snapshot has crossed the IPC boundary back to React.
    emit({ type: "docUpdate", docId: DOC_MD, version: 10, ops: [{ p: 5, i: " online" }], source: "someone-else" });
    resolveJoin({ text: "notes", version: 10, comments: [], changes: [], caughtUp: [], resumed: false });

    await waitFor(() => expect(result.current.liveFile).toBe(true));
    expect(remoteTexts.at(-1)).toBe("notes online");
  });

  it("holds a document owing an answer past the drain timeout and across removal or rename, until answered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, rerender } = await mountLive();
    expect(joins()).toEqual([{ docId: DOC_A, fromVersion: null }]);

    // Type, and let the send debounce fire so an operation is outstanding.
    await typeAndSend(result, "alpha edited");
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].docId).toBe(DOC_A);

    // Move to the other file before the answer arrives; well past the old
    // drain timeout, ordinary sync still may not own the path.
    rerender({ activeFile: "b.tex" });
    await waitFor(() => expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]));
    await advance(60_000);
    expect(leaves()).not.toContain(DOC_A);
    expect(result.current.livePaths).toContain("a.tex");

    // A collaborator deletes the path while its last edit is still awaiting
    // an answer. Losing the old lookup here would let REST own a.tex.
    emit({ type: "treeChanged", docs: [{ id: DOC_B, path: "b.tex" }], entities: [] });
    expect(result.current.livePaths).toEqual(["a.tex", "b.tex"]);

    // If the same entity id returns at a new path, that authoritative path
    // replaces the remembered one.
    emit({ type: "treeChanged", docs: [{ id: DOC_A, path: "renamed.tex" }, { id: DOC_B, path: "b.tex" }], entities: [] });
    expect(result.current.livePaths).toEqual(["b.tex", "renamed.tex"]);

    // A late answer proves the operation landed; only then is the room given up.
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    await waitFor(() => expect(result.current.livePaths).toEqual(["b.tex"]));
  });

  it("sends what the debounce was still holding, and checkpoints it only after its draining acknowledgement", async () => {
    const { result, rerender } = await mountLive();

    // Typed and switched away inside the debounce window.
    act(() => result.current.pushLocal("alpha final"));
    rerender({ activeFile: "b.tex" });

    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].docId).toBe(DOC_A);
    expect(sends()[0].ops).not.toHaveLength(0);
    expect(leaves()).not.toContain(DOC_A);
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    expectLeft({ docId: DOC_A, checkpoint: { text: "alpha final", version: 11 } });
  });

  it("resumes from the held version on return, and keeps unreplayable local work paused past the drain timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemoteText = vi.fn();
    const { result, rerender } = await mountLive({ onRemoteText });

    await typeAndSend(result, "alpha local");
    await waitFor(() => expect(sends()).toHaveLength(1));
    rerender({ activeFile: "b.tex" });
    await waitFor(() => expect(result.current).toMatchObject({ docId: DOC_B, liveFile: true }));
    // Back to the first file while it is still held.
    rerender({ activeFile: "a.tex" });
    await waitFor(() => expect(joins()).toHaveLength(3));
    expect(joins()[2]).toEqual({ docId: DOC_A, fromVersion: 10 });

    // The default mock answer says resumed:false. Taking its "alpha" snapshot
    // here would discard "alpha local", so the file stays held and paused.
    await waitFor(() => expect(result.current.liveFile).toBe(false));
    expect(result.current.livePaths).toEqual(["a.tex"]);
    expect(onRemoteText.mock.calls.map(([text]) => text)).toEqual(["alpha", "beta"]);
    expect(result.current.detail).toMatch(/paused/i);

    // Well past the old drain timeout, its path is still protected from ordinary sync.
    await advance(60_000);
    expect(leaves()).not.toContain(DOC_A);
    expect(result.current.liveFile).toBe(false);
    expect(result.current.livePaths).toContain("a.tex");
  });
});

describe("an acknowledgement whose outcome is not known", () => {
  it("rejoins from the trusted version after a lost send ack and never retransmits blindly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.loseSendAck = true;
    const { result, rerender } = await mountLive();

    await typeAndSend(result, "alpha edited");
    await waitFor(() => expect(sends()).toHaveLength(1));
    await waitFor(() => expect(joins()).toContainEqual({ docId: DOC_A, fromVersion: 10 }));
    expect(sends()).toHaveLength(1);

    // Catch-up identified our committed operation, so switching can release
    // the settled room rather than uploading the file through REST.
    rerender({ activeFile: "b.tex" });
    await waitFor(() => expect(leaves()).toContain(DOC_A));
    await waitFor(() => expect(result.current.livePaths).toEqual(["b.tex"]));
  });

  it("does not apply catch-up while its own public id is unknown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.publicId = null;
    backend.loseSendAck = true;
    const onRemoteText = vi.fn();
    const { result } = await mountLive({ onRemoteText });
    expect(onRemoteText).toHaveBeenLastCalledWith("alpha", 0, expect.objectContaining({
      projectRoot: "/tmp/project", path: "a.tex", baseContent: "alpha",
    }));

    await typeAndSend(result, "alpha edited");
    await waitFor(() => expect(joins()).toContainEqual({ docId: DOC_A, fromVersion: 10 }));

    // The replay says source "me", but without our public id Lattice cannot
    // prove that means us. Applying it as remote would duplicate " edited".
    expect(onRemoteText).toHaveBeenCalledTimes(1);
    expect(sends()).toHaveLength(1);
    expect(result.current.livePaths).toEqual(["a.tex"]);
    expect(result.current.detail).toMatch(/paused/i);
  });

  /** Send "alpha edited", lose its answer with the connection, and reconnect under a new id. */
  async function loseSendAcrossReconnect(onRemoteText: Options["onRemoteText"]) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.loseSendAck = true;
    const view = await mountLive({ onRemoteText });
    backend.joinsFail = true;
    await typeAndSend(view.result, "alpha edited");
    await waitFor(() => expect(sends()).toHaveLength(1));
    emit({ type: "disconnected", reason: "network changed" });
    // Overleaf names every connection afresh, so the replay of what we sent
    // before still says "me" while this connection is "me-2".
    backend.publicId = "me-2";
    backend.joinsFail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    await waitFor(() => expect(joins()).toContainEqual({ docId: DOC_A, fromVersion: 10 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    return view;
  }

  it("recognises its own update replayed under the previous connection's id instead of applying it twice", async () => {
    const seen: string[] = [];
    const { result } = await loseSendAcrossReconnect((text) => { seen.push(text); });

    expect(seen.some((text) => text.includes("edited edited"))).toBe(false);
    await waitFor(() => expect(seen.at(-1)).toBe("alpha edited"));
    // It landed; nothing is resent, and the file is no longer held back.
    expect(sends()).toHaveLength(1);
    expect(result.current.settledVersion()).toBe(11);
  });

  it("resends an update that never landed, naming the connection it first went out on", async () => {
    backend.lostSendMissing = true;
    const { result } = await loseSendAcrossReconnect(() => undefined);

    await waitFor(() => expect(sends()).toHaveLength(2));
    const [first, resend] = invokeCalls("overleaf_rt_send_ops");
    expect(first).not.toHaveProperty("dupIfSource");
    // Overleaf acknowledges rather than reapplies it if the first copy lands late.
    expect(resend).toMatchObject({ docId: DOC_A, version: 10, ops: first!.ops, dupIfSource: ["me"] });
    expect(result.current.livePaths).toEqual(["a.tex"]);

    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(result.current.settledVersion()).toBe(11));
    // Once answered on this connection it is never sent a third time.
    expect(sends()).toHaveLength(2);
  });

  it("recognises the first copy landing late under the previous connection's id instead of applying it twice", async () => {
    backend.lostSendMissing = true;
    const seen: string[] = [];
    const { result } = await loseSendAcrossReconnect((text) => { seen.push(text); });
    await waitFor(() => expect(sends()).toHaveLength(2));
    const [first] = invokeCalls("overleaf_rt_send_ops");

    // The first copy commits after all and is broadcast under its old id.
    emit({ type: "docUpdate", docId: DOC_A, version: 10, ops: first!.ops, source: "me" });
    // Overleaf then answers the resend as a duplicate.
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(result.current.settledVersion()).toBe(11));
    expect(seen.some((text) => text.includes("edited edited"))).toBe(false);
  });
});

describe("the update hash", () => {
  it("is Overleaf's git-blob SHA-1 of the text the update produces", async () => {
    expect(await overleafDocHash("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await overleafDocHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("rides on an update now and then, never on one sent behind queued work", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await mountLive();
    await typeAndSend(result, "alpha edited");
    await waitFor(() => expect(sends()).toHaveLength(1));
    // `printf 'alpha edited' | git hash-object --stdin`
    expect(sends()[0]).toMatchObject({ version: 10, hash: "4d07786ac58e50541ba6ca85027b45ba5e038dba" });

    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await typeAndSend(result, "alpha edited!");
    await waitFor(() => expect(sends()).toHaveLength(2));
    // Within five seconds of the last one: no hash, the same as Overleaf's editor.
    expect(sends()[1]).not.toHaveProperty("hash");
  });
});

describe("characters Overleaf cannot store", () => {
  it("sends and shows U+FFFD in their place, the way the server stores them, and says so once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemoteText = vi.fn();
    const onNotice = vi.fn();
    const { result } = await mountLive({ onRemoteText, onNotice });

    await typeAndSend(result, "alpha \u{1F535}");
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]!.ops).toEqual([{ p: 5, i: " \uFFFD\uFFFD" }]);
    // The editor is swapped to the stored text, guarded on still holding what was typed.
    await waitFor(() => expect(onRemoteText).toHaveBeenLastCalledWith(
      "alpha \uFFFD\uFFFD", 0, expect.objectContaining({ baseContent: "alpha \u{1F535}" }),
    ));
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]![0]).toMatch(/replaced with �/);

    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await typeAndSend(result, "alpha \uFFFD\uFFFD \u{1D538}");
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(onNotice).toHaveBeenCalledTimes(1);
  });
});

describe("an error in one document", () => {
  it("is ignored for a document we are not holding, and otherwise stops that file without the connection", async () => {
    const { result } = await mountLive();
    emit({ type: "otError", docId: "some-other-doc", message: "nope" });
    expect(result.current.status).toBe("live");
    expect(result.current.liveFile).toBe(true);

    emit({ type: "otError", docId: DOC_A, message: "rejected" });
    await waitFor(() => expect(result.current.liveFile).toBe(false));
    // Chat, presence and the file tree ride this same connection, and one
    // file's rejection says nothing about any of them.
    expect(result.current.status).toBe("live");
    expect(leaves()).toContain(DOC_A);
    expect(result.current.detail).toMatch(/rejected/);
  });
});

describe("settled guards around REST mutations", () => {
  it("treats debounced and in-flight typing as unsettled, and reload never overwrites it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRemoteText = vi.fn();
    const { result } = await mountLive({ onRemoteText });
    expect(result.current.settledVersion()).toBe(10);

    // Still inside the 250 ms debounce: OtDocument itself is settled, but the
    // editor already holds local text that a reload must not replace.
    act(() => result.current.pushLocal("alpha debounced"));
    expect(result.current.settledVersion()).toBeNull();
    act(() => result.current.reload());
    expect(joins()).toHaveLength(1);
    expect(onRemoteText).toHaveBeenCalledTimes(1);

    // Once flushed, the same guard is carried by OtDocument's in-flight op.
    await advance(300);
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(result.current.settledVersion()).toBeNull();
    act(() => result.current.reload());
    expect(joins()).toHaveLength(1);
    expect(onRemoteText).toHaveBeenCalledTimes(1);

    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(result.current.settledVersion()).toBe(11));
  });
});

describe("what typing goes out as", () => {
  it.each([
    ["an owner", "owner", 1, true],
    ["a writer", "readAndWrite", 1, true],
    ["a comment-only reviewer", "review", 0, false],
    ["a viewer", "readOnly", 0, false],
    // Unknown fails closed until Overleaf names a role.
    ["an account with no permission named yet", "unknown", 0, false],
  ])("sends %s's typing as ordinary edits only when it may write", async (_label, role, sent, canWrite) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.permission = role;
    const { result } = await mountLive();
    expect(result.current.canWrite).toBe(canWrite);
    await typeAndSend(result, "alpha edited");
    await waitFor(() => expect(sends()).toHaveLength(sent));
    // An unknown permission is never written into SyncState.
    expect(invokeCalls("overleaf_set_permission")).not.toContainEqual(expect.objectContaining({ permission: "unknown" }));
  });
});

describe("durable sync permission", () => {
  const permissionWrites = () => invokeCalls("overleaf_set_permission");

  it("records a known realtime permission, but never project A's after switching to project B", async () => {
    backend.permission = "readOnly";
    const { rerender } = mount({ projectRoot: "/tmp/project-a" });
    await waitFor(() => expect(permissionWrites()).toContainEqual({ permission: "readOnly", projectRoot: "/tmp/project-a" }));

    backend.permission = "owner";
    rerender({ projectRoot: "/tmp/project-b" });
    await waitFor(() => expect(permissionWrites()).toContainEqual({ permission: "owner", projectRoot: "/tmp/project-b" }));
    expect(permissionWrites()).not.toContainEqual({ permission: "readOnly", projectRoot: "/tmp/project-b" });
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
    backend.anchors = {
      comments: [{ threadId: "t1", position: 20, quote: "quoted" }],
      changes: [{ id: "c1", position: 10, text: "suggested", deletion: false, userId: "them", timestamp: null, hue: 200 }],
    };
  });

  const mountWithAnchors = async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.changes).toHaveLength(1));
    return view.result;
  };
  const peerUpdate = (ops: unknown[]) => emit({ type: "docUpdate", docId: DOC_A, version: 10, ops, source: "someone-else" });

  it.each([
    ["a collaborator types above", () => peerUpdate([{ p: 0, i: "12345" }]), 5],
    ["we type above them ourselves", (result: Hook) => typeAndSend(result, "XXalpha"), 2],
  ])("moves them along when %s", async (_label, typeAbove, shift) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const result = await mountWithAnchors();
    await typeAbove(result);
    await waitFor(() => expect(result.current.changes[0].position).toBe(10 + shift));
    expect(result.current.comments[0].position).toBe(20 + shift);
  });

  it("drops a suggestion whose text was deleted outright", async () => {
    const result = await mountWithAnchors();
    peerUpdate([{ p: 10, d: "suggested" }]);
    // Nothing left to accept or reject; offering a button that would act on
    // whatever moved into its place is worse than offering none.
    await waitFor(() => expect(result.current.changes).toHaveLength(0));
  });
});
