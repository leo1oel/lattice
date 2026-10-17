/**
 * The save that must finish before a surface lets go of its project. It lives
 * apart from `use-project-lifecycle.ts`, which calls it, and imports nothing:
 * Vitest reruns its unit test only when this file changes, not for whatever
 * the lifecycle hook's imports reach.
 */

/** How long a project switch waits for an in-flight Overleaf sync before giving up on it. */
const PROJECT_SWITCH_SYNC_WAIT_MS = 15_000;

/** `work`, or a quiet give-up after the project-switch wait. */
export const settleWithin = (work: Promise<unknown>) => Promise.race([
  work,
  new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
]);

/** Why {@link saveEveryEdit} stopped, or "saved" once every open edit is on disk. */
export type SaveEveryEditOutcome = "saved" | "composing" | "failed" | "changed";

/**
 * Publish and durably save every open edit before this surface lets go of its
 * project: a project switch, or another surface taking the workspace. Only
 * "saved" means letting go loses nothing. An unfinished IME composition
 * cannot be published yet, a failed save is reported where it happened, and
 * an edit typed while the save ran is still only in this page's memory.
 */
export async function saveEveryEdit({ flush, save, flushWholeFiles, hasUnsavedEdits }: {
  flush: () => boolean;
  save: () => Promise<boolean>;
  flushWholeFiles: () => Promise<void>;
  hasUnsavedEdits: () => boolean;
}): Promise<SaveEveryEditOutcome> {
  if (!flush()) return "composing";
  if (!(await save())) return "failed";
  await settleWithin(flushWholeFiles());
  return hasUnsavedEdits() ? "changed" : "saved";
}
