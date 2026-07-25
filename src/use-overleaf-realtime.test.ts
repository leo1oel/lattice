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

function joinAnswer(docId: string) {
  return {
    text: docId === DOC_A ? "alpha" : "beta",
    version: 10,
    comments: [],
    changes: [],
    caughtUp: [],
    resumed: false,
  };
}

beforeEach(() => {
  joins = [];
  sends = [];
  leaves = [];
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
        permission: "readAndWrite",
        trackChanges: false,
        userId: "user-1",
      };
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

  it("stops live editing when it belongs to a document we are holding", async () => {
    const { result } = mount("a.tex");
    await waitFor(() => expect(result.current.liveFile).toBe(true));

    emit({ type: "otError", docId: DOC_A, message: "rejected" });
    await waitFor(() => expect(result.current.status).toBe("error"));
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
