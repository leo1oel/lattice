import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

type MockPdfDestination = {
  page: number;
  scrollTop: number;
  scrollLeft: number;
  scaleValue?: string;
};

type MockPdfSlick = {
  args: {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    options: Record<string, unknown>;
  };
  dispatch: ReturnType<typeof vi.fn>;
  gotoPage: ReturnType<typeof vi.fn<(page: number) => void>>;
  linkService: {
    page: number;
    goToDestination: (destination: MockPdfDestination) => Promise<void>;
  };
  loadDocument: ReturnType<typeof vi.fn>;
  unbindEvents: ReturnType<typeof vi.fn>;
  finishReady: () => void;
  emit: (name: string, event: object) => void;
  viewer: {
    cleanup: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    currentScale: number;
    currentScaleValue: string;
    getPageView: (index: number) => {
      div: HTMLDivElement;
      textLayer: { div: HTMLDivElement };
      viewport: { scale: number };
    };
  };
};

const pdfSlickMock = vi.hoisted(() => ({
  instances: [] as MockPdfSlick[],
  numPages: 3,
  viewportScale: 1,
  documentBytes: new Uint8Array([1, 2, 3]),
  deferLoad: false,
  deferReady: false,
  pendingLoad: null as null | {
    onProgress?: (progress: { loaded: number; total: number; percent: number }) => void;
    resolve: () => void;
  },
}));
const browserRuntime = vi.hoisted(() => ({ hosted: false }));
const pdfJs = vi.hoisted(() => ({ GlobalWorkerOptions: {} as { workerSrc?: string } }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../platform/browser-runtime", () => ({
  isBrowserHosted: () => browserRuntime.hosted,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: pdfJs.GlobalWorkerOptions,
}));

