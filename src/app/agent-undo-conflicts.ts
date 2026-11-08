/**
 * Undone files that came back with conflict markers, from the Agent history
 * (use-agent-checkpoints.ts) to the conflict resolver (app-overleaf-dialogs.tsx).
 * The announcer has already checked the files belong to the open project.
 * The resolver names its sides by who left the markers, so the paths stay
 * known as an Undo's until their dialog closes.
 */
type Listener = (paths: readonly string[]) => void;

const listeners = new Set<Listener>();
const undoConflictPaths = new Set<string>();

export function announceAgentUndoConflicts(paths: readonly string[]) {
  for (const path of paths) undoConflictPaths.add(path);
  for (const listener of listeners) listener(paths);
}

export function subscribeAgentUndoConflicts(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether an Agent Undo, rather than a sync, left the markers in `path`. */
export function isAgentUndoConflict(path: string) {
  return undoConflictPaths.has(path);
}

export function forgetAgentUndoConflict(path: string) {
  undoConflictPaths.delete(path);
}
