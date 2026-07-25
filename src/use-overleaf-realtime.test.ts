/**
 * What happens to a document when the writer moves to another file.
 *
 * A document that still owes Overleaf an operation cannot simply be dropped:
 * the answer is addressed to it and arrives on the channel whatever is on
 * screen, and leaving its room first sends both the acknowledgement and any
 * rejection somewhere nobody is listening. These cover that it is kept until
 * it settles, and that coming back to it resumes rather than starts over.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useOverleafRealtime } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const DOC_A = "doc-a";
const DOC_B = "doc-b";

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

function joinAnswer(docId: string) {
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
    if (command === "overleaf_rt_connect") {
      return {
        publicId: "me",
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
      joins.push({
        docId: input.docId as string,
        fromVersion: (input.fromVersion as number | null) ?? null,
      });
      return joinAnswer(input.docId as string);
    }
    if (command === "overleaf_rt_send_ops") {
      sends.push({
        docId: input.docId as string,
        version: input.version as number,
        ops: input.ops as unknown[],
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
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  vi.useRealTimers();
});

function mount(activeFile: string) {
  return renderHook(
    (file: string) => useOverleafRealtime({
      enabled: true,
      documents: true,
      projectRoot: "/tmp/project",
      activeFile: file,
      onRemoteText: () => undefined,
      readCaret: () => 0,
      onNotice: () => undefined,
    }),
    { initialProps: activeFile },
  );
}

describe("switching files with work in flight", () => {
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

    // The answer still arrives, and only then is the room given up.
    emit({ type: "docAck", docId: DOC_A, version: 10 });
    await waitFor(() => expect(leaves).toContain(DOC_A));
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

    // Well past the drain timeout, with the file open and being typed in.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(leaves).not.toContain(DOC_A);
    expect(result.current.liveFile).toBe(true);
  });
});

/**
 * Suggesting is not a display mode. The toolbar can turn Overleaf's setting
 * on, but if the keystrokes still leave as ordinary edits then the label is
 * simply untrue — the text lands in everyone's document immediately while the
 * button claims it is waiting to be reviewed.
 */
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

  it("sends suggestions once the account has turned it on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.trackChanges = true;
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));

    await typeInto(result);
    await waitFor(() => expect(tracked).toHaveLength(1));
    expect(sends).toHaveLength(0);
  });

  it("follows the setting when it is turned on mid-session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    emit({ type: "trackChangesToggled", on: true });
    await waitFor(() => expect(result.current.trackChanges).toBe(true));
    await typeInto(result);
    await waitFor(() => expect(tracked).toHaveLength(1));
    expect(sends).toHaveLength(0);
  });

  it("lets a reviewer type, but only ever as suggestions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.permission = "review";
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    // They cannot change the document directly, which is a different question
    // from whether they may contribute at all.
    expect(result.current.canWrite).toBe(false);

    await typeInto(result);
    await waitFor(() => expect(tracked).toHaveLength(1));
    expect(sends).toHaveLength(0);
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

/**
 * Your own suggestion has to become visible where you made it. Overleaf never
 * echoes an operation back to whoever sent it, so nothing on the channel says
 * the suggestion exists — which is why suggesting looked exactly like editing
 * from this side.
 */
describe("a suggestion you just made", () => {
  it("is read back so it shows as a suggestion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    account.trackChanges = true;
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));
    await waitFor(() => expect(result.current.trackChanges).toBe(true));

    await act(async () => {
      result.current.pushLocal("alpha suggested");
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(tracked).toHaveLength(1));

    // Nothing yet — the read is debounced, because a burst of typing is one
    // suggestion being written rather than many.
    expect(rangeReads).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(rangeReads).toEqual([DOC_A]));
    await waitFor(() => expect(result.current.changes).toHaveLength(1));
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
