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
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import type { DiffFileChange } from "../history/pierre-diff";

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

export type OverleafLabel = {
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

export function useOverleafHistory(projectRoot: string) {
  const [updates, setUpdates] = useState<OverleafUpdate[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchPage = useCallback((before: number | null) => {
    setError(null);
    const page = before === null ? { count: PAGE_SIZE } : { before, count: PAGE_SIZE };
    return invoke<OverleafUpdatesPage>("overleaf_history_updates", { projectRoot, ...page }).then((result) => {
      setUpdates((current) => (before === null ? result.updates : [...current, ...result.updates]));
      setNextBefore(result.nextBefore);
    }, (reason: unknown) => setError(toMessage(reason)));
  }, [projectRoot]);

  /** Reload from the top, as if the drawer had just been opened. */
  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchPage(null);
    setLoading(false);
  }, [fetchPage]);

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
    if (nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    await fetchPage(nextBefore);
    setLoadingMore(false);
  };

  /** Run a mutation, then re-read: Overleaf's server is the only authority on the result. */
  const mutate = (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    return invoke(command, { projectRoot, ...args })
      .then(() => refreshRef.current())
      .catch((reason: unknown) => {
        setError(toMessage(reason));
        throw reason;
      })
      .finally(() => setBusy(false));
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
