import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction } from "../app-utils";
import { showNotice } from "./notify";
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
  vi.mocked(invoke).mockResolvedValue("deleted");
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
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", { projectRoot: "/paper", kind: "doc", entityId: "doc-1", path: "dropped.tex" });
  });

  it("removes the file when the writer confirms", async () => {
    const run = settle({ current: "ask" });
    vi.mocked(confirmAction).mockResolvedValue(true);
    await run(["dropped.tex"]);
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", { projectRoot: "/paper", kind: "doc", entityId: "doc-1", path: "dropped.tex" });
  });

  it("leaves a file a co-author changed while the writer was being asked, and says so", async () => {
    // The host re-read Overleaf's history and found an edit after the sync's
    // snapshot (overleaf/sync/tests/deletions.rs drives that against a mock
    // Overleaf): nothing was removed, so nothing may claim it was.
    const run = settle({ current: "ask" });
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue("changedOnOverleaf");
    await run(["dropped.tex"]);
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", { projectRoot: "/paper", kind: "doc", entityId: "doc-1", path: "dropped.tex" });
    expect(showNotice).toHaveBeenCalledOnce();
    expect(showNotice).toHaveBeenCalledWith(expect.stringMatching(/^dropped\.tex changed on Overleaf after you were asked, so it was not removed there\./), "Overleaf");
  });
});
