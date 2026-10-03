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

/** `path` as a clean project-relative path, or null when it is empty or climbs out of the project. */
export function normalizeProjectRelativePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

/**
 * Whether a burst the watcher reported may have changed the project file at
 * `path`: it names that file or a folder holding it (a folder removed or
 * renamed takes the file with it), or it names no exact set at all.
 */
export function changesReach(paths: readonly string[] | null, path: string): boolean {
  if (!paths) return true;
  const target = normalizeProjectRelativePath(path);
  return paths.some((rawPath) => {
    const changed = normalizeProjectRelativePath(rawPath);
    return !changed || !target || target === changed || target.startsWith(`${changed}/`);
  });
}
