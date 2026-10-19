import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerRecord } from "./pdf-slick";

const invoke = vi.hoisted(() => vi.fn());
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./pdfjs-runtime", () => ({ getDocument }));

const { changedPages, pdfPageSignatures, swapPdfPages } = await import("./pdf-page-swap");

const FINISHED = 3;
const RUNNING = 1;

type FakePage = { pageNumber: number; build: string; rotate: number; view: number[]; getViewport: () => object };

function page(pageNumber: number, build: string, view = [0, 0, 612, 792]): FakePage {
  return { pageNumber, build, rotate: 0, view, getViewport: () => ({ build, scale: 1.5, rotation: 0 }) };
}

/** A loading task for a document of `pages`, as PDF.js's getDocument returns it. */
function loading(build: string, pages: number, view?: number[]) {
  const document = { numPages: pages, getPage: async (pageNumber: number) => page(pageNumber, build, view) };
  return { promise: Promise.resolve(document), destroy: vi.fn(), document };
}

function view(id: number, pdfPage: FakePage | null, renderingState = FINISHED) {
  return {
    id,
    pdfPage,
    renderingState,
    viewport: { scale: 1.5, rotation: 0 },
    textLayer: pdfPage ? { pdfPage } : null,
    annotationLayer: pdfPage ? { pdfPage } : null,
    setPdfPage: vi.fn(),
    reset: vi.fn(),
  };
}

