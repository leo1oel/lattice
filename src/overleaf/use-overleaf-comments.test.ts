/**
 * The part of the comments layer that had a real bug in it: Overleaf keys
 * resolve, reopen and delete by the document a thread lives in, and this hook
 * used to hand it whichever document happened to be open. Acting on a comment
 * from any other file therefore addressed the wrong document.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeCalls, mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { useOverleafComments } from "./use-overleaf-comments";
import type { OverleafThread } from "../app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const HERE = "doc-open";
const ELSEWHERE = "doc-other";

const thread = (id: string): OverleafThread => ({
  id, resolved: false, resolvedBy: null, resolvedAt: null,
  messages: [{ id: `${id}-m1`, content: "have a look at this", authorName: "Ada Lovelace", authorEmail: null, timestamp: 1, mine: true }],
});

/** Two threads: one in the open document, one in a file that is not. */
function mockProject(anchors: unknown[] = [
  { threadId: "t-here", docId: HERE, position: 10, quote: "here" },
  { threadId: "t-elsewhere", docId: ELSEWHERE, position: 40, quote: "elsewhere" },
]) {
  mockInvoke({
    overleaf_threads: [thread("t-here"), thread("t-elsewhere")],
    overleaf_comment_anchors: anchors,
    overleaf_resolve_thread: undefined,
    overleaf_delete_thread: undefined,
    overleaf_edit_message: undefined,
    overleaf_delete_message: undefined,
  });
}

function mount() {
  return renderHook(() => useOverleafComments({
    enabled: true,
    projectRoot: "/tmp/project",
    anchor: async () => undefined,
  }));
}

afterEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("useOverleafComments", () => {
  it("keeps a new comment bound to its original document across a file switch", async () => {
    let releaseReply!: () => void;
    const replyPending = new Promise<void>((resolve) => { releaseReply = resolve; });
    mockInvoke({ overleaf_reply_to_thread: () => replyPending, overleaf_threads: [], overleaf_comment_anchors: [] });
    const anchor = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ projectRoot }) => useOverleafComments({ enabled: true, projectRoot, anchor }),
      { initialProps: { projectRoot: "/tmp/project-a" } },
    );
    const target = { projectRoot: "/tmp/project-a", docId: "doc-a", path: "a.md" };
    const creating = result.current.create(target, 4, "text", "comment");

    rerender({ projectRoot: "/tmp/project-b" });
    releaseReply();
    await act(() => creating);

    expect(anchor).toHaveBeenCalledWith(target, expect.any(String), 4, "text");
  });

  type Comments = ReturnType<typeof useOverleafComments>;
  it.each([
    ["resolves against the thread's own document, not the open one", (hook: Comments) => hook.setResolved("t-elsewhere", true),
      "overleaf_resolve_thread", { docId: ELSEWHERE, threadId: "t-elsewhere", resolved: true }],
    ["deletes against the thread's own document, not the open one", (hook: Comments) => hook.remove("t-elsewhere"),
      "overleaf_delete_thread", { docId: ELSEWHERE, threadId: "t-elsewhere" }],
    ["edits a single message by id", (hook: Comments) => hook.editMessage("t-here", "t-here-m1", "reworded"),
      "overleaf_edit_message", { threadId: "t-here", messageId: "t-here-m1", content: "reworded" }],
    ["deletes a single message by id", (hook: Comments) => hook.deleteMessage("t-here", "t-here-m1"),
      "overleaf_delete_message", { threadId: "t-here", messageId: "t-here-m1" }],
  ] as const)("%s", async (_label, action, command, expected) => {
    mockProject();
    const { result } = mount();
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    // It carries every anchor in the project, not only the open document's.
    await waitFor(() => expect(result.current.anchors.get("t-elsewhere"))
      .toEqual({ threadId: "t-elsewhere", docId: ELSEWHERE, position: 40, quote: "elsewhere" }));
    await act(() => action(result.current));
    expect(invoke).toHaveBeenCalledWith(command, { projectRoot: "/tmp/project", ...expected });
  });

  it("says so plainly when a thread has no anchor left", async () => {
    mockProject([]);
    const { result } = mount();
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    // Caught inside `act` rather than asserted on the returned promise: a
    // rejection thrown out of `act` skips React's flush, so the state the
    // panel would actually render never lands.
    let raised: unknown;
    await act(async () => {
      await result.current.setResolved("t-here", true).catch((reason) => {
        raised = reason;
      });
    });
    expect(String(raised)).toMatch(/no longer attached/);
    expect(invoke).not.toHaveBeenCalledWith("overleaf_resolve_thread", expect.anything());
    expect(result.current.error).toMatch(/no longer attached/);
  });

  it("keeps the current project's threads when the previous project's read answers late", async () => {
    const pending = new Map<string, (threads: OverleafThread[]) => void>();
    mockInvoke({
      overleaf_threads: ({ projectRoot }: { projectRoot: string }) =>
        new Promise<OverleafThread[]>((resolve) => { pending.set(projectRoot, resolve); }),
      overleaf_comment_anchors: [],
    });
    const { result, rerender } = renderHook(
      ({ projectRoot }) => useOverleafComments({ enabled: true, projectRoot, anchor: async () => undefined }),
      { initialProps: { projectRoot: "/tmp/project-a" } },
    );
    await waitFor(() => expect(pending.has("/tmp/project-a")).toBe(true));

    rerender({ projectRoot: "/tmp/project-b" });
    await waitFor(() => expect(pending.has("/tmp/project-b")).toBe(true));
    await act(async () => pending.get("/tmp/project-b")!([thread("thread-b")]));
    await waitFor(() => expect(result.current.threads.map((item) => item.id)).toEqual(["thread-b"]));

    await act(async () => pending.get("/tmp/project-a")!([thread("thread-a")]));
    expect(result.current.threads.map((item) => item.id)).toEqual(["thread-b"]);
    expect(result.current.loading).toBe(false);
  });

  it("lets only the newest read settle loading and errors", async () => {
    const replies: { resolve: (threads: OverleafThread[]) => void; reject: (reason: Error) => void }[] = [];
    mockInvoke({
      overleaf_threads: () => new Promise<OverleafThread[]>((resolve, reject) => { replies.push({ resolve, reject }); }),
      overleaf_comment_anchors: [],
      overleaf_reply_to_thread: undefined,
    });
    const { result } = mount();
    await waitFor(() => expect(replies).toHaveLength(1));
    // Replying re-reads the threads while the first read is still out.
    let newer!: Promise<unknown>;
    act(() => { newer = result.current.reply("t-here", "agreed"); });
    await waitFor(() => expect(replies).toHaveLength(2));

    // The superseded read fails after the newer one began: nothing it says applies.
    await act(async () => replies[0]!.reject(new Error("stale failure")));
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      replies[1]!.resolve([thread("t-here")]);
      await newer;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads.map((item) => item.id)).toEqual(["t-here"]);
  });

  it("re-reads only for thread changes in its own project", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const emit = mockListen();
      mockProject();
      const { result } = mount();
      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      const reads = invokeCalls("overleaf_threads").length;

      emit({ projectRoot: "/tmp/other-project", type: "threadsChanged" });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(invokeCalls("overleaf_threads")).toHaveLength(reads);

      emit({ projectRoot: "/tmp/project", type: "threadsChanged" });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(invokeCalls("overleaf_threads")).toHaveLength(reads + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
