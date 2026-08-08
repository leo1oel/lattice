/* Local seam — not upstream code.
 *
 * Upstream `@/lib/perf` is a full observability module (collector, HDR
 * histograms, web vitals). Vendored editor files only need `mark`, so this
 * seam implements the upstream `MarkFn` surface (callable + `.count` +
 * `.histogram`, see packages/app/src/lib/perf/mark.ts) as a thin
 * `performance.measure` wrapper. Marks land in the DevTools Performance
 * panel; counters and histograms are no-ops here.
 */

interface MarkOptions {
  /** Explicit start time (defaults to performance.now() at call time). */
  startTime?: number;
  /** Duration in ms. If omitted, a zero-duration marker is emitted. */
  duration?: number;
  /** Override tooltip. */
  tooltipText?: string;
}

export interface MarkFn {
  (name: string, props?: Record<string, unknown>, opts?: MarkOptions): void;
  count(name: string, props?: Record<string, string | number | boolean>): void;
  histogram(
    name: string,
    props: Record<string, string | number | boolean>,
    durationMs: number,
  ): void;
}

function markImpl(name: string, props?: Record<string, unknown>, opts?: MarkOptions): void {
  if (typeof performance === "undefined" || !performance.measure) return;
  try {
    const now = performance.now();
    const start = opts?.startTime ?? now;
    performance.measure(name, {
      start,
      duration: opts?.duration ?? Math.max(0, now - start),
      detail: props ? { props } : undefined,
    });
  } catch {
    // Measurement must never break the feature it observes.
  }
}

export const mark: MarkFn = Object.assign(markImpl, {
  count: () => undefined,
  histogram: () => undefined,
});
