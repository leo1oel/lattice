import { useCallback, useEffect, useMemo, useReducer, useRef, type RefObject } from "react";
import type { DocumentViewMode, PaperSummary, RefreshProject } from "../app-types";
import { paperTabKey } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useStoreSlice } from "../hooks/use-store-slice";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import { useFileViewStates } from "./use-file-view-states";
import type { ProjectState } from "./use-project-state";
import { collectAssetPaths } from "./workspace-restore";
import { paperDocumentPath } from "./paper-documents";
import { createOpenDocumentsStore, type OpenDocumentsState, type OpenDocumentsStore } from "./open-documents-store";
import { readDiskMtime } from "./read-document";
import { panelViewMode, setsDocumentMode, type RememberedViewModes } from "./document-view-modes";
import { publishDeferredEdits, type SurfaceOwner } from "./open-document-intents";

export type OpenDocumentsDeps = {
  projectState: ProjectState;
  /** The project's Papers, which `paper:` tab keys name. */
  papers: PaperSummary[];
  /** Posts the canvas's jump-to-line and view-restore requests. */
  updateCanvasRequest: UpdateCanvasRequest;
  /** Every open stops the speculative preview work for the document it might have been. */
  cancelPrewarm: () => void;
  /** Re-reads the tree; a delete picks the replacement document from the result. */
  refreshProject: RefreshProject;
  /** A save wrote `paths` into the project at `root`. */
  onSaved: (root: string, paths: readonly string[]) => void;
  /** The open file changed on disk behind the editor (an agent, another app). */
  onDiskEdit: (path: string) => void;
  /** Saves follow a pause in typing; with automatic builds on, a build follows each save. */
  autoBuild: {
    enabled: boolean;
    /** Build after an automatic save, without waiting on a preview. */
    afterSave: () => void;
    /** Rebuild after the open file changed on disk. */
    afterDiskEdit: () => void;
  };
};

/** The state behind the open-documents store, shared by the hooks that carry out its commands. */
export type DocumentStore = ReturnType<typeof useDocumentStore>;

/**
 * The open documents' state: the buffers, the tabs, the canvas mode, the
 * intent generations, back/forward history and the canvas's registered side,
 * with the buffer primitives every command builds on. Commands live in the
 * hooks that take this store; see useOpenDocuments.
 */
