/**
 * Owns Overleaf's own project-history timeline: the paginated feed of
 * updates, the label list, and the handful of mutations — restore a file,
 * restore something deleted, restore the whole project, name or unname a
 * version — that all move through the same REST layer Overleaf's own editor
 * uses. Every mutation re-reads the first page afterward rather than patching
 * local state, because a restore mints a brand new update at the top of the
 * feed and the server is the only authority on what that looks like.
 *
 * This is deliberately not a merge with `versions-timeline.tsx`. That hook (it
 * has no separate hook; the component owns its own state) tracks Lattice's
 * local git history — only what happened through this app. This one tracks
 * what Overleaf itself recorded, including every edit a collaborator made in
 * the browser while Lattice was closed. Restoring through here rewrites files
 * on Overleaf's server, not the local project directly; callers are expected
 * to sync afterward.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafLabel, OverleafUpdate, OverleafUpdatesPage } from "./overleaf-history-types";

/** Updates per page. Overleaf's own history view uses a similar batch size. */
const PAGE_SIZE = 20;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export type UseOverleafHistory = {
  updates: OverleafUpdate[];
  labels: OverleafLabel[];
  /** True only while the first page (or an explicit `refresh`) is in flight. */
  loading: boolean;
  loadingMore: boolean;
  /** Whether another `loadMore` would find anything — mirrors `nextBefore !== null`. */
  hasMore: boolean;
  error: string | null;
  /** True while a restore or label mutation is in flight. */
  busy: boolean;
  loadMore: () => Promise<void>;
  /** Reload from the top, as if the drawer had just been opened. */
  refresh: () => Promise<void>;
  /** Restore one file to the state it had at `version`. */
  revertFile: (version: number, path: string) => Promise<void>;
  /**
   * Restore the whole project to `version`. Destructive — it also deletes
   * files that did not exist at that version — so callers must confirm with
   * the user themselves before calling this; it performs the restore
   * unconditionally, same as every other action here.
   */
  revertProject: (version: number) => Promise<void>;
  /** Bring back a file that was deleted; `version` is its `deletedAtV`. */
  restoreDeletedFile: (version: number, path: string) => Promise<void>;
  addLabel: (version: number, comment: string) => Promise<void>;
  deleteLabel: (labelId: string) => Promise<void>;
};

export function useOverleafHistory(projectRoot: string): UseOverleafHistory {
  const [updates, setUpdates] = useState<OverleafUpdate[]>([]);
  const [labels, setLabels] = useState<OverleafLabel[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshLabels = useCallback(async () => {
    try {
      setLabels(await invoke<OverleafLabel[]>("overleaf_history_labels", { projectRoot }));
    } catch {
      // Labels are a supplement to the timeline — each update already carries
      // its own — so a failure here does not need its own error surface.
    }
  }, [projectRoot]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await invoke<OverleafUpdatesPage>("overleaf_history_updates", {
        projectRoot,
        count: PAGE_SIZE,
      });
      setUpdates(page.updates);
      setNextBefore(page.nextBefore);
    } catch (reason) {
      setError(message(reason));
    }
    setLoading(false);
    void refreshLabels();
  }, [projectRoot, refreshLabels]);

  // Mount fires `refresh` through a ref rather than calling it directly, so
  // the effect body never contains a traceable synchronous setState call.
  // The ref itself is kept current from its own effect rather than during
  // render, same as `callbacksRef` in versions-timeline.tsx.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    void refreshRef.current();
  }, [projectRoot]);

  const loadMore = useCallback(async () => {
    if (nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await invoke<OverleafUpdatesPage>("overleaf_history_updates", {
        projectRoot,
        before: nextBefore,
        count: PAGE_SIZE,
      });
      setUpdates((current) => [...current, ...page.updates]);
      setNextBefore(page.nextBefore);
    } catch (reason) {
      setError(message(reason));
    }
    setLoadingMore(false);
  }, [projectRoot, nextBefore, loadingMore]);

  /** Run a mutation, then re-read: Overleaf's server is the only authority on the result. */
  const act = useCallback(async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refreshRef.current();
    } catch (reason) {
      setError(message(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, []);

  const revertFile = useCallback((version: number, path: string) => act(async () => {
    await invoke("overleaf_history_revert", { projectRoot, version, path });
  }), [act, projectRoot]);

  const revertProject = useCallback((version: number) => act(async () => {
    await invoke("overleaf_history_revert", { projectRoot, version });
  }), [act, projectRoot]);

  const restoreDeletedFile = useCallback((version: number, path: string) => act(async () => {
    await invoke("overleaf_history_restore_file", { projectRoot, version, path });
  }), [act, projectRoot]);

  const addLabel = useCallback((version: number, comment: string) => act(async () => {
    await invoke("overleaf_history_add_label", { projectRoot, version, comment });
  }), [act, projectRoot]);

  const deleteLabel = useCallback((labelId: string) => act(async () => {
    await invoke("overleaf_history_delete_label", { projectRoot, labelId });
  }), [act, projectRoot]);

  return {
    updates,
    labels,
    loading,
    loadingMore,
    hasMore: nextBefore !== null,
    error,
    busy,
    loadMore,
    refresh,
    revertFile,
    revertProject,
    restoreDeletedFile,
    addLabel,
    deleteLabel,
  };
}
