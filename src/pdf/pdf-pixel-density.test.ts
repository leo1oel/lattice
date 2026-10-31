/**
 * Redrawing the PDF after the window moves to a display of another pixel
 * density (pdf-pixel-density.ts). jsdom has no displays: the window's
 * devicePixelRatio is set by hand, and matchMedia answers resolution queries
 * from it and reports a change to the queries whose answer it flipped, as a
 * browser does when the window crosses to the other display.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { watchPixelDensity } from "./pdf-pixel-density";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
// The app bundles PDFSlick's ESM build over the installed (patched) PDF.js;
// Node resolves its UMD build, which carries a PDF.js of its own. PDF.js's
// Node build is the legacy one.
vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("@pdfslick/core", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const packageJson = createRequire(import.meta.url).resolve("@pdfslick/core/package.json");
  return import(/* @vite-ignore */ pathToFileURL(join(dirname(packageJson), "dist/esm/index.js")).href);
});

const SETTLE_MS = 150;

const display = (() => {
  const listeners = new Map<string, Set<() => void>>();
  const matches = (query: string) => {
    const ratio = /\(resolution: ([\d.]+)dppx\)/.exec(query)?.[1];
    return ratio !== undefined && Number(ratio) === window.devicePixelRatio;
  };
  return {
    listeners,
    matchMedia: (query: string) => ({
      media: query,
      get matches() { return matches(query); },
      addEventListener: (_type: string, listener: () => void) => {
        listeners.set(query, (listeners.get(query) ?? new Set()).add(listener));
      },
      removeEventListener: (_type: string, listener: () => void) => { listeners.get(query)?.delete(listener); },
    }),
    /** Move the window to a display of `ratio` CSS-to-device pixels. */
    moveTo(ratio: number) {
      const before = new Map([...listeners.keys()].map((query) => [query, matches(query)]));
      window.devicePixelRatio = ratio;
      for (const [query, matched] of before) {
        if (matches(query) === matched) continue;
        for (const listener of [...(listeners.get(query) ?? [])]) listener();
      }
    },
    watched: () => [...listeners].filter(([, set]) => set.size > 0).map(([query]) => query),
  };
})();

beforeEach(() => {
  window.devicePixelRatio = 2;
  vi.stubGlobal("matchMedia", display.matchMedia);
  vi.spyOn(window, "matchMedia").mockImplementation(display.matchMedia as unknown as typeof window.matchMedia);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  display.listeners.clear();
  window.devicePixelRatio = 1;
  document.body.replaceChildren();
});

describe("watchPixelDensity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("reports a density change once it settles, and keeps watching from the new density", () => {
    const onChange = vi.fn();
    const stop = watchPixelDensity(onChange);
    expect(display.watched()).toEqual(["(resolution: 2dppx)"]);

    display.moveTo(1);
    expect(display.watched()).toEqual(["(resolution: 1dppx)"]);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    display.moveTo(2);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    expect(display.watched()).toEqual([]);
  });

  it("redraws once for a drag that crosses between displays several times, and not at all when it ends where it started", () => {
    const onChange = vi.fn();
    watchPixelDensity(onChange);

    display.moveTo(1);
    display.moveTo(2);
    display.moveTo(1);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    display.moveTo(2);
    display.moveTo(1);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops a pending change when it stops watching", () => {
    const onChange = vi.fn();
    const stop = watchPixelDensity(onChange);
    display.moveTo(1);
    stop();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onChange).not.toHaveBeenCalled();
  });
});

type Size = [width: number, height: number];

class FakeViewport {
  constructor(readonly size: Size, readonly scale: number, readonly rotation = 0) {}
  readonly userUnit = 1;
  get width() { return this.size[0] * this.scale; }
  get height() { return this.size[1] * this.scale; }
  get rawDims() { return { pageWidth: this.size[0], pageHeight: this.size[1], pageX: 0, pageY: 0 }; }
  clone({ scale = this.scale, rotation = this.rotation }: { scale?: number; rotation?: number } = {}) {
    return new FakeViewport(this.size, scale, rotation);
  }
}

/** Just enough of a PDFDocumentProxy for PDF.js's viewer to build its page views. */
function fakeDocument(pageCount: number) {
  const size: Size = [612, 792];
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    rotate: 0,
    view: [0, 0, ...size],
    isPureXfa: false,
    filterFactory: {},
    getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => new FakeViewport(size, scale, rotation),
    cleanup: () => undefined,
  }));
  return {
    numPages: pages.length,
    pagesMapper: { pagesNumber: pages.length },
    loadingParams: { disableAutoFetch: true },
    isPureXfa: false,
    annotationStorage: {},
    filterFactory: {},
    getPage: async (pageNumber: number) => pages[pageNumber - 1],
    getOptionalContentConfig: async () => ({ hasInitialVisibility: true }),
    getMetadata: async () => ({ info: {} }),
    getFieldObjects: async () => null,
    hasJSActions: async () => false,
    getDestination: async () => null,
  } as unknown as PDFDocumentProxy;
}

type PageViewScale = { outputScale?: { sx: number; sy: number } | null };

describe("PDF viewer on a display of another pixel density", () => {
  async function openViewer() {
    const { createViewerRecord, destroyViewerRecord, viewerOptions } = await import("./pdf-slick");
    const host = document.createElement("div");
    document.body.append(host);
    const record = createViewerRecord("paper.pdf", host, false, viewerOptions(false, "1", null), () => undefined);
    const { viewer } = record.slick;
    viewer.setDocument(fakeDocument(3));
    await vi.waitFor(() => expect(viewer.pagesCount).toBe(3));
    viewer.currentScale = 1.5;
    const outputScales = () => Array.from({ length: 3 }, (_, index) => {
      const { outputScale } = viewer.getPageView(index) as PageViewScale;
      return outputScale ? [outputScale.sx, outputScale.sy] : null;
    });
    return { record, viewer, outputScales, destroy: () => destroyViewerRecord(record) };
  }

  it("draws every page at the new density, at the same zoom and scroll position", async () => {
    const { record, viewer, outputScales, destroy } = await openViewer();
    expect(outputScales()).toEqual([[2, 2], [2, 2], [2, 2]]);
    record.root.scrollTop = 640;

    display.moveTo(1);
    await vi.waitFor(() => expect(outputScales()).toEqual([[1, 1], [1, 1], [1, 1]]));
    expect(viewer.currentScale).toBe(1.5);
    expect(record.root.scrollTop).toBe(640);

    display.moveTo(2);
    await vi.waitFor(() => expect(outputScales()).toEqual([[2, 2], [2, 2], [2, 2]]));
    await destroy();
  });

  it("stops watching the display when the viewer is torn down", async () => {
    const { viewer, destroy } = await openViewer();
    const refresh = vi.spyOn(viewer, "refresh");
    expect(display.watched()).toEqual(["(resolution: 2dppx)"]);

    await destroy();
    expect(display.watched()).toEqual([]);
    display.moveTo(1);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50));
    expect(refresh).not.toHaveBeenCalled();
  });
});
