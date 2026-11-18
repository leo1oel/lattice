/* eslint-disable lingui/no-unlocalized-strings -- test-only code: the page text and links the suites query by, not interface copy */
/**
 * Just enough of PDFSlick for the viewer's tests: pages with text and
 * annotation layers, events, find, zoom and staged readiness, and the state a
 * test steers them with. Wire it up from the test file with async `vi.mock`
 * factories:
 *
 *   vi.mock("@pdfslick/core", async () => ({ PDFSlick: (await import("./pdf-slick-test-mocks")).pdf.PdfSlickMock }));
 */
import { vi } from "vitest";

export type Destination = { page: number; scrollTop: number; scrollLeft: number; scaleValue?: string };
export type LoadProgress = { loaded: number; total: number; percent: number };
export type PageView = { div: HTMLDivElement; textLayer: { div: HTMLDivElement }; viewport: { scale: number } };

export const pdf = (() => {
  const state = {
    instances: [] as PdfSlickMock[],
    numPages: 3,
    viewportScale: 1,
    deferLoad: false,
    loadError: null as Error | null,
    deferReady: false,
    pendingLoad: null as null | { onProgress?: (progress: LoadProgress) => void; resolve: () => void },
    hosted: false,
    workerOptions: {} as { workerSrc?: string },
  };

  /** Just enough of PDFSlick: pages with text/annotation layers, events, find, zoom, and staged readiness. */
  class PdfSlickMock {
    l10n = { get: vi.fn(async (id: string) => id) };
    unbindEvents = vi.fn();
    document: {
      numPages: number;
      getData: () => Promise<Uint8Array>;
      loadingTask: { destroy: ReturnType<typeof vi.fn> };
    } | null = null;
    loadingTask: { destroy: ReturnType<typeof vi.fn> } | null = null;
    pageViews: PageView[] = [];
    handlers = new Map<string, Array<(event: object) => void>>();
    readyListeners = new Set<() => void>();
    pagesReady = false;
    findIndex = 0;
    findMatches = { current: 0, total: 0 };
    findTimer: number | undefined;
    store = {
      getState: () => ({ pagesReady: this.pagesReady }),
      subscribe: (listener: () => void) => {
        this.readyListeners.add(listener);
        return () => this.readyListeners.delete(listener);
      },
    };
    args: { container: HTMLDivElement; viewer: HTMLDivElement; options: Record<string, unknown> };
    viewer: {
      cleanup: ReturnType<typeof vi.fn>;
      setDocument: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      currentScale: number;
      currentScaleValue: string;
      getPageView: (index: number) => PageView;
      getCachedPageViews: () => Set<PageView>;
      pageWindowMinScale?: number;
    };
    linkService: {
      page: number;
      goToDestination: (destination: Destination) => Promise<void>;
      setDocument: ReturnType<typeof vi.fn>;
    };
    gotoPage = vi.fn((page: number) => {
      this.linkService.page = page;
      this.args.container.scrollTop = (page - 1) * 1_000;
      this.emit("pagechanging", { pageNumber: page });
    });

    constructor(args: PdfSlickMock["args"]) {
      this.args = args;
      let currentScale = Number(args.options.scaleValue) || 0.75;
      let currentScaleValue = String(args.options.scaleValue ?? "page-width");
      const emit = (name: string, event: object) => queueMicrotask(() => this.emit(name, event));
      this.viewer = {
        cleanup: vi.fn(),
        // PDF.js empties the viewer element when the document is detached.
        setDocument: vi.fn((pdfDocument: unknown) => {
          if (pdfDocument === null) args.viewer.textContent = "";
        }),
        update: vi.fn(),
        get currentScale() {
          return currentScale;
        },
        set currentScale(value: number) {
          currentScale = value;
          emit("scalechanging", { scale: value });
        },
        get currentScaleValue() {
          return currentScaleValue;
        },
        set currentScaleValue(value: string) {
          currentScaleValue = value;
          const preset = value === "page-fit" || value === "page-width" ? value : undefined;
          currentScale = value === "page-fit" ? 0.6 : value === "page-width" ? 0.75 : Number(value);
          emit("scalechanging", { scale: currentScale, presetValue: preset });
        },
        getPageView: (index: number) => this.pageViews[index]!,
        getCachedPageViews: () => new Set(this.pageViews),
      };
      this.linkService = {
        page: 1,
        goToDestination: vi.fn(async (destination: Destination) => {
          this.linkService.page = destination.page;
          if (destination.scaleValue) this.viewer.currentScaleValue = destination.scaleValue;
          args.container.scrollTop = destination.scrollTop;
          args.container.scrollLeft = destination.scrollLeft;
          this.emit("pagechanging", { pageNumber: destination.page });
        }),
        setDocument: vi.fn(),
      };
      state.instances.push(this);
    }

    // Find events follow PDF.js's contract (pinned in pdf-find-events.test.ts):
    // the running total arrives through updatefindmatchescount, a moved
    // selection only through updatefindcontrolstate, every search first
    // reports the previous selection as pending (state 3) and a fresh one
    // runs after a delay, and closing the find bar re-reports the closed
    // query's count (state 0) after a tick.
    dispatch = vi.fn((name: string, event: Record<string, unknown>) => {
      if (name !== "find" && name !== "findbarclose") return;
      window.clearTimeout(this.findTimer);
      if (name === "findbarclose") {
        const stale = this.findMatches;
        void Promise.resolve().then(() => this.emit("updatefindcontrolstate", { state: 0, matchesCount: stale }));
        for (const page of this.pageViews) page.div.querySelectorAll(".highlight").forEach((node) => node.remove());
        return;
      }
      this.emit("updatefindcontrolstate", { state: 3, matchesCount: this.findMatches });
      const again = event.type === "again";
      const search = () => {
        const query = String(event.query ?? "").toLocaleLowerCase();
        const matches = this.pageViews.filter((page) => (page.div.textContent ?? "").toLocaleLowerCase().includes(query));
        this.findIndex = again && matches.length
          ? (this.findIndex + (event.findPrevious ? -1 : 1) + matches.length) % matches.length
          : 0;
        for (const page of this.pageViews) page.div.querySelectorAll(".highlight").forEach((node) => node.remove());
        for (const [index, page] of matches.entries()) {
          const highlight = document.createElement("span");
          highlight.className = `highlight${index === this.findIndex ? " selected" : ""}`;
          highlight.textContent = query;
          page.div.querySelector(".textLayer")?.append(highlight);
        }
        this.findMatches = { current: matches.length ? this.findIndex + 1 : 0, total: matches.length };
        if (again) {
          this.emit("updatefindcontrolstate", { state: 0, matchesCount: this.findMatches });
          return;
        }
        // A fresh search reports finding its first match before counting pages.
        this.emit("updatefindcontrolstate", { state: 0, matchesCount: { current: 0, total: 0 } });
        this.emit("updatefindmatchescount", { matchesCount: this.findMatches });
      };
      if (again) search();
      else this.findTimer = window.setTimeout(search, 0);
    });

    loadDocument = vi.fn(async (_source: string | ArrayBuffer, options?: { onProgress?: (progress: LoadProgress) => void }) => {
      const loadingTask = { destroy: vi.fn(async () => undefined) };
      this.loadingTask = loadingTask;
      if (state.deferLoad) {
        await new Promise<void>((resolve) => {
          state.pendingLoad = { onProgress: options?.onProgress, resolve };
        });
      }
      if (state.loadError) throw state.loadError;
      this.document = {
        numPages: state.numPages,
        getData: async () => new Uint8Array([1, 2, 3]),
        loadingTask,
      };
      for (let pageNumber = 1; pageNumber <= state.numPages; pageNumber += 1) {
        const page = document.createElement("div");
        page.className = "page";
        page.dataset.pageNumber = String(pageNumber);
        page.innerHTML = `<canvas></canvas><div class="textLayer"><span>Attention is all you need — page ${pageNumber}</span></div>`
          + `<div class="annotationLayer"><a href="https://example.com/paper" target="_blank" rel="noopener noreferrer nofollow"`
          + ` title="https://example.com/paper"></a><a href="#page=3" class="internalLink" title="Jump to PDF page 3"></a></div>`;
        page.querySelector<HTMLAnchorElement>(".internalLink")!.onclick = () => {
          void this.linkService.goToDestination({ page: 3, scrollTop: 1_200, scrollLeft: 24, scaleValue: "1.5" });
          return false;
        };
        this.args.viewer.append(page);
        const textLayer = page.querySelector<HTMLDivElement>(".textLayer")!;
        this.pageViews.push({ div: page, textLayer: { div: textLayer }, viewport: { scale: state.viewportScale } });
      }
      this.emit("pagesinit", {});
      if (!state.deferReady) this.finishReady();
      this.emit("pagerendered", { pageNumber: 1 });
      for (let pageNumber = 1; pageNumber <= state.numPages; pageNumber += 1) this.emit("textlayerrendered", { pageNumber });
    });

    finishReady() {
      // PDFSlick applies its initial scale after awaiting getOutline().
      this.args.container.scrollTop = 0;
      this.pagesReady = true;
      this.readyListeners.forEach((listener) => listener());
    }

    on(name: string, listener: (event: object) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), listener]);
    }

    emit(name: string, event: object) {
      for (const listener of this.handlers.get(name) ?? []) listener(event);
    }
  }

  return { state, PdfSlickMock };
})();
