import { useCallback, useRef, useState } from "react";
import type { ProjectFindHit } from "../project/project-find-dialog";
import type { ReplacePreviewResult } from "../project/project-replace-dialog";

type FindState = { open: boolean; busy: boolean; error: string | null; hits: ProjectFindHit[] };
type ReplaceState = { open: boolean; busy: boolean; error: string | null; preview: ReplacePreviewResult | null };

/** Open/busy/result state of the project-wide find and replace dialogs. */
export function useProjectSearch() {
  const [find, setFindState] = useState<FindState>({ open: false, busy: false, error: null, hits: [] });
  const [replace, setReplaceState] = useState<ReplaceState>({ open: false, busy: false, error: null, preview: null });
  /** Bumped per query (and on close) so a slow search cannot land after a newer one. */
  const searchGenerationRef = useRef(0);
  const setFind = useCallback((update: Partial<FindState>) => setFindState((current) => ({ ...current, ...update })), []);
  const setReplace = useCallback(
    (update: Partial<ReplaceState>) => setReplaceState((current) => ({ ...current, ...update })),
    [],
  );
  const openFind = useCallback(() => setFind({ open: true, error: null, hits: [] }), [setFind]);
  const openReplace = useCallback(() => setReplace({ open: true, error: null, preview: null }), [setReplace]);
  return { find, setFind, replace, setReplace, searchGenerationRef, openFind, openReplace };
}

export type ProjectSearch = ReturnType<typeof useProjectSearch>;
