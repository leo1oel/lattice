import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot, UnusedSymbols, WordCount } from "../app-types";
import type { CitationInfo, ReferenceInfo } from "../editor/latex/latex-text";
import type { HistoryItem } from "../history/history-drawer";
import type { TodoHit } from "../project/todo-scavenger";
import type { ProjectState } from "./use-project-state";

const NO_UNUSED_SYMBOLS: UnusedSymbols = { labels: [], citations: [] };

/** The bibliography-derived indexes, read in one round. */
export function loadBibliographyIndex() {
  return Promise.all(requestBibliographyIndex());
}

/**
 * The reads of `loadBibliographyIndex`, each on its own: the paper list comes
 * back at once, while the label scan of a long .tex takes seconds.
 */
export function requestBibliographyIndex() {
  return [
    invoke<PaperSummary[]>("list_papers"),
    invoke<string[]>("list_citation_keys"),
    invoke<CitationInfo[]>("list_citations"),
    invoke<ReferenceInfo[]>("list_references"),
  ] as const;
}

/**
 * Everything the backend derives from the project's files: papers and
 * citations, labels, unused symbols, history, TODO markers, and word counts.
 */
export function useProjectLibrary(state: ProjectState) {
  const { project, setProject, projectRef, projectOperationGenerationRef, projectRefreshGenerationRef } = state;
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [citationKeys, setCitationKeys] = useState<string[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [bibliographyIndexPending, setBibliographyIndexPending] = useState(false);
  const [unusedSymbols, setUnusedSymbols] = useState<UnusedSymbols>(NO_UNUSED_SYMBOLS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [diskTodos, setDiskTodos] = useState<TodoHit[]>([]);
  const [projectWordCount, setProjectWordCount] = useState<WordCount | null>(null);
  const postSaveRefreshGenerationRef = useRef(0);
  const bibliographyRefreshGenerationRef = useRef(0);

  const loadHistory = useCallback(async () => setHistory(await invoke<HistoryItem[]>("list_history")), []);
  const loadTodos = useCallback(async () => setDiskTodos(await invoke<TodoHit[]>("list_todos").catch(() => [])), []);
  const loadWordCount = useCallback(async () => setProjectWordCount(await invoke<WordCount>("count_project_words").catch(() => null)), []);
  const refreshUnusedSymbols = useCallback(
    async () => setUnusedSymbols(await invoke<UnusedSymbols>("list_unused_symbols").catch(() => NO_UNUSED_SYMBOLS)),
    [],
  );
  const refreshHistory = useCallback(async () => {
    if (project) await loadHistory();
  }, [loadHistory, project]);
  const refreshTodos = useCallback(async () => {
    if (project) await loadTodos();
    else setDiskTodos([]);
  }, [loadTodos, project]);
  const refreshWordCount = useCallback(async () => {
    if (project) await loadWordCount();
    else setProjectWordCount(null);
  }, [loadWordCount, project]);

  /** Forget the outgoing project's keys and labels until the incoming project's index lands. */
  const resetBibliographyIndex = useCallback(() => {
    setCitationKeys([]);
    setCitations([]);
    setReferences([]);
    setBibliographyIndexPending(true);
  }, []);

  const applyReferences = useCallback((nextReferences: ReferenceInfo[] | null | undefined) => {
    setReferences(nextReferences ?? []);
    setBibliographyIndexPending(false);
  }, []);

  const applyBibliographyIndex = useCallback((
    [nextPapers, nextCitationKeys, nextCitations, nextReferences]: Awaited<ReturnType<typeof loadBibliographyIndex>>,
  ) => {
    setPapers(nextPapers);
    setCitationKeys(nextCitationKeys);
    setCitations(nextCitations);
    applyReferences(nextReferences);
  }, [applyReferences]);

  /** A newer bibliography refresh supersedes this one; see refreshAfterSave. */
  const claimBibliographyRefresh = useCallback(() => {
    const generation = ++bibliographyRefreshGenerationRef.current;
    return () => generation === bibliographyRefreshGenerationRef.current;
  }, []);

  const refreshAfterSave = useCallback((projectRoot: string, wroteTex: boolean, wroteBib: boolean) => {
    const generation = ++postSaveRefreshGenerationRef.current;
    // A subsequent .tex save must not discard a pending bibliography refresh,
    // and slow history/word-count scans must not delay the Papers update.
    if (wroteBib) {
      const isLatestBibliography = claimBibliographyRefresh();
      void Promise.allSettled([
        invoke<string[]>("list_citation_keys"),
        invoke<CitationInfo[]>("list_citations"),
        invoke<PaperSummary[]>("list_papers"),
      ]).then(([keys, nextCitations, nextPapers]) => {
        if (projectRef.current?.root !== projectRoot || !isLatestBibliography()) return;
        if (keys.status === "fulfilled") setCitationKeys(keys.value);
        if (nextCitations.status === "fulfilled") setCitations(nextCitations.value);
        if (nextPapers.status === "fulfilled") setPapers(nextPapers.value);
      });
    }
    void Promise.allSettled([
      wroteTex ? invoke<ReferenceInfo[]>("list_references") : Promise.resolve(null),
      invoke<UnusedSymbols>("list_unused_symbols"),
      invoke<HistoryItem[]>("list_history"),
      invoke<TodoHit[]>("list_todos"),
      invoke<WordCount>("count_project_words"),
    ] as const).then(([referenceResult, unusedResult, historyResult, todoResult, wordCountResult]) => {
      if (projectRef.current?.root !== projectRoot || generation !== postSaveRefreshGenerationRef.current) return;
      if (referenceResult.status === "fulfilled" && referenceResult.value) setReferences(referenceResult.value);
      if (unusedResult.status === "fulfilled") setUnusedSymbols(unusedResult.value);
      if (historyResult.status === "fulfilled") setHistory(historyResult.value);
      if (todoResult.status === "fulfilled") setDiskTodos(todoResult.value);
      if (wordCountResult.status === "fulfilled") setProjectWordCount(wordCountResult.value);
    });
  }, [claimBibliographyRefresh, projectRef]);

  /** Re-read the tree and every bibliography index, unless a newer refresh or project took over. */
  const refreshProject = useCallback(async (scope?: { expectedRoot: string; generation: number }) => {
    const refreshGeneration = ++projectRefreshGenerationRef.current;
    // A scoped refresh also yields to a project switch, including one that
    // lands between the tree read and the bibliography read.
    const mayApply = (snapshotRoot: string) => refreshGeneration === projectRefreshGenerationRef.current && (!scope || (
      projectOperationGenerationRef.current === scope.generation
      && projectRef.current?.root === scope.expectedRoot
      && snapshotRoot === scope.expectedRoot
    ));
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    if (!mayApply(snapshot.root)) return snapshot;
    setProject(snapshot);
    const index = await loadBibliographyIndex();
    if (!mayApply(snapshot.root)) return snapshot;
    applyBibliographyIndex(index);
    await refreshUnusedSymbols();
    return snapshot;
  }, [applyBibliographyIndex, projectOperationGenerationRef, projectRef, projectRefreshGenerationRef, refreshUnusedSymbols, setProject]);

  return {
    papers, setPapers, citationKeys, citations, references, bibliographyIndexPending,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    resetBibliographyIndex, applyReferences, applyBibliographyIndex, claimBibliographyRefresh, refreshAfterSave,
    refreshProject,
  };
}
