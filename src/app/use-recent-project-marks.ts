/**
 * The recent projects' marks and the finder that searches them: each folder
 * is looked at again as a list of them comes on screen (the welcome screen,
 * the title's switcher, the finder) or one fails to open, so a folder that
 * is gone is marked, never dropped unseen, and one linked to Overleaf is
 * labelled (`recent_project_states` in src-tauri/src/ipc/workspace.rs).
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLatestRef } from "../hooks/use-latest-ref";
import { loadRecentProjects, markRecentProjects, type RecentProject, type RecentProjectState } from "../settings/app-settings";

/** The recent projects with each folder's marks brought up to date, or null when none changed or the shell could not say. */
async function recheckRecentProjects(): Promise<RecentProject[] | null> {
  const paths = loadRecentProjects().map((item) => item.path);
  if (!paths.length) return null;
  // Without an answer (a browser tab, an older shell) the marks stay as they were.
  const states = await invoke<RecentProjectState[]>("recent_project_states", { paths }).catch(() => null);
  if (!states || states.length !== paths.length) return null;
  return markRecentProjects(new Map(paths.map((path, index) => [path, states[index]])));
}

const setOpen = (_: boolean, open: boolean) => open;

export function useRecentProjectMarks({ listShown, closeProjectMenu, onMarked }: {
  /** A list of recent projects other than the finder is on screen. */
  listShown: boolean;
  closeProjectMenu: () => void;
  /** The list as newly marked, already stored. */
  onMarked: (projects: RecentProject[]) => void;
}) {
  const [finderOpen, setFinderOpen] = useReducer(setOpen, false);
  const onMarkedRef = useLatestRef(onMarked);
  const check = useCallback(() => {
    void recheckRecentProjects().then((marked) => {
      if (marked) onMarkedRef.current(marked);
    });
  }, [onMarkedRef]);
  const shown = finderOpen || listShown;
  useEffect(() => {
    if (shown) check();
  }, [check, shown]);
  const closeProjectMenuRef = useLatestRef(closeProjectMenu);
  const finder = useMemo(() => ({
    open: finderOpen,
    show: () => {
      closeProjectMenuRef.current();
      setFinderOpen(true);
    },
    close: () => setFinderOpen(false),
  }), [closeProjectMenuRef, finderOpen]);
  return { check, finder };
}
