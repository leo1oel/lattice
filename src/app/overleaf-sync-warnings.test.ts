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

  it("names every file uploaded over a co-author's edit in one warning", () => {
    const warnings = overleafSyncWarnings(result({ pushed: ["a.tex", "b.tex"], uploadedOverEdits: ["a.tex", "b.tex"] }), vi.fn());
    expect(warnings).toEqual([{
      message: "Someone edited the Overleaf project while a.tex, b.tex uploaded. An upload replaces the whole file, so it may have overwritten their latest typing there. Check the file's history on Overleaf to bring back anything missing.",
    }]);
  });

  it("says nothing for a sync whose uploads met no one else's edit", () => {
    expect(overleafSyncWarnings(result({ pushed: ["a.tex"], uploadedOverEdits: [] }), vi.fn())).toEqual([]);
  });

  it("stays quiet about a file the previous sync was already holding", () => {
    expect(overleafSyncWarnings(result({ unresolvedConflicts: ["main.tex"] }), vi.fn())).toEqual([]);
  });
});
