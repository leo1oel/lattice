import { describe, expect, it } from "vitest";
import type { OverleafSyncResult } from "../app-types";
import { overleafSyncSummary } from "./overleaf-sync-summary";

const result = (patch: Partial<OverleafSyncResult>): OverleafSyncResult => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [], ...patch,
});

describe("overleafSyncSummary", () => {
  it("never calls a sync up to date while a marked-up file holds back Overleaf's edits", () => {
    expect(overleafSyncSummary(result({ unresolvedConflicts: ["main.tex"] })))
      .toBe("Overleaf: waiting on conflict resolution in main.tex.");
    expect(overleafSyncSummary(result({}))).toBe("Overleaf: already up to date.");
  });

  it("counts what moved", () => {
    expect(overleafSyncSummary(result({ pulled: ["a.tex"], unresolvedConflicts: ["main.tex"] })))
      .toBe("Overleaf: pulled 1, pushed 0.");
    expect(overleafSyncSummary(result({ pushed: ["a.tex"], merged: ["b.tex"] })))
      .toBe("Overleaf: pulled 0, pushed 1, merged 1.");
  });
});
