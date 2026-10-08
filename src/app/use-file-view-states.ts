import { useCallback, useEffect, useRef } from "react";
import type { FileViewState, ProjectSnapshot } from "../app-types";
import { loadFileViewStates, persistFileViewStates } from "../settings/app-settings";
import { clearTimer, restartTimer, useRefState } from "./effect-helpers";

const isPathWithin = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Where the writer last was in each file (cursor, scroll, Open Slide page),
 * remembered per project and persisted on a short debounce. Map insertion
 * order is the LRU app-settings uses when it caps local history.
 *
 * Editor cleanup runs after project and path transitions commit, so a stale
 * editor can report a final view state for a path that no longer exists here.
 * `remember` rejects those: callbacks from before the last invalidation, and
 * paths deleted or renamed away until something recreates them.
 */
export function useFileViewStates(
  projectRoot: string | null,
  projectRef: { readonly current: ProjectSnapshot | null },
  projectBeforeTransitionRef: { readonly current: ProjectSnapshot | null },
) {
  const statesRef = useRef(new Map<string, FileViewState>());
  const persistTimerRef = useRef<number | null>(null);
  const [epoch, , epochRef, setEpoch] = useRefState(0);
  const removedRef = useRef<string[]>([]);

  const persist = useCallback(() => {
    const root = projectRef.current?.root ?? projectBeforeTransitionRef.current?.root;
    if (root) persistFileViewStates(root, Object.fromEntries(statesRef.current));
  }, [projectBeforeTransitionRef, projectRef]);
  const flush = useCallback(() => {
    clearTimer(persistTimerRef);
    persist();
  }, [persist]);
  const schedule = useCallback(() => restartTimer(persistTimerRef, 250, persist), [persist]);
  useEffect(() => flush, [flush]);

  /** Retire every `remember` callback handed out so far. */
  const invalidate = useCallback(() => setEpoch(epochRef.current + 1), [epochRef, setEpoch]);

  const remember = useCallback((path: string, update: Partial<FileViewState>) => {
    if (!path || epoch !== epochRef.current || removedRef.current.some((removed) => isPathWithin(path, removed))
      || !projectRoot || projectRef.current?.root !== projectRoot) return;
    const next = { ...statesRef.current.get(path), ...update };
    // Reinsert a touched file at the newest end of the LRU.
    statesRef.current.delete(path);
    statesRef.current.set(path, next);
    schedule();
  }, [epoch, epochRef, projectRef, projectRoot, schedule]);
  const get = useCallback((path: string) => statesRef.current.get(path), []);

  /** A path that was removed exists again (created, imported, renamed onto). */
  const allow = useCallback((path: string) => {
    removedRef.current = removedRef.current.filter((removed) => removed !== path && !path.startsWith(`${removed}/`));
  }, []);
  /** Drop deleted paths (and everything `wasDeleted` matches) and keep them out. */
  const forget = useCallback((paths: string[], wasDeleted: (path: string) => boolean) => {
    invalidate();
    removedRef.current.push(...paths);
    for (const path of statesRef.current.keys()) {
      if (wasDeleted(path)) statesRef.current.delete(path);
    }
    schedule();
  }, [invalidate, schedule]);
  /** Carry state across renames and moves. */
  const remap = useCallback((changes: ReadonlyArray<{ previousPath: string; nextPath: string }>, remapPath: (path: string) => string) => {
    invalidate();
    for (const change of changes) {
      removedRef.current.push(change.previousPath);
      allow(change.nextPath);
    }
    statesRef.current = new Map([...statesRef.current].map(([path, state]) => [remapPath(path), state]));
    schedule();
  }, [allow, invalidate, schedule]);
  /** Persist the outgoing project's states and load the incoming one's. */
  const loadForProject = useCallback((root: string) => {
    flush();
    invalidate();
    statesRef.current = new Map(Object.entries(loadFileViewStates(root)));
    removedRef.current = [];
  }, [flush, invalidate]);

  return { statesRef, get, remember, allow, forget, remap, loadForProject };
}
