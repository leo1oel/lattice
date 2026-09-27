import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { clamp } from "../settings/app-settings";
import type { CanvasMode } from "../app-types";
import {
  captureViewport,
  capturePreviewViewport,
  restorePreviewViewport,
  restoreViewport,
  type MarkdownModeViewportHandoff,
} from "./markdown-preview-sync";

const isMarkdownMode = (mode: CanvasMode) => mode === "source" || mode === "split" || mode === "pdf";

/**
 * Keeps the reader's place when a Markdown document moves between Edit,
 * Split and Preview: the outgoing viewports are captured (App calls
 * `captureMarkdownModeViewport` before it switches) and restored into
 * whichever panes the new mode mounts. An explicit "View in source" instead
 * centres the same source-backed block in both Split panes.
 *
 * While either transition owns the viewports it sets `scrollSyncSuppressedRef`,
 * which pauses the split scroll coordinator.
 */
export function useMarkdownModeHandoff({
  activeFile,
  mode,
  markdownDocument,
  previewStart,
  primaryViewRef,
  primaryViewPathRef,
  previewViewportRef,
  previewViewport,
  primaryView,
  activeFileRef,
  scrollSyncSuppressedRef,
  reconcileFromSourceRef,
  onViewMarkdownSource,
}: {
  activeFile: string;
  mode: CanvasMode;
  markdownDocument: boolean;
  previewStart: number;
  primaryViewRef: RefObject<EditorView | null>;
  /** The file the primary view was created for; it can briefly lag a switch. */
  primaryViewPathRef: RefObject<string>;
  previewViewportRef: RefObject<HTMLDivElement | null>;
  /** State mirrors of the two viewports, so a remount re-runs the restore. */
  previewViewport: HTMLDivElement | null;
  primaryView: EditorView | null;
  activeFileRef: RefObject<string>;
  scrollSyncSuppressedRef: RefObject<boolean>;
  reconcileFromSourceRef: RefObject<(() => void) | null>;
  onViewMarkdownSource: () => void;
}) {
  const handoffRef = useRef<MarkdownModeViewportHandoff | null>(null);
  const restoreGenerationRef = useRef(0);
  const explicitViewInSourceTransitionRef = useRef(false);
  const explicitViewInSourceGenerationRef = useRef(0);
  const explicitViewInSourcePendingGenerationRef = useRef<number | null>(null);
  const identityRef = useRef({ path: activeFile, mode });

  const currentSourceView = useCallback(() => (
    primaryViewRef.current?.dom.isConnected && primaryViewPathRef.current === activeFile
      ? primaryViewRef.current
      : null
  ), [activeFile, primaryViewPathRef, primaryViewRef]);

  const captureMarkdownModeViewport = useCallback(() => {
    if (!markdownDocument || !isMarkdownMode(mode)) return;
    const sourceView = currentSourceView();
    const preview = previewViewportRef.current?.isConnected ? previewViewportRef.current : null;
    if (!sourceView && !preview) return;
    handoffRef.current = {
      path: activeFile,
      mode,
      ...(sourceView ? { source: captureViewport(sourceView.scrollDOM) } : {}),
      ...(preview ? { preview: capturePreviewViewport(preview) } : {}),
    };
  }, [activeFile, currentSourceView, markdownDocument, mode, previewViewportRef]);

  useLayoutEffect(() => {
    const restoreGeneration = ++restoreGenerationRef.current;
    const markdownMode = isMarkdownMode(mode);
    const explicitViewInSource = Boolean(markdownDocument && markdownMode && explicitViewInSourceTransitionRef.current);
    const previousIdentity = identityRef.current;
    const modeOrPathChanged = previousIdentity.path !== activeFile || previousIdentity.mode !== mode;
    identityRef.current = { path: activeFile, mode };
    explicitViewInSourceTransitionRef.current = false;
    if (modeOrPathChanged && !explicitViewInSource) {
      explicitViewInSourceGenerationRef.current += 1;
      explicitViewInSourcePendingGenerationRef.current = null;
    }
    if (!markdownDocument || !markdownMode) {
      handoffRef.current = null;
      scrollSyncSuppressedRef.current = false;
      return;
    }

    const handoff = handoffRef.current;
    if (explicitViewInSource) handoffRef.current = null;
    let restoreFrame: number | null = null;

    if (handoff && handoff.path === activeFile && handoff.mode !== mode && !explicitViewInSource) {
      scrollSyncSuppressedRef.current = true;
      const restore = () => {
        if (restoreGenerationRef.current !== restoreGeneration) return false;
        const sourceView = currentSourceView();
        const preview = previewViewportRef.current;
        let ready = true;
        if (mode !== "pdf") {
          const sourceSnapshot = handoff.source ?? handoff.preview;
          ready = Boolean(sourceView && sourceSnapshot && restoreViewport(sourceView.scrollDOM, sourceSnapshot)) && ready;
        }
        if (mode !== "source") {
          ready = Boolean(preview && (
            handoff.preview
              ? restorePreviewViewport(preview, handoff.preview)
              : handoff.source && restoreViewport(preview, handoff.source)
          )) && ready;
        }
        return ready;
      };
      let attempts = 0;
      let stableRestores = 0;
      const restoreWhenReady = () => {
        restoreFrame = null;
        stableRestores = restore() ? stableRestores + 1 : 0;
        attempts += 1;
        if (stableRestores >= 3 || attempts >= 30) {
          if (stableRestores >= 3 && handoffRef.current === handoff) handoffRef.current = null;
          if (!explicitViewInSourceTransitionRef.current) scrollSyncSuppressedRef.current = false;
          return;
        }
        restoreFrame = window.requestAnimationFrame(restoreWhenReady);
      };
      restoreWhenReady();
    } else if (!explicitViewInSource && explicitViewInSourcePendingGenerationRef.current == null) {
      scrollSyncSuppressedRef.current = false;
    }

    return () => {
      restoreGenerationRef.current += 1;
      if (restoreFrame != null) window.cancelAnimationFrame(restoreFrame);
    };
    // The viewport states re-run the restore once a remounted pane exists.
  }, [activeFile, currentSourceView, markdownDocument, mode, previewViewport, previewViewportRef, primaryView, scrollSyncSuppressedRef]);

  const viewMarkdownSource = useCallback((sourceOffset: number) => {
    // This is an explicit cross-pane reveal. Preview-only and Split have
    // different React roots, and the narrower Split preview reflows prose, so
    // coordinates from the old Preview cannot be carried across reliably.
    // Once both panes exist, center the same source-backed block in each pane.
    if (mode !== "split") explicitViewInSourceTransitionRef.current = true;
    const revealGeneration = ++explicitViewInSourceGenerationRef.current;
    explicitViewInSourcePendingGenerationRef.current = revealGeneration;
    const revealIsCurrent = () => (
      explicitViewInSourceGenerationRef.current === revealGeneration
      && explicitViewInSourcePendingGenerationRef.current === revealGeneration
      && activeFileRef.current === activeFile
    );
    const endReveal = () => {
      explicitViewInSourcePendingGenerationRef.current = null;
      scrollSyncSuppressedRef.current = false;
    };
    scrollSyncSuppressedRef.current = true;
    onViewMarkdownSource();

    let attempts = 0;
    const releaseScrollSync = () => {
      window.requestAnimationFrame(() => {
        if (!revealIsCurrent()) return;
        window.requestAnimationFrame(() => {
          if (revealIsCurrent() && identityRef.current.mode === "split") {
            endReveal();
            // The split coordinator's initial pass ran while the explicit
            // two-pane centering was in progress, so it was intentionally
            // blocked. Reconcile once against that final geometry now;
            // otherwise the first tiny source scroll performs this alignment
            // and visibly nudges the other pane.
            reconcileFromSourceRef.current?.();
          }
        });
      });
    };
    const focusSource = () => {
      if (!revealIsCurrent()) return;
      const view = primaryViewRef.current;
      const preview = previewViewportRef.current;
      const target = preview
        ? Array.from(preview.querySelectorAll<HTMLElement>("[data-source-offset]"))
            .filter((element) => {
              const from = Number(element.dataset.sourceOffset);
              const to = Number(element.dataset.sourceEndOffset);
              return Number.isFinite(from) && Number.isFinite(to) && sourceOffset >= from && sourceOffset <= to;
            })
            .sort((left, right) => (
              Number(left.dataset.sourceEndOffset) - Number(left.dataset.sourceOffset)
              - (Number(right.dataset.sourceEndOffset) - Number(right.dataset.sourceOffset))
            ))[0] ?? null
        : null;
      if (identityRef.current.mode !== "split" || !view?.dom.isConnected || !preview?.isConnected || !target) {
        if (attempts++ < 30) window.requestAnimationFrame(focusSource);
        // Source reveal remains useful even if a malformed document never
        // receives source labels. Stop suppressing normal split scrolling.
        else if (revealIsCurrent()) endReveal();
        return;
      }
      const cursor = clamp(previewStart + sourceOffset, 0, view.state.doc.length);
      view.dispatch({ selection: { anchor: cursor } });
      const previewFrom = Number(target.dataset.sourceOffset);
      const previewTo = Number(target.dataset.sourceEndOffset);
      const sourceFrom = clamp(previewStart + previewFrom, 0, view.state.doc.length);
      const sourceTo = clamp(previewStart + Math.max(previewFrom, previewTo - 1), sourceFrom, view.state.doc.length);
      const sourceCenter = (view.lineBlockAt(sourceFrom).top + view.lineBlockAt(sourceTo).bottom) / 2;
      const sourceMaxScroll = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
      view.scrollDOM.scrollTop = clamp(sourceCenter - view.scrollDOM.clientHeight / 2, 0, sourceMaxScroll);
      const previewRect = preview.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const previewCenter = preview.scrollTop + targetRect.top - previewRect.top + targetRect.height / 2;
      const previewMaxScroll = Math.max(0, preview.scrollHeight - preview.clientHeight);
      preview.scrollTop = clamp(previewCenter - preview.clientHeight / 2, 0, previewMaxScroll);
      view.focus();
      releaseScrollSync();
    };
    window.requestAnimationFrame(focusSource);
  }, [
    activeFile,
    activeFileRef,
    mode,
    onViewMarkdownSource,
    previewStart,
    previewViewportRef,
    primaryViewRef,
    reconcileFromSourceRef,
    scrollSyncSuppressedRef,
  ]);

  return { captureMarkdownModeViewport, viewMarkdownSource };
}
