import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

type Destination = { page: number; scrollTop: number; scrollLeft: number; scaleValue?: string };
type LoadProgress = { loaded: number; total: number; percent: number };
type PageView = { div: HTMLDivElement; textLayer: { div: HTMLDivElement }; viewport: { scale: number } };

const pdf = vi.hoisted(() => {
  const state = {
    instances: [] as PdfSlickMock[],
    numPages: 3,
    viewportScale: 1,
    deferLoad: false,
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
    pageViews: PageView[] = [];
    handlers = new Map<string, Array<(event: object) => void>>();
    readyListeners = new Set<() => void>();
    pagesReady = false;
    findIndex = 0;
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

    dispatch = vi.fn((name: string, event: Record<string, unknown>) => {
      if (name !== "find" && name !== "findbarclose") return;
      const query = String(event.query ?? "").toLocaleLowerCase();
      const matches = name === "find"
        ? this.pageViews.filter((page) => (page.div.textContent ?? "").toLocaleLowerCase().includes(query))
        : [];
      this.findIndex = event.type === "again" && matches.length
        ? (this.findIndex + (event.findPrevious ? -1 : 1) + matches.length) % matches.length
        : 0;
      for (const page of this.pageViews) page.div.querySelectorAll(".highlight").forEach((node) => node.remove());
      for (const [index, page] of matches.entries()) {
        const highlight = document.createElement("span");
        highlight.className = `highlight${index === this.findIndex ? " selected" : ""}`;
        highlight.textContent = query;
        page.div.querySelector(".textLayer")?.append(highlight);
      }
      this.emit("updatefindmatchescount", {
        matchesCount: { current: matches.length ? this.findIndex + 1 : 0, total: matches.length },
      });
    });

    loadDocument = vi.fn(async (_source: string | ArrayBuffer, options?: { onProgress?: (progress: LoadProgress) => void }) => {
      if (state.deferLoad) {
        await new Promise<void>((resolve) => {
          state.pendingLoad = { onProgress: options?.onProgress, resolve };
        });
      }
      this.document = {
        numPages: state.numPages,
        getData: async () => new Uint8Array([1, 2, 3]),
        loadingTask: { destroy: vi.fn(async () => undefined) },
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
});

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => pdf.state.hosted }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: pdf.state.workerOptions }));
vi.mock("@pdfslick/core", () => ({ PDFSlick: pdf.PdfSlickMock }));

const PAPER = "https://example.test/paper.pdf";
type PreviewProps = Partial<ComponentProps<typeof PdfPreview>>;
const preview = (props: PreviewProps = {}) => <PdfPreview url={PAPER} pdfBase64={null} {...props} />;
const renderPdf = (props: PreviewProps = {}) => render(preview(props));

/** Wait for the (index + 1)th viewer, i.e. a debounced replacement after a source change. */
async function viewerAt(index: number) {
  await waitFor(() => expect(pdf.state.instances).toHaveLength(index + 1), { timeout: 2_500 });
  return pdf.state.instances[index]!;
}

const pointer = (target: EventTarget, type: "pointerdown" | "pointerup", init: PointerEventInit = {}) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, ...init }));

