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

  it("never calls a sync up to date when it stopped on a conflict of its own", () => {
    const conflict = (path: string) => ({ path, setAside: "", markers: true });
    expect(overleafSyncSummary(result({ conflicts: [conflict("main.tex")] })))
      .toBe("Overleaf: waiting on conflict resolution in main.tex.");
    expect(overleafSyncSummary(result({ conflicts: [conflict("main.tex")], unresolvedConflicts: ["main.tex", "refs.bib"] })))
      .toBe("Overleaf: waiting on conflict resolution in main.tex, refs.bib.");
  });

  // A binary conflict is settled already: the newer copy took the path and the
  // other was set aside, so there is nothing left to resolve.
  it("calls a sync up to date when its only conflict is a binary one", () => {
    const figure = { path: "figure.png", setAside: "figure (Overleaf).png", markers: false };
    expect(overleafSyncSummary(result({ conflicts: [figure] }))).toBe("Overleaf: already up to date.");
    expect(overleafSyncSummary(result({ conflicts: [figure, { path: "main.tex", setAside: "", markers: true }] })))
      .toBe("Overleaf: waiting on conflict resolution in main.tex.");
  });

  it("counts what moved", () => {
    expect(overleafSyncSummary(result({ pulled: ["a.tex"], unresolvedConflicts: ["main.tex"] })))
      .toBe("Overleaf: pulled 1, pushed 0.");
    expect(overleafSyncSummary(result({ pushed: ["a.tex"], merged: ["b.tex"] })))
      .toBe("Overleaf: pulled 0, pushed 1, merged 1.");
  });
});
