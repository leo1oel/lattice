/**
 * The recent projects' marks, loaded only once a list of them is on screen
 * (use-recent-project-marks.ts): each folder is looked at again, so one that
 * is gone is marked, never dropped unseen, and one linked to Overleaf is
 * labelled (`recent_project_states` in src-tauri/src/ipc/workspace.rs).
 */
import { invoke } from "@tauri-apps/api/core";
import { loadRecentProjects, persistSetting, RECENT_PROJECTS_KEY, type RecentProject } from "../settings/app-settings";

/** What `recent_project_states` found for one folder. */
export type RecentProjectState = { missing: boolean; overleaf: boolean };

/**
 * Mark each listed project as its folder was found, keeping the order: a
 * folder that is gone stays listed and marked, never dropped unseen. Returns
 * null when nothing changed, so a caller writes and re-renders only for news.
 */
export function markRecentProjects(states: ReadonlyMap<string, RecentProjectState>): RecentProject[] | null {
  let changed = false;
  const projects = loadRecentProjects().map((item) => {
    const state = states.get(item.path);
    if (!state || (Boolean(item.missing) === state.missing && Boolean(item.overleaf) === state.overleaf)) return item;
    changed = true;
    const { missing: _missing, overleaf: _overleaf, ...rest } = item;
    // A folder that is gone keeps what it last was: its link comes back with it.
    const overleaf = state.missing ? item.overleaf : state.overleaf;
    return { ...rest, ...(overleaf ? { overleaf: true } : {}), ...(state.missing ? { missing: true } : {}) };
  });
  return changed ? (persistSetting(RECENT_PROJECTS_KEY, JSON.stringify(projects)), projects) : null;
}

/** The recent projects with each folder's marks brought up to date, or null when none changed or the shell could not say. */
export async function recheckRecentProjects(): Promise<RecentProject[] | null> {
  const paths = loadRecentProjects().map((item) => item.path);
  if (!paths.length) return null;
  // Without an answer (a browser tab, an older shell) the marks stay as they were.
  const states = await invoke<RecentProjectState[]>("recent_project_states", { paths }).catch(() => null);
  if (!states || states.length !== paths.length) return null;
  return markRecentProjects(new Map(paths.map((path, index) => [path, states[index]])));
}
