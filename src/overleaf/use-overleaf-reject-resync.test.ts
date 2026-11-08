/**
 * Rejecting a suggestion over the live channel, against a model of Overleaf's
 * document updater: updates are transformed against whatever landed since the
 * version they were made at, a hash is checked when nothing was transformed,
 * and the sender is answered with the version alone. The reject itself is an
 * update this side's OT copy never applied, so the copy has to be re-read
 * from Overleaf before anything else is sent (implicit-state audit S5).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCalls, mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { applyOps, transformBoth, type OtOp } from "./ot";
import { createOverleafConnectionStore } from "./overleaf-connection-store";
import { overleafDocHash, type TrackedChange } from "./overleaf-realtime-model";
import { useOverleafRealtime } from "./use-overleaf-realtime";
import { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import {
  cleanupRealtimeBackend, DOC_A, emit as emitRealtime, expectLeft, joinsOf, leaves, mountLive as mountRealtimeLive, resetRealtimeBackend,
  sends, typeAndSend,
} from "./use-overleaf-realtime-test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const ROOT = "/tmp/project";
/** "brave " is someone's suggested insertion. */
const INSERTION: TrackedChange = { id: "c-ins", position: 6, text: "brave ", deletion: false, userId: "them", timestamp: null, hue: 40 };

/** One Overleaf document, as its document updater keeps it. */
class OverleafDoc {
  history: OtOp[][] = [];
  constructor(public text: string, public from: number, public changes: TrackedChange[]) {}
  get version() { return this.from + this.history.length; }
  /** Apply `ops` made at version `at`; the version it landed at, or why it was refused. */
  async submit(ops: OtOp[], at: number, hash?: string): Promise<number | string> {
    if (at < this.from || at > this.version) return "version";
    let incoming = ops;
    for (const landed of this.history.slice(at - this.from)) [, incoming] = transformBoth(landed, incoming);
    const next = applyOps(this.text, incoming);
    if (next === null) return "mismatch";
    if (hash && at === this.version && await overleafDocHash(next) !== hash) return "hash";
    this.text = next;
    this.history.push(incoming);
    return this.version - 1;
  }
}

let server: OverleafDoc;
let emit: (payload: Record<string, unknown>) => void;
/** Answers Overleaf owes this client, delivered when the test says so. */
let owed: Record<string, unknown>[];
let rejected: TrackedChange[][];
let joinFailures: number;
/** What the editor shows; remote text lands only over the text it was computed from, as the app's does. */
let editor: string;

/** Overleaf's document updater behind the mocked commands; see OverleafDoc. */
function serveOverleaf() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server = new OverleafDoc("Hello brave world", 10, [INSERTION]);
  owed = [];
  rejected = [];
  joinFailures = 0;
  editor = "";
  const deliver = mockListen();
  emit = (payload) => deliver({ projectRoot: ROOT, ...payload });
  const answer = async (ops: OtOp[], version: number, hash?: string) => {
    const landed = await server.submit(ops, version, hash);
    owed.push(typeof landed === "number"
      ? { type: "docAck", docId: DOC_A, version: landed }
      : { type: "otError", docId: DOC_A, message: landed });
  };
  mockInvoke({
    overleaf_rt_connect: {
      publicId: "me", docs: [{ id: DOC_A, path: "a.tex" }], entities: [],
      permission: "readAndWrite", trackChanges: false, userId: "me-user", ownHue: 210,
    },
    overleaf_rt_join_doc: () => {
      if (joinFailures > 0) {
        joinFailures -= 1;
        throw new Error("the connection is closing");
      }
      return { text: server.text, version: server.version, comments: [], changes: server.changes, caughtUp: [], resumed: false };
    },
    // Answers once Overleaf has queued the update, not once it is applied (docs/overleaf-protocol.md).
    overleaf_rt_send_ops: async ({ ops, version, hash }: { ops: OtOp[]; version: number; hash?: string }) => answer(ops, version, hash),
    // The inverse operations client.rs builds, from the end of the document backwards.
    overleaf_reject_changes: async ({ version, changes }: { version: number; changes: TrackedChange[] }) => {
      rejected.push(changes);
      const ops = [...changes].sort((a, b) => b.position - a.position)
        .map((change) => (change.deletion ? { p: change.position, i: change.text } : { p: change.position, d: change.text }));
      const ids = new Set(changes.map((change) => change.id));
      server.changes = server.changes.filter((change) => !ids.has(change.id));
      await answer(ops, version);
    },
    overleaf_change_authors: [],
    overleaf_rt_doc_ranges: () => ({ text: "", version: server.version, comments: [], changes: server.changes, caughtUp: [], resumed: true }),
    overleaf_rt_leave_doc: undefined,
    overleaf_rt_disconnect: undefined,
    overleaf_set_permission: undefined,
  });
}
afterEach(cleanupRealtimeBackend);

/** The realtime channel and the review panel's accept/reject, wired as the workspace wires them. */
async function mountLive() {
  const store = createOverleafConnectionStore();
  const view = renderHook(() => {
    const realtime = useOverleafRealtime({
      store, enabled: true, documents: true, projectRoot: ROOT, activeFile: "a.tex",
      onRemoteText: (text, { baseContent }) => {
        if (editor !== baseContent) return false;
        editor = text;
        return true;
      },
      onNotice: () => undefined,
    });
    const review = useOverleafTrackChanges({
      enabled: true, projectRoot: ROOT, docId: realtime.docId,
      reserveOperation: realtime.reserveOperation, noteReservedOperationUnknown: realtime.noteReservedOperationUnknown,
      settledVersion: realtime.settledVersion, changes: realtime.changes, canAct: realtime.canWrite, reload: realtime.reload,
    });
    return { realtime, review };
  });
  editor = server.text;
  await waitFor(() => expect(view.result.current.realtime.liveFile).toBe(true));
  return view.result;
}

