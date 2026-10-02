import { useCallback, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot, ReplaceResult } from "../app-types";
import { toMessage } from "../app-utils";
import type { ProjectFindHit } from "../project/project-find-dialog";
import type { ReplaceOptions, ReplacePreviewResult } from "../project/project-replace-dialog";
import { useLatest } from "./effect-helpers";
import { setNotice } from "./notify";

type FindState = { open: boolean; busy: boolean; error: string | null; hits: ProjectFindHit[] };
type ReplaceState = { open: boolean; busy: boolean; error: string | null; preview: ReplacePreviewResult | null };

const CLOSED_FIND: FindState = { open: false, busy: false, error: null, hits: [] };
const CLOSED_REPLACE: ReplaceState = { open: false, busy: false, error: null, preview: null };

/**
 * Project-wide find and replace, run on the Rust side: the two dialogs' state
 * and every query they run. A search answers only while it is the newest one
 * and the project it started in is still open, so a slow search never lands
 * over a newer query or in another project. A replace writes the open
 * editor's unsaved edits first, then brings the project back up to date.
 */
export function useProjectSearch(deps: {
  projectRef: RefObject<ProjectSnapshot | null>;
  /** A check that turns false once the project open now is no longer the one open. */
  captureProjectScope: () => () => boolean;
  /** Whether the open editor holds unsaved edits a replace must write first. */
  unsavedEdits: () => boolean;
  save: () => Promise<boolean>;
  /** Reload what a replace may have rewritten: the open file, the project tree, history. */
  afterReplace: () => Promise<void>;
}) {
  const { t } = useLingui();
  const latest = useLatest(deps);
  const [find, setFindState] = useState<FindState>(CLOSED_FIND);
  const [replace, setReplaceState] = useState<ReplaceState>(CLOSED_REPLACE);
  /** Bumped per query (and on close) so a slow search cannot land after a newer one. */
  const searchGenerationRef = useRef(0);
  const setFind = useCallback((update: Partial<FindState>) => setFindState((current) => ({ ...current, ...update })), []);
  const setReplace = useCallback(
    (update: Partial<ReplaceState>) => setReplaceState((current) => ({ ...current, ...update })),
    [],
  );

  const openFind = useCallback(() => setFind({ open: true, error: null, hits: [] }), [setFind]);
  const closeFind = useCallback(() => {
    searchGenerationRef.current += 1;
    setFindState(CLOSED_FIND);
  }, []);
  const search = useCallback(async (query: string) => {
    const generation = ++searchGenerationRef.current;
    const projectRoot = latest.current.projectRef.current?.root;
    if (!query.trim() || !projectRoot) {
      setFind({ hits: [], busy: false, error: null });
      return;
    }
    setFind({ busy: true, error: null });
    const ownsProject = latest.current.captureProjectScope();
    const superseded = () => generation !== searchGenerationRef.current || !ownsProject();
    try {
      const hits = await invoke<ProjectFindHit[]>("search_project", { query });
      if (superseded()) return;
      setFind({ hits });
    } catch (reason) {
      if (superseded()) return;
      setFind({ hits: [], error: toMessage(reason) });
    } finally {
      if (generation === searchGenerationRef.current) setFind({ busy: false });
    }
  }, [latest, setFind]);

  const openReplace = useCallback(() => setReplace({ open: true, error: null, preview: null }), [setReplace]);
  const closeReplace = useCallback(() => setReplace({ open: false, preview: null }), [setReplace]);
  /** Save a dirty buffer, then run one replace step with the dialog's busy/error state. */
  const runReplaceStep = useCallback(async (step: () => Promise<void>, onError?: () => void) => {
    setReplace({ busy: true, error: null });
    try {
      if (latest.current.unsavedEdits() && !(await latest.current.save())) return;
      await step();
    } catch (reason) {
      onError?.();
      setReplace({ error: toMessage(reason) });
    } finally {
      setReplace({ busy: false });
    }
  }, [latest, setReplace]);
  const previewReplace = useCallback((query: string, options: ReplaceOptions) => runReplaceStep(async () => {
    setReplace({ preview: await invoke<ReplacePreviewResult>("preview_replace_in_project", { query, paths: null, ...options }) });
  }, () => setReplace({ preview: null })), [runReplaceStep, setReplace]);
  const applyReplace = useCallback((query: string, replacement: string, options: ReplaceOptions) => runReplaceStep(async () => {
    const result = await invoke<ReplaceResult>("replace_in_project", { query, replacement, paths: null, ...options });
    await latest.current.afterReplace();
    setReplace({ open: false, preview: null });
    const replacements = result.replacements;
    const files = result.filesChanged.length;
    setNotice(!replacements
      ? t`No matches found.`
      : replacements === 1
        ? t`Replaced ${replacements} occurrence in ${files} file.`
        : files === 1
          ? t`Replaced ${replacements} occurrences in ${files} file.`
          : t`Replaced ${replacements} occurrences in ${files} files.`);
  }), [latest, runReplaceStep, setReplace, t]);

  return { find, replace, openFind, closeFind, search, openReplace, closeReplace, previewReplace, applyReplace };
}

export type ProjectSearch = ReturnType<typeof useProjectSearch>;
