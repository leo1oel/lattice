import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useOverleafHistory } from "./use-overleaf-history";
import type { OverleafUpdate } from "./overleaf-history-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function update(overrides: Partial<OverleafUpdate> = {}): OverleafUpdate {
  return {
    fromVersion: 1,
    toVersion: 2,
    startTs: 1_700_000_000_000,
    endTs: 1_700_000_010_000,
    authors: ["Ada Lovelace"],
    paths: ["main.tex"],
    labels: [],
    origin: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("useOverleafHistory pagination", () => {
  it("loads the first page on mount and appends load-more pages until nextBefore is null", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") {
        if ((args as { before?: number })?.before === undefined) {
          return { updates: [update({ toVersion: 3 })], nextBefore: 2 };
        }
        if ((args as { before?: number }).before === 2) {
          return { updates: [update({ toVersion: 1 })], nextBefore: null };
        }
        throw new Error(`Unexpected page request: ${JSON.stringify(args)}`);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.updates).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);

    // nextBefore is now null: a further loadMore must not fire another request.
    const callsBefore = vi.mocked(invoke).mock.calls.length;
    await act(async () => {
      await result.current.loadMore();
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(callsBefore);
    expect(result.current.updates).toHaveLength(2);
  });

  it("surfaces the paid-plan error instead of swallowing it", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") {
        throw new Error("Overleaf's full history needs a paid plan on this project.");
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.error).toMatch(/paid plan/));
    expect(result.current.updates).toEqual([]);
  });
});

describe("useOverleafHistory actions", () => {
  function mockBase(extra: (command: string, args: unknown) => unknown) {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      return extra(command as string, args);
    });
  }

  it("restores one file to a version, then re-reads the timeline", async () => {
    mockBase((command) => {
      if (command === "overleaf_history_revert") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));

    const callsBefore = vi.mocked(invoke).mock.calls.length;
    await act(async () => {
      await result.current.revertFile(2, "main.tex");
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", {
      projectRoot: "/tmp/project",
      version: 2,
      path: "main.tex",
    });
    // The restore itself, then a fresh read of updates and labels.
    expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(callsBefore + 1);
  });

  it("performs a whole-project restore unconditionally — callers decide whether to confirm", async () => {
    mockBase((command) => {
      if (command === "overleaf_history_revert") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));

    await act(async () => {
      await result.current.revertProject(2);
    });
    // No `path`: that is what tells the backend to restore the whole project.
    expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", {
      projectRoot: "/tmp/project",
      version: 2,
    });
  });

  it("restores a deleted file using the version passed in, not the update's own version", async () => {
    mockBase((command) => {
      if (command === "overleaf_history_restore_file") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));

    await act(async () => {
      await result.current.restoreDeletedFile(7, "old/appendix.tex");
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_history_restore_file", {
      projectRoot: "/tmp/project",
      version: 7,
      path: "old/appendix.tex",
    });
  });

  it("adds and removes labels, and surfaces a failure without crashing", async () => {
    let shouldFail = false;
    mockBase((command, args) => {
      if (command === "overleaf_history_add_label") {
        if (shouldFail) throw new Error("network blip");
        return undefined;
      }
      if (command === "overleaf_history_delete_label") return undefined;
      throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
    });
    const { result } = renderHook(() => useOverleafHistory("/tmp/project"));
    await waitFor(() => expect(result.current.updates).toHaveLength(1));

    await act(async () => {
      await result.current.addLabel(2, "Submitted draft");
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_history_add_label", {
      projectRoot: "/tmp/project",
      version: 2,
      comment: "Submitted draft",
    });

    await act(async () => {
      await result.current.deleteLabel("lbl-1");
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_history_delete_label", {
      projectRoot: "/tmp/project",
      labelId: "lbl-1",
    });

    shouldFail = true;
    await act(async () => {
      await expect(result.current.addLabel(2, "Will fail")).rejects.toThrow("network blip");
    });
    expect(result.current.error).toMatch(/network blip/);
  });
});