/** Deliver every answer Overleaf owes, in order. */
const answerAll = () => act(async () => {
  for (const payload of owed.splice(0)) emit(payload);
});

async function type(text: string) {
  editor = text;
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
}

describe("rejecting a suggestion live", () => {
  beforeEach(serveOverleaf);

  it("re-reads the document once Overleaf has applied the reject, then edits land where they were typed", async () => {
    const result = await mountLive();
    expect(result.current.realtime.changes).toEqual([INSERTION]);

    await act(() => result.current.review.reject([INSERTION]));
    expect(server.text).toBe("Hello world");
    // The answer comes after reject returned and asked for its reload.
    await answerAll();

    await waitFor(() => expect(editor).toBe("Hello world"));
    expect(joinsOf(DOC_A)).toEqual([{ docId: DOC_A, fromVersion: null }, { docId: DOC_A, fromVersion: null }]);
    await waitFor(() => expect(result.current.realtime.changes).toEqual([]));
    expect(result.current.realtime.detail).toBeNull();

    // Typed after the reject: built on Overleaf's text, so it lands at the end there too.
    await type("Hello world, again");
    await act(async () => {
      result.current.realtime.pushLocal(editor);
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(sends()).toHaveLength(1));
    await answerAll();
    expect(server.text).toBe("Hello world, again");
    await waitFor(() => expect(result.current.realtime.unacknowledged).toBe(false));
  });

  it("sends nothing typed while the reject is unanswered until the document is re-read", async () => {
    const result = await mountLive();
    await act(() => result.current.review.reject([INSERTION]));

    // Typed into the editor, which still shows the rejected words.
    await act(async () => {
      result.current.realtime.pushLocal("Hello brave world later");
      vi.advanceTimersByTime(300);
    });
    expect(result.current.realtime.unacknowledged).toBe(true);
    await answerAll();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    // Built on the copy without the reject, it would have deleted or misplaced text on Overleaf.
    expect(sends()).toEqual([]);
    expect(server.text).toBe("Hello world");
    await waitFor(() => expect(joinsOf(DOC_A)).toHaveLength(2));
  });

  it("keeps re-reading until a join succeeds", async () => {
    const result = await mountLive();
    joinFailures = 2;
    await act(() => result.current.review.reject([INSERTION]));
    await answerAll();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(editor).toBe("Hello world"));
    expect(joinsOf(DOC_A)).toHaveLength(4);
    await waitFor(() => expect(result.current.realtime.changes).toEqual([]));
  });

  it("does nothing on a second Reject of a suggestion already rejected", async () => {
    const result = await mountLive();
    // A deletion suggestion: rejecting it twice put the words back twice.
    const deletion: TrackedChange = { id: "c-del", position: 6, text: "bold ", deletion: true, userId: "them", timestamp: null, hue: 40 };
    server.changes = [deletion];
    await act(async () => {
      result.current.realtime.reload();
    });
    await waitFor(() => expect(result.current.realtime.changes).toEqual([deletion]));

    await act(() => result.current.review.reject([deletion]));
    // The card is still on screen until the re-read: a second click.
    await act(() => result.current.review.reject([deletion]));
    await answerAll();
    await act(() => result.current.review.reject([deletion]));

    expect(rejected).toEqual([[deletion]]);
    expect(server.text).toBe("Hello bold brave world");
    await waitFor(() => expect(editor).toBe("Hello bold brave world"));
  });
});

describe("an out-of-band reservation", () => {
  beforeEach(() => {
    resetRealtimeBackend();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("does not promote text after it, and replaces that copy once it is answered", async () => {
    const view = await mountRealtimeLive();
    act(() => { expect(view.result.current.reserveOperation()).not.toBeNull(); });
    // Typed before the answer: built on a copy without the reserved
    // operation's text, so it is held rather than sent (audit S5).
    await typeAndSend(view.result, "alpha later", { sent: false });
    emitRealtime({ type: "docAck", docId: DOC_A, version: 10 });
    // The answer replaces the copy from scratch; the stale one leaves with the last text it proved.
    await waitFor(() => expect(joinsOf(DOC_A)).toEqual([{ docId: DOC_A, fromVersion: null }, { docId: DOC_A, fromVersion: null }]));
    expectLeft({ checkpoint: { text: "alpha", version: 10 } });
    await waitFor(() => expect(view.result.current.liveFile).toBe(true));
    expect(sends()).toEqual([]);
    await typeAndSend(view.result, "alpha after reset");
    emitRealtime({ type: "docAck", docId: DOC_A, version: 10 });
    act(() => view.result.current.suspendPaths(["a.tex"]));
    await waitFor(() => expect(leaves()).toHaveLength(2));
    // A debounced send can land after the leave under load, so check the leave itself, not call order.
    expect(invokeCalls("overleaf_rt_leave_doc").at(-1)).toEqual(expect.objectContaining({
      docId: DOC_A, checkpoint: { text: "alpha after reset", version: 11 },
    }));
  });
});
