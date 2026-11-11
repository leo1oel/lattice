import { describe, expect, it } from "vitest";
import type { OverleafSyncResult } from "../app-types";
import { unsettledPaths } from "./overleaf-sync-unsettled";

const result = (patch: Partial<OverleafSyncResult>): OverleafSyncResult => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [], ...patch,
});

describe("unsettledPaths", () => {
  it("keeps a file still marked up from an earlier conflict out of live editing", () => {
    expect(unsettledPaths(result({ unresolvedConflicts: ["main.tex"] }))).toEqual(["main.tex"]);
  });

  it("lists every path a sync left for the writer, but not a refused download that went up", () => {
    expect(unsettledPaths(result({
      pushed: ["kept.tex"],
      conflicts: [{ path: "a.tex", localCopy: "a (local conflict 20261108-0217).tex", markers: true }],
      deletedLocal: ["b.tex"], skippedRemoteDeletes: ["c.tex"], skippedLarge: ["d.pdf"],
      heldRenames: ["f.tex"], refusedIncoming: ["kept.tex", "e.tex"],
    }))).toEqual(["a.tex", "b.tex", "c.tex", "d.pdf", "f.tex", "e.tex"]);
  });
});