vi.mock("@pdfslick/core", () => ({
  PDFSlick: class PDFSlickMock {
    l10n = { get: vi.fn(async (id: string) => id) };
    args: MockPdfSlick["args"];
    dispatch: ReturnType<typeof vi.fn>;
    gotoPage: MockPdfSlick["gotoPage"];
    linkService: MockPdfSlick["linkService"];
    loadDocument: ReturnType<typeof vi.fn>;
    unbindEvents = vi.fn();
    readyListeners = new Set<() => void>();
    pagesReady = false;
    store = {
      getState: () => ({ pagesReady: this.pagesReady }),
      subscribe: (listener: () => void) => {
        this.readyListeners.add(listener);
        return () => this.readyListeners.delete(listener);
      },
    };
    finishReady = () => {
      // PDFSlick applies its initial scale after awaiting getOutline().
      this.args.container.scrollTop = 0;
      this.pagesReady = true;
      this.readyListeners.forEach((listener) => listener());
    };
    document: {
      numPages: number;
      getData: () => Promise<Uint8Array>;
      loadingTask: { destroy: ReturnType<typeof vi.fn> };
    } | null = null;
    eventHandlers = new Map<string, Array<(event: object) => void>>();
    pageViews: Array<{
      div: HTMLDivElement;
      textLayer: { div: HTMLDivElement };
      viewport: { scale: number };
    }> = [];
    viewer: MockPdfSlick["viewer"];
    findIndex = 0;

    constructor(args: MockPdfSlick["args"]) {
      this.args = args;
      let currentScale = Number(args.options.scaleValue) || 0.75;
      let currentScaleValue = String(args.options.scaleValue ?? "page-width");
      const emit = (name: string, event: object) => this.emit(name, event);
      this.viewer = {
        cleanup: vi.fn(),
        update: vi.fn(),
        get currentScale() {
          return currentScale;
        },
        set currentScale(value: number) {
          currentScale = value;
          queueMicrotask(() => emit("scalechanging", { scale: value }));
        },
        get currentScaleValue() {
          return currentScaleValue;
        },
        set currentScaleValue(value: string) {
          currentScaleValue = value;
          const scale = value === "page-fit" ? 0.6 : value === "page-width" ? 0.75 : Number(value);
          currentScale = scale;
          queueMicrotask(() => emit("scalechanging", {
            scale,
            presetValue: value === "page-fit" || value === "page-width" ? value : undefined,
          }));
        },
        getPageView: (index: number) => this.pageViews[index],
      };
      this.linkService = {
        page: 1,
        goToDestination: vi.fn(async (destination: MockPdfDestination) => {
          this.linkService.page = destination.page;
          if (destination.scaleValue) this.viewer.currentScaleValue = destination.scaleValue;
          args.container.scrollTop = destination.scrollTop;
          args.container.scrollLeft = destination.scrollLeft;
          this.emit("pagechanging", { pageNumber: destination.page });
        }),
      };
      this.gotoPage = vi.fn((page: number) => {
        this.linkService.page = page;
        args.container.scrollTop = (page - 1) * 1_000;
        this.emit("pagechanging", { pageNumber: page });
      });
      this.dispatch = vi.fn((name: string, event: Record<string, unknown>) => {
        if (name === "findbarclose") {
          this.clearHighlights();
          this.emit("updatefindmatchescount", { matchesCount: { current: 0, total: 0 } });
          return;
        }
        if (name !== "find") return;
        const query = String(event.query ?? "").toLocaleLowerCase();
        const matches = this.pageViews.filter((page) => (
          page.div.textContent ?? ""
        ).toLocaleLowerCase().includes(query));
        if (event.type === "again" && matches.length) {
          this.findIndex = (this.findIndex + (event.findPrevious ? -1 : 1) + matches.length) % matches.length;
        } else {
          this.findIndex = 0;
        }
        this.clearHighlights();
        for (const [index, page] of matches.entries()) {
          const highlight = document.createElement("span");
          highlight.className = `highlight${index === this.findIndex ? " selected" : ""}`;
          highlight.textContent = query;
          page.div.querySelector(".textLayer")?.append(highlight);
        }
        this.emit("updatefindmatchescount", {
          matchesCount: {
            current: matches.length ? this.findIndex + 1 : 0,
            total: matches.length,
          },
        });
      });
      this.loadDocument = vi.fn(async (
        source: string | ArrayBuffer,
        options?: {
          onProgress?: (progress: { loaded: number; total: number; percent: number }) => void;
        },
      ) => {
        void source;
        if (pdfSlickMock.deferLoad) {
          await new Promise<void>((resolve) => {
            pdfSlickMock.pendingLoad = { onProgress: options?.onProgress, resolve };
          });
        }
        this.document = {
          numPages: pdfSlickMock.numPages,
          getData: async () => pdfSlickMock.documentBytes,
          loadingTask: { destroy: vi.fn(async () => undefined) },
        };
        for (let pageNumber = 1; pageNumber <= pdfSlickMock.numPages; pageNumber += 1) {
          const page = document.createElement("div");
          page.className = "page";
          page.dataset.pageNumber = String(pageNumber);
          const canvas = document.createElement("canvas");
          const textLayer = document.createElement("div");
          textLayer.className = "textLayer";
          const span = document.createElement("span");
          span.textContent = `Attention is all you need — page ${pageNumber}`;
          textLayer.append(span);
          const annotationLayer = document.createElement("div");
          annotationLayer.className = "annotationLayer";
          const link = document.createElement("a");
          link.href = "https://example.com/paper";
          link.target = "_blank";
          link.rel = "noopener noreferrer nofollow";
          link.title = "https://example.com/paper";
          const internalLink = document.createElement("a");
          internalLink.href = "#page=3";
          internalLink.className = "internalLink";
          internalLink.title = "Jump to PDF page 3";
          internalLink.onclick = () => {
            void this.linkService.goToDestination({
              page: 3,
              scrollTop: 1_200,
              scrollLeft: 24,
              scaleValue: "1.5",
            });
            return false;
          };
          annotationLayer.append(link, internalLink);
          page.append(canvas, textLayer, annotationLayer);
          args.viewer.append(page);
          this.pageViews.push({
            div: page,
            textLayer: { div: textLayer },
            viewport: { scale: pdfSlickMock.viewportScale },
          });
        }
        this.emit("pagesinit", {});
        if (!pdfSlickMock.deferReady) this.finishReady();
        this.emit("pagerendered", { pageNumber: 1 });
        for (let pageNumber = 1; pageNumber <= pdfSlickMock.numPages; pageNumber += 1) {
          this.emit("textlayerrendered", { pageNumber });
        }
      });
      pdfSlickMock.instances.push(this as unknown as MockPdfSlick);
    }

    on(name: string, listener: (event: object) => void) {
      const handlers = this.eventHandlers.get(name) ?? [];
      handlers.push(listener);
      this.eventHandlers.set(name, handlers);
    }

    emit(name: string, event: object) {
      for (const listener of this.eventHandlers.get(name) ?? []) listener(event);
    }

    clearHighlights() {
      for (const page of this.pageViews) {
        page.div.querySelectorAll(".highlight").forEach((highlight) => highlight.remove());
      }
    }
  },
}));

