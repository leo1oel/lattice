import { describe, expect, it } from "vitest";
import type { CatalogFileV2, CatalogV2 } from "../../protocol/collab-v2";
import { planCatalogDeltaV2 } from "./collab-catalog-delta-v2";

const file = (partial: Partial<CatalogFileV2> & { fileId: string; path: string }): CatalogFileV2 => ({ kind: "text", state: "live", documentEpoch: 1, ...partial });
const catalog = (files: CatalogFileV2[], catalogRevision = 1): CatalogV2 => ({
  protocol: 2, projectInstanceId: "proj", lifecycle: "live", catalogRevision,
  snapshotGeneration: 1, workspaceLeaseGeneration: 1, authorityEpoch: 1, files,
});

describe("planCatalogDeltaV2", () => {
  it("reports nothing when only the revision moves", () => {
    const files = [file({ fileId: "a", path: "main.tex" })];
    const delta = planCatalogDeltaV2(catalog(files, 1), catalog(files.map((f) => ({ ...f })), 2));
    expect(delta).toEqual({ created: [], renamed: [], deleted: [], staleBinaries: [] });
  });

  it("creates files that become live and ignores non-live newcomers", () => {
    const next = catalog([
      file({ fileId: "a", path: "main.tex" }),
      file({ fileId: "b", path: "new.tex" }),
      file({ fileId: "c", path: "draft.tex", state: "initializing" }),
    ], 2);
    const delta = planCatalogDeltaV2(catalog([file({ fileId: "a", path: "main.tex" })]), next);
    expect(delta.created.map((f) => f.path)).toEqual(["new.tex"]);
    expect(delta.deleted).toEqual([]);
  });

  it("renames files that keep their epoch", () => {
    const before = catalog([file({ fileId: "a", path: "old/intro.tex" })]);
    const after = catalog([file({ fileId: "a", path: "chapters/intro.tex" })], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.renamed).toEqual([{ file: after.files[0], previousPath: "old/intro.tex" }]);
    expect(delta.created).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  it("deletes files that leave the live set or vanish", () => {
    const keep = file({ fileId: "a", path: "keep.tex" });
    const dying = file({ fileId: "c", path: "dying.tex" });
    const delta = planCatalogDeltaV2(
      catalog([keep, file({ fileId: "b", path: "gone.tex" }), dying]),
      catalog([{ ...keep }, { ...dying, state: "tombstoned" }], 2),
    );
    expect(delta.deleted).toEqual([{ fileId: "b", path: "gone.tex" }, { fileId: "c", path: "dying.tex" }]);
  });

  it("treats an epoch bump as a rewrite at the new path plus cleanup of the old", () => {
    const before = catalog([file({ fileId: "a", path: "old.tex", documentEpoch: 1 })]);
    const after = catalog([file({ fileId: "a", path: "new.tex", documentEpoch: 2 })], 2);
    const delta = planCatalogDeltaV2(before, after);
    expect(delta.created).toEqual([after.files[0]]);
    expect(delta.renamed).toEqual([]);
    expect(delta.deleted).toEqual([{ fileId: "a", path: "old.tex" }]);
  });

  it("flags binaries whose content moved, but not text files or untouched binaries", () => {
    const text = file({ fileId: "t", path: "main.tex" });
    const untouched = file({ fileId: "b1", path: "fig.png", kind: "binary", hash: "h1", contentRevision: 1 });
    const moved = file({ fileId: "b2", path: "plot.pdf", kind: "binary", hash: "h2", contentRevision: 3 });
    const after = catalog([{ ...text }, { ...untouched }, { ...moved, hash: "h3", contentRevision: 4 }], 2);
    expect(planCatalogDeltaV2(catalog([text, untouched, moved]), after).staleBinaries).toEqual([after.files[2]]);
  });
});
