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
});
