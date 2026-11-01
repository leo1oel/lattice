import { useCallback, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot, ReplaceResult } from "../app-types";
import { hostErrorMessage } from "../app-utils";
import type { ProjectFindHit } from "../project/project-find-dialog";
import type { ReplaceOptions, ReplacePreviewResult } from "../project/project-replace-dialog";
import { useLatestRef } from "../hooks/use-latest-ref";
import { showNotice } from "./notify";

/** `seed`: a query handed over by whoever opened Find (the palette's no-match row); new per opening. */
type FindState = { open: boolean; busy: boolean; error: string | null; hits: ProjectFindHit[]; seed: { query: string } | null };
type ReplaceState = { open: boolean; busy: boolean; error: string | null; preview: ReplacePreviewResult | null };

const CLOSED_FIND: FindState = { open: false, busy: false, error: null, hits: [], seed: null };
const CLOSED_REPLACE: ReplaceState = { open: false, busy: false, error: null, preview: null };

/**
 * Project-wide find and replace, run on the Rust side: the two dialogs' state
 * and every query they run. A search answers only while it is the newest one
 * and the project it started in is still open, so a slow search never lands
 * over a newer query or in another project. A replace writes the open
 * editor's unsaved edits first, then brings the project back up to date.
 *
 * A replace is bound the same way to the project and the dialog operation it
 * started in: the save before it can take long enough for the writer to close
 * the dialog or switch projects, and a replacement approved for A must then
 * never run, so it is dropped before it reaches the backend, which also
 * refuses a request for a project that is no longer the window's.
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
  const depsRef = useLatestRef(deps);
  const [find, setFindState] = useState<FindState>(CLOSED_FIND);
  const [replace, setReplaceState] = useState<ReplaceState>(CLOSED_REPLACE);
  /** Bumped per query (and on close) so a slow search cannot land after a newer one. */
  const searchGenerationRef = useRef(0);
  const setFind = useCallback((update: Partial<FindState>) => setFindState((current) => ({ ...current, ...update })), []);
  const setReplace = useCallback(
    (update: Partial<ReplaceState>) => setReplaceState((current) => ({ ...current, ...update })),
    [],
  );

  const openFind = useCallback(() => setFind({ open: true, error: null, hits: [], seed: null }), [setFind]);
  /** Open Find on `query`, as if typed there. */
  const openFindFor = useCallback((query: string) => setFind({ open: true, error: null, hits: [], seed: { query } }), [setFind]);
  const closeFind = useCallback(() => {
    searchGenerationRef.current += 1;
    setFindState(CLOSED_FIND);
  }, []);
  const search = useCallback(async (query: string) => {
    const generation = ++searchGenerationRef.current;
    const projectRoot = depsRef.current.projectRef.current?.root;
    if (!query.trim() || !projectRoot) {
      setFind({ hits: [], busy: false, error: null });
      return;
    }
    setFind({ busy: true, error: null });
    const ownsProject = depsRef.current.captureProjectScope();
    const superseded = () => generation !== searchGenerationRef.current || !ownsProject();
    await invoke<ProjectFindHit[]>("search_project", { query }).then(
      (hits) => {
        if (!superseded()) setFind({ hits });
      },
      (reason) => {
        if (!superseded()) setFind({ hits: [], error: hostErrorMessage(reason) });
      },
    );
    if (generation === searchGenerationRef.current) setFind({ busy: false });
  }, [depsRef, setFind]);

  /** Bumped per preview or replace (and on close) so a stale one neither runs nor lands. */
  const replaceGenerationRef = useRef(0);
  const openReplace = useCallback(() => setReplace({ open: true, error: null, preview: null }), [setReplace]);
  const closeReplace = useCallback(() => {
    replaceGenerationRef.current += 1;
    setReplaceState(CLOSED_REPLACE);
  }, []);
  /**
   * Save a dirty buffer, then run one replace step with the dialog's busy/error
   * state. `step` runs only while the project it was asked for is open and
   * its operation is the dialog's newest; it gets checks for both, as it may
   * outlive them.
   */
  const runReplaceStep = useCallback(async (
    step: (scope: { projectRoot: string; ownsProject: () => boolean; isCurrent: () => boolean }) => Promise<void>,
    onError?: () => void,
  ) => {
    const { unsavedEdits, save, projectRef, captureProjectScope } = depsRef.current;
    const projectRoot = projectRef.current?.root;
    if (!projectRoot) return;
    const generation = ++replaceGenerationRef.current;
    const ownsProject = captureProjectScope();
    const isCurrent = () => generation === replaceGenerationRef.current && ownsProject();
    setReplace({ busy: true, error: null });
    await (async () => {
      if (unsavedEdits() && !(await save())) return;
      if (isCurrent()) await step({ projectRoot, ownsProject, isCurrent });
    })().catch((reason: unknown) => {
      if (!isCurrent()) return;
      onError?.();
      setReplace({ error: hostErrorMessage(reason) });
    });
    if (generation === replaceGenerationRef.current) setReplace({ busy: false });
  }, [depsRef, setReplace]);
  const previewReplace = useCallback((query: string, options: ReplaceOptions) => runReplaceStep(async ({ isCurrent }) => {
    const preview = await invoke<ReplacePreviewResult>("preview_replace_in_project", { query, paths: null, ...options });
    if (isCurrent()) setReplace({ preview });
  }, () => setReplace({ preview: null })), [runReplaceStep, setReplace]);
  const applyReplace = useCallback((query: string, replacement: string, options: ReplaceOptions) => runReplaceStep(async ({ projectRoot, ownsProject, isCurrent }) => {
    const result = await invoke<ReplaceResult>("replace_in_project", { projectRoot, query, replacement, paths: null, ...options });
    // The files changed on disk: reload them and say so even if the dialog
    // closed meanwhile, but not into a project opened since.
    if (!ownsProject()) return;
    await depsRef.current.afterReplace();
    if (!ownsProject()) return;
    if (isCurrent()) setReplace({ open: false, preview: null });
    const replacements = result.replacements;
    const files = result.filesChanged.length;
    showNotice(!replacements
      ? t`No matches found.`
      : replacements === 1
        ? t`Replaced ${replacements} occurrence in ${files} file.`
        : files === 1
          ? t`Replaced ${replacements} occurrences in ${files} file.`
          : t`Replaced ${replacements} occurrences in ${files} files.`);
  }), [depsRef, runReplaceStep, setReplace, t]);

  return { find, replace, openFind, openFindFor, closeFind, search, openReplace, closeReplace, previewReplace, applyReplace };
}

export type ProjectSearch = ReturnType<typeof useProjectSearch>;
