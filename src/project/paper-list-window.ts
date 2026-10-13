/**
 * A long Papers list draws only the papers near the view. With every row
 * mounted, a library of 600 papers was 28k elements and 19k component
 * renders: it held WebKit's first paint back by 620 ms, and every keystroke
 * in the search box that showed the whole list again took 330 ms.
 *
 * Rows are as tall as their titles and notices make them, so each row is
 * measured once drawn and an undrawn one is assumed as tall as the drawn ones
 * on average. The rows not drawn stand as gaps of those heights, so the
 * scroll extent and the scrollbar are the whole list's. The window moves
 * before the view reaches the edge of what is drawn, and the row at the top
 * of the view is held where it was while rows above it are drawn or measured
 * (the browser's own scroll anchoring is off, since WebKit has none). The row
 * holding the keyboard stays drawn wherever the view scrolls, and a key that
 * moves to a row not drawn draws it first.
 *
 * A short list (and one without layout, as in tests) is drawn whole.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** A list of fewer papers is drawn whole. */
export const PAPER_WINDOW_MIN = 120;
/** Rows drawn before the view has been measured. */
const FIRST_ROWS = 40;
/** A row is assumed this tall until rows of the list have been measured. */
const ASSUMED_ROW = 64;
/** Rows are drawn this many view heights beyond each edge of the view… */
const KEEP_VIEWS = 1;
/** …and the window moves once fewer than this many remain drawn beyond an edge. */
const LEAD_VIEWS = 0.25;

/** Rows `from`…`to` (exclusive), in the order the list shows them. */
export type RowSpan = { from: number; to: number };

export type PaperListWindow = {
  /** Whether the list draws only some of its rows. */
  active: boolean;
  /** The rows to draw, in order and apart. */
  drawn: readonly RowSpan[];
  /**
   * The height of a gap standing for rows `span`: their heights and the
   * margins between them, and the one above the first unless it starts its
   * group. The row drawn after a gap keeps its own margin (app-shell.css).
   */
  gapHeight: (span: RowSpan) => number;
  /** Each drawn row's ref (the row carries `data-paper-key`): measures it. */
  observeRow: (row: HTMLElement | null) => (() => void) | undefined;
  /** Draw row `index` if it is not, then hand it to `then` (to focus a control in it). */
  reveal: (index: number, then: (row: HTMLElement) => void) => void;
  /** The drawn row of `key`, if it is drawn. */
  rowOf: (key: string) => HTMLElement | null;
};

/**
 * The rows measured so far by key and their sum, and the margin between two
 * rows. A row is measured again whenever its size changes while drawn (a
 * narrower panel wraps its title); one not drawn keeps its last height.
 */
type Measures = { heights: ReadonlyMap<string, number>; total: number; gap: number };

const NO_MEASURES: Measures = { heights: new Map(), total: 0, gap: Number.NaN };

const layoutAvailable = () => typeof ResizeObserver !== "undefined" && typeof IntersectionObserver !== "undefined";

/** Row `index`'s height, with the margin that parts it from the row above unless it starts a group. */
function slot(measures: Measures, keys: readonly string[], starts: ReadonlySet<number>, index: number) {
  const { heights, total, gap } = measures;
  const height = heights.get(keys[index]!) ?? (heights.size ? total / heights.size : ASSUMED_ROW);
  return starts.has(index) ? height : height + (Number.isNaN(gap) ? 0 : gap);
}

/** The drawn row of `key` under `root`, if it is drawn. */
function drawnRow(root: ParentNode | null | undefined, key: string): HTMLElement | null {
  for (const row of root?.querySelectorAll<HTMLElement>(".paper-row[data-paper-key]") ?? []) {
    if (row.dataset.paperKey === key) return row;
  }
  return null;
}

/**
 * The window over `keys` (every paper's key, in the list's order) drawn in the
 * scroller `viewportRef`; `groupStarts` holds the index each group starts at.
 * Each group's list carries `data-paper-rows-from` and `-to`, its rows' range.
 */
