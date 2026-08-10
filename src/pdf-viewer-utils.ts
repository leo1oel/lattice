export type PdfSearchMatch = {
  page: number;
  occurrence: number;
};

/** Copied from pdfjs-dist into public/pdfjs by the Vite pdfjs-assets plugin. */
function pdfAssetUrl(relative: string): string {
  try {
    return new URL(`${import.meta.env.BASE_URL}${relative}`, window.location.href).href;
  } catch {
    return `${import.meta.env.BASE_URL}${relative}`;
  }
}

/** Shared by every getDocument() call so previews and the viewer agree on fonts. */
export const PDF_CMAP_URL = pdfAssetUrl("pdfjs/cmaps/");
export const PDF_STANDARD_FONT_DATA_URL = pdfAssetUrl("pdfjs/standard_fonts/");

/** Normalize a browser text selection from the PDF text layer for agent context. */
export function normalizePdfSelection(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function findPdfMatches(pageTexts: string[], rawQuery: string): PdfSearchMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: PdfSearchMatch[] = [];
  pageTexts.forEach((text, pageIndex) => {
    const haystack = text.toLocaleLowerCase();
    let from = 0;
    let occurrence = 0;
    while (from <= haystack.length - query.length) {
      const index = haystack.indexOf(query, from);
      if (index < 0) break;
      matches.push({ page: pageIndex + 1, occurrence });
      occurrence += 1;
      from = index + Math.max(1, query.length);
    }
  });
  return matches;
}

export function annotationBounds(rect: number[], scale: number) {
  if (rect.length !== 4 || !rect.every(Number.isFinite) || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const [x1, y1, x2, y2] = rect;
  return {
    left: Math.min(x1, x2) * scale,
    top: Math.min(y1, y2) * scale,
    width: Math.abs(x2 - x1) * scale,
    height: Math.abs(y2 - y1) * scale,
  };
}

export type PdfPageSize = { width: number; height: number };

export type PdfPageRect = { top: number; bottom: number };

/** Find the first closest ordered page shell, preserving document-order ties. */
export function closestPdfPageIndex(
  pageCount: number,
  getRect: (index: number) => PdfPageRect,
  marker: number,
): number {
  if (pageCount <= 0) return -1;
  let low = 0;
  let high = pageCount;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (getRect(middle).bottom < marker) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === pageCount) return pageCount - 1;
  const previous = getRect(low - 1);
  const next = getRect(low);
  const previousDistance = Math.max(0, marker - previous.bottom);
  const nextDistance = Math.max(0, next.top - marker);
  return previousDistance <= nextDistance ? low - 1 : low;
}

export const PDF_MIN_SCALE = 0.3;
export const PDF_MAX_SCALE = 5;
export const PDF_RENDER_CACHE_SIZE = 10;
export const PDF_MAX_CANVAS_PIXELS = 2 ** 24;
const PDF_MAX_CONCURRENT_RENDERS = 2;

export const PDF_RENDER_PRIORITY = {
  cached: 0,
  nearby: 1,
  current: 2,
} as const;

type PdfRenderJob = {
  cancelled: boolean;
  order: number;
  priority: number;
  started: boolean;
  run: () => Promise<void>;
};

type PdfCooperativeRenderJob = {
  cancelled: boolean;
  continuation: (() => void) | null;
  order: number;
  priority: number;
  run: (onContinue: (continuation: () => void) => void) => Promise<void>;
  state: "pending" | "running" | "paused" | "finished";
};

export type PdfRenderCancellation = (() => void) & {
  prioritize: () => void;
  setPriority: (priority: number) => void;
};

/** Bound PDF.js worker pressure and put visible pages ahead of cached pages. */
export class PdfRenderQueue {
  private active = 0;
  private nextOrder = 0;
  private readonly pending: PdfRenderJob[] = [];

  constructor(private readonly maxConcurrent = PDF_MAX_CONCURRENT_RENDERS) {}

  enqueue(
    run: () => Promise<void>,
    priority: number = PDF_RENDER_PRIORITY.cached,
  ): PdfRenderCancellation {
    const job = {
      cancelled: false,
      order: this.nextOrder,
      priority,
      started: false,
      run,
    };
    this.nextOrder += 1;
    this.insert(job);
    this.drain();
    const cancel = (() => {
      job.cancelled = true;
    }) as PdfRenderCancellation;
    cancel.prioritize = () => {
      cancel.setPriority(Math.max(job.priority, PDF_RENDER_PRIORITY.nearby));
    };
    cancel.setPriority = (nextPriority) => {
      if (job.cancelled || job.started || job.priority === nextPriority) return;
      const currentIndex = this.pending.indexOf(job);
      if (currentIndex < 0) return;
      this.pending.splice(currentIndex, 1);
      job.priority = nextPriority;
      this.insert(job);
      this.drain();
    };
    return cancel;
  }

  private insert(job: PdfRenderJob) {
    const index = this.pending.findIndex((pending) => (
      pending.priority < job.priority
      || (pending.priority === job.priority && pending.order > job.order)
    ));
    this.pending.splice(index < 0 ? this.pending.length : index, 0, job);
  }

