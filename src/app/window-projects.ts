/**
 * The projects in this window ("Projects in this window"): the one live
 * project and the ones it was switched away from, shown as the title bar's
 * project tabs (`project-tabs.tsx`) once there are two. Only the active one is
 * open in the backend, which still binds one root per window; the others are
 * suspended, which costs nothing, and come back through the ordinary switch
 * (`switchProject`) with their tabs, places and parked editors.
 *
 * Each page keeps its list through a reload. Desktop windows also save their
 * group and active root to the native app's session file for relaunch.
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "zustand/vanilla";
import { nativeProjectTabWindow } from "./project-tab-window";

export type WindowProject = { root: string; name: string };
type WindowProjectGroup = { activeRoot: string | null; projects: readonly WindowProject[] };

export function loadWindowProjectGroup(): Promise<WindowProjectGroup | null> {
  return nativeProjectTabWindow()
    ? invoke<WindowProjectGroup | null>("load_project_tab_group").catch(() => null)
    : Promise.resolve(null);
}

let pendingSave: Promise<unknown> = Promise.resolve();

/** Wait for queued tab changes before letting this desktop window quit. */
export function flushWindowProjectGroup() {
  return pendingSave;
}

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
const store = createStore<{ projects: readonly WindowProject[]; activeRoot: string | null }>()(() => ({
  projects: load(), activeRoot: null,
}));
store.subscribe(({ projects, activeRoot }) => {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(projects));
  } catch {
    // The native session can still save even if this page's storage is unavailable.
  }
  if (!activeRoot || !nativeProjectTabWindow() || !projects.some(({ root }) => root === activeRoot)) return;
  // While a dragged active tab is leaving, the source briefly has no current
  // project. Save the group once its next active root has entered.
  const group: WindowProjectGroup = { projects, activeRoot };
  pendingSave = pendingSave.then(() => invoke("save_project_tab_group", { group })).catch(() => undefined);
});
const projectsNow = () => store.getState().projects;

export const windowProjects = {
  get: projectsNow,
  subscribe: (listener: () => void) => store.subscribe(listener),
  restore(projects: readonly WindowProject[]) {
    store.setState({ projects, activeRoot: null });
  },
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
    store.setState({ projects: next, activeRoot: entered.root });
  },
  remove(root: string) {
    const projects = projectsNow();
    if (projects.some((entry) => entry.root === root)) store.setState({ projects: projects.filter((entry) => entry.root !== root) });
  },
  /** Insert before the named neighbour, or at the end if the neighbour is gone. */
  reorder(root: string, beforeRoot: string | null) {
    if (root === beforeRoot) return;
    const projects = projectsNow();
    const entry = projects.find((project) => project.root === root);
    if (!entry) return;
    const next = projects.filter((project) => project !== entry);
    const index = next.findIndex((project) => project.root === beforeRoot);
    const slot = index < 0 ? next.length : index;
    if (projects[slot] === entry) return;
    next.splice(slot, 0, entry);
    store.setState({ projects: next });
  },
};

export function useWindowProjects() {
  return useSyncExternalStore(windowProjects.subscribe, projectsNow);
}
