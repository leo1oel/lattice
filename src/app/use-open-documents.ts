import { useCallback } from "react";
import type { DocumentViewMode, OpenFileOptions } from "../app-types";
import { arxivIdFromTabKey, isBibFilePath, isHtmlFilePath, isPaperTabKey, paperTabKey, stripFrontmatter } from "../app-utils";
import { withEditor, withPdf } from "./document-view-modes";
import { claimGenerations, documentKind, ownerOf, type LoadFile, type OpenClaim } from "./open-document-intents";
import { useDocumentAutosave } from "./use-document-autosave";
import { useDocumentDiskSync } from "./use-document-disk-sync";
import { useDocumentOpens } from "./use-document-opens";
import { useDocumentSave } from "./use-document-save";
import { useDocumentStore, type OpenDocumentsDeps } from "./use-document-store";
import { useDocumentTreeChanges } from "./use-document-tree-changes";
import { useWorkspaceLayout } from "./use-workspace-layout";

export { paperDocumentPath, readPaperDocuments, type PaperView } from "./paper-documents";
export type { SaveStatus } from "./save-activity";
export { documentKind, type OpenDocumentsDeps };

const RECENTLY_CLOSED_LIMIT = 20;

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
  const store = useDocumentStore(deps);
  const {
    depsRef, documentsStore, projectRoot, captureProjectScope, renderedRef,
    file, fileRef, text, textRef, setText, savedText, savedRef, asset, assetRef, setAsset,
    paper, paperView, paperPath, paperDirty, paperBlog, paperMarkdown, setPaperText,
    tabs, setTabs, tabsRef, closedRef, activeTab, assetPaths, revealRequest,
    mode, setMode, htmlModesRef, documentModeRef, bibModeRef, viewModeFor,
    intentRef, viewIntentRef, setOpening, setNavIndex, navLockRef,
    persistenceReadyRoot, tabsSettledRoot, flushRef, captureViewportRef, viewStates,
    showFileText, closePaper, paperBuffersDirty, addTab, flush, bufferText, flushAndCheckDirty, markDiskMtime, accept,
  } = store;
  const { save, saveStatus, saveActivityRef } = useDocumentSave(store);
  const opens = useDocumentOpens(store, save);
  const { loadFile, openFile, choosePaperView, openPaper, openAsset } = opens;
  const { onAssetChanged, assetMissing } = useDocumentDiskSync(store, saveActivityRef);
  const { onEditorLeave, onLeaveForPdf, onCompletionActiveChange, registerCompletionClose } = useDocumentAutosave(store, save);
  const enter = useWorkspaceLayout(store, opens);
  const { remove, move } = useDocumentTreeChanges(store, loadFile);

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
        setAsset(null);
        if (fileFallback) await openFile(fileFallback);
        else setMode((current) => (current === "asset" ? "split" : current));
      }
      return;
    }
    if (key === activeFile && fileFallback) await openFile(fileFallback);
  }, [
    closePaper, closedRef, flushAndCheckDirty, flushRef, intentRef, loadFile, openFile, paperBuffersDirty, renderedRef,
    save, setAsset, setMode, setOpening, setTabs, tabsRef,
  ]);

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

  /**
   * The files visited this session, newest first and each once, as the
   * back/forward history holds them (the palette's Recent files). Read when
   * asked, so following them costs nothing while writing.
   */
  const recentPaths = () => [...new Set(documentsStore.getState().navStack.map((entry) => entry.path).reverse())];

  /** Reopen the most recently closed tab, through its own reader. */
  const reopenClosed = useCallback(() => {
    const key = closedRef.current.shift();
    if (key) void open(key);
  }, [closedRef, open]);

  /** Step back or forward through the lines the writer jumped between. */
  const go = useCallback(async (step: -1 | 1) => {
    const { navIndex: index, navStack: stack } = documentsStore.getState();
    const nextIndex = index + step;
    const entry = stack[nextIndex];
    if (!entry) return;
    navLockRef.current = true;
    setNavIndex(nextIndex);
    await openFile(entry.path, { line: entry.line }).finally(() => {
      navLockRef.current = false;
    });
  }, [documentsStore, navLockRef, openFile, setNavIndex]);

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
      else if (isBibFilePath(activeFile)) bibModeRef.current = next;
      else documentModeRef.current = next;
      setAsset(null);
      closePaper();
      // PDF can stand alone without a source tab. Returning to any source-backed
      // view restores the active document to the strip before rendering it.
      if (next !== "pdf" && activeFile) addTab(activeFile);
      if (!isCurrentViewRequest()) return;
      captureViewportRef.current?.();
      setMode(next);
    })();
  }, [
    addTab, bibModeRef, captureViewportRef, closePaper, documentModeRef, flushRef, htmlModesRef, intentRef, renderedRef,
    save, setAsset, setMode, viewIntentRef,
  ]);

  /** Bring the editor (or the PDF) on screen, widening a view that hides it to split. */
  const reveal = useCallback((surface: "editor" | "pdf") => setMode(surface === "editor" ? withEditor : withPdf), [setMode]);

  /** Leave the Paper in front (its source went away) for the file beneath it; its tab stays. */
  const leavePaper = useCallback(() => {
    closePaper();
    setMode("split");
  }, [closePaper, setMode]);

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
  }, [intentRef, setOpening]);

  /** True while nothing newer was opened or chosen in this project. */
  const scope = useCallback(() => {
    const ownsProject = captureProjectScope();
    const generation = intentRef.current;
    const viewGeneration = viewIntentRef.current;
    return () => ownsProject() && intentRef.current === generation && viewIntentRef.current === viewGeneration;
  }, [captureProjectScope, intentRef, viewIntentRef]);

  const registerFlush = useCallback((next: (() => boolean) | null) => { flushRef.current = next; }, [flushRef]);
  const registerViewportCapture = useCallback((next: (() => void) | null) => {
    captureViewportRef.current = next;
  }, [captureViewportRef]);

  const tabsReady = Boolean(projectRoot) && (tabsSettledRoot === projectRoot || persistenceReadyRoot === projectRoot);
  const paperText = paperView === "blog" ? paperBlog ?? "" : paperMarkdown;

  return {
    /** The open documents' store, for components that subscribe to one slice (the "Opening …" overlay). */
    store: documentsStore,
    // What is open.
    file, text, savedText,
    paper, paperView, paperPath, paperDirty,
    /** Both a blog and a full text exist, so the Paper can switch between them. */
    paperViews: Boolean(paper && paperBlog !== null && paperMarkdown),
    asset, assetMissing, assetPaths,
    activeTab, tabs, tabsReady, mode,
    /** Counts explicit opens; see showTab. */
    revealRequest,
    /** Unsaved edits in the document in front. */
    dirty: paper ? paperDirty : text !== savedText,
    /** What the canvas edits (the Paper's current view, else the file), and how it reports back. */
    canvas: {
      key: paper ? `paper:${paperPath}` : `local:${file}`,
      path: paperPath ?? file,
      text: paper ? paperText : text,
      previewText: paper ? (paperView === "blog" ? paperBlog ?? "" : stripFrontmatter(paperMarkdown)) : undefined,
      setText: paper ? setPaperText : setText,
      onLeave: onEditorLeave,
      onLeaveForPdf,
      onCompletionActiveChange,
      onAssetChanged,
      registerFlush,
      registerViewportCapture,
      registerCompletionClose,
    },
    /** Ref twins for async work that must compare against the latest buffers. */
    live: { file: fileRef, text: textRef, saved: savedRef, asset: assetRef },
    viewModeFor,
    viewStates,
    // Intents.
    open, openFile, openAsset, openPaper, close, reopenClosed, go, chooseMode, choosePaperView, reveal, leavePaper,
    recentPaths,
    // Buffers.
    /** The last write to disk, for the status bar's save slot. */
    saveStatus,
    flush, save, bufferText, hasUnsavedEdits, edit: setText, accept, load: loadFile as LoadFile, clear, markDiskVersion, claim, scope,
    // Project and tree.
    enter, remove, move,
  };
}

export type OpenDocuments = ReturnType<typeof useOpenDocuments>;
