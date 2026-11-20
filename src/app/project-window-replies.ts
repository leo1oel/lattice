/**
 * What `open_project_window` and `open_project` (src-tauri/src/ipc/) answer,
 * as use-project-lifecycle.ts reads it.
 */

// Must match the prefix `open_project_window` puts on a window-creation
// failure. Everything else it can fail with is the project itself.
// eslint-disable-next-line lingui/no-unlocalized-strings -- matched against the backend's error text
export const NEW_WINDOW_FAILURE_PREFIX = "Could not open a new window";
/** What `open_project` answers when another window already shows the project. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- matched against the backend's error text
export const OPEN_IN_ANOTHER_WINDOW = "already open in another Lattice window";

/**
 * `open_project_window`'s answer. A headless host's tab is the only window
 * there is, so the host opens nothing and says `openHere`: the asking window
 * then takes the project itself, as "Open in this window" does (windows.rs).
 */
export type OpenedProjectWindow = { label: string; focusedExisting: boolean; openHere?: boolean } | null;