  private drain() {
    while (this.active < this.maxConcurrent) {
      const job = this.pending.shift();
      if (!job) return;
      if (job.cancelled) continue;
      job.started = true;
      this.active += 1;
      void job.run().finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

/**
 * Let the current page take over at PDF.js continuation boundaries without
 * cancelling partially painted background pages. Only one canvas advances at
 * a time; paused work resumes after every more important page is ready.
 */
export class PdfCooperativeRenderQueue {
  private current: PdfCooperativeRenderJob | null = null;
  private nextOrder = 0;
  private readonly jobs = new Set<PdfCooperativeRenderJob>();

  enqueue(
    run: PdfCooperativeRenderJob["run"],
    priority: number = PDF_RENDER_PRIORITY.cached,
  ): PdfRenderCancellation {
    const job: PdfCooperativeRenderJob = {
      cancelled: false,
      continuation: null,
      order: this.nextOrder,
      priority,
      run,
      state: "pending",
    };
    this.nextOrder += 1;
    this.jobs.add(job);
    this.dispatch();

    const cancel = (() => {
      if (job.cancelled || job.state === "finished") return;
      job.cancelled = true;
      job.continuation = null;
      if (job.state === "pending" || job.state === "paused") {
        job.state = "finished";
        this.jobs.delete(job);
        this.dispatch();
      }
    }) as PdfRenderCancellation;
    cancel.prioritize = () => {
      cancel.setPriority(Math.max(job.priority, PDF_RENDER_PRIORITY.nearby));
    };
    cancel.setPriority = (nextPriority) => {
      if (job.cancelled || job.state === "finished" || job.priority === nextPriority) return;
      job.priority = nextPriority;
      if (
        job.state === "running"
        && (!this.current || job.priority > this.current.priority)
      ) {
        this.current = job;
      }
      this.dispatch();
    };
    return cancel;
  }

  private highestRunnable(except: PdfCooperativeRenderJob | null = null) {
    let highest: PdfCooperativeRenderJob | null = null;
    for (const job of this.jobs) {
      if (
        job === except
        || job.cancelled
        || (job.state !== "pending" && job.state !== "paused")
      ) {
        continue;
      }
      if (
        !highest
        || job.priority > highest.priority
        || (job.priority === highest.priority && job.order < highest.order)
      ) {
        highest = job;
      }
    }
    return highest;
  }

  private dispatch() {
    const job = this.highestRunnable();
    if (!job) return;
    // A started PDF.js task may be waiting for operator-list data without
    // touching its canvas. Let a newly visible page begin immediately; the
    // displaced task will park itself at its next continuation boundary.
    if (this.current && job.priority <= this.current.priority) return;
    this.current = job;
    job.state = "running";
    if (job.continuation) {
      const continuation = job.continuation;
      job.continuation = null;
      continuation();
      return;
    }
    void job.run((continuation) => this.continueJob(job, continuation)).then(
      () => this.finish(job),
      () => this.finish(job),
    );
  }

  private continueJob(job: PdfCooperativeRenderJob, continuation: () => void) {
    if (job.cancelled || job.state === "finished") {
      continuation();
      return;
    }
    if (this.current && this.current !== job) {
      if (this.current.priority >= job.priority) {
        job.continuation = continuation;
        job.state = "paused";
        return;
      }
      this.current = job;
    }
    if (!this.current) this.current = job;
    const next = this.highestRunnable(job);
    if (this.current === job && next && next.priority > job.priority) {
      job.continuation = continuation;
      job.state = "paused";
      this.current = null;
      this.dispatch();
      return;
    }
    continuation();
  }

  private finish(job: PdfCooperativeRenderJob) {
    job.continuation = null;
    job.state = "finished";
    this.jobs.delete(job);
    if (this.current === job) this.current = null;
    this.dispatch();
  }
}

/**
 * Keep expensive rendered pages in recency order while protecting every page
 * near the viewport. Page shells remain mounted, so eviction does not disturb
 * continuous scrolling.
 */
export function updatePdfRenderCache(
  cachedPages: number[],
  nearbyPages: ReadonlySet<number>,
  page: number,
  isNearby: boolean,
  limit = PDF_RENDER_CACHE_SIZE,
): number[] {
  const next = cachedPages.filter((cached) => cached !== page);
  if (isNearby || cachedPages.includes(page)) next.push(page);
  while (next.length > limit) {
    const evict = next.findIndex((cached) => !nearbyPages.has(cached));
    if (evict < 0) break;
    next.splice(evict, 1);
  }
  return next;
}

/** Turn a directly entered percentage into the viewer's bounded scale. */
export function parsePdfZoomPercent(value: string): number | null {
  const percent = Number(value.trim().replace(/%$/, ""));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, Number((percent / 100).toFixed(3))));
}

/**
 * Canvas supersampling for pdf.js. Preview.app looks fine with Type1 Times;
 * WKWebView at devicePixelRatio=1 (common in VMs) needs extra scale or glyphs go soft.
 */
export function pdfRenderPixelRatio(
  devicePixelRatio = 1,
  page?: PdfPageSize,
  maxCanvasPixels = PDF_MAX_CANVAS_PIXELS,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Cap supersampling — 3× on large conference PDFs was freezing WKWebView.
  const preferred = dpr < 2 ? 2 : Math.min(Math.max(dpr, 2), 2.5);
  if (!page || !(page.width > 0) || !(page.height > 0) || !(maxCanvasPixels > 0)) {
    return preferred;
  }
  const areaLimit = Math.sqrt(maxCanvasPixels / (page.width * page.height));
  return Math.min(preferred, areaLimit);
}

/** Scale that fits a page into the scroll area (padding deducted). */
export function fitPdfScale(
  mode: "width" | "height",
  page: PdfPageSize,
  area: { width: number; height: number },
  padding = { x: 48, y: 40 },
  limits = { min: PDF_MIN_SCALE, max: PDF_MAX_SCALE },
): number {
  if (!(page.width > 0) || !(page.height > 0) || !(area.width > 0) || !(area.height > 0)) {
    return 1;
  }
  const availableWidth = Math.max(1, area.width - padding.x);
  const availableHeight = Math.max(1, area.height - padding.y);
  const raw = mode === "width"
    ? availableWidth / page.width
    : availableHeight / page.height;
  return Math.min(limits.max, Math.max(limits.min, Number(raw.toFixed(2))));
}
