import { describe, expect, it, vi } from "vitest";
import type { OverleafSyncResult } from "../app-types";
import { overleafSyncWarnings } from "./overleaf-sync-warnings";

const result = (patch: Partial<OverleafSyncResult>): OverleafSyncResult => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [], ...patch,
});

describe("overleafSyncWarnings", () => {
  it("names a file newly held with conflict markers, and offers to resolve it", () => {
    const resolve = vi.fn();
    const warnings = overleafSyncWarnings(result({
      unresolvedConflicts: ["main.tex", "intro.tex"], newlyUnresolvedConflicts: ["main.tex"],
    }), resolve);
    expect(warnings.map((warning) => warning.message)).toEqual([
      "main.tex still has conflict markers. Resolve them to bring in Overleaf's newer edits.",
    ]);
    void warnings[0].action?.onClick();
    expect(resolve).toHaveBeenCalledWith("main.tex");
  });

  it("stays quiet about a file the previous sync was already holding", () => {
    expect(overleafSyncWarnings(result({ unresolvedConflicts: ["main.tex"] }), vi.fn())).toEqual([]);
  });
});
