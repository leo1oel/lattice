import { subscribeTauriEvent } from "../app/effect-helpers";

/** What the Rust watcher (`src-tauri/src/fs_watch.rs`) broadcasts to every window after a burst of changes. */
type ProjectFilesChangedPayload = { root: string; paths?: string[] | null };

/**
 * Call `onChange` each time the filesystem watcher reports a coalesced burst
 * of changes under the project at `root`, until the returned disposer runs.
 * `paths` holds the changed project-relative paths when the watcher knows the
 * exact set, and is null when anything in the project may have changed.
 */
export function onProjectFilesChanged(
  root: string,
  onChange: (paths: readonly string[] | null) => void,
): () => void {
  return subscribeTauriEvent<ProjectFilesChangedPayload>("project-fs-changed", (payload) => {
    if (payload.root === root) onChange(payload.paths?.length ? payload.paths : null);
  });
}
