/**
 * Bridges Overleaf's own diff and file-list shapes onto the pieces this app
 * already has for rendering a diff and a changed-files list — `HistoryDiff`
 * and `FileKindIcon`-style views in `versions-timeline.tsx` — rather than
 * building a second hunk renderer just because the source format differs.
 *
 * Overleaf's diff arrives as a flat run of unchanged/inserted/deleted chunks,
 * already split; `HistoryDiff` wants full before/after text and does its own
 * line-level diffing. Re-diffing reconstructed text is redundant work, but it
 * is one small function's worth, and it means this file never has to keep a
 * second diff-rendering implementation honest with the first.
 */
import type { DiffFileChange } from "../history/versions-timeline";
import type {
  OverleafBinaryDiff,
  OverleafDiffChunk,
  OverleafFileEntry,
} from "./overleaf-history-types";

/** Narrows the `overleaf_history_diff` union — true for the binary half. */
export function isBinaryDiff(
  diff: OverleafDiffChunk[] | OverleafBinaryDiff,
): diff is OverleafBinaryDiff {
  return !Array.isArray(diff);
}

/**
 * Walk the chunk stream back into the two full texts it was split from: `u`
 * chunks belong to both sides, `d` chunks only to the before text, `i` chunks
 * only to the after text. Order in the array is the order each side reads in,
 * so concatenating per side is enough to recover the originals exactly.
 */
export function textFromDiffChunks(path: string, chunks: OverleafDiffChunk[]): DiffFileChange {
  let before = "";
  let after = "";
  for (const chunk of chunks) {
    if (chunk.u != null) {
      before += chunk.u;
      after += chunk.u;
    }
    if (chunk.d != null) before += chunk.d;
    if (chunk.i != null) after += chunk.i;
  }
  return { path, before, after };
}

/**
 * The "what changed" half of `overleaf_history_files`: entries with no
 * `operation` existed unchanged across the whole range and are not part of
 * this update, so they are filtered out rather than shown as edits.
 */
export function changedFiles(entries: OverleafFileEntry[]): OverleafFileEntry[] {
  return entries.filter((entry) => entry.operation !== undefined);
}
