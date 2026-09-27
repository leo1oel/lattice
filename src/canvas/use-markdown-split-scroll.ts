import { useEffect, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { clamp } from "../settings/app-settings";
import { interpolateScrollAnchors, scrollRange } from "./markdown-preview-sync";

type Side = "editor" | "preview";
const otherSide = (side: Side): Side => side === "editor" ? "preview" : "editor";

/**
 * Split-mode scroll coordination between the Markdown source editor and its
 * visual preview: each pane follows the other through a map of source-labelled
 * block anchors, and moving the source cursor reveals its block in the preview.
 *
 * `cursorRevealRef` and `reconcileRef` are filled in for the editor's update
 * listener and for the explicit View-in-source reveal, respectively.
 */
export function useMarkdownSplitScroll({
  view, preview, active, previewStart, peerScrollSettleMs, suppressedRef, viewportLockRef, cursorRevealRef, reconcileRef,
}: {
  view: EditorView | null;
  preview: HTMLDivElement | null;
  active: boolean;
  previewStart: number;
  peerScrollSettleMs: number;
  /** Set while another writer (a mode handoff or explicit reveal) owns both viewports. */
  suppressedRef: RefObject<boolean>;
  /** Non-zero while the preview holds its viewport still across an insertion. */
  viewportLockRef: RefObject<number>;
  cursorRevealRef: RefObject<(() => void) | null>;
  reconcileRef: RefObject<(() => void) | null>;
}) {
  useEffect(() => {
    if (!view || !preview || !active) return;

    const panes = {
      editor: { scroller: view.scrollDOM, ignore: false, frame: null as number | null, frameMeasure: false },
      preview: { scroller: preview as HTMLElement, ignore: false, frame: null as number | null, frameMeasure: false },
    };
    let settledSyncTimer: number | null = null;
    let settledSyncOwner: Side = "editor";
    let activeScrollOwner: Side | null = null;
    let scrollOwnerTimer: number | null = null;
    let anchorsDirty = true;
    const anchorMaps: Record<Side, Array<{ from: number; to: number }>> = { editor: [], preview: [] };
    let cachedAnchorRanges: Array<{ from: number; to: number; element: HTMLElement }> = [];
    const scrollSyncBlocked = () => suppressedRef.current || viewportLockRef.current !== 0;
    const holdScrollOwnership = (owner: Side) => {
      activeScrollOwner = owner;
      if (scrollOwnerTimer != null) window.clearTimeout(scrollOwnerTimer);
      scrollOwnerTimer = window.setTimeout(() => {
        scrollOwnerTimer = null;
        activeScrollOwner = null;
      }, 200);
    };
    const rebuildAnchorPairs = () => {
      const sourceAnchors = Array.from(preview.querySelectorAll<HTMLElement>("[data-source-offset]"));
      const previewRect = preview.getBoundingClientRect();
      const pairs: Array<{ editor: number; preview: number }> = [];
      const ranges: Array<{ from: number; to: number; element: HTMLElement }> = [];
      for (const anchor of sourceAnchors) {
        const previewFrom = Number(anchor.dataset.sourceOffset);
        const previewTo = Number(anchor.dataset.sourceEndOffset);
        if (!Number.isFinite(previewFrom) || !Number.isFinite(previewTo)) continue;
        ranges.push({ from: previewFrom, to: previewTo, element: anchor });
        const sourceFrom = clamp(previewStart + previewFrom, 0, view.state.doc.length);
        const sourceTo = clamp(previewStart + Math.max(previewFrom, previewTo - 1), sourceFrom, view.state.doc.length);
        const anchorRect = anchor.getBoundingClientRect();
        const pair = {
          editor: (view.lineBlockAt(sourceFrom).top + view.lineBlockAt(sourceTo).bottom) / 2,
          preview: Math.max(0, preview.scrollTop + anchorRect.top - previewRect.top + anchorRect.height / 2),
        };
        const previous = pairs.at(-1);
        if (!previous || (pair.editor > previous.editor && pair.preview > previous.preview)) pairs.push(pair);
      }
      anchorMaps.editor = pairs.map((pair) => ({ from: pair.editor, to: pair.preview }));
      anchorMaps.preview = pairs.map((pair) => ({ from: pair.preview, to: pair.editor }));
      cachedAnchorRanges = ranges;
      anchorsDirty = false;
    };
    const refreshAnchorsIfNeeded = () => {
      if (anchorsDirty) rebuildAnchorPairs();
    };
    // Measuring every anchor is O(document) and lands as a dropped frame when
    // it runs on the scroll path. Rebuild the map ahead of time once the DOM
    // quiets down after a publication, in idle time where available, so a
    // burst's throttled follows can interpolate from a fresh cache and the
    // lazy rebuild remains only a fallback.
    let anchorPrebuild: number | null = null;
    const usesIdleCallback = typeof window.requestIdleCallback === "function";
    const cancelAnchorPrebuild = () => {
      if (anchorPrebuild == null) return;
      if (usesIdleCallback) window.cancelIdleCallback(anchorPrebuild);
      else window.clearTimeout(anchorPrebuild);
      anchorPrebuild = null;
    };
    const scheduleAnchorPrebuild = () => {
      cancelAnchorPrebuild();
      const run = () => {
        anchorPrebuild = null;
        refreshAnchorsIfNeeded();
      };
      anchorPrebuild = usesIdleCallback ? window.requestIdleCallback(run, { timeout: 1_000 }) : window.setTimeout(run, 200);
    };
    /** Move the other pane so the block centred in `source` is centred there too. */
    const follow = (source: Side, measureAnchors = true) => {
      const from = panes[source];
      const to = panes[otherSide(source)];
      if (from.ignore) {
        from.ignore = false;
        return;
      }
      if (scrollSyncBlocked() || activeScrollOwner === otherSide(source)) return;
      if (measureAnchors) refreshAnchorsIfNeeded();
      const fromHalf = from.scroller.clientHeight / 2;
      const toHalf = to.scroller.clientHeight / 2;
      const targetCenter = interpolateScrollAnchors(
        from.scroller.scrollTop + fromHalf, anchorMaps[source],
        fromHalf, scrollRange(from.scroller) + fromHalf, toHalf, scrollRange(to.scroller) + toHalf,
      );
      const nextTop = targetCenter - toHalf;
      if (Math.abs(to.scroller.scrollTop - nextTop) <= 1) return;
      to.ignore = true;
      to.scroller.scrollTop = nextTop;
    };
    const reconcilePreviewFromSource = () => {
      // Split changes the Preview width, so discard measurements from its
      // initial mount and align with the final source/Preview geometry.
      anchorsDirty = true;
      follow("editor");
    };
    reconcileRef.current = reconcilePreviewFromSource;

    // Cursor-driven reveal, VS Code style: when the source cursor lands on a
    // block that is not visible in the preview (a click far away, a find
    // jump, typing below the fold), bring that block to the middle of the
    // preview viewport. A partially visible block is left alone — nudging it
    // would fight the user's own preview scrolling, and it already shows the
    // text being edited. Scroll gestures never arrive here; the coordinator
    // above owns those.
    let lastRevealHead = view.state.selection.main.head;
    let revealTimer: number | null = null;
    const revealPreviewAtCursor = () => {
      if (scrollSyncBlocked()) return;
      refreshAnchorsIfNeeded();
      const offset = view.state.selection.main.head - previewStart;
      let best: { from: number; to: number; element: HTMLElement } | null = null;
      for (const range of cachedAnchorRanges) {
        // Half-open with a floor of one character, so a cursor on an empty
        // block still matches it; prefer the tightest enclosing block.
        if (offset < range.from || offset >= Math.max(range.to, range.from + 1)) continue;
        if (!best || range.to - range.from <= best.to - best.from) best = range;
      }
      if (!best) return;
      const rect = best.element.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      if (rect.bottom > previewRect.top + 8 && rect.top < previewRect.bottom - 8) return;
      const target = clamp(preview.scrollTop + rect.top - previewRect.top - (preview.clientHeight - rect.height) / 2, 0, scrollRange(preview));
      if (Math.abs(preview.scrollTop - target) <= 1) return;
      panes.preview.ignore = true;
      preview.scrollTop = target;
    };
    cursorRevealRef.current = () => {
      const head = view.state.selection.main.head;
      if (head === lastRevealHead) return;
      lastRevealHead = head;
      // Only cursor motion the user made in the source pane reveals; caret
      // restores on unfocused editors (file switches, programmatic
      // selection) must not move the preview.
      if (!view.hasFocus) return;
      if (revealTimer != null) window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(revealPreviewAtCursor, 80);
    };

    // Trackpad input can deliver several scroll events before the browser
    // paints. Synchronizing both panes for every event repeatedly walks and
    // measures the Markdown DOM, so coalesce each direction to one pass per
    // animation frame.
    const scheduleFollow = (source: Side, measureAnchors = true) => {
      const pane = panes[source];
      pane.frameMeasure ||= measureAnchors;
      if (pane.frame != null) return;
      pane.frame = window.requestAnimationFrame(() => {
        pane.frame = null;
        const shouldMeasure = pane.frameMeasure;
        pane.frameMeasure = false;
        follow(source, shouldMeasure);
      });
    };

    // Large Markdown places two expensive, independently painted documents
    // beside each other (the split preview is a full editable ProseMirror
    // tree, which cannot use content-visibility culling — see
    // editor-globals.css on .ok-chunk-wrapper). The peer still follows every
    // animation frame — anything sparser reads as stuttering during trackpad
    // momentum — but burst follows interpolate purely from the cached anchor
    // map, so the scroll path performs no DOM measurement. The one exact,
    // freshly measured reconciliation runs after the gesture settles.
    // Smaller documents may measure lazily on the scroll path itself,
    // regardless of whether they are Paper/Blog or ordinary project Markdown.
    const followPeer = (owner: Side) => {
      settledSyncOwner = owner;
      scheduleFollow(owner, false);
      if (settledSyncTimer != null) window.clearTimeout(settledSyncTimer);
      settledSyncTimer = window.setTimeout(() => {
        settledSyncTimer = null;
        follow(settledSyncOwner);
      }, peerScrollSettleMs);
    };

    // scrollTop writes can coalesce into fewer events or arrive after the
    // next frame. The one-shot ignore flag handles the normal reciprocal
    // event; ownership also rejects a late/coalesced peer event so it cannot
    // seize control and write back into the scrollbar the user is dragging.
    const ownScroll = (side: Side) => () => {
      const pane = panes[side];
      if (pane.ignore) {
        pane.ignore = false;
        return;
      }
      if (scrollSyncBlocked() || activeScrollOwner === otherSide(side)) return;
      holdScrollOwnership(side);
      if (peerScrollSettleMs > 0) followPeer(side);
      else scheduleFollow(side);
    };
    const interaction = (side: Side) => () => {
      panes[side].ignore = false;
      holdScrollOwnership(side);
    };
    const editorInteraction = interaction("editor");
    const previewInteraction = interaction("preview");
    const previewRoot = preview.closest<HTMLElement>("[data-slot='scroll-area']");
    const passive = { passive: true };
    const listeners: [EventTarget | null, string, () => void, AddEventListenerOptions?][] = [
      [view.scrollDOM, "scroll", ownScroll("editor"), passive],
      [preview, "scroll", ownScroll("preview"), passive],
      [view.scrollDOM, "wheel", editorInteraction, passive],
      [view.scrollDOM.closest(".source-editor") ?? view.scrollDOM, "pointerdown", editorInteraction, { capture: true, passive: true }],
      [view.scrollDOM, "keydown", editorInteraction],
      [previewRoot, "wheel", previewInteraction, passive],
      [previewRoot, "pointerdown", previewInteraction, { capture: true, passive: true }],
      [previewRoot, "keydown", previewInteraction],
    ];
    for (const [target, type, listener, options] of listeners) target?.addEventListener(type, listener, options);
    const markAnchorsDirty = () => {
      // Source labels and child nodes change after every settled visual edit.
      // Measuring every block here forces a full layout after each source
      // publication. Mark the map stale and remeasure once the mutations
      // stop, off the scroll path.
      anchorsDirty = true;
      scheduleAnchorPrebuild();
    };
    const observer = new MutationObserver(markAnchorsDirty);
    observer.observe(preview, { attributes: true, attributeFilter: ["data-source-offset", "data-source-end-offset"], childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(markAnchorsDirty);
    resizeObserver.observe(preview);
    const previewContent = preview.firstElementChild;
    if (previewContent instanceof HTMLElement) resizeObserver.observe(previewContent);
    // Initial alignment uses the proportional fallback. Exact block geometry
    // is measured lazily on the first real scroll after labels are available.
    scheduleFollow("editor", false);
    return () => {
      cursorRevealRef.current = null;
      if (reconcileRef.current === reconcilePreviewFromSource) reconcileRef.current = null;
      if (revealTimer != null) window.clearTimeout(revealTimer);
      for (const pane of Object.values(panes)) {
        if (pane.frame != null) window.cancelAnimationFrame(pane.frame);
      }
      if (settledSyncTimer != null) window.clearTimeout(settledSyncTimer);
      if (scrollOwnerTimer != null) window.clearTimeout(scrollOwnerTimer);
      cancelAnchorPrebuild();
      observer.disconnect();
      resizeObserver.disconnect();
      for (const [target, type, listener, options] of listeners) target?.removeEventListener(type, listener, options);
    };
  }, [active, cursorRevealRef, peerScrollSettleMs, preview, previewStart, reconcileRef, suppressedRef, view, viewportLockRef]);
}
