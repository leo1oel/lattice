/**
 * The keys of `TrellisController.texts`, the last text each document showed:
 * its project and its path, so a snapshot painted while another project's
 * tabs come back never shows that project's file of the same name.
 */
import { createContext } from "react";

export const snapshotTextKey = (root: string, path: string) => `${root}\n${path}`;

/** Forget the texts of every project but those at `roots`. */
export function retainSnapshotTexts(texts: Map<string, string>, roots: readonly string[]) {
  for (const key of texts.keys()) {
    if (!roots.includes(key.slice(0, key.indexOf("\n")))) texts.delete(key);
  }
}

/**
 * The project the workspace drawing a snapshot belongs to (trellis-workspace.tsx
 * provides it). Not the app store's root: a workspace mounting for the next
 * project draws its restored tabs before App publishes that project to the
 * store, and a snapshot that read the store then painted the last project's
 * file of the same name.
 */
export const SnapshotProjectContext = createContext("");