export function useDocumentStore(deps: OpenDocumentsDeps) {
  const depsRef = useLatestRef(deps);
  const { project, projectRef, projectBeforeTransitionRef, projectOperationGenerationRef, captureProjectScope } = deps.projectState;
  const projectRoot = project?.root ?? null;
  // Made once per mount and kept: nothing is ever dispatched to this reducer.
  const [documentsStore] = useReducer(keepStore, null, createOpenDocumentsStore);
  // Subscribe to what renders; back/forward history and the "Opening …"
  // overlay are read where they are used, so they never render App.
  const {
    file, text, savedText, asset, paper, paperView, paperMarkdown, savedPaperMarkdown, paperBlog, savedPaperBlog,
    tabs, revealRequest, mode, persistenceReadyRoot, tabsSettledRoot,
  } = useStoreSlice(documentsStore, renderedFields);
  const {
    setFile, setText, setSavedText, setAsset, setPaper, setPaperView, setPaperMarkdown, setSavedPaperMarkdown,
    setPaperBlog, setSavedPaperBlog, setTabs, setMode, setOpening, setNavStack, setNavIndex,
    setPersistenceReadyRoot, setTabsSettledRoot, commitFileText, showFileText, setPaperBuffers, closePaper,
    addTab, showTab, pushNavigation,
  } = documentsStore.getState();
  // Ref-shaped views for async work: they read the store, so they hold every write at once.
  const {
    fileRef, textRef, savedRef, assetRef, paperMarkdownRef, savedPaperMarkdownRef, paperBlogRef, savedPaperBlogRef, tabsRef,
  } = useMemo(() => ({
    fileRef: liveField(documentsStore, "file"),
    textRef: liveField(documentsStore, "text"),
    savedRef: liveField(documentsStore, "savedText"),
    assetRef: liveField(documentsStore, "asset"),
    paperMarkdownRef: liveField(documentsStore, "paperMarkdown"),
    savedPaperMarkdownRef: liveField(documentsStore, "savedPaperMarkdown"),
    paperBlogRef: liveField(documentsStore, "paperBlog"),
    savedPaperBlogRef: liveField(documentsStore, "savedPaperBlog"),
    tabsRef: liveField(documentsStore, "tabs"),
  }), [documentsStore]);
  const paperPath = paper ? paperDocumentPath(paper.arxivId, paperView) : null;
  const paperDirty = Boolean(paper) && (paperMarkdown !== savedPaperMarkdown || paperBlog !== savedPaperBlog);

  // ---- Closed tabs stack for reopening.
  const closedRef = useRef<string[]>([]);

  // ---- Canvas mode, and the modes each kind of document returns to.
  const htmlModesRef = useRef(new Map<string, DocumentViewMode>());
  const documentModeRef = useRef<DocumentViewMode>("split");
  // A bibliography opens as its source until the writer picks its reference list (Preview) or Split.
  const bibModeRef = useRef<DocumentViewMode>("source");
  const viewModes = useCallback((): RememberedViewModes => ({
    html: htmlModesRef.current, bib: bibModeRef.current, document: documentModeRef.current,
  }), []);
  const viewModeFor = useCallback((path: string) => panelViewMode(path, viewModes()), [viewModes]);
  // Runs before the layout persistence effect (useWorkspaceLayout), which saves the mode recorded here.
  useEffect(() => {
    if (!paper && !asset && file && setsDocumentMode(file, mode)) documentModeRef.current = mode;
  }, [asset, file, paper, mode]);

  // ---- Intents. Every open reserves the next generation; a read that lands
  // under an older one is dropped. Back/forward steps lock out recording.
  const intentRef = useRef(0);
  const viewIntentRef = useRef(0);
  const navLockRef = useRef(false);

  // ---- Disk: the open file's last-seen mtime (-1: inspect the next version).
  const diskMtimeRef = useRef<number | null>(null);

  // ---- The canvas's side: deferred visual edits, the Markdown viewport.
  const flushRef = useRef<(() => boolean) | null>(null);
  const captureViewportRef = useRef<(() => void) | null>(null);

  const viewStates = useFileViewStates(projectRoot, projectRef, projectBeforeTransitionRef);
  const { statesRef: viewStateRef } = viewStates;
  const assetPaths = useMemo(() => collectAssetPaths(project?.files ?? []), [project]);
  const activeTab = paper ? paperTabKey(paper.arxivId) : asset?.path ?? file;

  /** The render values commands compare against, as of the last commit (what their closures used to hold). */
  const renderedRef = useLatestRef({ project, file, paper, asset, paperView, paperDirty, assetPaths });

  // ---- Buffer primitives -----------------------------------------------------------------------------------------
  const paperBuffersDirty = useCallback(() => (
    paperMarkdownRef.current !== savedPaperMarkdownRef.current || paperBlogRef.current !== savedPaperBlogRef.current
  ), [paperBlogRef, paperMarkdownRef, savedPaperBlogRef, savedPaperMarkdownRef]);
  const setPaperText = useCallback((value: string) => {
    if (paperView === "blog") setPaperBlog(value);
    else setPaperMarkdown(value);
  }, [paperView, setPaperBlog, setPaperMarkdown]);
  /** Publish deferred visual edits; false while a text composition is still open. */
  const flush = useCallback(() => flushRef.current?.() !== false, []);
  /**
   * The text on screen for `path`, deferred visual edits published first:
   * what "Save a copy" writes out once a save of `path` failed. The retained
   * file and each of the open Paper's reading files has its own buffer; null
   * when none of them is `path`.
   */
  const bufferText = useCallback((path: string): string | null => {
    publishDeferredEdits(flushRef.current);
    if (path === fileRef.current) return textRef.current;
    const openPaper = renderedRef.current.paper;
    if (openPaper && path === paperDocumentPath(openPaper.arxivId, "blog")) return paperBlogRef.current;
    if (openPaper && path === paperDocumentPath(openPaper.arxivId, "fulltext")) return paperMarkdownRef.current;
    return null;
  }, [fileRef, paperBlogRef, paperMarkdownRef, renderedRef, textRef]);
  /** Publish deferred visual edits, then report whether `owner`'s buffer is dirty. */
  const flushAndCheckDirty = useCallback((owner: SurfaceOwner) => {
    if (flushRef.current?.() === false) return true;
    if (owner === "file") return textRef.current !== savedRef.current;
    return owner === "paper" && paperBuffersDirty();
  }, [paperBuffersDirty, savedRef, textRef]);

  const markDiskMtime = useCallback(async (path: string, mayApply: () => boolean = () => true) => {
    const mtime = await readDiskMtime(path);
    if (mayApply()) diskMtimeRef.current = mtime;
  }, []);

  const requestLine = useCallback((path: string, line: number) => {
    depsRef.current.updateCanvasRequest("navigation", { path, line, id: crypto.randomUUID() });
  }, [depsRef]);

  /**
   * Durable text for `path` reached disk: show it if `path` is the open file.
   * `expect` makes it a compare-and-swap: "clean" only replaces a buffer with
   * no unsaved edits; `{ text, saved }` only one still holding exactly those.
   * True when the buffer now shows `content`.
   */
  const accept = useCallback((
    path: string,
    content: string,
    expect?: "clean" | { text?: string; saved?: string },
  ) => {
    if (fileRef.current !== path) return false;
    if (expect === "clean" && textRef.current !== savedRef.current) return false;
    if (typeof expect === "object") {
      if (expect.text !== undefined && textRef.current !== expect.text) return false;
      if (expect.saved !== undefined && savedRef.current !== expect.saved) return false;
    }
    commitFileText(content);
    return true;
  }, [commitFileText, fileRef, savedRef, textRef]);

  return {
    depsRef, autoBuildEnabled: deps.autoBuild.enabled, documentsStore,
    project, projectRoot, projectRef, projectOperationGenerationRef, captureProjectScope,
    // Buffers.
    file, setFile, fileRef, text, textRef, setText, savedText, savedRef, setSavedText,
    asset, setAsset, assetRef, paper, setPaper,
    paperMarkdown, paperMarkdownRef, savedPaperMarkdown, savedPaperMarkdownRef, setSavedPaperMarkdown,
    paperBlog, paperBlogRef, savedPaperBlog, savedPaperBlogRef, setSavedPaperBlog,
    paperView, setPaperView, paperPath, paperDirty,
    // Tabs, modes, intents, history, restore.
    tabs, setTabs, tabsRef, closedRef, activeTab, assetPaths, revealRequest,
    mode, setMode, htmlModesRef, documentModeRef, bibModeRef, viewModes, viewModeFor,
    intentRef, viewIntentRef, setOpening,
    setNavStack, setNavIndex, pushNavigation, navLockRef,
    persistenceReadyRoot, setPersistenceReadyRoot, tabsSettledRoot, setTabsSettledRoot,
    diskMtimeRef, flushRef, captureViewportRef, viewStates, viewStateRef, renderedRef,
    // Primitives.
    commitFileText, showFileText, setPaperBuffers, closePaper, paperBuffersDirty, setPaperText,
    addTab, showTab, flush, bufferText, flushAndCheckDirty, markDiskMtime, requestLine, accept,
  };
}

/** The fields useDocumentStore renders from; picked whole so a write elsewhere re-renders nothing. */
const renderedFields = ({
  file, text, savedText, asset, paper, paperView, paperMarkdown, savedPaperMarkdown, paperBlog, savedPaperBlog,
  tabs, revealRequest, mode, persistenceReadyRoot, tabsSettledRoot,
}: OpenDocumentsState) => ({
  file, text, savedText, asset, paper, paperView, paperMarkdown, savedPaperMarkdown, paperBlog, savedPaperBlog,
  tabs, revealRequest, mode, persistenceReadyRoot, tabsSettledRoot,
});

const keepStore = (store: OpenDocumentsStore) => store;

/** A read-only ref over one field of the store, for code written against ref twins. */
function liveField<K extends keyof OpenDocumentsState>(store: OpenDocumentsStore, key: K): RefObject<OpenDocumentsState[K]> {
  return { get current() { return store.getState()[key]; } };
}
