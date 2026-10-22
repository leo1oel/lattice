import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction } from "../app-utils";
import type { OverleafRemoteDelete } from "../settings/app-settings";
import { useOverleafRemoteDeletes } from "./use-overleaf-remote-deletes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn(), showNotice: vi.fn() }));
vi.mock("../app-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-utils")>(),
  confirmAction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

/** Settle remote deletes under `policy` for a project whose Overleaf copy holds `dropped.tex`. */
function settle(policy: { current: OverleafRemoteDelete }) {
  const entities = { current: new Map([["dropped.tex", { id: "doc-1", kind: "doc" }]]) };
  const view = renderHook(() => useOverleafRemoteDeletes(policy, entities, () => () => true));
  return (paths: string[]) => view.result.current(paths, "/paper", 1);
}

describe("settling files deleted here but still on Overleaf", () => {
  it("asks once about a file the writer keeps on Overleaf, though every sync reports it", async () => {
    const policy = { current: "ask" as OverleafRemoteDelete };
    const run = settle(policy);
    vi.mocked(confirmAction).mockResolvedValue(false);
    await run(["dropped.tex"]);
    await run(["dropped.tex"]);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();

    // Choosing to remove files from Overleaf still applies to it.
    policy.current = "always";
    await run(["dropped.tex"]);
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", { projectRoot: "/paper", kind: "doc", entityId: "doc-1" });
  });

  it("removes the file when the writer confirms", async () => {
    const run = settle({ current: "ask" });
    vi.mocked(confirmAction).mockResolvedValue(true);
    await run(["dropped.tex"]);
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", { projectRoot: "/paper", kind: "doc", entityId: "doc-1" });
  });
});
