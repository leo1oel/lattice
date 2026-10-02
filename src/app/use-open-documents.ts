import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import type {
  AssetPreview, CanvasMode, DocumentViewMode, NavigationEntry, OpenFileOptions, PaperSummary, ProjectSnapshot,
  RefreshProject,
} from "../app-types";
import {
  arxivIdFromTabKey, isHtmlFilePath, isPaperTabKey, isPreviewableSourceFilePath, isProjectSourceFilePath, paperTabKey,
  remapProjectPath, stripFrontmatter, toMessage, type ProjectPathChange,
} from "../app-utils";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { formatBibDocument } from "../papers/bib-format";
import { isProjectFileMissing } from "../pdf/project-pdf-refusals";
import { loadLastFile, loadWorkspaceLayout, persistLastFile, persistWorkspaceLayout } from "../settings/app-settings";
import { addAppLog } from "../telemetry/app-log-store";
import { notifyError } from "../telemetry/app-notify";
import { afterNextPaintOpportunity, useLatest, useRefState } from "./effect-helpers";
import { setError, setNotice, setWarning } from "./notify";
import type { EditorWriteResult } from "./open-slide-writes";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import { useFileViewStates } from "./use-file-view-states";
import type { ProjectState } from "./use-project-state";
import { collectAssetPaths, planWorkspaceRestore } from "./workspace-restore";

export type PaperView = "blog" | "fulltext";

/** The two cached reading files of an imported Paper. */
export function paperDocumentPath(arxivId: string, view: PaperView): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project-relative file path
  return `.research/papers/${arxivId}/${view === "blog" ? "blog.md" : "paper.md"}`;
}

/** Which reader a tab key opens through: a Paper's, an asset preview's, or the text editor's. */
export function documentKind(key: string, assetPaths: ReadonlySet<string>): "paper" | "asset" | "file" {
  return isPaperTabKey(key) ? "paper" : assetPaths.has(key) ? "asset" : "file";
}

/** How often an open project PDF is checked for a new version on disk. */
const PDF_RECHECK_MS = 2500;
/** How often the open file is checked for an edit made behind the editor. */
const DISK_POLL_MS = 2500;
const RECENTLY_CLOSED_LIMIT = 20;
const NAVIGATION_HISTORY_LIMIT = 80;

/** A canvas mode that brings an editor on screen, widening a preview-only or asset surface to split. */
const withEditor = (mode: CanvasMode): CanvasMode => (mode === "pdf" || mode === "asset" ? "split" : mode);
/** A canvas mode that brings the PDF on screen beside an editor-only view. */
const withPdf = (mode: CanvasMode): CanvasMode => (mode === "source" ? "split" : mode);

/**
 * A Paper's full text and overview, read from the local library. They are
 * independent: an arxiv2md conversion can fail while alphaXiv still supplied
 * a useful blog, so keep either readable result rather than letting one
 * rejection discard the other. Library rows stay local on open — refreshing
 * alphaXiv in the foreground made a cached Paper switch wait on the network.
 */
async function readPaperDocuments(arxivId: string) {
  const [fullText, blog] = await Promise.allSettled([
    invoke<string>("read_paper", { arxivId }),
    invoke<string | null>("read_paper_blog_local", { arxivId }),
  ]);
  return {
    markdown: fullText.status === "fulfilled" ? fullText.value : "",
    blog: blog.status === "fulfilled" ? blog.value : null,
    failure: fullText.status === "rejected" ? fullText.reason as unknown : null,
  };
}

/** Run the canvas's deferred-edit flush: published, refused (a text composition is open), or what it threw. */
function publishDeferredEdits(flush: (() => boolean) | null): "published" | "refused" | { error: unknown } {
  try {
    return flush?.() === false ? "refused" : "published";
  } catch (error) {
    return { error };
  }
}

