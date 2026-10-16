import { useCallback, useState } from "react";

export type FigureEdit = { path: string; before: string; after: string };

/** Undo outlives the dialog so navigation and reopening keep it, but a project switch clears it. */
export function useProjectFigureUndo(root: string) {
  const [state, setState] = useState<{ root: string; edits: FigureEdit[] }>({ root, edits: [] });
  if (state.root !== root) setState({ root, edits: [] });
  const setEdits = useCallback((update: (previous: FigureEdit[]) => FigureEdit[]) =>
    setState((previous) => ({ root: previous.root, edits: update(previous.edits) })), []);
  return [state.root === root ? state.edits : [], setEdits] as const;
}
