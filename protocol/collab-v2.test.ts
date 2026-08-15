import { describe, expect, it } from "vitest";
import { isCatalogV2 } from "./collab-v2";

const valid = { protocol: 2, projectInstanceId: "project", lifecycle: "live", catalogRevision: 1, snapshotGeneration: 0, workspaceLeaseGeneration: 0, authorityEpoch: 1, files: [{ fileId: "file", path: "a.md", kind: "text", state: "live", documentEpoch: 1 }] };

describe("isCatalogV2", () => {
  it("accepts a complete catalog and fails closed for malformed lifecycle fields and files", () => {
    expect(isCatalogV2(valid)).toBe(true);
    expect(isCatalogV2({ ...valid, files: [{ ...valid.files[0], path: "data.lattice-sheet", kind: "spreadsheet" }] })).toBe(true);
    for (const bad of [
      { ...valid, catalogRevision: -1 },
      { ...valid, snapshotGeneration: undefined },
      { ...valid, lifecycle: "unknown" },
      { ...valid, files: [{ ...valid.files[0], kind: undefined }] },
      { ...valid, files: [{ ...valid.files[0], state: "unknown" }] },
      { ...valid, files: [{ ...valid.files[0], documentEpoch: 0 }] },
    ]) expect(isCatalogV2(bad)).toBe(false);
  });
});
