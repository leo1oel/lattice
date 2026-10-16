import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot, UnusedSymbols, WordCount } from "../app-types";
import { toMessage } from "../app-utils";
import type { CitationInfo, ReferenceInfo } from "../editor/latex/latex-text";
import type { HistoryItem } from "../history/history-drawer";
import type { TodoHit } from "../project/todo-scavenger";
import type { ProjectState } from "./use-project-state";

const NO_UNUSED_SYMBOLS: UnusedSymbols = { labels: [], citations: [] };

type CitationHealth = NonNullable<PaperSummary["citationHealth"]>;

/**
 * Whether a project's paper list has been read. An unread list is not an empty
 * library: until the first read lands the panel says it is loading, and a read
 * that failed says so with a retry, rather than inviting a first paper.
 */
export type PaperLoad =
  | { root: string | null; status: "loading" | "ready" }
  | { root: string; status: "error"; error: string };

/** A row whose health the cache could not vouch for: never checked, or expired. */
const awaitsHealthCheck = (paper: PaperSummary) => Boolean(paper.doi && (!paper.citationHealth || paper.citationHealth.stale));

/** The bibliography-derived indexes, read in one round. */
export function loadBibliographyIndex() {
  return Promise.all(requestBibliographyIndex());
}

/**
 * The reads of `loadBibliographyIndex`, each on its own: the paper list comes
 * back at once (it reads only local files and cached citation health), while
 * the label scan of a long .tex takes seconds.
 */
export function requestBibliographyIndex() {
  return [
    invoke<PaperSummary[]>("list_papers"),
    invoke<CitationInfo[]>("list_citations"),
    invoke<ReferenceInfo[]>("list_references"),
  ] as const;
}

/**
 * Everything the backend derives from the project's files: papers and
 * citations, labels, unused symbols, history, TODO markers, and word counts.
 */
