import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeCalls, mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";
import { textFromDiffChunks, useOverleafHistory, type OverleafUpdate } from "./use-overleaf-history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const update = (overrides: Partial<OverleafUpdate> = {}): OverleafUpdate => ({
  fromVersion: 1, toVersion: 2, startTs: 1_700_000_000_000, endTs: 1_700_000_010_000,
  authors: ["Ada Lovelace"], paths: ["main.tex"], labels: [], origin: null, ...overrides,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

/** Mount once the first page (one update, unless `commands` says otherwise) has loaded. */
async function mountWith(commands: CommandTable) {
  mockInvoke({ overleaf_history_updates: { updates: [update()], nextBefore: null }, ...commands });
  const view = renderHook(() => useOverleafHistory("/tmp/project"));
  await waitFor(() => expect(view.result.current.updates).toHaveLength(1));
  return view.result;
}

describe("textFromDiffChunks", () => {
  it("reconstructs the before and after text from a run of chunks", () => {
    expect(textFromDiffChunks("main.tex", [
      { u: "intro\n" }, { d: "old claim\n" }, { i: "new claim\n" }, { u: "conclusion\n" },
    ])).toEqual({
      path: "main.tex",
      before: "intro\nold claim\nconclusion\n",
      after: "intro\nnew claim\nconclusion\n",
    });
    expect(textFromDiffChunks("new.tex", [{ i: "brand new file\n" }])).toEqual({ path: "new.tex", before: "", after: "brand new file\n" });
  });
});

describe("useOverleafHistory", () => {
  it("loads the first page on mount and appends load-more pages until nextBefore is null", async () => {
    const result = await mountWith({
      overleaf_history_updates: ({ before }: { before?: number }) => {
        if (before === undefined) return { updates: [update({ toVersion: 3 })], nextBefore: 2 };
        if (before === 2) return { updates: [update({ toVersion: 1 })], nextBefore: null };
        throw new Error(`Unexpected page request: ${before}`);
      },
    });
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadMore());
    expect(result.current.updates).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);

    // nextBefore is now null: a further loadMore must not fire another request.
    const callsBefore = vi.mocked(invoke).mock.calls.length;
    await act(() => result.current.loadMore());
    expect(invoke).toHaveBeenCalledTimes(callsBefore);
  });

  it("surfaces the paid-plan error instead of swallowing it", async () => {
    mockInvoke({ overleaf_history_updates: () => { throw new Error("Overleaf's full history needs a paid plan on this project."); } });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.error).toMatch(/paid plan/));
    expect(result.current.updates).toEqual([]);
  });

  it.each([
    ["restores one file", "revertFile", [2, "main.tex"], "overleaf_history_revert", { version: 2, path: "main.tex" }],
    // No `path`: that is what tells the backend to restore the whole project.
    ["restores the whole project unconditionally", "revertProject", [2], "overleaf_history_revert", { version: 2 }],
    ["restores a deleted file at the version passed in", "restoreDeletedFile", [7, "old/appendix.tex"], "overleaf_history_restore_file", { version: 7, path: "old/appendix.tex" }],
    ["names a version", "addLabel", [2, "Submitted draft"], "overleaf_history_add_label", { version: 2, comment: "Submitted draft" }],
    ["removes a label", "deleteLabel", ["lbl-1"], "overleaf_history_delete_label", { labelId: "lbl-1" }],
  ] as const)("%s, then re-reads the timeline", async (_label, action, args, command, expected) => {
    const result = await mountWith({ [command]: undefined });
    const pagesBefore = invokeCalls("overleaf_history_updates").length;
    await act(() => (result.current[action] as (...values: unknown[]) => Promise<void>)(...args));
    expect(invoke).toHaveBeenCalledWith(command, { projectRoot: "/tmp/project", ...expected });
    expect(invokeCalls("overleaf_history_updates")).toHaveLength(pagesBefore + 1);
  });

  it("surfaces a failed mutation without crashing", async () => {
    const result = await mountWith({ overleaf_history_add_label: () => { throw new Error("network blip"); } });
    await act(async () => {
      await expect(result.current.addLabel(2, "Will fail")).rejects.toThrow("network blip");
    });
    expect(result.current.error).toMatch(/network blip/);
  });

  it("shows only the current project's timeline when the previous project's read answers late", async () => {
    const pending = new Map<string, (page: { updates: OverleafUpdate[]; nextBefore: number | null }) => void>();
    mockInvoke({
      overleaf_history_updates: ({ projectRoot }: { projectRoot: string }) =>
        new Promise((resolve) => { pending.set(projectRoot, resolve); }),
    });
    const { result, rerender } = renderHook(({ projectRoot }) => useOverleafHistory(projectRoot), {
      initialProps: { projectRoot: "/tmp/project-a" },
    });
    await waitFor(() => expect(pending.has("/tmp/project-a")).toBe(true));

    rerender({ projectRoot: "/tmp/project-b" });
    await waitFor(() => expect(pending.has("/tmp/project-b")).toBe(true));
    await act(async () => pending.get("/tmp/project-b")!({ updates: [update({ toVersion: 20 })], nextBefore: null }));
    await act(async () => pending.get("/tmp/project-a")!({ updates: [update({ toVersion: 10 })], nextBefore: 9 }));

    expect(result.current.updates.map((item) => item.toVersion)).toEqual([20]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("drops a page still in flight when the timeline reloads from the top", async () => {
    const olderPages: ((page: { updates: OverleafUpdate[]; nextBefore: number | null }) => void)[] = [];
    let firstPage = 0;
    const result = await mountWith({
      overleaf_history_updates: ({ before }: { before?: number }) => {
        if (before === undefined) {
          firstPage += 1;
          return { updates: [update({ toVersion: firstPage === 1 ? 3 : 4 })], nextBefore: 2 };
        }
        return new Promise((resolve) => { olderPages.push(resolve); });
      },
      overleaf_history_add_label: undefined,
    });

    let loadingMore!: Promise<void>;
    act(() => { loadingMore = result.current.loadMore(); });
    expect(result.current.loadingMore).toBe(true);
    // A restore or label mints a new update at the top, so the list is re-read.
    await act(() => result.current.addLabel(3, "Submitted draft"));
    expect(result.current.loadingMore).toBe(false);

    await act(async () => {
      olderPages[0]!({ updates: [update({ toVersion: 1 })], nextBefore: null });
      await loadingMore;
    });
    expect(result.current.updates.map((item) => item.toVersion)).toEqual([4]);
    expect(result.current.hasMore).toBe(true);
  });
});
