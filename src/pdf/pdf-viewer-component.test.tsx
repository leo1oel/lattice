import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

type MockPdfSlick = {
  args: {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    options: Record<string, unknown>;
  };
  dispatch: ReturnType<typeof vi.fn>;
  gotoPage: ReturnType<typeof vi.fn>;
  loadDocument: ReturnType<typeof vi.fn>;
  unbindEvents: ReturnType<typeof vi.fn>;
  viewer: {
    cleanup: ReturnType<typeof vi.fn>;
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
    args: MockPdfSlick["args"];
    dispatch: ReturnType<typeof vi.fn>;
    gotoPage: ReturnType<typeof vi.fn>;
    loadDocument: ReturnType<typeof vi.fn>;
    unbindEvents = vi.fn();
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
          queueMicrotask(() => emit("scalechanging", { scale }));
        },
        getPageView: (index: number) => this.pageViews[index],
      };
      this.gotoPage = vi.fn((page: number) => this.emit("pagechanging", { pageNumber: page }));
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
      this.loadDocument = vi.fn(async (source: string | ArrayBuffer) => {
        void source;
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
          annotationLayer.append(link);
          page.append(canvas, textLayer, annotationLayer);
          args.viewer.append(page);
          this.pageViews.push({
            div: page,
            textLayer: { div: textLayer },
            viewport: { scale: pdfSlickMock.viewportScale },
          });
        }
        this.emit("pagesinit", {});
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
        disableAutoFetch: true,
        disableFontFace: false,
        standardFontDataUrl: expect.stringContaining("/pdfjs/standard_fonts/"),
        useSystemFonts: false,
      },
    });
    expect(pdfJs.GlobalWorkerOptions.workerSrc).toContain("pdf.worker.min.mjs");
    expect(await view.findByLabelText("PDF page 3")).toBeInTheDocument();
    expect(onNumPages).toHaveBeenLastCalledWith(3);
  });

  it("uses PDFSlick navigation, native search highlights, selection, and secure links", async () => {
    const onTextSelect = vi.fn();
    const view = render(
      <PdfPreview url="https://example.test/paper.pdf" pdfBase64={null} onTextSelect={onTextSelect} />,
    );
    const pageInput = await view.findByLabelText("PDF page number");
    await waitFor(() => expect(pdfSlickMock.instances).toHaveLength(1));
    const instance = pdfSlickMock.instances[0];

    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.blur(pageInput);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(3);

    const searchInput = view.getByLabelText("Search PDF");
    fireEvent.change(searchInput, { target: { value: "attention" } });
    await waitFor(() => expect(view.getByText("1 / 3")).toBeInTheDocument());
    expect(view.container.querySelectorAll(".highlight")).toHaveLength(3);
    expect(view.container.querySelectorAll(".highlight.selected")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Next search result" }));
    expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining({
      findPrevious: false,
      type: "again",
    }));

    const textLayer = view.container.querySelector<HTMLElement>(".textLayer")!;
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      anchorNode: textLayer.firstChild,
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "Attention\u00a0 is all\n you need",
    } as Selection);
    fireEvent.mouseUp(textLayer);
    await waitFor(() => {
      expect(onTextSelect).toHaveBeenLastCalledWith("Attention is all you need");
    });
    selection.mockReturnValue({ rangeCount: 0, isCollapsed: true } as Selection);
    document.dispatchEvent(new Event("selectionchange"));
    expect(onTextSelect).toHaveBeenLastCalledWith("");
    selection.mockRestore();

    const link = view.getAllByTitle("https://example.com/paper")[0];
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
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
