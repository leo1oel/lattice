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

// A window shows one project, so a refresh request needs no root.
const treeRefreshRequests = new EventTarget();

/** Ask this window's views of the project tree to read it from disk again: the Refresh action. */
export function requestProjectTreeRefresh(): void {
  treeRefreshRequests.dispatchEvent(new Event("refresh"));
}

/**
 * Call `onStale` whenever the tree of the project at `root` may no longer
 * match the disk: the watcher reported a burst, someone asked for a Refresh,
 * the project was opened again, or the window came back to the front. The
 * last two are when a change made in Finder or another app shows, and the
 * backstop for whatever the watcher missed (an FSEvents overflow, a volume it
 * does not cover). Each is only a prompt to rescan; it does not say, as a
 * watcher burst with no paths does, that every project file may have changed.
 */
export function onProjectTreeStale(root: string, onStale: () => void): () => void {
  const stopWatching = onProjectFilesChanged(root, onStale);
  // Opening the project again raises the window that already shows it.
  const stopReopened = subscribeTauriEvent<{ root: string }>("project-reopened", (payload) => {
    if (payload.root === root) onStale();
  });
  treeRefreshRequests.addEventListener("refresh", onStale);
  window.addEventListener("focus", onStale);
  return () => {
    stopWatching();
    stopReopened();
    treeRefreshRequests.removeEventListener("refresh", onStale);
    window.removeEventListener("focus", onStale);
  };
}

// Lattice's own writes to a .bib outside the editor, for this window.
const bibliographyWrites = new EventTarget();

/** Say that Lattice itself (the agent's bibliography tool) just wrote a .bib of the project at `root`. */
export function announceBibliographyWrite(root: string): void {
  bibliographyWrites.dispatchEvent(new CustomEvent("write", { detail: root }));
}

/**
 * Call `onWrite` each time Lattice announces a write to a .bib of the project
 * at `root`. The watcher reports the same write, but only after its debounce.
 */
export function onBibliographyWrite(root: string, onWrite: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === root) onWrite();
  };
  bibliographyWrites.addEventListener("write", listener);
  return () => bibliographyWrites.removeEventListener("write", listener);
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