export function useProjectLibrary(state: ProjectState) {
  const {
    project, setProject, projectRef, projectOperationGenerationRef, projectRefreshGenerationRef, captureProjectScope,
  } = state;
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [paperLoad, setPaperLoad] = useState<PaperLoad>({ root: null, status: "loading" });
  const citationHealthGenerationRef = useRef(0);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const citationKeys = useMemo(() => citations.map((citation) => citation.key), [citations]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [bibliographyIndexPending, setBibliographyIndexPending] = useState(false);
  const [unusedSymbols, setUnusedSymbols] = useState<UnusedSymbols>(NO_UNUSED_SYMBOLS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [diskTodos, setDiskTodos] = useState<TodoHit[]>([]);
  const [projectWordCount, setProjectWordCount] = useState<WordCount | null>(null);
  const postSaveRefreshGenerationRef = useRef(0);
  const bibliographyRefreshGenerationRef = useRef(0);

  const historyScanRef = useRef(0);
  const todoScanRef = useRef(0);
  const wordCountScanRef = useRef(0);
  const unusedSymbolsScanRef = useRef(0);

  /**
   * Claim one kind of scan. The predicate holds while the project that started
   * it still owns the window (same root and operation generation, so leaving
   * and reopening the same root also discards it) and no later scan of that
   * kind has started: a project switch starts the incoming project's scans
   * while the outgoing ones are still in flight, and the late reply must not
   * replace the incoming project's rows.
   */
  const claimScan = useCallback((scanRef: { current: number }) => {
    const scan = ++scanRef.current;
    const ownsProject = captureProjectScope();
    return () => scan === scanRef.current && ownsProject();
  }, [captureProjectScope]);

  const loadHistory = useCallback(async () => {
    const current = claimScan(historyScanRef);
    const rows = await invoke<HistoryItem[]>("list_history");
    if (current()) setHistory(rows);
  }, [claimScan]);
  const loadTodos = useCallback(async () => {
    const current = claimScan(todoScanRef);
    const hits = await invoke<TodoHit[]>("list_todos").catch(() => []);
    if (current()) setDiskTodos(hits);
  }, [claimScan]);
  const loadWordCount = useCallback(async () => {
    const current = claimScan(wordCountScanRef);
    const count = await invoke<WordCount>("count_project_words").catch(() => null);
    if (current()) setProjectWordCount(count);
  }, [claimScan]);
  const refreshUnusedSymbols = useCallback(async () => {
    const current = claimScan(unusedSymbolsScanRef);
    const symbols = await invoke<UnusedSymbols>("list_unused_symbols").catch(() => NO_UNUSED_SYMBOLS);
    if (current()) setUnusedSymbols(symbols);
  }, [claimScan]);
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

  /**
   * Show `rows` as `root`'s library at once, then recheck in the background
   * the citation health the cache could not vouch for. Health is per DOI, so a
   * recheck lands on whichever rows the project shows by then; a newer recheck
   * or another project discards it.
   */
  const publishPapers = useCallback((root: string, rows: PaperSummary[]) => {
    setPapers(rows);
    setPaperLoad({ root, status: "ready" });
    if (!rows.some(awaitsHealthCheck)) return;
    const generation = ++citationHealthGenerationRef.current;
    void invoke<Record<string, CitationHealth>>("refresh_citation_health").then((health) => {
      if (generation !== citationHealthGenerationRef.current || projectRef.current?.root !== root) return;
      setPapers((current) => current.map((paper) => {
        const checked = paper.doi ? health[paper.doi] : undefined;
        return checked ? { ...paper, citationHealth: checked } : paper;
      }));
    }, () => undefined);
  }, [projectRef]);

  /** A failed read leaves a library already shown as it was; an unread one says it failed. */
  const failPapers = useCallback((root: string, reason: unknown) => {
    setPaperLoad((current) => (
      current.root === root && current.status === "ready" ? current : { root, status: "error", error: toMessage(reason) }
    ));
  }, []);

  /**
   * Forget the outgoing project's papers, keys and labels until the incoming
   * project's index lands, so its rows never show under the new project.
   */
  const resetBibliographyIndex = useCallback((root: string) => {
    citationHealthGenerationRef.current += 1;
    setPapers([]);
    setPaperLoad({ root, status: "loading" });
    setCitations([]);
    setReferences([]);
    setBibliographyIndexPending(true);
  }, []);

  const applyReferences = useCallback((nextReferences: ReferenceInfo[] | null | undefined) => {
    setReferences(nextReferences ?? []);
    setBibliographyIndexPending(false);
  }, []);

  const applyBibliographyIndex = useCallback((
    [nextPapers, nextCitations, nextReferences]: Awaited<ReturnType<typeof loadBibliographyIndex>>,
  ) => {
    const root = projectRef.current?.root;
    if (root) publishPapers(root, nextPapers);
    setCitations(nextCitations);
    applyReferences(nextReferences);
  }, [applyReferences, projectRef, publishPapers]);

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
        invoke<CitationInfo[]>("list_citations"),
        invoke<PaperSummary[]>("list_papers"),
      ]).then(([nextCitations, nextPapers]) => {
        if (projectRef.current?.root !== projectRoot || !isLatestBibliography()) return;
        if (nextCitations.status === "fulfilled") setCitations(nextCitations.value);
        if (nextPapers.status === "fulfilled") publishPapers(projectRoot, nextPapers.value);
      });
    }
    // These replies share the scans' slots: a later scan of a kind supersedes
    // this refresh's result for it, and this refresh supersedes earlier ones.
    const ownsProject = captureProjectScope();
    const currentUnused = claimScan(unusedSymbolsScanRef);
    const currentHistory = claimScan(historyScanRef);
    const currentTodos = claimScan(todoScanRef);
    const currentWordCount = claimScan(wordCountScanRef);
    void Promise.allSettled([
      wroteTex ? invoke<ReferenceInfo[]>("list_references") : Promise.resolve(null),
      invoke<UnusedSymbols>("list_unused_symbols"),
      invoke<HistoryItem[]>("list_history"),
      invoke<TodoHit[]>("list_todos"),
      invoke<WordCount>("count_project_words"),
    ] as const).then(([referenceResult, unusedResult, historyResult, todoResult, wordCountResult]) => {
      if (projectRef.current?.root !== projectRoot || !ownsProject() || generation !== postSaveRefreshGenerationRef.current) return;
      if (referenceResult.status === "fulfilled" && referenceResult.value) setReferences(referenceResult.value);
      if (unusedResult.status === "fulfilled" && currentUnused()) setUnusedSymbols(unusedResult.value);
      if (historyResult.status === "fulfilled" && currentHistory()) setHistory(historyResult.value);
      if (todoResult.status === "fulfilled" && currentTodos()) setDiskTodos(todoResult.value);
      if (wordCountResult.status === "fulfilled" && currentWordCount()) setProjectWordCount(wordCountResult.value);
    });
  }, [captureProjectScope, claimBibliographyRefresh, claimScan, projectRef, publishPapers]);

  /** Read the paper list again after a failed read, from the Papers panel's retry. */
  const retryPapers = useCallback(() => {
    const root = projectRef.current?.root;
    if (!root) return;
    const isLatestBibliography = claimBibliographyRefresh();
    setPaperLoad({ root, status: "loading" });
    void invoke<PaperSummary[]>("list_papers").then((rows) => {
      if (projectRef.current?.root === root && isLatestBibliography()) publishPapers(root, rows);
    }, (reason: unknown) => {
      if (projectRef.current?.root === root && isLatestBibliography()) failPapers(root, reason);
    });
  }, [claimBibliographyRefresh, failPapers, projectRef, publishPapers]);

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
    // Each read lands on its own, as on opening: the rows an Overleaf pull
    // brought do not wait for the label scan of a long .tex. A save that
    // re-reads the bibliography after this started supersedes it.
    const isLatestBibliography = claimBibliographyRefresh();
    const [paperRequest, citationRequest, referenceRequest] = requestBibliographyIndex();
    const papersPublished = paperRequest.then((rows) => {
      if (mayApply(snapshot.root) && isLatestBibliography()) publishPapers(snapshot.root, rows);
    }, (reason: unknown) => {
      if (mayApply(snapshot.root) && isLatestBibliography()) failPapers(snapshot.root, reason);
      throw reason;
    });
    const [, nextCitations, nextReferences] = await Promise.all([papersPublished, citationRequest, referenceRequest]);
    if (!mayApply(snapshot.root)) return snapshot;
    if (isLatestBibliography()) setCitations(nextCitations);
    applyReferences(nextReferences);
    await refreshUnusedSymbols();
    return snapshot;
  }, [
    applyReferences, claimBibliographyRefresh, failPapers, projectOperationGenerationRef, projectRef,
    projectRefreshGenerationRef, publishPapers, refreshUnusedSymbols, setProject,
  ]);

  return {
    papers, paperLoad, publishPapers, failPapers, retryPapers, citationKeys, citations, references, bibliographyIndexPending,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    resetBibliographyIndex, applyReferences, setCitations, applyBibliographyIndex, claimBibliographyRefresh, refreshAfterSave,
    refreshProject,
  };
}