/** A file's mtime on disk; null when it is missing or could not be read. */
async function readDiskMtime(path: string): Promise<number | null> {
  try {
    const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
    return stat.exists ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Keep full text when it is showing and exists; otherwise prefer the overview. */
function preferredPaperView(current: PaperView, markdown: string, blog: string | null): PaperView {
  return current === "fulltext" && markdown ? "fulltext" : blog ? "blog" : "fulltext";
}

function recordNavigationTiming(
  kind: "file" | "paper",
  path: string,
  startedAt: number,
  phases: Record<string, number>,
): void {
  const endedAt = performance.now();
  const detail = { kind, path, totalMs: endedAt - startedAt, ...phases };
  try {
    performance.measure("lattice:document-switch", { start: startedAt, end: endedAt, detail });
  } catch {
    // Older WebKit builds do not support PerformanceMeasureOptions.detail.
  }
  if (detail.totalMs < 100) return;
  addAppLog({
    level: "info",
    source: i18n._(msg`Navigation performance`),
    title: kind === "paper" ? i18n._(msg`Paper switch`) : i18n._(msg`File switch`),
    detail: `${path}\n${Object.entries(detail)
      .filter(([key]) => key.endsWith("Ms"))
      .map(([key, value]) => `${key}=${Number(value).toFixed(1)}`)
      .join(" ")}`,
    toast: false,
  });
}

/** Which buffer owns the canvas: a Paper's, an asset preview (no buffer), or the text file's. */
type SurfaceOwner = "file" | "paper" | "asset";

/** An open that resolves its document later (a Paper fetched first); `isCurrent` turns false once anything else opens. */
export type OpenClaim = { isCurrent(): boolean };

/** Generations behind the claims `claim()` handed out; private to the store. */
const claimGenerations = new WeakMap<OpenClaim, number>();

type LoadOptions = {
  restoreView?: boolean;
  revealSource?: boolean;
  expectedProjectRoot?: string;
  projectGeneration?: number;
  /**
   * A prerequisite (the previous file's save) the load may overlap with
   * its own disk read but must confirm before committing state. Resolving
   * false — or rejecting — aborts the switch, preserving the old
   * "save failure keeps the current file" semantics without paying
   * write + read serially.
   */
  gate?: Promise<boolean>;
  /** Primary-surface intent reserved by a caller before it awaited save. */
  loadGeneration?: number;
  /** Re-check the old owner's deferred edits immediately before commit. */
  canCommit?: () => boolean;
  /**
   * Where in the freshly loaded file to land. Requesting it here, rather
   * than after this load resolves, keeps the content and the jump in one
   * React commit: setting it afterwards paints the new document at its top
   * first and only scrolls to the line on the next frame, which a SyncTeX
   * jump out of the PDF shows as a flash.
   */
  navigateToLine?: number;
};

/** Load a file from disk into the editor now, replacing its buffer (a reload, or a programmatic replacement). */
type LoadFile = (
  path: string,
  options?: Pick<LoadOptions, "restoreView" | "expectedProjectRoot" | "projectGeneration" | "canCommit">,
) => Promise<boolean>;

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

/** A project being entered: restore its saved tabs, then (after the project's slow scans) its Paper or asset surface. */
export type ProjectEntry = {
  /**
   * Put back the primary file, the tabs in strip order, the canvas mode and
   * the Paper view from the saved layout. Resolves false when the writer
   * opened something meanwhile (their document wins) or the project changed.
   */
  restore(papers: PaperSummary[]): Promise<boolean>;
  /** Open the restored Paper or asset tab through its reader, then start persisting the layout. */
  finish(): void;
};

/**
 * The documents open in a project window: the tabs, the document in front of
 * the canvas and the buffers behind it.
 *
 * One text file is always loaded (possibly none: `""`), and a Paper or an
 * asset preview can sit in front of it; the file keeps its buffer underneath.
 * Every way of changing what is in front — opening a file, Paper or asset,
 * closing or reopening a tab, going back, choosing a view, entering a project
 * — is an intent: it publishes deferred visual edits first, saves what it is
 * about to cover, and commits only if nothing newer was asked for while it
 * read. So a slow read can never replace a later choice, a failed save keeps
 * the old document, and an edit typed during a switch is never dropped.
 *
 * The store also keeps the open documents in step with disk (an external edit
 * reloads a clean buffer; a rewritten PDF swaps versions), saves after a
 * pause in typing, remembers where the writer was in each file, and saves and
 * restores the project's tab layout.
 *
 * Commands keep their identity across keystrokes (they read the latest state
 * through refs), so handing them to memoized children costs nothing while
 * typing. Render fields are plain values: depend on them one by one.
 */
export function useOpenDocuments(deps: OpenDocumentsDeps) {
  const { t } = useLingui();
  const depsRef = useLatest(deps);
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

  // ---- Tabs, in strip order, persisted with the layout; nothing caps or
  // evicts them. Closed tabs stack up (newest first) for reopening.
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  useLayoutEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const closedRef = useRef<string[]>([]);

  // ---- Canvas mode, and the modes each kind of document returns to.
  const [mode, setMode] = useState<CanvasMode>("split");
  const htmlModesRef = useRef(new Map<string, DocumentViewMode>());
  const documentModeRef = useRef<DocumentViewMode>("split");
  useEffect(() => {
    if (
      !paper
      && !asset
      && file
      && isPreviewableSourceFilePath(file)
      && !isHtmlFilePath(file)
      && (mode === "source" || mode === "split" || mode === "pdf")
    ) {
      documentModeRef.current = mode;
    }
  }, [asset, file, paper, mode]);

  // ---- Intents. Every open reserves the next generation; a read that lands
  // under an older one is dropped. `opening` is the "Opening …" overlay.
  const intentRef = useRef(0);
  const viewIntentRef = useRef(0);
  const [opening, setOpening] = useState<{ generation: number; label: string } | null>(null);

  // ---- Back/forward history.
  const [navStack, setNavStack] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const navLock = useRef(false);

  // ---- Restore and layout persistence. Persistence starts once the project's
  // restore finished; Trellis reconciles panels as soon as the tabs settle
  // (restored, or superseded by a file the writer opened during the restore).
  const [persistenceReadyRoot, setPersistenceReadyRoot] = useState<string | null>(null);
  const [tabsSettledRoot, setTabsSettledRoot] = useState<string | null>(null);

  // ---- Disk: the open file's last-seen mtime (-1: inspect the next version),
  // saves in flight, and a PDF removed from the project while it is open.
  const diskMtimeRef = useRef<number | null>(null);
  const saveActivityRef = useRef({ pending: 0, generation: 0 });
  const [missingAsset, setMissingAsset] = useState<AssetPreview | null>(null);
  const viewerRecheckAtRef = useRef(0);

  // ---- The canvas's side: deferred visual edits, the Markdown viewport, the completion menu.
  const flushRef = useRef<(() => boolean) | null>(null);
  const captureViewportRef = useRef<(() => void) | null>(null);
  const [completionActive, setCompletionActive] = useState(false);
  const completionActiveRef = useRef(false);

  const viewStates = useFileViewStates(projectRoot, projectRef, projectBeforeTransitionRef);
  const { statesRef: viewStateRef } = viewStates;
  const assetPaths = useMemo(() => collectAssetPaths(project?.files ?? []), [project]);
  const activeTab = paper ? paperTabKey(paper.arxivId) : asset?.path ?? file;

  /** The render values commands compare against, as of the last commit (what their closures used to hold). */
  const renderedRef = useLatest({ project, file, paper, asset, paperView, paperDirty, navIndex, navStack, assetPaths });

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

  /** Publish deferred visual edits; false while a text composition is still open. */
  const flush = useCallback(() => flushRef.current?.() !== false, []);
  const ownerOf = (state: { paper: PaperSummary | null; asset: AssetPreview | null }): SurfaceOwner => (
    state.paper ? "paper" : state.asset ? "asset" : "file"
  );
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

  // ---- Load ------------------------------------------------------------------------------------------------------
  const loadFile = useCallback(async (path: string, options?: LoadOptions) => {
    const loadGeneration = options?.loadGeneration ?? intentRef.current + 1;
    if (options?.loadGeneration === undefined) intentRef.current = loadGeneration;
    const expectedRoot = options?.expectedProjectRoot ?? projectRef.current?.root;
    const projectGeneration = options?.projectGeneration ?? projectOperationGenerationRef.current;
    const isLatestLoad = () => (
      loadGeneration === intentRef.current
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === expectedRoot
    );
    const previousPath = fileRef.current;
    const showLoadedDocument = (content: string) => {
      showFileText(path, content);
      addTab(path);
      closePaper();
      setAssetLive(null);
      setMode((current) => {
        if (isHtmlFilePath(path)) return htmlModesRef.current.get(path) ?? "pdf";
        if (isPreviewableSourceFilePath(path)) return documentModeRef.current;
        if (options?.revealSource) return "source";
        if (isHtmlFilePath(previousPath)) return documentModeRef.current;
        if (current === "asset") return "split";
        return current;
      });
      if (options?.navigateToLine !== undefined) requestLine(path, options.navigateToLine);
    };
    const commitLoaded = ([content, gateOk]: [string, boolean]) => {
      if (!gateOk || !isLatestLoad() || options?.canCommit?.() === false) return false;
      showLoadedDocument(content);
      // Where you last were in this file, unless the caller is about to send
      // you somewhere specific in it. Both land as requests the editor answers
      // on the next frame, and the restore is applied second, so asking for
      // both means the remembered position quietly wins and the jump is lost.
      const saved = options?.restoreView === false ? undefined : viewStateRef.current.get(path)?.text;
      if (saved) {
        depsRef.current.updateCanvasRequest("restore", {
          path, cursor: saved.cursor, scrollTop: saved.scrollTop, id: crypto.randomUUID(),
        });
      }
      // The restore used to wait behind this stat; it has no bearing on
      // cursor or scroll, so let it land whenever it lands (mayApply already
      // discards stale completions).
      void markDiskMtime(path, isLatestLoad);
      return true;
    };
    return Promise.all([
      invoke<string>("read_project_file", { path, projectRoot: expectedRoot }),
      options?.gate ?? Promise.resolve(true),
    ]).then(commitLoaded).catch((reason: unknown) => {
      if (isLatestLoad()) setError(toMessage(reason));
      return false;
    });
  }, [
    addTab, closePaper, depsRef, fileRef, markDiskMtime, projectOperationGenerationRef, projectRef, requestLine,
    setAssetLive, showFileText, viewStateRef,
  ]);

  // ---- Save ------------------------------------------------------------------------------------------------------
  const saveContents = useCallback(async (): Promise<boolean> => {
    const { project: current, paper: openPaper, asset: openAsset, file: activeFile } = renderedRef.current;
    if (!current) return true;
    const write = async () => {
      const primaryPath = fileRef.current;
      const primarySource = textRef.current;
      const primarySavedSource = savedRef.current;
      const paperBuffers = [
        ["fulltext", paperMarkdownRef.current, savedPaperMarkdownRef.current],
        ["blog", paperBlogRef.current, savedPaperBlogRef.current],
      ] as const;
      const writtenPaths: string[] = [];
      if (!openPaper && !openAsset && primaryPath && primarySource !== primarySavedSource) {
        const content = /\.bib$/i.test(primaryPath) ? formatBibDocument(primarySource) : primarySource;
        // Format before awaiting disk I/O: subsequent typing must remain a dirty
        // edit, not be replaced by the formatted snapshot when the write returns.
        if (content !== primarySource) setTextLive(content);
        const writeResult = await invoke<EditorWriteResult>("write_project_file", {
          path: primaryPath, content, baseContent: primarySavedSource, projectRoot: current.root,
        });
        const writtenSource = writeResult?.content ?? content;
        if (writtenSource !== content && fileRef.current === primaryPath && textRef.current === content) {
          setTextLive(writtenSource);
        }
        if (writeResult?.hadConflicts) {
          const path = primaryPath;
          setWarning(t({ message: `Kept overlapping external edits in ${path} with conflict markers.` }));
        }
        setSavedLive(writtenSource);
        // Force the detector to inspect the next filesystem version. An Agent
        // may finish another atomic write after the backend response but before
        // a post-save stat; recording that newer mtime without reading it would
        // hide the Agent edit indefinitely.
        diskMtimeRef.current = -1;
        writtenPaths.push(primaryPath);
      }
      for (const [view, content, savedContent] of openPaper ? paperBuffers : []) {
        if (content === null || content === savedContent) continue;
        const path = paperDocumentPath(openPaper!.arxivId, view);
        await invoke("write_project_file", { path, content, projectRoot: current.root });
        if (view === "blog") setSavedPaperBlog(content);
        else setSavedPaperMarkdown(content);
        writtenPaths.push(path);
      }
      if (!writtenPaths.length) return true;
      // Saving must only wait for durable writes. The derived sidebars are
      // useful, but making file switches and builds wait on six independent
      // project scans turned every save into a visible pause.
      depsRef.current.onSaved(current.root, writtenPaths);
      return true;
    };
    return write().catch((reason: unknown) => {
      // Autosave runs constantly, so this path gets a plain notification rather
      // than a `logAction` trace — a start line per keystroke pause would bury
      // everything else in the log.
      notifyError(t`Save`, activeFile ? t`Could not save ${activeFile}` : t`Could not save the project`, { detail: toMessage(reason) });
      return false;
    });
  }, [
    depsRef, fileRef, paperBlogRef, paperMarkdownRef, renderedRef, savedPaperBlogRef, savedPaperMarkdownRef, savedRef,
    setSavedLive, setSavedPaperBlog, setSavedPaperMarkdown, setTextLive, t, textRef,
  ]);
  // Keep activity tracking outside the save body: React Compiler cannot lower
  // try/finally, while Promise.finally still covers every early return/error.
  const save = useCallback((): Promise<boolean> => {
    saveActivityRef.current.pending += 1;
    saveActivityRef.current.generation += 1;
    return saveContents().finally(() => { saveActivityRef.current.pending -= 1; });
  }, [saveContents]);

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

  // ---- Open --------------------------------------------------------------------------------------------------------
  const pushNavigation = useCallback((path: string, line: number) => {
    if (navLock.current || !path) return;
    const index = renderedRef.current.navIndex;
    setNavStack((stack) => {
      const trimmed = stack.slice(0, Math.max(0, index + 1));
      const last = trimmed[trimmed.length - 1];
      if (last && last.path === path && last.line === line) {
        setNavIndex(trimmed.length - 1);
        return trimmed;
      }
      const next = [...trimmed, { path, line }].slice(-NAVIGATION_HISTORY_LIMIT);
      setNavIndex(next.length - 1);
      return next;
    });
  }, [renderedRef]);

  /** Open a project file in the text editor, optionally at a 1-based line. */
  const openFile = useCallback(async (path: string, options?: OpenFileOptions) => {
    const line = options?.line;
    const { project: current, file: activeFile, paper: openPaper, asset: openAsset } = renderedRef.current;
    const owner = ownerOf(renderedRef.current);
    depsRef.current.cancelPrewarm();
    // A file the writer opens settles the project's tabs, even while the
    // restore it supersedes is still waiting on the paper scan.
    const openingRoot = projectRef.current?.root;
    if (openingRoot) setTabsSettledRoot(openingRoot);
    // Every click is a primary-surface intent, including reselecting the file
    // already on screen. Reserving it first prevents an older Paper/asset read
    // from replacing the surface after this click.
    const switchStartedAt = performance.now();
    const loadGeneration = intentRef.current + 1;
    intentRef.current = loadGeneration;
    const alreadyOpen = path === activeFile && !openPaper && !openAsset;
    if (alreadyOpen) {
      // This intent invalidates any older Paper/file request even though it
      // does not need its own opening UI.
      setOpening(null);
      // The active document may have lost its tab (its panel was closed):
      // asking for it again brings the tab, and so its panel, back.
      addTab(path);
      if (line) {
        requestLine(path, line);
        setMode(withEditor);
        pushNavigation(path, line);
      }
      // Bring the on-screen copy level with disk: save it, or take an edit made behind it.
      const refresh = async () => {
        if (flushRef.current?.() === false) return;
        if (textRef.current !== savedRef.current) {
          await save();
          return;
        }
        const content = await invoke<string>("read_project_file", { path, projectRoot: current?.root });
        if (intentRef.current === loadGeneration && fileRef.current === path && content !== textRef.current) {
          accept(path, content);
          await markDiskMtime(path);
        }
      };
      await refresh().catch((reason: unknown) => {
        if (intentRef.current === loadGeneration) setError(toMessage(reason));
      });
      return;
    }
    const clearOpening = () => setOpening((shown) => (shown?.generation === loadGeneration ? null : shown));
    setOpening({ generation: loadGeneration, label: path.split("/").at(-1) ?? path });
    await afterNextPaintOpportunity();
    const openingPaintMs = performance.now() - switchStartedAt;
    if (intentRef.current !== loadGeneration) {
      clearOpening();
      return;
    }
    // Reserve this user intent before save or any other await. Otherwise an
    // older file request waiting on a write can allocate a newer generation
    // after a later Paper/asset click and incorrectly reclaim the surface.
    // Visual Markdown serialization is intentionally deferred while typing.
    // Publish it before taking the dirty snapshot so a programmatic switch
    // cannot apply the old document's final edit to the next file buffer.
    const flushStartedAt = performance.now();
    const flushed = publishDeferredEdits(flushRef.current);
    if (flushed !== "published") {
      if (flushed !== "refused" && intentRef.current === loadGeneration) setError(toMessage(flushed.error));
      clearOpening();
      return;
    }
    const flushMs = performance.now() - flushStartedAt;
    if (activeFile && !openPaper && !openAsset) {
      const remembered = viewStateRef.current.get(activeFile);
      viewStateRef.current.set(activeFile, {
        ...remembered,
        text: remembered?.text ?? { cursor: 0, scrollTop: 0 },
      });
    }
    const contentLoadStartedAt = performance.now();
    let gate: Promise<boolean> | undefined;
    const paperDirtyNow = Boolean(openPaper) && paperBuffersDirty();
    const targetAliasesDirtyPaper = paperDirtyNow
      && (path === paperDocumentPath(openPaper!.arxivId, "fulltext") || path === paperDocumentPath(openPaper!.arxivId, "blog"));
    if (textRef.current !== savedRef.current || paperDirtyNow) {
      if (targetAliasesDirtyPaper) {
        // save() rewrites this destination from the Paper editor; overlapping
        // it with the read below would hand the incoming editor pre-save
        // contents after the write succeeds.
        if (!(await save()) || intentRef.current !== loadGeneration) {
          clearOpening();
          return;
        }
      } else {
        // Otherwise the write of the old file and the read of the new one are
        // independent — run them concurrently and let loadFile confirm the
        // save before committing state.
        gate = save();
      }
    }
    const applied = await loadFile(path, {
      restoreView: !line,
      revealSource: options?.revealSource ?? true,
      gate,
      loadGeneration,
      canCommit: () => !flushAndCheckDirty(owner),
      navigateToLine: line,
    });
    clearOpening();
    if (!applied) return;
    recordNavigationTiming("file", path, switchStartedAt, {
      openingPaintMs, flushMs, saveAndReadMs: performance.now() - contentLoadStartedAt,
    });
    if (line) {
      // The jump itself rode the load's commit; this only widens a
      // preview-only surface so the editor it lands in is on screen.
      setMode(withEditor);
      pushNavigation(path, line);
    } else {
      pushNavigation(path, 1);
    }
  }, [
    accept, addTab, depsRef, fileRef, flushAndCheckDirty, loadFile, markDiskMtime, paperBuffersDirty,
    projectRef, pushNavigation, renderedRef, requestLine, save, savedRef, textRef, viewStateRef,
  ]);

  /** Show the Paper's overview or its full text: two distinct editable documents. */
  const choosePaperView = useCallback((view: PaperView) => {
    if (view === renderedRef.current.paperView) return;
    // Publish the old NodeView while its path still owns the callback, then change identity.
    if (flushRef.current?.() === false) return;
    setPaperView(view);
  }, [renderedRef]);

  const openPaper = useCallback(async (
    target: PaperSummary,
    options?: { view?: PaperView; claim?: OpenClaim },
  ): Promise<boolean> => {
    const { file: activeFile, paper: openPaperNow } = renderedRef.current;
    const owner = ownerOf(renderedRef.current);
    depsRef.current.cancelPrewarm();
    const switchStartedAt = performance.now();
    // Publish the old visual document while its path and setter still own the
    // buffer. Saving first leaves TipTap's deferred final update behind; the
    // following Paper render can then route that old update into Paper state.
    const reservedGeneration = options?.claim ? claimGenerations.get(options.claim) : undefined;
    if (reservedGeneration !== undefined && reservedGeneration !== intentRef.current) return false;
    const loadGeneration = reservedGeneration ?? intentRef.current + 1;
    if (reservedGeneration === undefined) intentRef.current = loadGeneration;
    const ownsProject = captureProjectScope();
    const isLatestLoad = () => loadGeneration === intentRef.current && ownsProject();
    const clearOpening = () => setOpening((shown) => (shown?.generation === loadGeneration ? null : shown));
    setOpening({ generation: loadGeneration, label: target.title });
    const opened = await (async () => {
      await afterNextPaintOpportunity();
      const openingPaintMs = performance.now() - switchStartedAt;
      if (!isLatestLoad()) return null;
      const flushStartedAt = performance.now();
      if (flushRef.current?.() === false) return null;
      const flushMs = performance.now() - flushStartedAt;
      const contentLoadStartedAt = performance.now();
      const readPaper = () => readPaperDocuments(target.arxivId);
      const isPaperDocument = (path: string | null) => (
        path === paperDocumentPath(target.arxivId, "fulltext") || path === paperDocumentPath(target.arxivId, "blog")
      );
      const targetAliasesDirtyBuffer = (openPaperNow?.arxivId === target.arxivId && paperBuffersDirty())
        || (isPaperDocument(activeFile) && textRef.current !== savedRef.current);
      // A dirty buffer holding one of this Paper's files must reach disk before
      // the read; otherwise the save and the read are independent.
      const results = targetAliasesDirtyBuffer
        ? (await save()) && isLatestLoad() ? await readPaper() : null
        : await Promise.all([save(), readPaper()]).then(([saved, loaded]) => (saved ? loaded : null));
      if (!results) return null;
      const { markdown: fullText, blog, failure } = results;
      if (!isLatestLoad()) return null;
      if (!fullText && !blog) throw failure ?? new Error(t`No readable paper content is available.`);
      // The old editor stayed live while save/read ran. If it changed in that
      // interval, keep it on screen for autosave instead of replacing it with
      // the Paper and dropping the late edit.
      if (flushAndCheckDirty(owner)) return null;
      setPaperBuffers(fullText, blog);
      setPaperView((current) => preferredPaperView(current, fullText, blog));
      if (!fullText && blog) setNotice(t`Full paper text is unavailable; showing the overview instead.`);
      setPaper(target);
      setAssetLive(null);
      setMode("pdf");
      addTab(paperTabKey(target.arxivId));
      recordNavigationTiming("paper", target.title, switchStartedAt, {
        openingPaintMs, flushMs, saveAndReadMs: performance.now() - contentLoadStartedAt,
      });
      return { hasBlog: blog !== null, hasFullText: Boolean(fullText) };
    })().catch((reason: unknown) => {
      if (isLatestLoad()) setError(toMessage(reason));
      return null;
    }).finally(clearOpening);
    if (!opened) return false;
    // Honor a view the caller named when it is locally readable; the open
    // already fell back to whichever side exists.
    if (options?.view === "fulltext" && opened.hasFullText) choosePaperView("fulltext");
    else if (options?.view === "blog" && opened.hasBlog) choosePaperView("blog");
    return true;
  }, [
    addTab, captureProjectScope, choosePaperView, depsRef, flushAndCheckDirty, paperBuffersDirty, renderedRef, save, savedRef,
    setAssetLive, setPaperBuffers, t, textRef,
  ]);

  const openAsset = useCallback(async (path: string) => {
    const owner = ownerOf(renderedRef.current);
    if (flushRef.current?.() === false) return false;
    const loadGeneration = intentRef.current + 1;
    intentRef.current = loadGeneration;
    setOpening(null);
    const ownsProject = captureProjectScope();
    const isLatestLoad = () => loadGeneration === intentRef.current && ownsProject();
    const read = async () => {
      if (!(await save())) return false;
      if (!isLatestLoad()) return false;
      const preview = await invoke<AssetPreview>("read_project_asset", { path });
      if (!isLatestLoad() || flushAndCheckDirty(owner)) return false;
      addTab(path);
      setAssetLive(preview);
      closePaper();
      setMode("asset");
      return true;
    };
    return read().catch((reason: unknown) => {
      if (isLatestLoad()) setError(toMessage(reason));
      return false;
    });
  }, [addTab, captureProjectScope, closePaper, flushAndCheckDirty, renderedRef, save, setAssetLive]);

  const close = useCallback(async (key: string) => {
    const { file: activeFile, paper: openPaperNow, asset: openAsset, assetPaths: assets } = renderedRef.current;
    // The writer already closed the document's panel: the last document does
    // not hold it open (its panel closes and the neighbours fill in).
    if (!tabsRef.current.includes(key)) return;
    const remaining = tabsRef.current.filter((tab) => tab !== key);
    const finishClose = () => {
      setTabs((current) => current.filter((tab) => tab !== key));
      closedRef.current = [key, ...closedRef.current.filter((tab) => tab !== key)].slice(0, RECENTLY_CLOSED_LIMIT);
    };

    const closingOpenPaper = Boolean(openPaperNow && paperTabKey(openPaperNow.arxivId) === key);
    const fileFallback = [...remaining].reverse().find((tab) => documentKind(tab, assets) === "file");
    if (closingOpenPaper) {
      const loadGeneration = intentRef.current + 1;
      intentRef.current = loadGeneration;
      setOpening(null);
      // Deferred visual edits are not represented by the Paper's dirty flag
      // yet. Flush before the dirty check and keep all ownership/tab mutations
      // behind a successful save and fallback load.
      if (flushRef.current?.() === false) return;
      if (paperBuffersDirty() && !(await save())) return;
      if (intentRef.current !== loadGeneration || flushAndCheckDirty("paper")) return;
      if (fileFallback) {
        const applied = await loadFile(fileFallback, {
          revealSource: true,
          loadGeneration,
          canCommit: () => !flushAndCheckDirty("paper"),
        });
        if (!applied) return;
      } else {
        closePaper();
        setMode((current) => (current === "pdf" ? "split" : current));
      }
    }
    finishClose();
    // The most recent still-open text file to fall back to (papers can't load
    // into the editor).
    if (isPaperTabKey(key)) return;
    if (assets.has(key)) {
      if (openAsset?.path === key) {
        setAssetLive(null);
        if (fileFallback) await openFile(fileFallback);
        else setMode((current) => (current === "asset" ? "split" : current));
      }
      return;
    }
    if (key === activeFile && fileFallback) await openFile(fileFallback);
  }, [closePaper, flushAndCheckDirty, loadFile, openFile, paperBuffersDirty, renderedRef, save, setAssetLive]);

  /** Bring `key` in front through its own reader. A Paper that left the library closes its tab instead. */
  const open = useCallback(async (key: string, options?: OpenFileOptions) => {
    const { paper: openPaperNow, assetPaths: assets } = renderedRef.current;
    const kind = documentKind(key, assets);
    if (kind === "file") return openFile(key, options);
    if (kind === "asset") {
      await openAsset(key);
      return;
    }
    if (openPaperNow && paperTabKey(openPaperNow.arxivId) === key) return;
    const target = depsRef.current.papers.find((item) => item.arxivId === arxivIdFromTabKey(key));
    if (target) await openPaper(target);
    else await close(key);
  }, [close, depsRef, openAsset, openFile, openPaper, renderedRef]);

  /** Reopen the most recently closed tab, through its own reader. */
  const reopenClosed = useCallback(() => {
    const key = closedRef.current.shift();
    if (key) void open(key);
  }, [open]);

  /** Step back or forward through the lines the writer jumped between. */
  const go = useCallback(async (step: -1 | 1) => {
    const { navIndex: index, navStack: stack } = renderedRef.current;
    const nextIndex = index + step;
    const entry = stack[nextIndex];
    if (!entry) return;
    navLock.current = true;
    setNavIndex(nextIndex);
    await openFile(entry.path, { line: entry.line }).finally(() => {
      navLock.current = false;
    });
  }, [openFile, renderedRef]);

  /** Switch the document in front between Edit, Split and Preview: the writer's choice, remembered per kind. */
  const chooseMode = useCallback((next: DocumentViewMode) => {
    const { file: activeFile, paper: openPaperNow, paperDirty: openPaperDirty } = renderedRef.current;
    const viewGeneration = viewIntentRef.current + 1;
    viewIntentRef.current = viewGeneration;
    const primaryLoadGeneration = intentRef.current;
    const isCurrentViewRequest = () => (
      viewIntentRef.current === viewGeneration
      && intentRef.current === primaryLoadGeneration
    );
    void (async () => {
      if (flushRef.current?.() === false) return;
      if (openPaperDirty && !(await save())) return;
      if (!isCurrentViewRequest()) return;
      if (openPaperNow) {
        captureViewportRef.current?.();
        setMode(next);
        return;
      }
      if (isHtmlFilePath(activeFile)) htmlModesRef.current.set(activeFile, next);
      else documentModeRef.current = next;
      setAssetLive(null);
      closePaper();
      // PDF can stand alone without a source tab. Returning to any source-backed
      // view restores the active document to the strip before rendering it.
      if (next !== "pdf" && activeFile) addTab(activeFile);
      if (!isCurrentViewRequest()) return;
      captureViewportRef.current?.();
      setMode(next);
    })();
  }, [addTab, closePaper, renderedRef, save, setAssetLive]);

  /** Bring the editor (or the PDF) on screen, widening a view that hides it to split. */
  const reveal = useCallback((surface: "editor" | "pdf") => setMode(surface === "editor" ? withEditor : withPdf), []);

  /** Leave the Paper in front (its source went away) for the file beneath it; its tab stays. */
  const leavePaper = useCallback(() => {
    closePaper();
    setMode("split");
  }, [closePaper]);

  // ---- Disk --------------------------------------------------------------------------------------------------------
  // An external edit to the open file: record its mtime the first time, then
  // reload a newer version into a clean buffer.
  const autoBuildEnabled = deps.autoBuild.enabled;
  useEffect(() => {
    if (!project || !file || asset || paper) return;
    let cancelled = false;
    const poll = async () => {
      if (saveActivityRef.current.pending) return;
      const saveGenerationAtStart = saveActivityRef.current.generation;
      // Disk reads may finish after our own autosave or a live delivery.
      // Such a snapshot is not a new external edit and must not rewind the
      // buffer or suspend Overleaf OT. Leave mtime unconsumed so we retry.
      const readIsCurrent = () => !cancelled
        && !saveActivityRef.current.pending
        && saveActivityRef.current.generation === saveGenerationAtStart;
      const saved = savedRef.current;
      const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path: file });
      if (!readIsCurrent() || !stat.exists || savedRef.current !== saved) return;
      if (diskMtimeRef.current == null) {
        diskMtimeRef.current = stat.mtimeMs;
        return;
      }
      if (stat.mtimeMs <= diskMtimeRef.current) return;
      const content = await invoke<string>("read_project_file", { path: file });
      if (!readIsCurrent() || savedRef.current !== saved) return;
      diskMtimeRef.current = stat.mtimeMs;
      if (content === saved) return;
      depsRef.current.onDiskEdit(file);
      if (textRef.current !== savedRef.current) return;
      accept(file, content);
      if (depsRef.current.autoBuild.enabled) depsRef.current.autoBuild.afterDiskEdit();
    };
    const timer = window.setInterval(() => {
      void poll().catch(() => {
        // Ignore transient filesystem races while the editor is open.
      });
    }, DISK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accept, asset, autoBuildEnabled, depsRef, file, paper, project, savedRef, textRef]);

  // An open project PDF is read a range at a time from one version of the file,
  // so a rewrite on disk (a build, the agent, an Overleaf pull) must hand the
  // viewer the new version; it keeps its page and zoom across the swap. The
  // viewer asks at once when a read finds the file changed; the poll catches
  // a rewrite before any read does. A file removed from the project stays
  // open with a notice and is checked less often; a rebuild that deletes and
  // then rewrites it brings the new version back in at the same page.
  const recheckAsset = useCallback(() => {
    const shown = assetRef.current;
    if (!shown?.ranges) return;
    const path = shown.path;
    const ownsProject = captureProjectScope();
    void invoke<AssetPreview>("read_project_asset", { path })
      .then((preview) => {
        const current = assetRef.current;
        if (!ownsProject() || current?.path !== path || !preview.ranges) return;
        if (preview.ranges.version !== current.ranges?.version) setAssetLive(preview);
        else setMissingAsset((missing) => (missing === current ? null : missing));
      })
      .catch((reason: unknown) => {
        // A file caught mid-write is read again on the next tick.
        if (ownsProject() && assetRef.current === shown && isProjectFileMissing(reason)) setMissingAsset(shown);
      });
  }, [assetRef, captureProjectScope, setAssetLive]);
  /** The viewer found its file changed: answered at most once per poll interval. */
  const onAssetChanged = useCallback(() => {
    const now = Date.now();
    if (now - viewerRecheckAtRef.current < PDF_RECHECK_MS) return;
    viewerRecheckAtRef.current = now;
    recheckAsset();
  }, [recheckAsset]);
  const assetMissing = asset !== null && asset === missingAsset;
  const pdfPath = asset?.ranges ? asset.path : null;
  useEffect(() => {
    if (!project || !pdfPath) return;
    const timer = window.setInterval(recheckAsset, assetMissing ? 2 * PDF_RECHECK_MS : PDF_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [assetMissing, pdfPath, project, recheckAsset]);

  // ---- Autosave ----------------------------------------------------------------------------------------------------
  const automaticBuildPending = useRef(false);
  const automaticBuildQueued = useRef(false);
  const saveAndBuild = useCallback(async () => {
    automaticBuildQueued.current = true;
    if (automaticBuildPending.current) return;
    automaticBuildPending.current = true;
    const generation = projectOperationGenerationRef.current;
    const settle = () => { automaticBuildPending.current = false; };
    const step = async (): Promise<void> => {
      automaticBuildQueued.current = false;
      const saved = await save();
      if (generation !== projectOperationGenerationRef.current || !saved) return;
      // Only serialize the writes. The build pipeline owns build coalescing;
      // awaiting it here used to discard edits and attention changes during a build.
      depsRef.current.autoBuild.afterSave();
      if (automaticBuildQueued.current && textRef.current !== savedRef.current) return step();
    };
    await step().finally(settle);
  }, [depsRef, projectOperationGenerationRef, save, savedRef, textRef]);
  const saveRef = useLatest(save);
  const saveAndBuildRef = useLatest(saveAndBuild);
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    const documentDirty = Boolean(!paper && !asset && file && text !== savedText);
    if (!project || (!documentDirty && !paperDirty)) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = !paper && autoBuildEnabled;
    // A completion menu is still part of the current edit. Saving and building
    // while its keyboard or pointer selection is in progress compiles the
    // temporary `\cite{}` buffer and can replace the menu with an error panel.
    if (automatic && completionActive) return;
    const delay = automatic ? 1_200 : 900;
    // Call through refs so project entry and build state updates do not keep
    // resetting the idle timer (that starved autosave and left PDF stuck reloading).
    saveTimer.current = window.setTimeout(() => {
      if (automatic) void saveAndBuildRef.current();
      else void saveRef.current();
    }, delay);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [
    asset, autoBuildEnabled, completionActive, file, paper, paperBlog, paperDirty, paperMarkdown, project,
    saveAndBuildRef, saveRef, savedPaperBlog, savedPaperMarkdown, savedText, text,
  ]);

  /** The writer left the editor: save now (and build, with automatic builds). */
  const onEditorLeave = useCallback(() => {
    if (completionActiveRef.current) return;
    // A visual edit may still be debounced, and its publication updates refs
    // before React commits. Flush first and never inspect render-time source.
    if (flushRef.current?.() === false) return;
    if (!renderedRef.current.paper && depsRef.current.autoBuild.enabled && textRef.current !== savedRef.current) {
      void saveAndBuild();
    } else {
      // Saving on attention changes is independent of automatic compilation
      // and includes dirty paper buffers.
      void save();
    }
  }, [depsRef, renderedRef, save, saveAndBuild, savedRef, textRef]);
  const onCompletionActiveChange = useCallback((active: boolean) => {
    completionActiveRef.current = active;
    setCompletionActive(active);
  }, []);

  // ---- Layout persistence -----------------------------------------------------------------------------------------
  useEffect(() => {
    if (!projectRoot || persistenceReadyRoot !== projectRoot) return;
    persistWorkspaceLayout(projectRoot, {
      openTabs: tabs,
      activeFile: file,
      activeTab,
      canvasMode: mode,
      documentMode: documentModeRef.current,
      paperView,
    });
  }, [activeTab, file, mode, paperView, persistenceReadyRoot, projectRoot, tabs]);
  // Remember the file open per project, so reopening it lands on the last page.
  useEffect(() => {
    if (projectRoot && file) persistLastFile(projectRoot, file);
  }, [projectRoot, file]);

  // ---- Project entry -------------------------------------------------------------------------------------------------
  /**
   * Start entering `snapshot`'s project: drop the outgoing documents before
   * the new root reaches any effect (an autosave or the incoming project's
   * first Overleaf sync could otherwise write the old relative path into the
   * new project). Call after the transition began and before the snapshot is
   * published as the current project.
   */
  const enter = useCallback((snapshot: ProjectSnapshot): ProjectEntry => {
    const projectGeneration = projectOperationGenerationRef.current;
    const restoreGeneration = intentRef.current + 1;
    intentRef.current = restoreGeneration;
    const ownsProjectRestore = () => (
      projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === snapshot.root
    );
    setPersistenceReadyRoot(null);
    setTabsSettledRoot(null);
    showFileText("", "");
    viewStates.loadForProject(snapshot.root);
    setPaper(null);
    setAssetLive(null);
    setPaperBuffers("", null);
    setTabs([]);
    setMode("split");
    htmlModesRef.current.clear();
    documentModeRef.current = "split";
    /** A newer file intent from the writer cancels the rest of the restore. */
    let primaryGeneration = restoreGeneration;
    const restoreIsCurrent = () => ownsProjectRestore() && intentRef.current === primaryGeneration;
    const supersede = () => {
      if (ownsProjectRestore()) setTabsSettledRoot(snapshot.root);
      return false;
    };
    let plan: ReturnType<typeof planWorkspaceRestore> | null = null;
    return {
      restore: async (papers) => {
        plan = planWorkspaceRestore(snapshot, papers, loadWorkspaceLayout(snapshot.root), loadLastFile(snapshot.root));
        const { primaryFile, activeTab: restoredTab, mode: restoredMode } = plan;
        documentModeRef.current = plan.documentMode;
        if (!restoreIsCurrent()) return supersede();
        if (primaryFile && !(await loadFile(primaryFile, { expectedProjectRoot: snapshot.root, projectGeneration }))) {
          return supersede();
        }
        primaryGeneration = intentRef.current;
        if (!ownsProjectRestore()) return false;
        if (!restoreIsCurrent()) return supersede();
        if (isHtmlFilePath(restoredTab)) htmlModesRef.current.set(restoredTab, restoredMode as DocumentViewMode);
        setTabs(plan.tabs);
        setTabsSettledRoot(snapshot.root);
        setMode(restoredMode);
        setPaperView(plan.paperView);
        setNavStack(primaryFile ? [{ path: primaryFile, line: 1 }] : []);
        setNavIndex(primaryFile ? 0 : -1);
        return true;
      },
      finish: () => {
        // The project's slow scans ran since restore(); a file the writer
        // opened meanwhile must not be replaced by the restored Paper or asset.
        if (!plan || plan.activeKind === "document" || !restoreIsCurrent()) {
          setPersistenceReadyRoot(snapshot.root);
          return;
        }
        // Paper and asset tabs load through their own readers once the base
        // project state exists; this finishes the active surface without
        // changing tab order.
        const { activeTab: restoredTab, mode: restoredMode, paperView: restoredView } = plan;
        void (async () => {
          if (isPaperTabKey(restoredTab)) {
            const arxivId = arxivIdFromTabKey(restoredTab);
            const target = depsRef.current.papers.find((item) => item.arxivId === arxivId);
            if (target) {
              if (!(await openPaper(target))) return;
              if (projectRef.current?.root === snapshot.root) {
                choosePaperView(restoredView);
                setMode(restoredMode === "source" || restoredMode === "split" ? restoredMode : "pdf");
              }
            }
          } else if (!(await openAsset(restoredTab))) return;
          if (projectRef.current?.root === snapshot.root) setPersistenceReadyRoot(snapshot.root);
        })();
      },
    };
  }, [
    choosePaperView, depsRef, loadFile, openAsset, openPaper, projectOperationGenerationRef, projectRef, setAssetLive,
    setPaperBuffers, showFileText, viewStates,
  ]);

  // ---- Tree changes ------------------------------------------------------------------------------------------------
  /**
   * `paths` were deleted from disk. Retire every tab-strip and navigation
   * reference to them (and to anything inside a deleted directory) before
   * the refresh await, so autosave cannot recreate a deleted buffer and a
   * background tab cannot reopen a missing file; then put the root document
   * (or another open source) in front of a deleted file.
   */
  const remove = useCallback(async (paths: readonly string[]) => {
    const { file: activeFile, paper: openPaperNow, asset: openAsset } = renderedRef.current;
    const gone = (candidate: string | null | undefined) => Boolean(
      candidate && paths.some((path) => candidate === path || candidate.startsWith(`${path}/`)),
    );
    const deletedActiveFile = gone(activeFile);
    const deletedActiveAsset = gone(openAsset?.path);
    const remainingTabs = tabsRef.current.filter((tab) => !gone(tab));
    tabsRef.current = remainingTabs;
    closedRef.current = closedRef.current.filter((tab) => !gone(tab));
    setTabs(remainingTabs);
    setNavStack((entries) => entries.filter((entry) => !gone(entry.path)));
    const { updateCanvasRequest } = depsRef.current;
    updateCanvasRequest("restore", (request) => request && gone(request.path) ? null : request);
    updateCanvasRequest("navigation", (request) => request && gone(request.path) ? null : request);
    if (deletedActiveFile) {
      intentRef.current += 1;
      setOpening(null);
      showFileText("", "");
    }
    if (deletedActiveAsset) setAssetLive(null);
    viewStates.forget([...paths], gone);
    const snapshot = await depsRef.current.refreshProject();
    if (deletedActiveFile && !openAsset && !openPaperNow) {
      const livePaths = new Set(flattenProjectPaths(snapshot.files));
      const rootDocument = snapshot.manifest.rootDocuments.find((document) => (
        document.isDefault && livePaths.has(document.path) && !gone(document.path)
      )) ?? snapshot.manifest.rootDocuments.find((document) => (
        livePaths.has(document.path) && !gone(document.path)
      ));
      const replacement = rootDocument?.path
        ?? remainingTabs.find((tab) => livePaths.has(tab) && isProjectSourceFilePath(tab))
        ?? [...livePaths].find(isProjectSourceFilePath);
      if (replacement) await loadFile(replacement);
    } else if (deletedActiveAsset) {
      setMode("split");
    }
  }, [depsRef, loadFile, renderedRef, setAssetLive, showFileText, viewStates]);

  /** Files moved or were renamed: carry the tabs, the open documents, history and remembered views along. */
  const move = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remap = (path: string) => remapProjectPath(path, changes);
    viewStates.remap(changes, remap);
    setTabs((current) => current.map(remap));
    fileRef.current = remap(fileRef.current);
    setFile((path) => remap(path));
    setAsset((shown) => shown && { ...shown, path: remap(shown.path) });
    setNavStack((entries) => entries.map((entry) => ({ ...entry, path: remap(entry.path) })));
    depsRef.current.updateCanvasRequest("restore", (request) => request ? { ...request, path: remap(request.path) } : request);
  }, [depsRef, fileRef, setAsset, setFile, viewStates]);

  // ---- Small commands --------------------------------------------------------------------------------------------


  /** Nothing is open in the editor any more. */
  const clear = useCallback(() => showFileText("", ""), [showFileText]);

  /** Publish deferred edits, then report whether the document in front holds edits not yet on disk. */
  const hasUnsavedEdits = useCallback(() => flushAndCheckDirty(ownerOf(renderedRef.current)), [flushAndCheckDirty, renderedRef]);

  /** Record the open file's current disk version, so a rewrite of our own does not read as someone else's edit. */
  const markDiskVersion = useCallback(() => (
    fileRef.current ? markDiskMtime(fileRef.current) : Promise.resolve()
  ), [fileRef, markDiskMtime]);

  /** Supersede every open in flight, for an open whose document resolves later. */
  const claim = useCallback((): OpenClaim => {
    const generation = intentRef.current + 1;
    intentRef.current = generation;
    setOpening(null);
    const handle = { isCurrent: () => intentRef.current === generation };
    claimGenerations.set(handle, generation);
    return handle;
  }, []);

  /** True while nothing newer was opened or chosen in this project. */
  const scope = useCallback(() => {
    const ownsProject = captureProjectScope();
    const generation = intentRef.current;
    const viewGeneration = viewIntentRef.current;
    return () => ownsProject() && intentRef.current === generation && viewIntentRef.current === viewGeneration;
  }, [captureProjectScope]);

  const registerFlush = useCallback((next: (() => boolean) | null) => { flushRef.current = next; }, []);
  const registerViewportCapture = useCallback((next: (() => void) | null) => { captureViewportRef.current = next; }, []);

  const tabsReady = Boolean(projectRoot) && (tabsSettledRoot === projectRoot || persistenceReadyRoot === projectRoot);
  const paperText = paperView === "blog" ? paperBlog ?? "" : paperMarkdown;

  return {
    // What is open.
    file, text, savedText,
    paper, paperView, paperPath, paperDirty,
    /** Both a blog and a full text exist, so the Paper can switch between them. */
    paperViews: Boolean(paper && paperBlog !== null && paperMarkdown),
    asset, assetMissing, assetPaths,
    activeTab, tabs, tabsReady, mode,
    /** Unsaved edits in the document in front. */
    dirty: paper ? paperDirty : text !== savedText,
    opening: opening?.label ?? null,
    /** What the canvas edits (the Paper's current view, else the file), and how it reports back. */
    canvas: {
      key: paper ? `paper:${paperPath}` : `local:${file}`,
      path: paperPath ?? file,
      text: paper ? paperText : text,
      previewText: paper ? (paperView === "blog" ? paperBlog ?? "" : stripFrontmatter(paperMarkdown)) : undefined,
      setText: paper ? setPaperText : setTextLive,
      onLeave: onEditorLeave,
      onCompletionActiveChange,
      onAssetChanged,
      registerFlush,
      registerViewportCapture,
    },
    /** Ref twins for async work that must compare against the latest buffers. */
    live: { file: fileRef, text: textRef, saved: savedRef, asset: assetRef },
    viewStates,
    // Intents.
    open, openFile, openAsset, openPaper, close, reopenClosed, go, chooseMode, choosePaperView, reveal, leavePaper,
    // Buffers.
    flush, save, hasUnsavedEdits, edit: setTextLive, accept, load: loadFile as LoadFile, clear, markDiskVersion, claim, scope,
    // Project and tree.
    enter, remove, move,
  };
}

export type OpenDocuments = ReturnType<typeof useOpenDocuments>;
