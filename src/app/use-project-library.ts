import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode, PaperSummary, ProjectSnapshot, UnusedSymbols, WordCount } from "../app-types";
import { isBibFilePath, toMessage } from "../app-utils";
import type { CitationInfo, ReferenceInfo } from "../editor/latex/latex-text";
import type { HistoryItem } from "../history/history-drawer";
import { changesReach, onBibliographyWrite, onProjectFilesChanged } from "../project/project-files-changed";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { TodoHit } from "../project/todo-scavenger";
import { collectFilePaths } from "./workspace-restore";
import {
  announceProjectIndex, isProjectIndexPending, PROJECT_INDEX_IDLE, projectIndexNotice, projectIndexReducer,
  type CitationIndex, type ReferenceIndex,
} from "./project-index-load";
import type { ProjectState } from "./use-project-state";

const NO_UNUSED_SYMBOLS: UnusedSymbols = { labels: [], citations: [] };

/**
 * How long a watcher burst that touched a .bib waits for the next before the
 * bibliography is read again. A reference manager's auto-export (Better
 * BibTeX) and a git checkout write in several bursts; a large .bib is parsed
 * once for all of them rather than once per burst.
 */
const BIBLIOGRAPHY_WATCH_DELAY_MS = 400;

/**
 * Whether a burst the watcher reported may have changed the project's
 * bibliography: it names a .bib (one the tree does not show yet included), a
 * folder holding one the tree shows, or no exact set at all.
 */