describe("PDFSlick viewer integration", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    browserRuntime.hosted = false;
    pdfSlickMock.instances.length = 0;
    pdfSlickMock.numPages = 3;
    pdfSlickMock.viewportScale = 1;
    pdfSlickMock.documentBytes = new Uint8Array([1, 2, 3]);
    pdfSlickMock.deferLoad = false;
    pdfSlickMock.deferReady = false;
    pdfSlickMock.pendingLoad = null;
    localStorage.clear();
  });

  it("does not reserve an outline track when an outline component renders nothing", () => {
    const EmptyOutline = () => null;
    const view = render(<PdfPreview url={null} pdfBase64={null} outline={<EmptyOutline />} />);

    const findControls = view.container.querySelector(".pdf-find-controls");
    expect(findControls?.querySelector(".pdf-outline-trigger")).toBeNull();
    expect(findControls?.querySelector(".pdf-search")).toBeInTheDocument();
  });

  it("keeps the search input controlled as compiled PDFs appear and disappear", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<PdfPreview url={null} pdfBase64={null} />);

    view.rerender(<PdfPreview url="blob:lattice-compiled-pdf" pdfBase64={null} />);
    view.rerender(<PdfPreview url={null} pdfBase64={null} />);

    const errors = consoleError.mock.calls.flat().join("\n");
    expect(errors).not.toContain("changing an uncontrolled input to be controlled");
    expect(errors).not.toContain("changing a controlled input to be uncontrolled");
    consoleError.mockRestore();
  });

  it("starts from a file's local page and zoom without overwriting it before load", () => {
    const onViewState = vi.fn();
    const onPageChange = vi.fn();
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        initialViewState={{ page: 7, scale: 1.75, fitMode: null, scrollTop: 640, scrollLeft: 30 }}
        onPageChange={onPageChange}
        onViewState={onViewState}
      />,
    );

    expect(onPageChange).toHaveBeenLastCalledWith(7);
    expect(JSON.parse(localStorage.getItem("lattice.pdf-view-preference.v1") ?? "null"))
      .toEqual({ fitMode: null, scale: 1.75 });
    view.unmount();
    expect(onViewState).not.toHaveBeenCalled();
  });

  it("constructs PDFSlick with virtualized high-resolution rendering and local PDF.js assets", async () => {
    browserRuntime.hosted = true;
    const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const onNumPages = vi.fn();
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        pdfBytes={bytes}
        initialViewState={{ page: 1, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 }}
        onNumPages={onNumPages}
      />,
    );

    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(1));
    const instance = pdfSlickMock.instances[0];
    await waitFor(() => expect(instance.loadDocument).toHaveBeenCalledOnce());
    expect(instance.viewer).toHaveProperty("enableSelectionRendering", false);
    expect(instance.loadDocument.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);
    expect(instance.args.options).toMatchObject({
      enableHWA: true,
      enableDetailCanvas: true,
      maxCanvasPixels: 2 ** 25,
      minDurationToUpdateCanvas: 0,
      removePageBorders: true,
      scaleValue: "0.75",
      getDocumentParams: {
        cMapPacked: true,
        cMapUrl: expect.stringContaining("/pdfjs/cmaps/"),
        data: expect.any(ArrayBuffer),
        disableAutoFetch: true,
        disableFontFace: false,
        rangeChunkSize: 2 ** 20,
        standardFontDataUrl: expect.stringContaining("/pdfjs/standard_fonts/"),
        useSystemFonts: false,
      },
    });
    expect((instance.args.options.getDocumentParams as { data: ArrayBuffer }).data.byteLength)
      .toBe(bytes.byteLength);
    expect(pdfJs.GlobalWorkerOptions.workerSrc).toContain("pdf.worker.min.mjs");
    expect(await view.findByLabelText("PDF page 3")).toBeInTheDocument();
    expect(onNumPages).toHaveBeenLastCalledWith(3);
  });

  it("draws the pane's scrollbars as hover-reveal overlay bars on the PDF.js viewport", async () => {
    const view = render(<PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} />);
    expect(await view.findByLabelText("PDF page 1")).toBeInTheDocument();

    const area = view.container.querySelector(".pdf-scroll-area")!;
    expect(area.querySelectorAll(":scope > .overlay-scrollbar")).toHaveLength(2);

    // PDF.js creates the scrolling element, so prove the bars found it.
    const viewport = view.container.querySelector<HTMLElement>(".pdf-scroll-area-viewport")!;
    const vertical = area.querySelector<HTMLElement>(
      '.overlay-scrollbar[data-orientation="vertical"]',
    )!;
    for (const [element, sizes] of [
      [viewport, { clientHeight: 200, scrollHeight: 800 }],
      [vertical, { clientHeight: 200 }],
    ] as const) {
      for (const [name, value] of Object.entries(sizes)) {
        Object.defineProperty(element, name, { configurable: true, value });
      }
    }
    // The bars measure on attach, and these sizes only exist afterwards. Scroll
    // the PDF.js viewport to ask for a fresh measurement: only a listener bound
    // to that element can answer, which is the attachment this test is about.
    fireEvent.scroll(viewport);
    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-end"));
    expect(vertical.firstElementChild).toHaveStyle({ height: "48px" });

    fireEvent.scroll(viewport);
    expect(vertical).toHaveAttribute("data-scrolling");
  });

  it("shows real network progress and the first-page rendering stage", async () => {
    pdfSlickMock.deferLoad = true;
    const view = render(
      <PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} />,
    );

    await waitFor(() => expect(pdfSlickMock.pendingLoad).not.toBeNull());
    const pendingLoad = pdfSlickMock.pendingLoad!;
    expect(view.getByRole("status")).toHaveTextContent("Loading PDF…");

    act(() => {
      pendingLoad.onProgress?.({ loaded: 3, total: 10, percent: 30 });
    });
    expect(view.getByRole("status")).toHaveTextContent("Loading PDF…30%");
    expect(view.getByRole("progressbar", { name: "PDF loading progress" }))
      .toHaveAttribute("aria-valuenow", "30");
    expect(view.container.querySelector(".pdf-load-progress-fill")).toHaveStyle({ width: "30%" });

    act(() => {
      pendingLoad.onProgress?.({ loaded: 10, total: 10, percent: 100 });
    });
    expect(view.getByRole("status")).toHaveTextContent("Rendering first page…");
    expect(view.queryByRole("progressbar", { name: "PDF loading progress" })).toBeNull();

    await act(async () => pendingLoad.resolve());
    expect(await view.findByLabelText("PDF page 1")).toBeInTheDocument();
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  });

  it.each(["blank page", "text glyph"])("uses PDFSlick navigation, search, links, and clears selection on a %s click", async (clearTarget) => {
    const onTextSelect = vi.fn();
    const view = render(
      <PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} onTextSelect={onTextSelect} />,
    );
    const pageInput = await view.findByLabelText("PDF page number");
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(1));
    const instance = pdfSlickMock.instances[0];
    expect(instance.args.options.getDocumentParams).toMatchObject({ rangeChunkSize: 2 ** 20 });
    expect(instance.args.options.getDocumentParams).not.toHaveProperty("data");

    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.blur(pageInput);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(3);

    const searchInput = view.getByLabelText("Search PDF");
    fireEvent.change(searchInput, { target: { value: "attention" } });
    await waitFor(() => expect(view.getByText("1 / 3")).toBeInTheDocument());
    expect(view.container.querySelectorAll(".highlight")).toHaveLength(3);
    expect(view.container.querySelectorAll(".highlight.selected")).toHaveLength(1);

    const matchCase = view.getByRole("button", { name: "Match case" });
    const wholeWord = view.getByRole("button", { name: "Whole word" });
    expect(matchCase).toHaveAttribute("aria-pressed", "false");
    expect(wholeWord).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(matchCase);
    await waitFor(() => expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining({
      caseSensitive: true,
      entireWord: false,
      query: "attention",
    })));
    fireEvent.click(wholeWord);
    await waitFor(() => expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining({
      caseSensitive: true,
      entireWord: true,
      query: "attention",
    })));

    fireEvent.keyDown(searchInput, { key: "Enter", shiftKey: true });
    expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining({
      findPrevious: true,
      type: "again",
    }));
    fireEvent.click(view.getByRole("button", { name: "Next search result" }));
    expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining({
      findPrevious: false,
      type: "again",
    }));

    const textLayer = view.container.querySelector<HTMLElement>(".textLayer")!;
    const glyph = textLayer.querySelector<HTMLElement>("span")!;
    glyph.textContent = "Attention\u00a0 is all\n you need";
    const range = document.createRange();
    range.selectNodeContents(glyph);
    const liveSelection = {
      anchorNode: glyph,
      getRangeAt: () => range,
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "Attention\u00a0 is all\n you need",
    } as unknown as Selection;
    const selection = vi.spyOn(window, "getSelection").mockReturnValue(liveSelection);
    const documentSelection = vi.spyOn(document, "getSelection").mockReturnValue(liveSelection);
    fireEvent.mouseUp(textLayer);
    await waitFor(() => {
      expect(onTextSelect).toHaveBeenLastCalledWith("Attention is all you need");
    });
    const preview = view.container.querySelector<HTMLElement>(".pdf-preview")!;
    preview.focus();
    fireEvent.keyDown(preview, { key: "f", metaKey: true });
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
      expect(searchInput).toHaveValue("Attention is all you need");
    });
    fireEvent.change(searchInput, { target: { value: "other query" } });
    preview.focus();
    fireEvent.keyDown(preview, { key: "f", ctrlKey: true });
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
      expect(searchInput).toHaveValue("Attention is all you need");
    });
    glyph.getClientRects = () => [{
      left: 0,
      right: 100,
      top: 0,
      bottom: 20,
      width: 100,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }] as unknown as DOMRectList;
    glyph.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    const collapsedSelection = { rangeCount: 0, isCollapsed: true } as Selection;
    selection.mockReturnValue(collapsedSelection);
    documentSelection.mockReturnValue(collapsedSelection);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.mouseUp(glyph);
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    expect(onTextSelect).toHaveBeenLastCalledWith("Attention is all you need");
    const pageCanvas = view.container.querySelector<HTMLElement>(".page canvas")!;
    const target = clearTarget === "text glyph" ? glyph : pageCanvas;
    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    expect(onTextSelect).toHaveBeenLastCalledWith("");
    fireEvent.mouseUp(target);
    await waitFor(() => {
      expect(onTextSelect).toHaveBeenLastCalledWith("");
    });
    documentSelection.mockRestore();
    selection.mockRestore();

    const link = view.getAllByTitle("https://example.com/paper")[0];
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("returns to exact locations after internal PDF link jumps and clears history on replacement", async () => {
    const view = render(
      <PdfPreview url="https://example.test/first.pdf" pdfBase64={null} />,
    );
    await view.findByLabelText("PDF page 1");
    const instance = pdfSlickMock.instances[0];
    const viewport = instance.args.container;
    const back = view.getByRole("button", { name: "Previous PDF location" });
    const forward = view.getByRole("button", { name: "Next PDF location" });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    instance.linkService.page = 1;
    viewport.scrollTop = 240;
    viewport.scrollLeft = 12;
    fireEvent.click(view.getAllByTitle("Jump to PDF page 3")[0]);
    await waitFor(() => expect(back).toBeEnabled());
    expect(forward).toBeDisabled();
    expect(viewport.scrollTop).toBe(1_200);
    expect(viewport.scrollLeft).toBe(24);

    fireEvent.click(back);
    await waitFor(() => expect(viewport.scrollTop).toBe(240));
    expect(viewport.scrollLeft).toBe(12);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(1);
    expect(back).toBeDisabled();
    expect(forward).toBeEnabled();

    fireEvent.click(forward);
    await waitFor(() => expect(viewport.scrollTop).toBe(1_200));
    expect(viewport.scrollLeft).toBe(24);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(3);
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    view.rerender(<PdfPreview url="https://example.test/second.pdf" pdfBase64={null} />);
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(2), { timeout: 2_500 });
    await waitFor(() => expect(back).toBeDisabled());
    expect(forward).toBeDisabled();
  });

  it("preserves forward and reverse SyncTeX point coordinates", async () => {
    pdfSlickMock.viewportScale = 2;
    const onSource = vi.fn();
    const view = render(
      <PdfPreview
        url="https://example.test/paper.pdf"
        pdfBase64={null}
        onSource={onSource}
        syncTarget={{ id: "sync-1", page: 2, x: 72, y: 96, width: 120, height: 14 }}
      />,
    );
    const page = await view.findByLabelText("PDF page 2");
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      right: 610,
      bottom: 820,
      width: 600,
      height: 800,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect);

    await waitFor(() => expect(view.getByLabelText("Source location in PDF")).toHaveStyle({
      left: "144px",
      top: "192px",
      width: "240px",
      height: "28px",
    }));
    fireEvent.doubleClick(page, { clientX: 110, clientY: 220 });
    expect(onSource).toHaveBeenCalledWith(2, 50, 100);
  });

  it("navigates to a quote page but conservatively skips an ambiguous highlight", async () => {
    const view = render(
      <PdfPreview
        url="https://example.test/paper.pdf"
        pdfBase64={null}
        initialViewState={{ page: 1, scale: 1, fitMode: null, scrollTop: 450, scrollLeft: 0 }}
        sourceQuote={{ id: "ambiguous", page: 2, first: "Attention", last: "Attention" }}
      />,
    );
    await view.findByLabelText("PDF page 2");
    const instance = pdfSlickMock.instances[0];
    const layer = instance.viewer.getPageView(1).textLayer.div;
    layer.append(layer.firstChild!.cloneNode(true));
    act(() => instance.emit("textlayerrendered", { pageNumber: 2 }));

    await waitFor(() => expect(instance.gotoPage).toHaveBeenCalledWith(2));
    expect(instance.args.container.scrollTop).toBe(1_000);
    expect(layer.querySelector(".pdf-source-quote-highlight")).toBeNull();
  });

  it("waits for delayed target-page text and highlights across quote boundaries", async () => {
    const sourceQuote = { id: "delayed", page: 3, first: "Unique opening", last: "closing words" };
    const view = render(
      <PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} sourceQuote={sourceQuote} />,
    );
    await view.findByLabelText("PDF page 3");
    const instance = pdfSlickMock.instances[0];
    const layer = instance.viewer.getPageView(2).textLayer.div;
    layer.replaceChildren();
    act(() => instance.emit("textlayerrendered", { pageNumber: 3 }));
    expect(layer.querySelector(".pdf-source-quote-highlight")).toBeNull();

    const first = document.createElement("span");
    first.textContent = "Unique opening and ";
    const second = document.createElement("span");
    second.textContent = "closing words";
    layer.append(first, second);
    act(() => instance.emit("textlayerrendered", { pageNumber: 3 }));

    await waitFor(() => expect(layer.querySelectorAll(".pdf-source-quote-highlight")).toHaveLength(2));
    expect(instance.gotoPage).toHaveBeenCalledTimes(2); // promotion, then the new quote target
  });

  it("cleans the old quote highlight on target change and unmount", async () => {
    const firstTarget = { id: "first", page: 1, first: "Attention", last: "page 1" };
    const view = render(
      <PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} sourceQuote={firstTarget} />,
    );
    const firstLayer = (await view.findByLabelText("PDF page 1")).querySelector(".textLayer")!;
    await waitFor(() => expect(firstLayer.querySelector(".pdf-source-quote-highlight")).not.toBeNull());

    view.rerender(
      <PdfPreview
        url="https://example.test/paper.pdf"
        pdfBase64={null}
        sourceQuote={{ id: "second", page: 2, first: "Attention", last: "page 2" }}
      />,
    );
    const secondLayer = view.getByLabelText("PDF page 2").querySelector(".textLayer")!;
    await waitFor(() => expect(secondLayer.querySelector(".pdf-source-quote-highlight")).not.toBeNull());
    expect(firstLayer.querySelector(".pdf-source-quote-highlight")).toBeNull();

    view.unmount();
    expect(secondLayer.querySelector(".pdf-source-quote-highlight")).toBeNull();
  });

  it("recreates the SyncTeX highlight when a same-size document replaces the viewer", async () => {
    const syncTarget = { id: "sync-stable", page: 2, x: 72, y: 96, width: 120, height: 14 };
    const view = render(
      <PdfPreview url="https://example.test/first.pdf" pdfBase64={null} syncTarget={syncTarget} />,
    );
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(1));
    await view.findByLabelText("Source location in PDF");

    view.rerender(
      <PdfPreview url="https://example.test/second.pdf" pdfBase64={null} syncTarget={syncTarget} />,
    );
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(2), { timeout: 2_500 });
    const replacementPage = pdfSlickMock.instances[1].viewer.getPageView(1).div;
    await waitFor(() => {
      expect(replacementPage.querySelector("[data-sync-target='sync-stable']")).toBeInTheDocument();
    });
  });

  it.each([
    { pages: 3, viewportScale: 1, restoredTop: 2_817 },
    { pages: 2, viewportScale: 1.5, restoredTop: 3_125.5 },
  ])("keeps the old viewer until ready and restores its latest offset with $pages pages at scale $viewportScale", async ({ pages, viewportScale, restoredTop }) => {
    const view = render(<PdfPreview url="https://example.test/old.pdf" pdfBase64={null} />);
    await view.findByLabelText("PDF page 3");
    const old = pdfSlickMock.instances[0];
    act(() => old.gotoPage(3));
    old.args.container.scrollTop = 2_430;
    Object.defineProperty(old.viewer.getPageView(2).div, "offsetTop", { value: 2_000 });

    pdfSlickMock.deferReady = true;
    pdfSlickMock.numPages = pages;
    pdfSlickMock.viewportScale = viewportScale;
    view.rerender(<PdfPreview url="https://example.test/new.pdf" pdfBase64={null} />);
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(2), { timeout: 2_500 });
    const replacement = pdfSlickMock.instances[1];
    expect(old.args.container.isConnected).toBe(true);
    expect(replacement.args.container).toHaveClass("pdf-viewer-staging");
    // The reader keeps scrolling while loading; page geometry also changes.
    old.args.container.scrollTop = 2_617;
    old.args.container.scrollLeft = 37;
    Object.defineProperty(replacement.viewer.getPageView(pages - 1).div, "offsetTop", { value: 2_200 });
    act(() => replacement.finishReady());
    await waitFor(() => expect(old.args.container.isConnected).toBe(false));
    expect(replacement.gotoPage).toHaveBeenCalledWith(pages);
    expect(replacement.args.container.scrollTop).toBe(restoredTop);
    expect(replacement.args.container.scrollLeft).toBe(37);
  });

  it("redraws an existing source highlight without replaying its navigation on replacement", async () => {
    const target = { id: "old-target", page: 2, x: 20, y: 80, width: 30, height: 12 };
    const view = render(<PdfPreview url="https://example.test/old.pdf" pdfBase64={null} syncTarget={target} />);
    await view.findByLabelText("Source location in PDF");
    const old = pdfSlickMock.instances[0];
    act(() => old.gotoPage(3));
    old.args.container.scrollTop = 2_617;
    view.rerender(<PdfPreview url="https://example.test/new.pdf" pdfBase64={null} syncTarget={target} />);
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(2), { timeout: 2_500 });
    const replacement = pdfSlickMock.instances[1];
    await waitFor(() => expect(replacement.args.viewer.querySelector("[data-sync-target='old-target']")).not.toBeNull());
    expect(replacement.gotoPage).not.toHaveBeenCalledWith(2);
    expect(replacement.args.container.scrollTop).toBe(2_617);

    replacement.gotoPage.mockClear();
    act(() => { replacement.viewer.currentScale = 1.5; });
    await act(async () => undefined);
    expect(replacement.gotoPage).not.toHaveBeenCalled();

    view.rerender(<PdfPreview url="https://example.test/new.pdf" pdfBase64={null} syncTarget={{ ...target, id: "new-target" }} />);
    await waitFor(() => expect(replacement.gotoPage).toHaveBeenCalledWith(2));
  });

  it("does not promote a staged viewer after unmount", async () => {
    pdfSlickMock.deferReady = true;
    const view = render(<PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} />);
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(1));
    const pending = pdfSlickMock.instances[0];
    view.unmount();
    act(() => pending.finishReady());
    expect(pending.gotoPage).not.toHaveBeenCalled();
    expect(pending.args.container.isConnected).toBe(false);
  });

  it("restores local view state and destroys PDFSlick without leaving page nodes", async () => {
    const onViewState = vi.fn();
    const view = render(
      <PdfPreview
        url="https://example.test/paper.pdf"
        pdfBase64={null}
        initialViewState={{ page: 2, scale: 1.5, fitMode: null, scrollTop: 640, scrollLeft: 30 }}
        onViewState={onViewState}
      />,
    );
    await view.findByLabelText("PDF page 2");
    const instance = pdfSlickMock.instances[0];
    await waitFor(() => expect(instance.gotoPage).toHaveBeenCalledWith(2));
    expect(instance.args.container.scrollTop).toBe(640);
    expect(instance.args.container.scrollLeft).toBe(30);

    view.unmount();
    await act(async () => undefined);
    expect(instance.unbindEvents).toHaveBeenCalledOnce();
    expect(instance.viewer.cleanup).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".pdfViewer .page")).toHaveLength(0);
    expect(onViewState).toHaveBeenCalledWith(expect.objectContaining({ page: 2, scale: 1.5 }));
  });

  it("returns assembled bytes only for URL-backed documents after first render", async () => {
    vi.useFakeTimers();
    try {
      const onDocumentData = vi.fn();
      render(
        <PdfPreview
          url="https://example.test/paper.pdf"
          pdfBase64={null}
          onDocumentData={onDocumentData}
        />,
      );
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });
      expect(onDocumentData).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    } finally {
      vi.useRealTimers();
    }
  });
});
