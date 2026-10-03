/**
 * Overleaf's own project history: the paginated feed of updates and the
 * mutations — restore a file, restore something deleted, restore the whole
 * project, name or unname a version — that move through the same REST layer
 * Overleaf's own editor uses. Every mutation re-reads the first page afterward
 * rather than patching local state, because a restore mints a brand new update
 * at the top of the feed and the server is the only authority on its shape.
 *
 * This is not Lattice's git history (`versions-timeline.tsx`): it is what
 * Overleaf itself recorded, including every edit a collaborator made in the
 * browser while Lattice was closed. Restoring rewrites files on Overleaf's
 * server, not the local project; callers are expected to sync afterward.
 */
import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import type { DiffFileChange } from "../history/pierre-diff";
import { useOverleafProjectSnapshot } from "./use-overleaf-project-snapshot";

/** One entry in the paginated `overleaf_history_updates` feed, newest first. */
export type OverleafUpdate = {
  fromVersion: number;
  toVersion: number;
  /** Milliseconds since the epoch — not an ISO string. */
  startTs: number;
  endTs: number;
  /** Display names; accounts Overleaf could not resolve are already dropped. */
  authors: string[];
  /** Files this entry touched. Can be empty even though the entry is real. */
  paths: string[];
  labels: OverleafLabel[];
  /** "upload", "dropbox", "git-bridge", "file-restore", "project-restore", … or null for a normal editor edit. */
  origin: string | null;
};

type OverleafLabel = {
  id: string;
  comment: string;
  version: number;
  createdAt: string | null;
  author: string | null;
};

type OverleafUpdatesPage = {
  updates: OverleafUpdate[];
  /** Epoch milliseconds to pass back as `before` for the next page; null when there is none. */
  nextBefore: number | null;
};

/** One run of a per-file diff: unchanged, inserted, or deleted verbatim text. */
export type OverleafDiffChunk = { u?: string; i?: string; d?: string; meta?: unknown };

export type OverleafFileOperation = "added" | "edited" | "removed" | "renamed";

/**
 * One row of `overleaf_history_files`. An entry with no `operation` existed,
 * unchanged, for the entire range asked about, so only entries that have one
 * are part of "what changed".
 */
export type OverleafFileEntry = {
  pathname: string;
  operation?: OverleafFileOperation;
  newPathname?: string;
  /** Set when `operation` is "removed"; the version to pass back to bring the file back. */
  deletedAtV?: number;
  editable?: boolean;
};

/**
 * Walk Overleaf's chunk stream back into the two full texts it was split from:
 * `u` belongs to both sides, `d` only to the before text, `i` only to the after
 * text, so the shared diff renderer can diff them itself.
 */
export function textFromDiffChunks(path: string, chunks: OverleafDiffChunk[]): DiffFileChange {
  let before = "";
  let after = "";
  for (const chunk of chunks) {
    before += (chunk.u ?? "") + (chunk.d ?? "");
    after += (chunk.u ?? "") + (chunk.i ?? "");
  }
  return { path, before, after };
}

/** Updates per page. Overleaf's own history view uses a similar batch size. */
const PAGE_SIZE = 20;

type HistorySnapshot = {
  updates: OverleafUpdate[];
  nextBefore: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  busy: boolean;
};

/** Mounting reads the first page straight away. */
const FIRST_LOAD: HistorySnapshot = { updates: [], nextBefore: null, loading: true, loadingMore: false, error: null, busy: false };

export function useOverleafHistory(projectRoot: string) {
  const [{ updates, nextBefore, loading, loadingMore, error, busy }, session] = useOverleafProjectSnapshot(projectRoot, FIRST_LOAD);

  /**
   * Read the page before `before`, or the first page, and publish it with
   * `merge`. A newer read, a project change or unmounting discards it.
   */
  const fetchPage = useCallback(async (
    before: number | null,
    flag: "loading" | "loadingMore",
    merge: (current: OverleafUpdate[], page: OverleafUpdate[]) => OverleafUpdate[],
  ) => {
    const current = session();
    if (!current) return;
    const publish = current.read();
    // A first-page read replaces the list a page still in flight would extend.
    publish((snapshot) => ({ ...snapshot, loading: flag === "loading", loadingMore: flag === "loadingMore", error: null }));
    const page = before === null ? { count: PAGE_SIZE } : { before, count: PAGE_SIZE };
    try {
      const result = await invoke<OverleafUpdatesPage>("overleaf_history_updates", { projectRoot: current.projectRoot, ...page });
      publish((snapshot) => ({
        ...snapshot, updates: merge(snapshot.updates, result.updates), nextBefore: result.nextBefore, [flag]: false,
      }));
    } catch (reason) {
      publish((snapshot) => ({ ...snapshot, error: toMessage(reason), [flag]: false }));
    }
  }, [session]);

  /** Reload from the top, as if the drawer had just been opened. */
  const refresh = useCallback(() => fetchPage(null, "loading", (_current, page) => page), [fetchPage]);

  // Mount fires `refresh` through a ref so the effect body never contains a
  // traceable synchronous setState call.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    void refreshRef.current();
  }, [projectRoot]);

  const loadMore = async () => {
    // The cursor belongs to the list on screen, which a first-page read in flight is about to replace.
    if (nextBefore == null || loading || loadingMore) return;
    await fetchPage(nextBefore, "loadingMore", (current, page) => [...current, ...page]);
  };

  /** Run a mutation, then re-read: Overleaf's server is the only authority on the result. */
  const mutate = (command: string, args: Record<string, unknown>) => {
    const current = session();
    current?.publish((snapshot) => ({ ...snapshot, busy: true, error: null }));
    return invoke(command, { projectRoot, ...args })
      .then(() => refreshRef.current())
      .catch((reason: unknown) => {
        current?.publish((snapshot) => ({ ...snapshot, error: toMessage(reason) }));
        throw reason;
      })
      .finally(() => current?.publish((snapshot) => ({ ...snapshot, busy: false })));
  };

  return {
    updates,
    loading,
    loadingMore,
    hasMore: nextBefore !== null,
    error,
    /** True while a restore or label mutation is in flight. */
    busy,
    loadMore,
    /** Restore one file to the state it had at `version`. */
    revertFile: (version: number, path: string) => mutate("overleaf_history_revert", { version, path }),
    /**
     * Restore the whole project to `version`. Destructive — it also deletes
     * files that did not exist then — so callers confirm with the user first.
     */
    revertProject: (version: number) => mutate("overleaf_history_revert", { version }),
    /** Bring back a deleted file; `version` is its `deletedAtV`. */
    restoreDeletedFile: (version: number, path: string) => mutate("overleaf_history_restore_file", { version, path }),
    addLabel: (version: number, comment: string) => mutate("overleaf_history_add_label", { version, comment }),
    deleteLabel: (labelId: string) => mutate("overleaf_history_delete_label", { labelId }),
  };
}