export function changesReachBibliography(paths: readonly string[] | null, files: readonly FileNode[]): boolean {
  if (!paths || paths.some(isBibFilePath)) return true;
  return collectFilePaths([...files], (node) => isBibFilePath(node.path)).some((path) => changesReach(paths, path));
}

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
    invoke<CitationIndex>("list_citations"),
    invoke<ReferenceIndex>("list_references"),
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
  const [indexLoad, dispatchIndexLoad] = useReducer(projectIndexReducer, PROJECT_INDEX_IDLE);
  const indexLoadRef = useLatestRef(indexLoad);
  const bibliographyIndexPending = isProjectIndexPending(indexLoad);
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
    dispatchIndexLoad({ type: "reset" });
  }, []);

  const applyCitations = useCallback((index: CitationIndex) => {
    setCitations(index.citations);
    dispatchIndexLoad({ type: "loaded", part: "citations", skipped: index.skipped });
  }, []);
  const applyReferences = useCallback((index: ReferenceIndex) => {
    setReferences(index.references);
    dispatchIndexLoad({ type: "loaded", part: "references", skipped: index.skipped });
  }, []);
  /** A citation or label read failed: the checks stay off and the toast offers a retry. */
  const failIndex = useCallback((part: "citations" | "references", reason: unknown) => {
    dispatchIndexLoad({ type: "failed", part, error: toMessage(reason) });
  }, []);

  const applyBibliographyIndex = useCallback((
    [nextPapers, nextCitations, nextReferences]: Awaited<ReturnType<typeof loadBibliographyIndex>>,
  ) => {
    const root = projectRef.current?.root;
    if (root) publishPapers(root, nextPapers);
    applyCitations(nextCitations);
    applyReferences(nextReferences);
  }, [applyCitations, applyReferences, projectRef, publishPapers]);

  /** A newer bibliography refresh supersedes this one; see refreshAfterSave. */
  const claimBibliographyRefresh = useCallback(() => {
    const generation = ++bibliographyRefreshGenerationRef.current;
    return () => generation === bibliographyRefreshGenerationRef.current;
  }, []);

  /**
   * Read `projectRoot`'s citation keys and paper list again after its .bib
   * files changed. A failed read keeps keys already shown, and says so only
   * when there were none to keep; a newer bibliography read, or another
   * project, discards this one.
   */
  const refreshCitations = useCallback((projectRoot: string) => {
    const isLatestBibliography = claimBibliographyRefresh();
    void Promise.allSettled([
      invoke<CitationIndex>("list_citations"),
      invoke<PaperSummary[]>("list_papers"),
    ]).then(([nextCitations, nextPapers]) => {
      if (projectRef.current?.root !== projectRoot || !isLatestBibliography()) return;
      if (nextCitations.status === "fulfilled") applyCitations(nextCitations.value);
      else failIndex("citations", nextCitations.reason);
      if (nextPapers.status === "fulfilled") publishPapers(projectRoot, nextPapers.value);
    });
  }, [applyCitations, claimBibliographyRefresh, failIndex, projectRef, publishPapers]);

  /**
   * The bibliography changed without a save in the editor: the agent's
   * bibliography tool, a reference manager's auto-export, a git pull. The
   * unused-citation list follows the keys, so it is read again too.
   */
  const refreshBibliography = useCallback((projectRoot: string) => {
    if (projectRef.current?.root !== projectRoot) return;
    refreshCitations(projectRoot);
    void refreshUnusedSymbols();
  }, [projectRef, refreshCitations, refreshUnusedSymbols]);

  // The watcher reports what changed on disk; only a .bib it may have touched
  // costs a re-read, and a run of bursts costs one.
  const watchedRoot = project?.root;
  useEffect(() => {
    if (!watchedRoot) return;
    let timer: number | undefined;
    const stopListening = onProjectFilesChanged(watchedRoot, (paths) => {
      if (!changesReachBibliography(paths, projectRef.current?.files ?? [])) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refreshBibliography(watchedRoot), BIBLIOGRAPHY_WATCH_DELAY_MS);
    });
    // The agent's own write: the key it just cited must not read as unknown
    // until the watcher catches up.
    const stopAgentWrites = onBibliographyWrite(watchedRoot, () => {
      window.clearTimeout(timer);
      refreshBibliography(watchedRoot);
    });
    return () => {
      window.clearTimeout(timer);
      stopListening();
      stopAgentWrites();
    };
  }, [projectRef, refreshBibliography, watchedRoot]);

  const refreshAfterSave = useCallback((projectRoot: string, wroteTex: boolean, wroteBib: boolean) => {
    const generation = ++postSaveRefreshGenerationRef.current;
    // An index whose last read failed is read again on any save, so the
    // checks come back once the file that broke it is fixed.
    const readCitations = wroteBib || indexLoadRef.current.citations.status === "failed";
    const readReferences = wroteTex || indexLoadRef.current.references.status === "failed";
    // A subsequent .tex save must not discard a pending bibliography refresh,
    // and slow history/word-count scans must not delay the Papers update.
    if (readCitations) refreshCitations(projectRoot);
    // These replies share the scans' slots: a later scan of a kind supersedes
    // this refresh's result for it, and this refresh supersedes earlier ones.
    const ownsProject = captureProjectScope();
    const currentUnused = claimScan(unusedSymbolsScanRef);
    const currentHistory = claimScan(historyScanRef);
    const currentTodos = claimScan(todoScanRef);
    const currentWordCount = claimScan(wordCountScanRef);
    void Promise.allSettled([
      readReferences ? invoke<ReferenceIndex>("list_references") : Promise.resolve(null),
      invoke<UnusedSymbols>("list_unused_symbols"),
      invoke<HistoryItem[]>("list_history"),
      invoke<TodoHit[]>("list_todos"),
      invoke<WordCount>("count_project_words"),
    ] as const).then(([referenceResult, unusedResult, historyResult, todoResult, wordCountResult]) => {
      if (projectRef.current?.root !== projectRoot || !ownsProject() || generation !== postSaveRefreshGenerationRef.current) return;
      if (referenceResult.status === "fulfilled" && referenceResult.value) applyReferences(referenceResult.value);
      else if (referenceResult.status === "rejected") failIndex("references", referenceResult.reason);
      if (unusedResult.status === "fulfilled" && currentUnused()) setUnusedSymbols(unusedResult.value);
      if (historyResult.status === "fulfilled" && currentHistory()) setHistory(historyResult.value);
      if (todoResult.status === "fulfilled" && currentTodos()) setDiskTodos(todoResult.value);
      if (wordCountResult.status === "fulfilled" && currentWordCount()) setProjectWordCount(wordCountResult.value);
    });
  }, [
    applyReferences, captureProjectScope, claimScan, failIndex, indexLoadRef, projectRef, refreshCitations,
  ]);

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

  /** The notice the index toast last showed, so the same files are listed once. */
  const announcedIndexRef = useRef<string | null>(null);
  /** Read the citation and label indexes again, from the toast that says they failed or left files out. */
  const retryProjectIndex = useCallback(() => {
    const root = projectRef.current?.root;
    if (!root) return;
    // The toast closed on the click: whatever this read finds is said again,
    // and a clean read takes down any toast still up. ("" matches no notice.)
    announcedIndexRef.current = "";
    const ownsProject = captureProjectScope();
    const isLatestBibliography = claimBibliographyRefresh();
    const [, citationRequest, referenceRequest] = requestBibliographyIndex();
    void citationRequest.then((index) => {
      if (ownsProject() && isLatestBibliography()) applyCitations(index);
    }, (reason: unknown) => {
      if (ownsProject() && isLatestBibliography()) failIndex("citations", reason);
    });
    void referenceRequest.then((index) => {
      if (ownsProject()) applyReferences(index);
    }, (reason: unknown) => {
      if (ownsProject()) failIndex("references", reason);
    });
  }, [applyCitations, applyReferences, captureProjectScope, claimBibliographyRefresh, failIndex, projectRef]);

  // The toast follows the index: shown when a read fails or leaves files out,
  // taken down once a read succeeds, and not shown again for the same files.
  useEffect(() => {
    const notice = projectIndexNotice(indexLoad);
    const signature = notice && JSON.stringify(notice);
    if (signature === announcedIndexRef.current) return;
    announcedIndexRef.current = signature;
    announceProjectIndex(notice, retryProjectIndex);
  }, [indexLoad, retryProjectIndex]);

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
    const [[citationResult, referenceResult]] = await Promise.all([
      Promise.allSettled([citationRequest, referenceRequest]), papersPublished,
    ]);
    if (!mayApply(snapshot.root)) return snapshot;
    if (isLatestBibliography()) {
      if (citationResult.status === "fulfilled") applyCitations(citationResult.value);
      else failIndex("citations", citationResult.reason);
    }
    if (referenceResult.status === "fulfilled") applyReferences(referenceResult.value);
    else failIndex("references", referenceResult.reason);
    await refreshUnusedSymbols();
    return snapshot;
  }, [
    applyCitations, applyReferences, claimBibliographyRefresh, failIndex, failPapers, projectOperationGenerationRef,
    projectRef, projectRefreshGenerationRef, publishPapers, refreshUnusedSymbols, setProject,
  ]);

  return {
    papers, paperLoad, publishPapers, failPapers, retryPapers, citationKeys, citations, references, bibliographyIndexPending,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    resetBibliographyIndex, applyCitations, applyReferences, failIndex, retryProjectIndex, applyBibliographyIndex,
    claimBibliographyRefresh, refreshAfterSave, refreshProject,
  };
}
