import { useEffect, useRef, useState } from "react";
import { clamp } from "../settings/app-settings";
import type { CanvasMode } from "../app-types";

/**
 * Trailing edge of the source → preview handoff.
 *
 * Handing the preview a new document costs a full Markdown parse plus a
 * serialize round trip, so publishing every source keystroke makes typing in
 * split mode scale with document length (~90ms per parse at 40KB, several
 * times that once reconciliation runs). External edits — the source pane, a
 * collaborator, an agent write — are therefore published on the same idle
 * budget the preview already spends on the opposite direction.
 *
 * `immediate` bypasses the wait for documents the preview itself just wrote.
 * Settling those would leave the preview's accepted document behind the real
 * source for the length of the budget, and an edit landing in that window is
 * rejected against the stale text and surfaces as a spurious conflict draft.
 */
export function useSettledPreviewText(
  text: string,
  immediate: boolean,
  resetKey: string,
  idleMs: number,
  maxMs: number,
): string {
  const [settled, setSettled] = useState(text);
  const [settledKey, setSettledKey] = useState(resetKey);
  const latestTextRef = useRef(text);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Opening another file, and the preview's own echo, land in the same commit
  // as the source they came from. Adjusting state during render re-runs this
  // component before the commit, so no frame can observe the stale document.
  if (settledKey !== resetKey || (immediate && settled !== text)) {
    setSettledKey(resetKey);
    setSettled(text);
  }

  useEffect(() => {
    // Refreshed here rather than during render so the max timer below, which
    // outlives the commit that armed it, publishes the newest document.
    latestTextRef.current = text;
    if (settled === text) {
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      return;
    }
    const publish = () => {
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      setSettled(latestTextRef.current);
    };
    // A max timer keeps continuous typing from starving the preview entirely;
    // it is armed once per burst and cleared when the preview catches up.
    if (maxTimerRef.current == null) maxTimerRef.current = setTimeout(publish, maxMs);
    const idle = setTimeout(publish, idleMs);
    return () => clearTimeout(idle);
  }, [idleMs, maxMs, settled, text]);

  useEffect(() => () => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
  }, []);

  return settled;
}

/**
 * Splice the visual editor's new body into the source after its frontmatter,
 * or null when the source no longer holds the body the edit was made against.
 * Line endings follow the document, and a body written into an empty document
 * after frontmatter starts on its own line.
 */
export function spliceMarkdownBody(source: string, from: number, expectedBody: string, nextBody: string) {
  if (source.slice(from) !== expectedBody) return null;
  const insert = expectedBody.includes("\r\n") ? nextBody.replace(/\r?\n/g, "\r\n") : nextBody;
  const prefix = source.slice(0, from);
  const separator = expectedBody === "" && insert !== "" && from === source.length && prefix !== "" && !/\r?\n$/.test(prefix)
    ? (source.includes("\r\n") ? "\r\n" : "\n")
    : "";
  return { prefix, inserted: `${separator}${insert}` };
}

export function minimalTextChange(previous: string, next: string, offset: number) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    from: offset + prefix,
    to: offset + previous.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/**
 * Ranges rebased into a preview that renders `[start, end)` of the file. A range
 * straddling the slice boundary is dropped rather than mispainted.
 */
export function rangesWithinPreview<T extends { from: number; to: number }>(items: readonly T[], start: number, end: number): T[] {
  return items.flatMap((item) => (
    item.from < start || item.to > end ? [] : [{ ...item, from: item.from - start, to: item.to - start }]
  ));
}