/** An internal-link annotation like PDF.js renders for `\cite`, appended to `page`. */
function appendInternalLink(page: HTMLElement, href = "") {
  const layer = document.createElement("div");
  layer.className = "annotationLayer";
  layer.innerHTML = `<section data-internal-link><a href="${href}"></a></section>`;
  page.append(layer);
  return { annotation: layer.firstElementChild as HTMLElement, link: layer.querySelector("a")! };
}

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe("PDFSlick viewer integration", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    Object.assign(pdf.state, {
      instances: [], numPages: 3, viewportScale: 1, deferLoad: false, deferReady: false, pendingLoad: null, hosted: false,
    });
    localStorage.clear();
  });

  it("does not reserve an outline track when an outline component renders nothing", () => {
    const EmptyOutline = () => null;
    const view = renderPdf({ url: null, outline: <EmptyOutline /> });

    const findControls = view.container.querySelector(".pdf-find-controls");
    expect(findControls?.querySelector(".pdf-outline-trigger")).toBeNull();
    expect(findControls?.querySelector(".pdf-search")).toBeInTheDocument();
  });

  it("keeps the search input controlled as compiled PDFs appear and disappear", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderPdf({ url: null });

    view.rerender(preview({ url: "blob:lattice-compiled-pdf" }));
    view.rerender(preview({ url: null }));

    const errors = consoleError.mock.calls.flat().join("\n");
    expect(errors).not.toContain("changing an uncontrolled input to be controlled");
    expect(errors).not.toContain("changing a controlled input to be uncontrolled");
  });

  it("starts from a file's local page and zoom without overwriting it before load", () => {
    const onViewState = vi.fn();
    const onPageChange = vi.fn();
    const view = renderPdf({
      url: null,
      initialViewState: { page: 7, scale: 1.75, fitMode: null, scrollTop: 640, scrollLeft: 30 },
      onPageChange,
      onViewState,
    });

    expect(onPageChange).toHaveBeenLastCalledWith(7);
    expect(JSON.parse(localStorage.getItem("lattice.pdf-view-preference.v1") ?? "null"))
      .toEqual({ fitMode: null, scale: 1.75 });
    view.unmount();
    expect(onViewState).not.toHaveBeenCalled();
  });

  it("constructs PDFSlick with virtualized high-resolution rendering and local PDF.js assets", async () => {
    pdf.state.hosted = true;
    const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const onNumPages = vi.fn();
    const view = renderPdf({
      url: null,
      pdfBytes: bytes,
      initialViewState: { page: 1, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 },
      onNumPages,
    });

    const instance = await viewerAt(0);
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
    expect(pdf.state.workerOptions.workerSrc).toContain("pdf.worker.min.mjs");
    expect(await view.findByLabelText("PDF page 3")).toBeInTheDocument();
    expect(onNumPages).toHaveBeenLastCalledWith(3);
  });

  it("draws the pane's scrollbars as hover-reveal overlay bars on the PDF.js viewport", async () => {
    const view = renderPdf();
    expect(await view.findByLabelText("PDF page 1")).toBeInTheDocument();

    const area = view.container.querySelector(".pdf-scroll-area")!;
    expect(area.querySelectorAll(":scope > .overlay-scrollbar")).toHaveLength(2);

    // PDF.js creates the scrolling element, so prove the bars found it.
    const viewport = view.container.querySelector<HTMLElement>(".pdf-scroll-area-viewport")!;
    const vertical = area.querySelector<HTMLElement>('.overlay-scrollbar[data-orientation="vertical"]')!;
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
    pdf.state.deferLoad = true;
    const view = renderPdf();

    await waitFor(() => expect(pdf.state.pendingLoad).not.toBeNull());
    const pendingLoad = pdf.state.pendingLoad!;
    expect(view.getByRole("status")).toHaveTextContent("Loading PDF…");

    act(() => pendingLoad.onProgress?.({ loaded: 3, total: 10, percent: 30 }));
    expect(view.getByRole("status")).toHaveTextContent("Loading PDF…30%");
    expect(view.getByRole("progressbar", { name: "PDF loading progress" })).toHaveAttribute("aria-valuenow", "30");
    expect(view.container.querySelector(".pdf-load-progress-fill")).toHaveStyle({ width: "30%" });

    act(() => pendingLoad.onProgress?.({ loaded: 10, total: 10, percent: 100 }));
    expect(view.getByRole("status")).toHaveTextContent("Rendering first page…");
    expect(view.queryByRole("progressbar", { name: "PDF loading progress" })).toBeNull();

    await act(async () => pendingLoad.resolve());
    expect(await view.findByLabelText("PDF page 1")).toBeInTheDocument();
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  });

  it.each(["blank page", "text glyph"])("uses PDFSlick navigation, search, links, and clears selection on a %s click", async (clearTarget) => {
    const onTextSelect = vi.fn();
    const view = renderPdf({ onTextSelect });
    const pageInput = await view.findByLabelText("PDF page number");
    const instance = await viewerAt(0);
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
    const lastFind = (options: object) => expect(instance.dispatch).toHaveBeenLastCalledWith("find", expect.objectContaining(options));
    fireEvent.click(matchCase);
    await waitFor(() => lastFind({ caseSensitive: true, entireWord: false, query: "attention" }));
    fireEvent.click(wholeWord);
    await waitFor(() => lastFind({ caseSensitive: true, entireWord: true, query: "attention" }));

    fireEvent.keyDown(searchInput, { key: "Enter", shiftKey: true });
    lastFind({ findPrevious: true, type: "again" });
    fireEvent.click(view.getByRole("button", { name: "Next search result" }));
    lastFind({ findPrevious: false, type: "again" });

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
    await waitFor(() => expect(onTextSelect).toHaveBeenLastCalledWith("Attention is all you need"));
    const surface = view.container.querySelector<HTMLElement>(".pdf-preview")!;
    const findShortcut = async (modifier: object) => {
      surface.focus();
      fireEvent.keyDown(surface, { key: "f", ...modifier });
      await waitFor(() => {
        expect(searchInput).toHaveFocus();
        expect(searchInput).toHaveValue("Attention is all you need");
      });
    };
    await findShortcut({ metaKey: true });
    fireEvent.change(searchInput, { target: { value: "other query" } });
    await findShortcut({ ctrlKey: true });
    glyph.getClientRects = () => [box(0, 0, 100, 20)] as unknown as DOMRectList;
    pointer(glyph, "pointerdown", { clientX: 10, clientY: 10 });
    pointer(document, "pointerup");
    const collapsedSelection = { rangeCount: 0, isCollapsed: true } as Selection;
    selection.mockReturnValue(collapsedSelection);
    documentSelection.mockReturnValue(collapsedSelection);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.mouseUp(glyph);
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    expect(onTextSelect).toHaveBeenLastCalledWith("Attention is all you need");
    const target = clearTarget === "text glyph" ? glyph : view.container.querySelector<HTMLElement>(".page canvas")!;
    pointer(target, "pointerdown", { clientX: 10, clientY: 10 });
    pointer(target, "pointerup");
    expect(onTextSelect).toHaveBeenLastCalledWith("");
    fireEvent.mouseUp(target);
    await waitFor(() => expect(onTextSelect).toHaveBeenLastCalledWith(""));

    const link = view.getAllByTitle("https://example.com/paper")[0];
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("previews project citations without intercepting PDF navigation and keeps the card clickable", async () => {
    const citation = { key: "smith:2024", title: "A useful paper", authors: "Smith and Chen", year: "2024", venue: "Example Journal" };
    const onOpenCitation = vi.fn();
    const view = renderPdf({ url: "https://example.test/first.pdf", citations: [citation], canOpenCitation: () => true, onOpenCitation });
    const { link } = appendInternalLink(await view.findByLabelText("PDF page 1"), "#cite.0%40smith%3A2024");
    const navigate = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", navigate);
    fireEvent.pointerOver(link);
    const title = await view.findByRole("button", { name: citation.title });
    expect(view.getByText("Smith · Chen")).toBeInTheDocument();
    expect(view.getByText("Example Journal · 2024")).toBeInTheDocument();
    fireEvent.pointerOut(link);
    fireEvent.pointerEnter(title.closest(".citation-hover-card")!);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(title).toBeInTheDocument();
    fireEvent.click(title);
    expect(onOpenCitation).toHaveBeenCalledWith(citation.key);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.focusIn(link);
    await view.findByRole("button", { name: citation.title });
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledOnce();
    expect(view.queryByText(citation.title)).toBeNull();
    expect(onOpenCitation).toHaveBeenCalledOnce();
  });

  it("ignores non-citations, supports escaped keys, and dismisses on scroll and document replacement", async () => {
    const citation = { key: "中文", title: "Metadata only", authors: "", year: "", venue: "" };
    const props = { url: "https://example.test/first.pdf", citations: [citation] };
    const view = renderPdf(props);
    const { annotation, link } = appendInternalLink(await view.findByLabelText("PDF page 1"));
    const expectNoCardAfterFocus = async () => {
      fireEvent.focusIn(link);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(view.queryByText(citation.title)).toBeNull();
    };
    const showCard = async () => {
      fireEvent.focusIn(link);
      await view.findByText(citation.title);
    };
    for (const href of ["#section.1", "#cite.unknown", "#cite.%ZZ"]) {
      link.href = href;
      await expectNoCardAfterFocus();
    }
    link.href = "#cite.%u4E2D%u6587";
    annotation.removeAttribute("data-internal-link");
    await expectNoCardAfterFocus();
    annotation.setAttribute("data-internal-link", "");
    await showCard();
    expect(view.queryByRole("button", { name: citation.title })).toBeNull();
    fireEvent.scroll(pdf.state.instances[0]!.args.container);
    expect(view.queryByText(citation.title)).toBeNull();
    await showCard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByText(citation.title)).toBeNull();
    await showCard();
    view.rerender(preview({ ...props, url: "https://example.test/second.pdf" }));
    await waitFor(() => expect(view.queryByText(citation.title)).toBeNull());
  });

  it("returns to exact locations after internal PDF link jumps and clears history on replacement", async () => {
    const view = renderPdf({ url: "https://example.test/first.pdf" });
    await view.findByLabelText("PDF page 1");
    const instance = pdf.state.instances[0]!;
    const viewport = instance.args.container;
    const back = view.getByRole("button", { name: "Previous PDF location" });
    const forward = view.getByRole("button", { name: "Next PDF location" });
    const expectHistory = (backEnabled: boolean, forwardEnabled: boolean) => {
      expect(back.hasAttribute("disabled")).toBe(!backEnabled);
      expect(forward.hasAttribute("disabled")).toBe(!forwardEnabled);
    };
    expectHistory(false, false);

    instance.linkService.page = 1;
    viewport.scrollTop = 240;
    viewport.scrollLeft = 12;
    fireEvent.click(view.getAllByTitle("Jump to PDF page 3")[0]);
    await waitFor(() => expect(back).toBeEnabled());
    expectHistory(true, false);
    expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([1_200, 24]);

    fireEvent.click(back);
    await waitFor(() => expect(viewport.scrollTop).toBe(240));
    expect(viewport.scrollLeft).toBe(12);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(1);
    expectHistory(false, true);

    fireEvent.click(forward);
    await waitFor(() => expect(viewport.scrollTop).toBe(1_200));
    expect(viewport.scrollLeft).toBe(24);
    expect(instance.gotoPage).toHaveBeenLastCalledWith(3);
    expectHistory(true, false);

    view.rerender(preview({ url: "https://example.test/second.pdf" }));
    await viewerAt(1);
    await waitFor(() => expect(back).toBeDisabled());
    expect(forward).toBeDisabled();
  });

  it("preserves forward and reverse SyncTeX point coordinates", async () => {
    pdf.state.viewportScale = 2;
    const onSource = vi.fn();
    const view = renderPdf({ onSource, syncTarget: { id: "sync-1", page: 2, x: 72, y: 96, width: 120, height: 14 } });
    const page = await view.findByLabelText("PDF page 2");
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(box(10, 20, 600, 800));

    await waitFor(() => expect(view.getByLabelText("Source location in PDF")).toHaveStyle({
      left: "144px",
      top: "192px",
      width: "240px",
      height: "28px",
    }));
    fireEvent.doubleClick(page, { clientX: 110, clientY: 220 });
    expect(onSource).toHaveBeenCalledWith(2, 50, 100);
  });

  it("restores a SyncTeX highlight cleared by first page rendering without replaying navigation", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const view = renderPdf({ syncTarget: { id: "cold-sync", page: 3, x: 83, y: 238, width: 421, height: 13 } });
    const highlight = await view.findByLabelText("Source location in PDF");
    expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    const instance = pdf.state.instances[0]!;
    const jumps = instance.gotoPage.mock.calls.length;
    const scrolls = scroll.mock.calls.length;

    // PDF.js clears page children on the first render of an unvisited page.
    highlight.remove();
    instance.args.container.scrollTop = 2_350;
    act(() => instance.emit("pagerendered", { pageNumber: 3 }));
    expect(await view.findByLabelText("Source location in PDF")).toBeInTheDocument();
    expect(instance.gotoPage).toHaveBeenCalledTimes(jumps);
    expect(scroll).toHaveBeenCalledTimes(scrolls);
    expect(instance.args.container.scrollTop).toBe(2_350);
  });

  it("navigates to a quote page but conservatively skips an ambiguous highlight", async () => {
    const view = renderPdf({
      initialViewState: { page: 1, scale: 1, fitMode: null, scrollTop: 450, scrollLeft: 0 },
      sourceQuote: { id: "ambiguous", page: 2, first: "Attention", last: "Attention" },
    });
    await view.findByLabelText("PDF page 2");
    const instance = pdf.state.instances[0]!;
    const layer = instance.viewer.getPageView(1).textLayer.div;
    layer.append(layer.firstChild!.cloneNode(true));
    act(() => instance.emit("textlayerrendered", { pageNumber: 2 }));

    await waitFor(() => expect(instance.gotoPage).toHaveBeenCalledWith(2));
    expect(instance.args.container.scrollTop).toBe(1_000);
    expect(layer.querySelector(".pdf-source-quote-highlight")).toBeNull();
  });

  it("waits for delayed target-page text and highlights across quote boundaries", async () => {
    const view = renderPdf({ sourceQuote: { id: "delayed", page: 3, first: "Unique opening", last: "closing words" } });
    await view.findByLabelText("PDF page 3");
    const instance = pdf.state.instances[0]!;
    const layer = instance.viewer.getPageView(2).textLayer.div;
    layer.replaceChildren();
    act(() => instance.emit("textlayerrendered", { pageNumber: 3 }));
    expect(layer.querySelector(".pdf-source-quote-highlight")).toBeNull();

    layer.innerHTML = "<span>Unique opening and </span><span>closing words</span>";
    act(() => instance.emit("textlayerrendered", { pageNumber: 3 }));

    await waitFor(() => expect(layer.querySelectorAll(".pdf-source-quote-highlight")).toHaveLength(2));
    expect(instance.gotoPage).toHaveBeenCalledTimes(2); // promotion, then the new quote target
  });

  it("cleans the old quote highlight on target change and unmount", async () => {
    const view = renderPdf({ sourceQuote: { id: "first", page: 1, first: "Attention", last: "page 1" } });
    const firstLayer = (await view.findByLabelText("PDF page 1")).querySelector(".textLayer")!;
    await waitFor(() => expect(firstLayer.querySelector(".pdf-source-quote-highlight")).not.toBeNull());

    view.rerender(preview({ sourceQuote: { id: "second", page: 2, first: "Attention", last: "page 2" } }));
    const secondLayer = view.getByLabelText("PDF page 2").querySelector(".textLayer")!;
    await waitFor(() => expect(secondLayer.querySelector(".pdf-source-quote-highlight")).not.toBeNull());
    expect(firstLayer.querySelector(".pdf-source-quote-highlight")).toBeNull();

    view.unmount();
    expect(secondLayer.querySelector(".pdf-source-quote-highlight")).toBeNull();
  });

  it.each([
    { pages: 3, viewportScale: 1, restoredTop: 2_817 },
    { pages: 2, viewportScale: 1.5, restoredTop: 3_125.5 },
  ])("keeps the old viewer until ready and restores its latest offset with $pages pages at scale $viewportScale", async ({ pages, viewportScale, restoredTop }) => {
    const view = renderPdf({ url: "https://example.test/old.pdf" });
    await view.findByLabelText("PDF page 3");
    const old = pdf.state.instances[0]!;
    act(() => old.gotoPage(3));
    old.args.container.scrollTop = 2_430;
    Object.defineProperty(old.viewer.getPageView(2).div, "offsetTop", { value: 2_000 });

    Object.assign(pdf.state, { deferReady: true, numPages: pages, viewportScale });
    view.rerender(preview({ url: "https://example.test/new.pdf" }));
    const replacement = await viewerAt(1);
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

  it("redraws an existing source highlight on a same-size replacement without replaying its navigation", async () => {
    const target = { id: "old-target", page: 2, x: 20, y: 80, width: 30, height: 12 };
    const view = renderPdf({ url: "https://example.test/old.pdf", syncTarget: target });
    await view.findByLabelText("Source location in PDF");
    const old = pdf.state.instances[0]!;
    act(() => old.gotoPage(3));
    old.args.container.scrollTop = 2_617;
    view.rerender(preview({ url: "https://example.test/new.pdf", syncTarget: target }));
    const replacement = await viewerAt(1);
    const replacementPage = replacement.viewer.getPageView(1).div;
    await waitFor(() => expect(replacementPage.querySelector("[data-sync-target='old-target']")).not.toBeNull());
    expect(replacement.gotoPage).not.toHaveBeenCalledWith(2);
    expect(replacement.args.container.scrollTop).toBe(2_617);

    replacement.gotoPage.mockClear();
    act(() => { replacement.viewer.currentScale = 1.5; });
    await act(async () => undefined);
    expect(replacement.gotoPage).not.toHaveBeenCalled();

    view.rerender(preview({ url: "https://example.test/new.pdf", syncTarget: { ...target, id: "new-target" } }));
    await waitFor(() => expect(replacement.gotoPage).toHaveBeenCalledWith(2));
  });

  it("tears down each replaced viewer so rebuilds do not accumulate PDF.js pages", async () => {
    // Regression: destroying only the loading task left PDF.js's static
    // text-layer map, the viewer's document listeners and every rendered
    // canvas of the previous build reachable, so each rebuild leaked a viewer.
    const view = renderPdf({ url: "https://example.test/build-1.pdf" });
    await view.findByLabelText("PDF page 3");
    const first = pdf.state.instances[0]!;
    const canvases = [...first.args.viewer.querySelectorAll("canvas")];
    for (const canvas of canvases) {
      canvas.width = 800;
      canvas.height = 1_000;
    }
    const firstTask = first.document!.loadingTask;

    view.rerender(preview({ url: "https://example.test/build-2.pdf" }));
    const replacement = await viewerAt(1);
    await waitFor(() => expect(first.args.container.isConnected).toBe(false));
    await act(async () => undefined);

    expect(first.viewer.setDocument).toHaveBeenCalledWith(null);
    expect(first.linkService.setDocument).toHaveBeenCalledWith(null);
    expect(firstTask.destroy).toHaveBeenCalledOnce();
    expect(canvases.map((canvas) => [canvas.width, canvas.height])).toEqual(
      canvases.map(() => [0, 0]),
    );
    expect(replacement.viewer.setDocument).not.toHaveBeenCalledWith(null);
  });

  it("does not promote a staged viewer after unmount", async () => {
    pdf.state.deferReady = true;
    const view = renderPdf();
    const pending = await viewerAt(0);
    view.unmount();
    act(() => pending.finishReady());
    expect(pending.gotoPage).not.toHaveBeenCalled();
    expect(pending.args.container.isConnected).toBe(false);
  });

  it("restores local view state and destroys PDFSlick without leaving page nodes", async () => {
    const onViewState = vi.fn();
    const view = renderPdf({
      initialViewState: { page: 2, scale: 1.5, fitMode: null, scrollTop: 640, scrollLeft: 30 },
      onViewState,
    });
    await view.findByLabelText("PDF page 2");
    const instance = pdf.state.instances[0]!;
    await waitFor(() => expect(instance.gotoPage).toHaveBeenCalledWith(2));
    expect([instance.args.container.scrollTop, instance.args.container.scrollLeft]).toEqual([640, 30]);

    view.unmount();
    await act(async () => undefined);
    expect(instance.unbindEvents).toHaveBeenCalledOnce();
    expect(instance.viewer.setDocument).toHaveBeenCalledWith(null);
    expect(document.querySelectorAll(".pdfViewer .page")).toHaveLength(0);
    expect(onViewState).toHaveBeenCalledWith(expect.objectContaining({ page: 2, scale: 1.5 }));
  });

  it("returns assembled bytes only for URL-backed documents after first render", async () => {
    vi.useFakeTimers();
    const onDocumentData = vi.fn();
    renderPdf({ onDocumentData });
    for (const ms of [200, 800]) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
      });
    }
    expect(onDocumentData).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });
});
