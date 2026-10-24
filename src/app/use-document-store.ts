import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AssetPreview, CanvasMode, DocumentViewMode, NavigationEntry, PaperSummary, RefreshProject,
} from "../app-types";
import { paperTabKey } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useRefState } from "./effect-helpers";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import { useFileViewStates } from "./use-file-view-states";
import type { ProjectState } from "./use-project-state";
import { collectAssetPaths } from "./workspace-restore";
import { paperDocumentPath, type PaperView } from "./paper-documents";
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

  // ---- Buffers. Every buffer has a ref twin for async work; the live setters write both halves.
  const [file, setFile, fileRef, setFileLive] = useRefState("");
  const [text, , textRef, setTextLive] = useRefState("");
  const [savedText, , savedRef, setSavedLive] = useRefState("");
  const [asset, setAsset, assetRef, setAssetLive] = useRefState<AssetPreview | null>(null);
  const [paper, setPaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, , paperMarkdownRef, setPaperMarkdownLive] = useRefState("");
  const [savedPaperMarkdown, , savedPaperMarkdownRef, setSavedPaperMarkdown] = useRefState("");
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, , paperBlogRef, setPaperBlogLive] = useRefState<string | null>(null);
  const [savedPaperBlog, , savedPaperBlogRef, setSavedPaperBlog] = useRefState<string | null>(null);
  const [paperView, setPaperView] = useState<PaperView>("blog");
  const paperPath = paper ? paperDocumentPath(paper.arxivId, paperView) : null;
  const paperDirty = Boolean(paper) && (paperMarkdown !== savedPaperMarkdown || paperBlog !== savedPaperBlog);

  // ---- Tabs, in strip order, saved with the layout; a full panel closes
  // some (trellis-tab-policy.ts). Closed ones stack for reopening.
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  useLayoutEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const closedRef = useRef<string[]>([]);

  // ---- Canvas mode, and the modes each kind of document returns to.
  const [mode, setMode] = useState<CanvasMode>("split");
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
  // under an older one is dropped. `opening` is the "Opening …" overlay.
  const intentRef = useRef(0);
  const viewIntentRef = useRef(0);
  const [opening, setOpening] = useState<{ generation: number; label: string } | null>(null);

  // ---- Back/forward history.
  const [navStack, setNavStack] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const navLockRef = useRef(false);

  // ---- Restore and layout persistence. Persistence starts once the project's
  // restore finished; Trellis reconciles panels as soon as the tabs settle
  // (restored, or superseded by a file the writer opened during the restore).
  const [persistenceReadyRoot, setPersistenceReadyRoot] = useState<string | null>(null);
  const [tabsSettledRoot, setTabsSettledRoot] = useState<string | null>(null);

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
  const renderedRef = useLatestRef({ project, file, paper, asset, paperView, paperDirty, navIndex, navStack, assetPaths });

  // ---- Buffer primitives -----------------------------------------------------------------------------------------
  /** Replace the primary buffer with durable content (live and saved agree). */
  const commitFileText = useCallback((content: string) => {
    setTextLive(content);
    setSavedLive(content);
  }, [setSavedLive, setTextLive]);
  const showFileText = useCallback((path: string, content: string) => {
    setFileLive(path);
    commitFileText(content);
  }, [commitFileText, setFileLive]);
  const setPaperBuffers = useCallback((markdown: string, blog: string | null) => {
    setPaperMarkdownLive(markdown);
    setSavedPaperMarkdown(markdown);
    setPaperBlogLive(blog);
    setSavedPaperBlog(blog);
  }, [setPaperBlogLive, setPaperMarkdownLive, setSavedPaperBlog, setSavedPaperMarkdown]);
  /** Leave Paper reading: the primary buffer belongs to a file again. */
  const closePaper = useCallback(() => {
    setPaper(null);
    setPaperBuffers("", null);
  }, [setPaperBuffers]);
  const paperBuffersDirty = useCallback(() => (
    paperMarkdownRef.current !== savedPaperMarkdownRef.current || paperBlogRef.current !== savedPaperBlogRef.current
  ), [paperBlogRef, paperMarkdownRef, savedPaperBlogRef, savedPaperMarkdownRef]);
  const setPaperText = useCallback((value: string) => {
    if (paperView === "blog") setPaperBlogLive(value);
    else setPaperMarkdownLive(value);
  }, [paperView, setPaperBlogLive, setPaperMarkdownLive]);
  const addTab = useCallback((path: string) => {
    setTabs((current) => (current.includes(path) ? current : [...current, path]));
  }, []);
  // Each explicit open counts up, so Trellis shows the opened document even
  // when it was already the active one and only a navigator (Papers, say)
  // covered it in its panel. Routine reloads keep the panels' selection.
  const [revealRequest, setRevealRequest] = useState(0);
  /** An explicit open: the document gets its tab, and its panel shows it. */
  const showTab = useCallback((path: string) => {
    addTab(path);
    setRevealRequest((request) => request + 1);
  }, [addTab]);

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
    depsRef, autoBuildEnabled: deps.autoBuild.enabled,
    project, projectRoot, projectRef, projectOperationGenerationRef, captureProjectScope,
    // Buffers.
    file, setFile, fileRef, text, textRef, setTextLive, savedText, savedRef, setSavedLive,
    asset, setAsset, assetRef, setAssetLive, paper, setPaper,
    paperMarkdown, paperMarkdownRef, savedPaperMarkdown, savedPaperMarkdownRef, setSavedPaperMarkdown,
    paperBlog, paperBlogRef, savedPaperBlog, savedPaperBlogRef, setSavedPaperBlog,
    paperView, setPaperView, paperPath, paperDirty,
    // Tabs, modes, intents, history, restore.
    tabs, setTabs, tabsRef, closedRef, activeTab, assetPaths, revealRequest,
    mode, setMode, htmlModesRef, documentModeRef, bibModeRef, viewModes, viewModeFor,
    intentRef, viewIntentRef, opening, setOpening,
    navStack, setNavStack, navIndex, setNavIndex, navLockRef,
    persistenceReadyRoot, setPersistenceReadyRoot, tabsSettledRoot, setTabsSettledRoot,
    diskMtimeRef, flushRef, captureViewportRef, viewStates, viewStateRef, renderedRef,
    // Primitives.
    commitFileText, showFileText, setPaperBuffers, closePaper, paperBuffersDirty, setPaperText,
    addTab, showTab, flush, bufferText, flushAndCheckDirty, markDiskMtime, requestLine, accept,
  };
}
