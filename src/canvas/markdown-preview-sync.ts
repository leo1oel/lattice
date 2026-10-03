import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { markdownPreviewSyncPolicy } from "../editor/markdown/markdown-preview-sync-policy";
import { clamp } from "../settings/app-settings";
import { clearTimer } from "../app/effect-helpers";
import type { CanvasMode, VisualMarkdownViewState } from "../app-types";

/**
 * Trailing edge of the source → preview handoff.
 *
 * Handing the preview a new document costs a full Markdown parse plus a
 * serialize round trip (~90ms at 40KB), so external edits — the source pane,
 * a collaborator, an agent write — are published on the same idle budget the
 * preview spends on the opposite direction.
 *
 * Documents the preview itself wrote (`markEcho`, called with the whole
 * `source` it produced) bypass the wait: settling those would leave the
 * preview's accepted document behind the real source, and an edit in that
 * window would surface as a spurious conflict draft. The echo is state, so the
 * comparison is a render-safe read that batches with the source write.
 */
export function useSettledPreviewText(source: string, text: string, resetKey: string) {
  const policy = markdownPreviewSyncPolicy(text.length);
  const { publicationIdleMs: idleMs, publicationMaxMs: maxMs } = policy;
  const [echo, markEcho] = useState<string | null>(null);
  const immediate = source === echo;
  const [settled, setSettled] = useState(text);
  const [settledKey, setSettledKey] = useState(resetKey);
  const latestTextRef = useRef(text);
  const maxTimerRef = useRef<number | null>(null);

  // Another file, or the preview's own echo, lands in the same commit as its
  // source: adjusting state during render keeps any frame from seeing stale text.
  if (settledKey !== resetKey || (immediate && settled !== text)) {
    setSettledKey(resetKey);
    setSettled(text);
  }

  useEffect(() => {
    // The max timer outlives the commit that armed it and publishes the newest document.
    latestTextRef.current = text;
    if (settled === text) {
      clearTimer(maxTimerRef);
      return;
    }
    const publish = () => {
      clearTimer(maxTimerRef);
      setSettled(latestTextRef.current);
    };
    // Armed once per burst so continuous typing cannot starve the preview.
    if (maxTimerRef.current == null) maxTimerRef.current = window.setTimeout(publish, maxMs);
    const idle = setTimeout(publish, idleMs);
    return () => clearTimeout(idle);
  }, [idleMs, maxMs, settled, text]);

  useEffect(() => () => clearTimer(maxTimerRef), []);

  return { settled, markEcho, policy };
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

/** The single replacement turning `previous` into `next`, shifted by `offset`: shared prefix and suffix stay put. */
export function minimalTextChange(previous: string, next: string, offset: number) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  const suffixLimit = Math.min(previous.length, next.length) - prefix;
  let suffix = 0;
  while (suffix < suffixLimit && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;
  return { from: offset + prefix, to: offset + previous.length - suffix, insert: next.slice(prefix, next.length - suffix) };
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

/**
 * Map `value` from one pane's scroll space into the other's through the
 * monotonic anchor `pairs`, interpolating linearly between neighbouring anchors
 * and the two ends of each range.
 */
export function interpolateScrollAnchors(
  value: number, pairs: Array<{ from: number; to: number }>, fromMin: number, fromMax: number, toMin: number, toMax: number,
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
  const firstInterior = Math.max(bound(fromMin, "from", true), bound(toMin, "to", true));
  const afterInterior = Math.min(bound(fromMax, "from", false, firstInterior), bound(toMax, "to", false, firstInterior));
  const insertion = bound(value, "from", false, firstInterior, afterInterior);
  const lower = insertion > firstInterior ? pairs[insertion - 1] : { from: fromMin, to: toMin };
  const upper = insertion < afterInterior ? pairs[insertion] : { from: fromMax, to: toMax };
  const span = upper.from - lower.from;
  const progress = span > 0 ? (value - lower.from) / span : 0;
  return clamp(lower.to + progress * (upper.to - lower.to), toMin, toMax);
}

export type ViewportSnapshot = { scrollTop: number; scrollRange: number };

/**
 * The top-level block at the top of a visual Markdown viewport, by its index
 * in the document, how far its top sits from the viewport's, and its height
 * (so a block rewrapped to another height keeps the same share above).
 *
 * A pixel offset does not survive a change of layout. The same Paper is drawn
 * by its full reader (with a masthead, figures loaded as they were scrolled
 * past) and by Trellis's read-only snapshot beside the notes (without either,
 * often at another width), so one offset lands sections apart in the other. A
 * long read-only document is drawn as passive chunks, of which only those near
 * the viewport hold blocks; each chunk carries the index of its first block.
 */
export type PreviewAnchor = NonNullable<VisualMarkdownViewState["anchor"]>;

export type PreviewViewportSnapshot = ViewportSnapshot & { anchor?: PreviewAnchor };

export type MarkdownModeViewportHandoff = {
  path: string;
  mode: CanvasMode;
  source?: ViewportSnapshot;
  preview?: PreviewViewportSnapshot;
};

/** How far `scroller` (or a report of its metrics) can scroll vertically. */
export const scrollRange = (scroller: { scrollHeight: number; clientHeight: number }) => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
/** How far a source editor scrolls before its text ends: its range without the scroll-past-end padding. */
export const sourceScrollRange = (view: EditorView) => Math.max(0, scrollRange(view.scrollDOM) - view.documentPadding.bottom);

/** A preview block labelled with the `[from, to)` preview-text range it renders. */
export type SourceAnchor = { from: number; to: number; element: HTMLElement };

export function sourceAnchors(preview: HTMLElement): SourceAnchor[] {
  return Array.from(preview.querySelectorAll<HTMLElement>("[data-source-offset]")).flatMap((element) => {
    const from = Number(element.dataset.sourceOffset);
    const to = Number(element.dataset.sourceEndOffset);
    return Number.isFinite(from) && Number.isFinite(to) ? [{ from, to, element }] : [];
  });
}

/** The vertical centre, in `view`'s document coordinates, of the source lines behind `anchor`. */
export function sourceAnchorCenter(view: EditorView, previewStart: number, anchor: { from: number; to: number }) {
  const length = view.state.doc.length;
  const from = clamp(previewStart + anchor.from, 0, length);
  const to = clamp(previewStart + Math.max(anchor.from, anchor.to - 1), from, length);
  return (view.lineBlockAt(from).top + view.lineBlockAt(to).bottom) / 2;
}

export function captureViewport(viewport: HTMLElement, range = scrollRange(viewport)): ViewportSnapshot {
  return { scrollTop: viewport.scrollTop, scrollRange: range };
}

const CHUNK = "[data-visual-chunk-first]";

const chunkFirst = (chunk: HTMLElement) => Number(chunk.dataset.visualChunkFirst);

/** A drawn chunk's (or the whole editor's) top-level blocks: the outermost ProseMirror's children. */
const blocksIn = (root: ParentNode) => root.querySelector(".ProseMirror")?.children;

/** The first of `elements` (in vertical order) whose bottom is below `top`; their length when none is. */
function firstReaching(elements: ArrayLike<Element>, top: number) {
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (elements[middle]!.getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The block at the top of `viewport`, or undefined while none is drawn there. */
function capturePreviewAnchor(viewport: HTMLElement): PreviewAnchor | undefined {
  const top = viewport.getBoundingClientRect().top;
  const chunks = viewport.querySelectorAll<HTMLElement>(CHUNK);
  const chunk = chunks.length ? chunks[firstReaching(chunks, top)] : null;
  if (chunks.length && !chunk) return undefined;
  const blocks = blocksIn(chunk ?? viewport);
  if (!blocks?.length) return undefined;
  const index = firstReaching(blocks, top);
  const block = blocks[index];
  if (!block) return undefined;
  const rect = block.getBoundingClientRect();
  return { block: (chunk ? chunkFirst(chunk) : 0) + index, top: rect.top - top, height: rect.height };
}

export function capturePreviewViewport(viewport: HTMLElement): PreviewViewportSnapshot {
  return { ...captureViewport(viewport), anchor: capturePreviewAnchor(viewport) };
}

export function restoreViewport(viewport: HTMLElement, snapshot: ViewportSnapshot, targetRange = scrollRange(viewport)): boolean {
  viewport.scrollTop = snapshot.scrollRange > 0 && targetRange > 0
    ? (snapshot.scrollTop / snapshot.scrollRange) * targetRange
    : snapshot.scrollTop;
  return snapshot.scrollTop <= 0 || snapshot.scrollRange <= 0 || targetRange > 0;
}

/**
 * Scroll `viewport` so `anchor`'s block sits where it was. False until that
 * block is drawn and in place: a passive chunk draws only once it is near the
 * viewport, so the caller tries again on a later frame.
 */
export function restorePreviewAnchor(viewport: HTMLElement, anchor: PreviewAnchor): boolean {
  const top = viewport.getBoundingClientRect().top;
  const chunks = viewport.querySelectorAll<HTMLElement>(CHUNK);
  let block: Element | undefined;
  if (chunks.length) {
    let chunk: HTMLElement | undefined;
    for (const candidate of chunks) {
      if (chunkFirst(candidate) > anchor.block) break;
      chunk = candidate;
    }
    if (!chunk) return false;
    block = blocksIn(chunk)?.[anchor.block - chunkFirst(chunk)];
    if (!block) {
      // Bring the chunk to the viewport, which draws it.
      viewport.scrollTop += chunk.getBoundingClientRect().top - top;
      return false;
    }
  } else {
    block = blocksIn(viewport)?.[anchor.block];
    if (!block) return false;
  }
  // The block straddling the top may have rewrapped (another width): the
  // same share of it stays above the viewport, so the line read stays put.
  const rect = block.getBoundingClientRect();
  const share = anchor.top < 0 && anchor.height && rect.height ? rect.height / anchor.height : 1;
  const offset = rect.top - top - anchor.top * share;
  if (Math.abs(offset) < 1) return true;
  const before = viewport.scrollTop;
  viewport.scrollTop = before + offset;
  // At either end of the range the block cannot move any further.
  return viewport.scrollTop === before;
}

/** The saved block back in place when there is one, else the saved share of the scroll range. */
export function restorePreviewViewport(viewport: HTMLElement, snapshot: PreviewViewportSnapshot): boolean {
  return snapshot.anchor ? restorePreviewAnchor(viewport, snapshot.anchor) : restoreViewport(viewport, snapshot);
}
