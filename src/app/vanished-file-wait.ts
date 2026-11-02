import type { RefObject } from "react";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import type { VanishedFile } from "./use-document-store";

/*
 * The open file left its path behind the editor: a shell `mv` or `git mv`, a
 * branch switch, an `rm`. Its tab must not stay a buffer that takes typing but
 * can never save (the backend refuses to write a deleted file back, rightly:
 * see project/history.rs `apply_editor_transaction`).
 *
 * - Renamed (the same file, or the one holding the saved text, is elsewhere in
 *   the project): the tab follows it, edits and all.
 * - Deleted with nothing unsaved: its tab closes, as Lattice's own delete does.
 * - Deleted with unsaved edits: saves hold, and the writer chooses: recreate
 *   the file where it was, save the edits elsewhere, or close the tab to drop
 *   them. A file that comes back by itself (a branch switched back) ends the
 *   wait, and the edits save against it as usual.
 *
 * The disk poll (use-document-disk-sync.ts) notices; vanished-file.ts, loaded
 * only then so it stays off the startup path, carries the rest out. This module
 * holds what the always-loaded side needs to end the wait.
 */

export const loadVanishedFile = () => import("./vanished-file");

export const vanishedToastKey = (path: string) => `vanished-file:${path}`;

/** The wait for the writer's choice about `vanished` is over: forget it and take its notice down. */
export function settleVanished(vanishedRef: RefObject<VanishedFile | null>, vanished: VanishedFile) {
  if (vanishedRef.current === vanished) vanishedRef.current = null;
  dismissAppToastByDedupeKey(vanishedToastKey(vanished.path));
}
