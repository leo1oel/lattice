/**
 * The recent projects' marks and the finder that searches them: each folder
 * is looked at again (project/recent-project-states.ts) as a list of them
 * comes on screen (the welcome screen, the title's switcher, the finder) or
 * one fails to open.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { RecentProject } from "../settings/app-settings";

/** Kept out of startup: only a list of recent projects on screen needs it. */
const recheckRecentProjects = () => import("../project/recent-project-states").then((module) => module.recheckRecentProjects());

const setOpen = (_: boolean, open: boolean) => open;

/** `listShown`: a list of recent projects other than the finder is on screen. Both setters are React's own, so stable. */
export function useRecentProjectMarks<T extends { projects: RecentProject[] }>(
  listShown: boolean,
  setProjectMenuOpen: (open: boolean) => void,
  setRecents: Dispatch<SetStateAction<T>>,
) {
  // Its own memos below are all it needs; the compiler's on top cost eager JS.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a React Compiler directive
  "use no memo";
  const [finderOpen, setFinderOpen] = useReducer(setOpen, false);
  const check = useCallback(() => {
    void recheckRecentProjects().then((marked) => {
      if (marked) setRecents((current) => ({ ...current, projects: marked }));
    });
  }, [setRecents]);
  const shown = finderOpen || listShown;
  useEffect(() => {
    if (shown) check();
  }, [check, shown]);
  const finder = useMemo(() => ({
    open: finderOpen,
    show: () => {
      setProjectMenuOpen(false);
      setFinderOpen(true);
    },
    close: () => setFinderOpen(false),
  }), [finderOpen, setProjectMenuOpen]);
  return { check, finder };
}