export function interpolateScrollAnchors(
  value: number,
  pairs: Array<{ from: number; to: number }>,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
) {
  const bound = (target: number, key: "from" | "to", upper: boolean, low = 0, high = pairs.length) => {
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = pairs[middle][key];
      if (candidate < target || (upper && candidate === target)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const firstInterior = Math.max(
    bound(fromMin, "from", true),
    bound(toMin, "to", true),
  );
  const afterInterior = Math.min(
    bound(fromMax, "from", false, firstInterior),
    bound(toMax, "to", false, firstInterior),
  );
  const insertion = bound(value, "from", false, firstInterior, afterInterior);
  const lower = insertion > firstInterior
    ? pairs[insertion - 1]
    : { from: fromMin, to: toMin };
  const upper = insertion < afterInterior
    ? pairs[insertion]
    : { from: fromMax, to: toMax };
  const span = upper.from - lower.from;
  const progress = span > 0 ? (value - lower.from) / span : 0;
  return clamp(lower.to + progress * (upper.to - lower.to), toMin, toMax);
}

export type ViewportSnapshot = {
  scrollTop: number;
  scrollRange: number;
};

type PreviewViewportSnapshot = ViewportSnapshot & {
  blockIndex?: number;
  blockViewportTop?: number;
  blockSourceOffset?: number;
  chunkId?: string;
  chunkBlockIndex?: number;
};

export type MarkdownModeViewportHandoff = {
  path: string;
  mode: CanvasMode;
  source?: ViewportSnapshot;
  preview?: PreviewViewportSnapshot;
};

export function captureViewport(viewport: HTMLElement): ViewportSnapshot {
  return {
    scrollTop: viewport.scrollTop,
    scrollRange: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  };
}

function previewViewportBlocks(viewport: HTMLElement): HTMLElement[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>(".ProseMirror")).flatMap(
    (proseMirror) => Array.from(proseMirror.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    ),
  );
}

export function capturePreviewViewport(viewport: HTMLElement): PreviewViewportSnapshot {
  const snapshot: PreviewViewportSnapshot = captureViewport(viewport);
  const blocks = previewViewportBlocks(viewport);
  const viewportRect = viewport.getBoundingClientRect();
  const blockIndex = blocks.findIndex((block) => (
    block.getBoundingClientRect().bottom > viewportRect.top
  ));
  const block = blocks[blockIndex];
  if (!block) return snapshot;
  const sourceOffset = Number(block.dataset.sourceOffset);
  const chunk = block.closest<HTMLElement>("[data-visual-chunk-id]");
  const chunkBlocks = chunk
    ? Array.from(chunk.querySelector<HTMLElement>(".ProseMirror")?.children ?? [])
    : [];
  return {
    ...snapshot,
    blockIndex,
    blockViewportTop: block.getBoundingClientRect().top - viewportRect.top,
    ...(Number.isFinite(sourceOffset) ? { blockSourceOffset: sourceOffset } : {}),
    ...(chunk?.dataset.visualChunkId ? {
      chunkId: chunk.dataset.visualChunkId,
      chunkBlockIndex: chunkBlocks.indexOf(block),
    } : {}),
  };
}

export function restoreViewport(
  viewport: HTMLElement,
  snapshot: ViewportSnapshot,
): boolean {
  const targetRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTop = snapshot.scrollRange > 0 && targetRange > 0
    ? (snapshot.scrollTop / snapshot.scrollRange) * targetRange
    : snapshot.scrollTop;
  return snapshot.scrollTop <= 0 || snapshot.scrollRange <= 0 || targetRange > 0;
}

export function restorePreviewViewport(
  viewport: HTMLElement,
  snapshot: PreviewViewportSnapshot,
): boolean {
  const viewportReady = restoreViewport(viewport, snapshot);
  if (snapshot.blockIndex == null || snapshot.blockViewportTop == null) return viewportReady;
  const blocks = previewViewportBlocks(viewport);
  let block = snapshot.blockSourceOffset == null
    ? null
    : blocks.find((candidate) => Number(candidate.dataset.sourceOffset) === snapshot.blockSourceOffset) ?? null;
  if (!block && snapshot.chunkId != null && snapshot.chunkBlockIndex != null) {
    const chunk = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-visual-chunk-id]"),
    ).find((candidate) => candidate.dataset.visualChunkId === snapshot.chunkId);
    const candidate = chunk?.querySelector<HTMLElement>(".ProseMirror")
      ?.children[snapshot.chunkBlockIndex];
    if (candidate instanceof HTMLElement) block = candidate;
  }
  if (!block && snapshot.chunkId != null) return false;
  block ??= blocks[snapshot.blockIndex] ?? null;
  if (!block) return false;
  const blockViewportTop = block.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top;
  if (Number.isFinite(blockViewportTop)) {
    viewport.scrollTop += blockViewportTop - snapshot.blockViewportTop;
  }
  return viewportReady;
}