/** A viewer on build "old": page 1 drawn, 2 drawn, 3 still drawing, 4 never loaded. */
function viewerRecord() {
  const views = [view(1, page(1, "old")), view(2, page(2, "old")), view(3, page(3, "old"), RUNNING), view(4, null)];
  const previousTask = { destroy: vi.fn() };
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const finder = {
    state: null as Record<string, unknown> | null,
    _highlightMatches: false,
    _scrollMatches: false,
    setDocument: vi.fn(),
  };
  const slick = {
    viewer: { pdfDocument: { build: "old" }, pagesCount: views.length, getPageView: (index: number) => views[index], update: vi.fn() },
    document: { build: "old" },
    loadingTask: previousTask,
    linkService: { setDocument: vi.fn() },
    findController: finder,
    getDocumentParams: { cMapPacked: true },
    enableHWA: true,
    url: undefined as string | undefined,
    dispatch: vi.fn(),
    on: (name: string, listener: (event: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    off: (name: string, listener: (event: unknown) => void) => listeners.get(name)?.delete(listener),
    emit: (name: string) => [...listeners.get(name) ?? []].forEach((listener) => listener({})),
  };
  const record = { slick } as unknown as ViewerRecord;
  return { record, slick, views, previousTask, finder };
}

const BYTES = new TextEncoder().encode("%PDF-1.5 new build").buffer;

describe("changedPages", () => {
  it("names the pages whose signatures differ", () => {
    const before = { document: "d", pages: ["a", "b", "c"] };
    expect(changedPages(before, { document: "d", pages: ["a", "x", "c"] })).toEqual([2]);
    expect(changedPages(before, before)).toEqual([]);
  });

  it("asks for a full load when the document as a whole changed", () => {
    const before = { document: "d", pages: ["a", "b"] };
    expect(changedPages(before, { document: "outline moved", pages: ["a", "b"] })).toBeNull();
    expect(changedPages(before, { document: "d", pages: ["a", "b", "c"] })).toBeNull();
  });
});

describe("pdfPageSignatures", () => {
  beforeEach(() => invoke.mockReset());

  it("sends the PDF as the raw body and reads nothing into a failure", async () => {
    invoke.mockResolvedValueOnce({ document: "d", pages: ["a"] });
    await expect(pdfPageSignatures(BYTES)).resolves.toEqual({ document: "d", pages: ["a"] });
    const [command, sent] = invoke.mock.calls[0];
    expect(command).toBe("pdf_page_signatures");
    // A copy, since the caller may hand its own buffer to PDF.js meanwhile.
    expect(sent).not.toBe(BYTES);
    expect(new Uint8Array(sent as ArrayBuffer)).toEqual(new Uint8Array(BYTES));
    invoke.mockRejectedValueOnce(new Error("not a PDF"));
    await expect(pdfPageSignatures(BYTES)).resolves.toBeNull();
    invoke.mockResolvedValueOnce(undefined);
    await expect(pdfPageSignatures(BYTES)).resolves.toBeNull();
  });
});

describe("swapPdfPages", () => {
  beforeEach(() => getDocument.mockReset());

  it("moves the viewer to the new document and redraws only the changed and unfinished pages", async () => {
    const task = loading("new", 4);
    getDocument.mockReturnValue(task);
    const { record, slick, views, previousTask } = viewerRecord();

    await expect(swapPdfPages(record, BYTES, [2], () => true)).resolves.toBe(true);

    expect(slick.viewer.pdfDocument).toBe(task.document);
    expect(slick.document).toBe(task.document);
    expect(slick.loadingTask).toBe(task);
    expect(slick.linkService.setDocument).toHaveBeenCalledWith(task.document);
    // Unchanged and drawn: same canvas and layers, now backed by the new page.
    expect(views[0].reset).not.toHaveBeenCalled();
    expect(views[0].setPdfPage).not.toHaveBeenCalled();
    expect(views[0].pdfPage).toMatchObject({ build: "new", pageNumber: 1 });
    expect(views[0].textLayer?.pdfPage).toBe(views[0].pdfPage);
    expect(views[0].annotationLayer?.pdfPage).toBe(views[0].pdfPage);
    // Changed and drawn: the old canvas stays until the new one is complete.
    expect(views[1].reset).toHaveBeenCalledWith({ keepCanvasWrapper: true });
    expect(views[1].pdfPage).toMatchObject({ build: "new", pageNumber: 2 });
    expect(views[1].viewport).toMatchObject({ build: "new" });
    // Still drawing the old document: starts over from the new one.
    expect(views[2].setPdfPage).toHaveBeenCalledWith(expect.objectContaining({ build: "new", pageNumber: 3 }));
    // Never loaded: PDF.js loads it from the viewer's document when needed.
    expect(views[3].pdfPage).toBeNull();
    expect(slick.viewer.update).toHaveBeenCalled();
    expect(previousTask.destroy).toHaveBeenCalled();
    expect(task.destroy).not.toHaveBeenCalled();
  });

  it("leaves the viewer as it was when a page changed size, the page count moved, or a newer build won", async () => {
    for (const [task, current] of [
      [loading("new", 4, [0, 0, 595, 842]), true],
      [loading("new", 5), true],
      [loading("new", 4), false],
    ] as const) {
      getDocument.mockReturnValue(task);
      const { record, slick, views, previousTask } = viewerRecord();
      await expect(swapPdfPages(record, BYTES, [2], () => current)).resolves.toBe(false);
      expect(slick.viewer.pdfDocument).toEqual({ build: "old" });
      expect(views[0].pdfPage).toMatchObject({ build: "old" });
      expect(views.every((each) => each.reset.mock.calls.length === 0)).toBe(true);
      expect(previousTask.destroy).not.toHaveBeenCalled();
      expect(task.destroy).toHaveBeenCalled();
    }
  });

  it("searches the new document again without taking the reader to a match", async () => {
    getDocument.mockReturnValue(loading("new", 4));
    const { record, slick, finder } = viewerRecord();
    finder._highlightMatches = true;
    finder.state = { query: "attention", caseSensitive: false, highlightAll: true };

    await swapPdfPages(record, BYTES, [], () => true);

    expect(finder.setDocument).toHaveBeenCalled();
    expect(slick.dispatch).toHaveBeenCalledWith("find", expect.objectContaining({
      query: "attention", type: "highlightallchange", source: slick,
    }));
    finder._scrollMatches = true;
    expect(finder._scrollMatches).toBe(false);
    // The reader's next search scrolls as usual.
    slick.emit("find");
    finder._scrollMatches = true;
    expect(finder._scrollMatches).toBe(true);
  });
});
