/**
 * The part of the comments layer that had a real bug in it: Overleaf keys
 * resolve, reopen and delete by the document a thread lives in, and this hook
 * used to hand it whichever document happened to be open. Acting on a comment
 * from any other file therefore addressed the wrong document.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useOverleafComments } from "./use-overleaf-comments";
import type { OverleafThread } from "./app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const HERE = "doc-open";
const ELSEWHERE = "doc-other";

function thread(id: string): OverleafThread {
  return {
    id,
    messages: [{
      id: `${id}-m1`,
      content: "have a look at this",
      authorName: "Ada Lovelace",
      authorEmail: null,
      timestamp: 1,
      mine: true,
    }],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
}

/** Two threads: one in the open document, one in a file that is not. */
function mockProject(options: { anchors?: unknown[] } = {}) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "overleaf_threads") return [thread("t-here"), thread("t-elsewhere")];
    if (command === "overleaf_comment_anchors") {
      return options.anchors ?? [
        { threadId: "t-here", docId: HERE, position: 10, quote: "here" },
        { threadId: "t-elsewhere", docId: ELSEWHERE, position: 40, quote: "elsewhere" },
      ];
    }
    return undefined;
  });
}

function mount() {
  return renderHook(() => useOverleafComments({
    enabled: true,
    docId: HERE,
    anchored: ["t-here"],
    anchor: async () => undefined,
  }));
}

afterEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("useOverleafComments", () => {
  it("resolves and deletes against the thread's own document, not the open one", async () => {
    mockProject();
    const { result } = mount();
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(() => result.current.setResolved("t-elsewhere", true));
    expect(invoke).toHaveBeenCalledWith("overleaf_resolve_thread", {
      docId: ELSEWHERE,
      threadId: "t-elsewhere",
      resolved: true,
    });

    await act(() => result.current.remove("t-elsewhere"));
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_thread", {
      docId: ELSEWHERE,
      threadId: "t-elsewhere",
    });
  });

  it("says so plainly when a thread has no anchor left", async () => {
    mockProject({ anchors: [] });
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

  it("carries every anchor in the project, not only the open document's", async () => {
    mockProject();
    const { result } = mount();
    await waitFor(() => expect(result.current.anchors.size).toBe(2));
    expect(result.current.anchors.get("t-elsewhere")).toEqual({
      threadId: "t-elsewhere",
      docId: ELSEWHERE,
      position: 40,
      quote: "elsewhere",
    });
    // Only threads anchored in the open document count as "open here".
    expect(result.current.openCount).toBe(1);
  });

  it("edits and deletes a single message by id", async () => {
    mockProject();
    const { result } = mount();
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(() => result.current.editMessage("t-here", "t-here-m1", "reworded"));
    expect(invoke).toHaveBeenCalledWith("overleaf_edit_message", {
      threadId: "t-here",
      messageId: "t-here-m1",
      content: "reworded",
    });

    await act(() => result.current.deleteMessage("t-here", "t-here-m1"));
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_message", {
      threadId: "t-here",
      messageId: "t-here-m1",
    });
  });
});
