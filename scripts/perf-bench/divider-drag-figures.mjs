/**
 * The figures divider-drag-timing.mjs reports for each drag, shared with
 * scripts/check-perf-evidence.mjs, which recomputes docs/performance.md's
 * divider-drag table from the retained runs with these same definitions.
 */

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The value at fraction `p` of the sorted values (the 95th percentile at 0.95). */
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/**
 * Whether Playwright's WebKit paced the drag at the display's 60 Hz: now and
 * then, on a busy machine, it paces a page at 30 Hz for a while, which
 * doubles every interval whatever the page does. A paced drag's intervals
 * are left out (null); its work per frame still counts.
 */
const at60 = (run) => median(run.frames) < 25;

/** Each figure of a drag by name, in the order the driver prints them; null where it does not apply. */
export const FIGURES = {
  "frame median ms": (run) => (at60(run) ? median(run.frames) : null),
  "frame p95 ms": (run) => (at60(run) ? quantile(run.frames, 0.95) : null),
  "work median ms": (run) => median(run.work),
  "work p95 ms": (run) => quantile(run.work, 0.95),
  "pointer moves": (run) => run.moves,
  "resize cursor %": (run) => (100 * run.resizeCursorFrames) / run.cursorFrames,
};

/** One figure of one drag: a number, or null (intervals of a drag paced at 30 Hz). */
export function readFigure(run, name) {
  const read = FIGURES[name];
  if (!read) throw new Error(`divider-drag-timing has no figure "${name}"`);
  return read(run);
}
