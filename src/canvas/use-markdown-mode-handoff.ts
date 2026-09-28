import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { clamp } from "../settings/app-settings";
import type { CanvasMode } from "../app-types";
import {
  captureViewport, capturePreviewViewport, restorePreviewViewport, restoreViewport, scrollRange, sourceAnchorCenter,
  sourceAnchors, type MarkdownModeViewportHandoff,
} from "./markdown-preview-sync";

const isMarkdownMode = (mode: CanvasMode) => mode === "source" || mode === "split" || mode === "pdf";

/**
 * Keeps the reader's place when a Markdown document moves between Edit, Split
 * and Preview: App calls `captureMarkdownModeViewport` before it switches, and
 * the viewports are restored into whichever panes the new mode mounts. An
 * explicit "View in source" instead centres the same source-backed block in
 * both Split panes. Either transition pauses the split scroll coordinator
 * through `scrollSyncSuppressedRef`.
 */
export function useMarkdownModeHandoff({
  activeFile, mode, markdownDocument, previewStart, primaryViewRef, primaryViewPathRef, previewViewportRef,
  previewViewport, primaryView, latestRef, scrollSyncSuppressedRef, reconcileFromSourceRef, onViewMarkdownSource,
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
  /** The canvas's newest props: a reveal is dropped once another file is open. */
  latestRef: RefObject<{ activeFile: string }>;
  scrollSyncSuppressedRef: RefObject<boolean>;
  reconcileFromSourceRef: RefObject<(() => void) | null>;
  onViewMarkdownSource: () => void;
}) {
  const handoffRef = useRef<MarkdownModeViewportHandoff | null>(null);
  const explicitViewInSourceTransitionRef = useRef(false);
  /** The explicit reveal still in progress; a newer reveal or a mode/file change replaces it. */
  const pendingRevealRef = useRef<object | null>(null);
  const identityRef = useRef({ path: activeFile, mode });

  /** The primary source view, when it is connected and showing this file. */
  const livePrimaryView = useCallback(() => (
    primaryViewRef.current?.dom.isConnected && primaryViewPathRef.current === activeFile ? primaryViewRef.current : null
  ), [activeFile, primaryViewPathRef, primaryViewRef]);

  const captureMarkdownModeViewport = useCallback(() => {
    if (!markdownDocument || !isMarkdownMode(mode)) return;
    const sourceView = livePrimaryView();
    const preview = previewViewportRef.current?.isConnected ? previewViewportRef.current : null;
    if (!sourceView && !preview) return;
    handoffRef.current = {
      path: activeFile,
      mode,
      ...(sourceView ? { source: captureViewport(sourceView.scrollDOM) } : {}),
      ...(preview ? { preview: capturePreviewViewport(preview) } : {}),
    };
  }, [activeFile, livePrimaryView, markdownDocument, mode, previewViewportRef]);

  useLayoutEffect(() => {
    const markdownMode = isMarkdownMode(mode);
    const explicitViewInSource = Boolean(markdownDocument && markdownMode && explicitViewInSourceTransitionRef.current);
    const previousIdentity = identityRef.current;
    const modeOrPathChanged = previousIdentity.path !== activeFile || previousIdentity.mode !== mode;
    identityRef.current = { path: activeFile, mode };
    explicitViewInSourceTransitionRef.current = false;
    if (modeOrPathChanged && !explicitViewInSource) pendingRevealRef.current = null;
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
        const sourceView = livePrimaryView();
        const preview = previewViewportRef.current;
        const sourceSnapshot = handoff.source ?? handoff.preview;
        const sourceReady = mode === "pdf"
          || Boolean(sourceView && sourceSnapshot && restoreViewport(sourceView.scrollDOM, sourceSnapshot));
        const previewReady = mode === "source" || Boolean(preview && (handoff.preview
          ? restorePreviewViewport(preview, handoff.preview)
          : handoff.source && restoreViewport(preview, handoff.source)));
        return sourceReady && previewReady;
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
    } else if (!explicitViewInSource && pendingRevealRef.current == null) {
      scrollSyncSuppressedRef.current = false;
    }

    // Cancelling the pending frame ends this restore: nothing else schedules one.
    return () => {
      if (restoreFrame != null) window.cancelAnimationFrame(restoreFrame);
    };
    // The viewport states re-run the restore once a remounted pane exists.
  }, [activeFile, livePrimaryView, markdownDocument, mode, previewViewport, previewViewportRef, primaryView, scrollSyncSuppressedRef]);

  const viewMarkdownSource = useCallback((sourceOffset: number) => {
    // Preview-only and Split have different React roots and reflow prose
    // differently, so once both panes exist, centre the same source-backed
    // block in each rather than carrying coordinates across.
    if (mode !== "split") explicitViewInSourceTransitionRef.current = true;
    const reveal = {};
    pendingRevealRef.current = reveal;
    const revealIsCurrent = () => pendingRevealRef.current === reveal && latestRef.current.activeFile === activeFile;
    const endReveal = () => {
      pendingRevealRef.current = null;
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
            // The split coordinator's initial pass was blocked by this reveal.
            // Reconcile once against the final geometry, or the first tiny
            // source scroll performs the alignment and nudges the other pane.
            reconcileFromSourceRef.current?.();
          }
        });
      });
    };
    const focusSource = () => {
      if (!revealIsCurrent()) return;
      const view = primaryViewRef.current;
      const preview = previewViewportRef.current;
      // The tightest source-labelled block that contains the offset.
      const target = (preview ? sourceAnchors(preview) : [])
        .filter(({ from, to }) => sourceOffset >= from && sourceOffset <= to)
        .sort((left, right) => (left.to - left.from) - (right.to - right.from))[0];
      if (identityRef.current.mode !== "split" || !view?.dom.isConnected || !preview?.isConnected || !target) {
        if (attempts++ < 30) window.requestAnimationFrame(focusSource);
        // A document that never receives source labels must not suppress split scrolling forever.
        else if (revealIsCurrent()) endReveal();
        return;
      }
      view.dispatch({ selection: { anchor: clamp(previewStart + sourceOffset, 0, view.state.doc.length) } });
      const sourceCenter = sourceAnchorCenter(view, previewStart, target);
      view.scrollDOM.scrollTop = clamp(sourceCenter - view.scrollDOM.clientHeight / 2, 0, scrollRange(view.scrollDOM));
      const targetRect = target.element.getBoundingClientRect();
      const previewCenter = preview.scrollTop + targetRect.top - preview.getBoundingClientRect().top + targetRect.height / 2;
      preview.scrollTop = clamp(previewCenter - preview.clientHeight / 2, 0, scrollRange(preview));
      view.focus();
      releaseScrollSync();
    };
    window.requestAnimationFrame(focusSource);
  }, [
    activeFile, latestRef, mode, onViewMarkdownSource, previewStart, previewViewportRef, primaryViewRef,
    reconcileFromSourceRef, scrollSyncSuppressedRef,
  ]);

  return { captureMarkdownModeViewport, viewMarkdownSource, livePrimaryView };
}
