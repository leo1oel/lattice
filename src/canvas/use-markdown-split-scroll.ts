import { useEffect, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { clamp } from "../settings/app-settings";
import { clearTimer, restartTimer, whenIdle, type TimerRef } from "../app/effect-helpers";
import { interpolateScrollAnchors, scrollRange, sourceAnchorCenter, sourceAnchors, type SourceAnchor } from "./markdown-preview-sync";

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
    const settledSyncTimer: TimerRef = { current: null };
    let activeScrollOwner: Side | null = null;
    const scrollOwnerTimer: TimerRef = { current: null };
    let anchorsDirty = true;
    const anchorMaps: Record<Side, Array<{ from: number; to: number }>> = { editor: [], preview: [] };
    let cachedAnchorRanges: SourceAnchor[] = [];
    const scrollSyncBlocked = () => suppressedRef.current || viewportLockRef.current !== 0;
    const holdScrollOwnership = (owner: Side) => {
      activeScrollOwner = owner;
      restartTimer(scrollOwnerTimer, 200, () => {
        activeScrollOwner = null;
      });
    };
    /** Remeasure the anchor maps if the preview changed since they were built. */
    const refreshAnchors = () => {
      if (!anchorsDirty) return;
      const previewTop = preview.getBoundingClientRect().top;
      const pairs: Array<{ editor: number; preview: number }> = [];
      cachedAnchorRanges = sourceAnchors(preview);
      for (const anchor of cachedAnchorRanges) {
        const anchorRect = anchor.element.getBoundingClientRect();
        const pair = {
          editor: sourceAnchorCenter(view, previewStart, anchor),
          preview: Math.max(0, preview.scrollTop + anchorRect.top - previewTop + anchorRect.height / 2),
        };
        const previous = pairs.at(-1);
        if (!previous || (pair.editor > previous.editor && pair.preview > previous.preview)) pairs.push(pair);
      }
      anchorMaps.editor = pairs.map((pair) => ({ from: pair.editor, to: pair.preview }));
      anchorMaps.preview = pairs.map((pair) => ({ from: pair.preview, to: pair.editor }));
      anchorsDirty = false;
    };
    let cancelAnchorPrebuild = () => {};
    /** Move the other pane so the block centred in `source` is centred there too. */
    const follow = (source: Side, measureAnchors = true) => {
      const from = panes[source];
      const to = panes[otherSide(source)];
      if (from.ignore) {
        from.ignore = false;
        return;
      }
      if (scrollSyncBlocked() || activeScrollOwner === otherSide(source)) return;
      if (measureAnchors) refreshAnchors();
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
      // Split changes the Preview width: discard measurements from its initial mount.
      anchorsDirty = true;
      follow("editor");
    };
    reconcileRef.current = reconcilePreviewFromSource;

    // Cursor-driven reveal, VS Code style: when the source cursor lands on a
    // block the preview does not show at all, centre that block there. A
    // partially visible block is left alone, so this never fights the user's
    // own preview scrolling.
    let lastRevealHead = view.state.selection.main.head;
    const revealTimer: TimerRef = { current: null };
    const revealPreviewAtCursor = () => {
      if (scrollSyncBlocked()) return;
      refreshAnchors();
      const offset = view.state.selection.main.head - previewStart;
      let best: SourceAnchor | null = null;
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
      // Only the user's own cursor motion reveals, not restores on an unfocused editor.
      if (!view.hasFocus) return;
      restartTimer(revealTimer, 80, revealPreviewAtCursor);
    };

    // Trackpad input can deliver several scroll events per paint: coalesce each
    // direction to one pass per animation frame.
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

    // Large Markdown puts two expensive documents side by side (the preview is
    // a full editable ProseMirror tree that cannot use content-visibility
    // culling). The peer still follows every frame — anything sparser stutters
    // during trackpad momentum — but from the cached anchor map alone, and the
    // one freshly measured reconciliation runs after the gesture settles.
    // Smaller documents may measure lazily on the scroll path itself.
    const followPeer = (owner: Side) => {
      scheduleFollow(owner, false);
      restartTimer(settledSyncTimer, peerScrollSettleMs, () => follow(owner));
    };

    // The one-shot ignore flag absorbs the normal reciprocal event; ownership
    // also rejects a late or coalesced peer event, so it cannot write back
    // into the scrollbar the user is dragging.
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
      // Labels change after every settled visual edit. Measuring every anchor is
      // O(document), a dropped frame on the scroll path: rebuild the map in idle
      // time once mutations stop, so follows interpolate from a fresh cache.
      anchorsDirty = true;
      cancelAnchorPrebuild();
      cancelAnchorPrebuild = whenIdle(refreshAnchors, 1_000, 200);
    };
    const observer = new MutationObserver(markAnchorsDirty);
    observer.observe(preview, { attributes: true, attributeFilter: ["data-source-offset", "data-source-end-offset"], childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(markAnchorsDirty);
    resizeObserver.observe(preview);
    const previewContent = preview.firstElementChild;
    if (previewContent instanceof HTMLElement) resizeObserver.observe(previewContent);
    // Initial alignment is proportional; exact geometry waits for the first real scroll.
    scheduleFollow("editor", false);
    return () => {
      cursorRevealRef.current = null;
      if (reconcileRef.current === reconcilePreviewFromSource) reconcileRef.current = null;
      clearTimer(revealTimer);
      for (const pane of Object.values(panes)) {
        if (pane.frame != null) window.cancelAnimationFrame(pane.frame);
      }
      clearTimer(settledSyncTimer);
      clearTimer(scrollOwnerTimer);
      cancelAnchorPrebuild();
      observer.disconnect();
      resizeObserver.disconnect();
      for (const [target, type, listener, options] of listeners) target?.removeEventListener(type, listener, options);
    };
  }, [active, cursorRevealRef, peerScrollSettleMs, preview, previewStart, reconcileRef, suppressedRef, view, viewportLockRef]);
}
