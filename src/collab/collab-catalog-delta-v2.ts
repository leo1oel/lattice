import type { CatalogFileV2, CatalogV2 } from "../../protocol/collab-v2";

/** Tree-level difference between two catalog snapshots, as seen by a peer. */
type CatalogDeltaV2 = {
  /** Files live now that were not live before (including epoch-bumped text files, which need a full rewrite). */
  created: CatalogFileV2[];
  /** Files live in both snapshots whose path changed (same document epoch). */
  renamed: { file: CatalogFileV2; previousPath: string }[];
  /** Previously live files that are gone or no longer live (tombstoned/purging/deleting). */
  deleted: { fileId: string; path: string }[];
  /** Live binaries whose content moved (hash/contentRevision changed) and must be re-downloaded. */
  staleBinaries: CatalogFileV2[];
};

const liveById = (catalog: CatalogV2) => new Map(catalog.files.filter((file) => file.state === "live").map((file) => [file.fileId, file]));

/**
 * Diff two catalog snapshots into actionable tree changes. An epoch change is
 * treated as create-at-current-path (the new doc must be re-pulled in full),
 * plus a delete of the previous path when it differs.
 */
export function planCatalogDeltaV2(previous: CatalogV2, next: CatalogV2): CatalogDeltaV2 {
  const before = liveById(previous);
  const after = liveById(next);
  const delta: CatalogDeltaV2 = { created: [], renamed: [], deleted: [], staleBinaries: [] };
  for (const [fileId, file] of after) {
    const prior = before.get(fileId);
    if (!prior || prior.documentEpoch !== file.documentEpoch) {
      delta.created.push(file);
      if (prior && prior.path !== file.path) delta.deleted.push({ fileId, path: prior.path });
      continue;
    }
    if (prior.path !== file.path) delta.renamed.push({ file, previousPath: prior.path });
    if (file.kind === "binary" && (prior.hash !== file.hash || prior.contentRevision !== file.contentRevision)) delta.staleBinaries.push(file);
  }
  for (const [fileId, prior] of before) {
    if (!after.has(fileId)) delta.deleted.push({ fileId, path: prior.path });
  }
  return delta;
}
