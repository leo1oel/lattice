import { useCallback } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { AssetPreview, OpenFileOptions, PaperSummary } from "../app-types";
import { paperTabKey, toMessage } from "../app-utils";
import { afterNextPaintOpportunity } from "./effect-helpers";
import { showError, showNotice } from "./notify";
import { paperDocumentPath, preferredPaperView, readPaperDocuments, type PaperView } from "./paper-documents";
import { readDocumentText } from "./read-document";
import { modeOnLoad, withEditorFor } from "./document-view-modes";
import {
  claimGenerations, ownerOf, publishDeferredEdits, recordNavigationTiming, type LoadOptions, type OpenClaim,
} from "./open-document-intents";
import type { DocumentStore } from "./use-document-store";

const NAVIGATION_HISTORY_LIMIT = 80;

export type DocumentOpens = ReturnType<typeof useDocumentOpens>;

/**
 * Bring a file, Paper or asset in front of the canvas. Each open is an
 * intent: it publishes deferred visual edits, saves what it covers, and
 * commits only while nothing newer was asked for (see useOpenDocuments).
 */
export function useDocumentOpens(store: DocumentStore, save: () => Promise<boolean>) {
  const { t } = useLingui();
  const {
    depsRef, projectRef, projectOperationGenerationRef, captureProjectScope, renderedRef,
    fileRef, textRef, savedRef, setAssetLive, setPaper, setPaperView, setMode, setOpening, setNavStack, setNavIndex,
    intentRef, navLockRef, flushRef, viewStateRef, setTabsSettledRoot, viewModes,
    showFileText, setPaperBuffers, closePaper, paperBuffersDirty, addTab, showTab, flushAndCheckDirty, markDiskMtime,
    requestLine, accept,
  } = store;

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
      setMode((current) => modeOnLoad(path, previousPath, current, options?.revealSource, viewModes()));
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
      readDocumentText(path, expectedRoot),
      options?.gate ?? Promise.resolve(true),
    ]).then(commitLoaded).catch((reason: unknown) => {
      if (isLatestLoad()) showError(toMessage(reason));
      return false;
    });
  }, [
    addTab, closePaper, depsRef, fileRef, intentRef, markDiskMtime, projectOperationGenerationRef, projectRef,
    requestLine, setAssetLive, setMode, showFileText, viewModes, viewStateRef,
  ]);

  // ---- Open --------------------------------------------------------------------------------------------------------
  const pushNavigation = useCallback((path: string, line: number) => {
    if (navLockRef.current || !path) return;
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
  }, [navLockRef, renderedRef, setNavIndex, setNavStack]);

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
      showTab(path);
      if (line) {
        requestLine(path, line);
        setMode(withEditorFor(path));
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
        if (intentRef.current === loadGeneration) showError(toMessage(reason));
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
      if (flushed !== "refused" && intentRef.current === loadGeneration) showError(toMessage(flushed.error));
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
      restoreView: options?.restoreView ?? !line,
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
      setMode(withEditorFor(path));
      pushNavigation(path, line);
    } else {
      pushNavigation(path, 1);
    }
  }, [
    accept, depsRef, fileRef, flushAndCheckDirty, flushRef, intentRef, loadFile, markDiskMtime, paperBuffersDirty,
    projectRef, pushNavigation, renderedRef, requestLine, save, savedRef, setMode, setOpening, setTabsSettledRoot,
    showTab, textRef, viewStateRef,
  ]);

  /** Show the Paper's overview or its full text: two distinct editable documents. */
  const choosePaperView = useCallback((view: PaperView) => {
    if (view === renderedRef.current.paperView) return;
    // Publish the old NodeView while its path still owns the callback, then change identity.
    if (flushRef.current?.() === false) return;
    setPaperView(view);
  }, [flushRef, renderedRef, setPaperView]);

  const openPaper = useCallback(async (
    target: PaperSummary,
    options?: { view?: PaperView; claim?: OpenClaim; line?: number },
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
      if (!fullText && blog) showNotice(t`Full paper text is unavailable; showing the overview instead.`);
      setPaper(target);
      setAssetLive(null);
      setMode("pdf");
      showTab(paperTabKey(target.arxivId));
      recordNavigationTiming("paper", target.title, switchStartedAt, {
        openingPaintMs, flushMs, saveAndReadMs: performance.now() - contentLoadStartedAt,
      });
      return { hasBlog: blog !== null, hasFullText: Boolean(fullText) };
    })().catch((reason: unknown) => {
      if (isLatestLoad()) showError(toMessage(reason));
      return null;
    }).finally(clearOpening);
    if (!opened) return false;
    // Honor a view the caller named when it is locally readable; the open
    // already fell back to whichever side exists.
    if (options?.view === "fulltext" && opened.hasFullText) choosePaperView("fulltext");
    else if (options?.view === "blog" && opened.hasBlog) choosePaperView("blog");
    else return true;
    // A search hit's line, in the reading file it was found in: the Preview
    // answers the request once that file is the one in front.
    if (options.line) requestLine(paperDocumentPath(target.arxivId, options.view), options.line);
    return true;
  }, [
    captureProjectScope, choosePaperView, depsRef, flushAndCheckDirty, flushRef, intentRef, paperBuffersDirty,
    renderedRef, requestLine, save, savedRef, setAssetLive, setMode, setOpening, setPaper, setPaperBuffers, setPaperView,
    showTab, t, textRef,
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
      showTab(path);
      setAssetLive(preview);
      closePaper();
      setMode("asset");
      return true;
    };
    return read().catch((reason: unknown) => {
      if (isLatestLoad()) showError(toMessage(reason));
      return false;
    });
  }, [
    captureProjectScope, closePaper, flushAndCheckDirty, flushRef, intentRef, renderedRef, save, setAssetLive, setMode,
    setOpening, showTab,
  ]);

  return { loadFile, openFile, choosePaperView, openPaper, openAsset };
}