export function usePaperListWindow(
  viewportRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  groupStarts: readonly number[],
): PaperListWindow {
  const count = keys.length;
  const active = count >= PAPER_WINDOW_MIN && layoutAvailable();
  const [range, setRange] = useState<RowSpan>({ from: 0, to: FIRST_ROWS });
  const [measures, setMeasures] = useState(NO_MEASURES);
  // The row the keyboard is in, by key: it stays drawn.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // What the handlers below read between renders, as of the last commit.
  const latestRef = useRef({ keys, measures, range });
  // The row held still across the next commit, or the end when the view was at it.
  const anchorRef = useRef<{ key: string; top: number } | "end" | null>(null);
  const pendingRef = useRef<{ key: string; then: (row: HTMLElement) => void } | null>(null);

  /** Keep the first row in view where it is on screen across the next commit. */
  const holdAnchor = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || anchorRef.current) return;
    // A view scrolled to the end (the scrollbar dragged down) stays there.
    if (viewport.scrollTop > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
      anchorRef.current = "end";
      return;
    }
    const top = viewport.getBoundingClientRect().top;
    for (const row of viewport.querySelectorAll<HTMLElement>(".paper-row[data-paper-key]")) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) {
        anchorRef.current = { key: row.dataset.paperKey!, top: box.top };
        return;
      }
    }
  }, [viewportRef]);

  /** Take the heights of rows just drawn, or redrawn at a new size. */
  const measureRows = useCallback((entries: ResizeObserverEntry[]) => {
    const changes = new Map<string, number>();
    let gap = Number.NaN;
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      const key = row.dataset.paperKey;
      if (!key || !row.isConnected) continue;
      changes.set(key, entry.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight);
      if (Number.isNaN(gap) && row.previousElementSibling?.classList.contains("paper-row")) {
        gap = Number.parseFloat(getComputedStyle(row).marginTop) || 0;
      }
    }
    const { measures: current } = latestRef.current;
    const moved = [...changes].some(([key, height]) => current.heights.get(key) !== height);
    if (!moved && (Number.isNaN(gap) || !Number.isNaN(current.gap))) return;
    holdAnchor();
    setMeasures((previous) => {
      const heights = new Map(previous.heights);
      let total = previous.total;
      for (const [key, height] of changes) {
        total += height - (heights.get(key) ?? 0);
        heights.set(key, height);
      }
      return { ...previous, heights, total, gap: Number.isNaN(previous.gap) ? gap : previous.gap };
    });
  }, [holdAnchor]);
  const observerRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => () => observerRef.current?.disconnect(), []);
  const observeRow = useCallback((row: HTMLElement | null) => {
    if (!row || !layoutAvailable()) return undefined;
    if (!observerRef.current) observerRef.current = new ResizeObserver(measureRows);
    const observer = observerRef.current;
    observer.observe(row);
    return () => observer.unobserve(row);
  }, [measureRows]);

  /** Move the window if the view, with some lead, is not all drawn, or far more than it is. */
  const check = useCallback(() => {
    const viewport = viewportRef.current;
    const height = viewport?.clientHeight ?? 0;
    if (!viewport || !height) return;
    const { keys: list, measures: measured, range: current } = latestRef.current;
    const box = viewport.getBoundingClientRect();
    const groups = viewport.querySelectorAll<HTMLElement>("[data-paper-rows-from]");
    const starts = new Set([...groups].map((group) => Number(group.dataset.paperRowsFrom)));
    const lead = height * LEAD_VIEWS;
    const keep = height * KEEP_VIEWS;
    const needed = { from: -1, to: -1 };
    const next = { from: -1, to: -1 };
    for (const group of groups) {
      const groupBox = group.getBoundingClientRect();
      if (groupBox.bottom - box.top < -keep) continue;
      if (groupBox.top - box.top > height + keep) break;
      let top = groupBox.top - box.top;
      for (let index = Number(group.dataset.paperRowsFrom); index < Number(group.dataset.paperRowsTo); index += 1) {
        const bottom = top + slot(measured, list, starts, index);
        if (bottom > -keep && top < height + keep) {
          if (next.from < 0) next.from = index;
          next.to = index + 1;
        }
        if (bottom > -lead && top < height + lead) {
          if (needed.from < 0) needed.from = index;
          needed.to = index + 1;
        }
        top = bottom;
      }
    }
    if (next.from < 0) {
      // The rows assumed so far put none in view (a jump far past what has
      // been measured): draw those about where the view is in the list.
      const group = [...groups].find((candidate) => {
        const groupBox = candidate.getBoundingClientRect();
        return groupBox.bottom > box.top && groupBox.top < box.bottom;
      });
      if (!group) return;
      const groupBox = group.getBoundingClientRect();
      const from = Number(group.dataset.paperRowsFrom);
      const to = Number(group.dataset.paperRowsTo);
      const at = from + Math.round((to - from) * Math.min(1, Math.max(0, (box.top + height / 2 - groupBox.top) / groupBox.height)));
      next.from = Math.max(from, at - FIRST_ROWS / 2);
      next.to = Math.min(to, next.from + FIRST_ROWS);
      needed.from = next.from;
      needed.to = next.to;
    }
    const covered = needed.from >= current.from && needed.to <= Math.min(current.to, list.length);
    const oversized = current.to - current.from > 3 * (next.to - next.from) + FIRST_ROWS;
    if (covered && !oversized) return;
    holdAnchor();
    latestRef.current.range = next;
    setRange(next);
  }, [holdAnchor, viewportRef]);

  // Follow the view while the window is on: scrolling, resizing, and focus.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !viewport) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        check();
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    viewport.addEventListener("scroll", schedule, { passive: true });
    const focusIn = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>(".paper-row[data-paper-key]");
      setFocusKey(row?.dataset.paperKey ?? null);
    };
    const focusOut = (event: FocusEvent) => {
      if (!viewport.contains(event.relatedTarget as Node | null)) setFocusKey(null);
    };
    viewport.addEventListener("focusin", focusIn);
    viewport.addEventListener("focusout", focusOut);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener("scroll", schedule);
      viewport.removeEventListener("focusin", focusIn);
      viewport.removeEventListener("focusout", focusOut);
    };
  }, [active, check, viewportRef]);

  // After every commit: keep the anchored row still, hand a revealed row
  // over, and check the window against a list that may have changed.
  useLayoutEffect(() => {
    latestRef.current = { keys, measures, range };
    const viewport = viewportRef.current;
    if (!active || !viewport) return;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const anchored = anchor && anchor !== "end" && drawnRow(viewport, anchor.key);
    if (anchor === "end") viewport.scrollTop = viewport.scrollHeight;
    else if (anchor && anchored) {
      const shift = anchored.getBoundingClientRect().top - anchor.top;
      if (Math.abs(shift) >= 0.5) viewport.scrollTop += shift;
    }
    const pending = pendingRef.current;
    const revealed = pending && drawnRow(viewport, pending.key);
    if (pending && revealed) {
      pendingRef.current = null;
      pending.then(revealed);
    }
    check();
  });

  const reveal = (index: number, then: (row: HTMLElement) => void) => {
    const key = keys[index];
    if (key === undefined) return;
    const row = drawnRow(viewportRef.current, key);
    if (row) {
      then(row);
      return;
    }
    pendingRef.current = { key, then };
    const from = Math.max(0, Math.min(index - FIRST_ROWS / 2, count - FIRST_ROWS));
    const next = { from, to: Math.min(count, from + FIRST_ROWS) };
    latestRef.current.range = next;
    setRange(next);
  };

  const rowOf = (key: string) => drawnRow(viewportRef.current, key);

  if (!active) return { active, drawn: [{ from: 0, to: count }], gapHeight: () => 0, observeRow, reveal, rowOf };
  const shown = { from: Math.min(range.from, count), to: Math.min(range.to, count) };
  const focused = focusKey === null ? -1 : keys.indexOf(focusKey);
  const drawn: RowSpan[] = focused >= 0 && (focused < shown.from || focused >= shown.to)
    ? [{ from: focused, to: focused + 1 }, shown].sort((a, b) => a.from - b.from)
    : [shown];
  const starts = new Set(groupStarts);
  const gapHeight = (span: RowSpan) => {
    let height = 0;
    for (let index = span.from; index < span.to; index += 1) height += slot(measures, keys, starts, index);
    return height;
  };
  return { active, drawn, gapHeight, observeRow, reveal, rowOf };
}
