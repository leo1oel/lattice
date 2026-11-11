/**
 * The projects in this window ("Projects in this window"): the one live
 * project and the ones it was switched away from, shown as the title bar's
 * project tabs (`project-tabs.tsx`) once there are two. Only the active one is
 * open in the backend, which still binds one root per window; the others are
 * suspended, which costs nothing, and come back through the ordinary switch
 * (`switchProject`) with their tabs, places and parked editors.
 *
 * Kept per window label in the page's session storage: a reload keeps the
 * list, a closed window or a relaunch starts without one.
 */
import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "zustand/vanilla";

export type WindowProject = { root: string; name: string };

const STORAGE_PREFIX = "lattice.window-projects.v1:";

function storageKey() {
  try {
    return STORAGE_PREFIX + getCurrentWindow().label;
  } catch {
    // No Tauri window (a browser tab, a test): the page's session is the window.
    return `${STORAGE_PREFIX}page`;
  }
}

function load(): readonly WindowProject[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey()) ?? "[]");
    return Array.isArray(value) ? value.filter((entry: WindowProject) => typeof entry?.root === "string" && typeof entry.name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Held outside React: the title bar's tabs, the command table's ⌃Tab and the
 * workspace's parked editors (trellis-workspace.tsx) all read it, and the
 * project lifecycle writes it as a project is entered.
 */
const store = createStore<{ projects: readonly WindowProject[] }>()(() => ({ projects: load() }));
store.subscribe(({ projects }) => {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(projects));
  } catch {
    // Kept for this page only.
  }
});
const projectsNow = () => store.getState().projects;

export const windowProjects = {
  get: projectsNow,
  subscribe: (listener: () => void) => store.subscribe(listener),
  /**
   * `entered` is now the window's project: added after `left` (the project
   * it replaced), or renamed in place. `left` keeps its place under the name
   * it had last.
   */
  enter(entered: WindowProject, left: WindowProject | null) {
    const next = projectsNow().map((entry) => (
      entry.root === entered.root ? entered : entry.root === left?.root ? left : entry
    ));
    if (left && !next.some((entry) => entry.root === left.root)) next.push(left);
    if (!next.some((entry) => entry.root === entered.root)) {
      const after = next.findIndex((entry) => entry.root === left?.root);
      next.splice(after < 0 ? next.length : after + 1, 0, entered);
    }
    store.setState({ projects: next });
  },
  remove(root: string) {
    const projects = projectsNow();
    if (projects.some((entry) => entry.root === root)) store.setState({ projects: projects.filter((entry) => entry.root !== root) });
  },
};

export function useWindowProjects() {
  return useSyncExternalStore(windowProjects.subscribe, projectsNow);
}
