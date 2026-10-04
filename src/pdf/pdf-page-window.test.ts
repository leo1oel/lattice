/**
 * The page window our PDF.js patch adds to PDFViewer (`PDFPageWindow`, see
 * patches/pdfjs-dist@*.patch): only the pages near the view are in the DOM,
 * and spacers keep every page's offset what it would be with all of them.
 * These drive the installed viewer, link service and find controller over a
 * stand-in document, in jsdom with a small block layout of the viewer CSS
 * (pages one under another, each but the last followed by a 10px margin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { installPdfTextLayerSelection } from "./pdf-text-layer-selection";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 700;
const GAP = 10;
/** PDF.js's viewer draws a PDF point at 4/3 of a CSS pixel at scale 1. */
const CSS_UNITS = 96 / 72;

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
  convertToViewportPoint(x: number, y: number) { return [x * this.scale, (this.size[1] - y) * this.scale]; }
  convertToPdfPoint(x: number, y: number) { return [x / this.scale, this.size[1] - y / this.scale]; }
}

/** Just enough of a PDFDocumentProxy for the viewer, link service and find controller. */
function fakeDocument(sizes: Size[], texts: Map<number, string> = new Map()) {
  const pages = sizes.map((size, index) => ({
    pageNumber: index + 1,
    rotate: 0,
    view: [0, 0, ...size],
    isPureXfa: false,
    filterFactory: {},
    getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => new FakeViewport(size, scale, rotation),
    getTextContent: async () => ({ items: [{ str: texts.get(index + 1) ?? `page ${index + 1}`, hasEOL: false }] }),
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

/**
 * Block layout of the viewer's children, as the viewer CSS lays them out:
 * page boxes and spacers one under another, a page followed by anything
 * keeping its bottom margin. Each read lays the current children out again.
 */
function installLayout(container: HTMLDivElement, viewer: HTMLDivElement) {
  const boxes = () => {
    const placed = new Map<Element, { top: number; left: number; width: number; height: number }>();
    let top = 0;
    for (const child of viewer.children) {
      const width = parseFloat((child as HTMLElement).style.width) || 0;
      const height = parseFloat((child as HTMLElement).style.height) || 0;
      placed.set(child, { top, left: Math.max(0, (VIEW_WIDTH - width) / 2), width, height });
      top += height + (child.classList.contains("page") && child.nextElementSibling ? GAP : 0);
    }
    return { placed, height: top, width: Math.max(VIEW_WIDTH, ...[...placed.values()].map((box) => box.width)) };
  };
  const box = (element: Element) => (element.parentElement === viewer ? boxes().placed.get(element) : undefined);
  let scrollTop = 0;
  let scrollLeft = 0;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = clamp(value, boxes().height - VIEW_HEIGHT); },
    },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = clamp(value, boxes().width - VIEW_WIDTH); },
    },
  });
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    if (this === container) return null;
    return this.parentElement === viewer ? container : this.parentElement;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return box(this)?.top ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return box(this)?.left ?? 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this === container ? VIEW_HEIGHT : box(this)?.height ?? 0;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this === container ? VIEW_WIDTH : box(this)?.width ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this === container ? boxes().height : 0;
  });
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    return this === container ? boxes().width : 0;
  });
}

/** Where page `number` (1-based) starts with every page in the DOM. */
function offsetOf(sizes: Size[], number: number, scale = 1) {
  let top = 0;
  for (let index = 0; index < number - 1; index += 1) top += Math.floor(sizes[index]![1] * scale * CSS_UNITS) + GAP;
  return top;
}

function extentOf(sizes: Size[], scale = 1) {
  return offsetOf(sizes, sizes.length + 1, scale) - GAP;
}

const LETTER: Size = [612, 792];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openViewer(sizes: Size[], { texts, pageWindowMinScale = 0.25 }: { texts?: Map<number, string>; pageWindowMinScale?: number } = {}) {
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  const container = document.createElement("div");
  const viewer = document.createElement("div");
  viewer.className = "pdfViewer";
  container.append(viewer);
  document.body.append(container);
  installLayout(container, viewer);
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const l10n = { translate: async () => undefined, pause: () => undefined, resume: () => undefined, get: async () => "" };
  // Rendering is out of scope: no page is ever drawn.
  const renderingQueue = { hasViewer: () => true, setViewer: () => undefined, renderHighestPriority: () => undefined, isHighestPriority: () => false };
  const pdfViewer = new PDFViewer({
    container, viewer, eventBus, linkService, findController, removePageBorders: true, annotationEditorMode: -1,
    l10n, renderingQueue,
  } as unknown as ConstructorParameters<typeof PDFViewer>[0]);
  pdfViewer.pageWindowMinScale = pageWindowMinScale;
  linkService.setViewer(pdfViewer);
  const pdfDocument = fakeDocument(sizes, texts);
  linkService.setDocument(pdfDocument);
  pdfViewer.setDocument(pdfDocument);
  await vi.waitFor(() => expect(pdfViewer.pagesCount).toBe(sizes.length));
  await settle();
  // What PDFSlick does once the pages exist.
  pdfViewer.currentScale = 1;
  pdfViewer.update();
  const attached = () => [...viewer.querySelectorAll<HTMLElement>(":scope > .page")].map((page) => Number(page.dataset.pageNumber));
  const spacers = () => [...viewer.children].filter((child) => !child.classList.contains("page")) as HTMLElement[];
  const pageDiv = (number: number) => pdfViewer.getPageView(number - 1).div as HTMLDivElement;
  const scrollTo = (top: number) => {
    container.scrollTop = top;
    pdfViewer.update();
  };
  return { pdfViewer, eventBus, linkService, container, viewer, attached, spacers, pageDiv, scrollTo, pdfDocument };
}

describe("PDF.js page window", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.dataset.testLayout = "";
    style.textContent = `.pdfViewer.removePageBorders .page { margin: 0 auto ${GAP}px; }
.pdfViewer.removePageBorders .page:last-child { margin-bottom: 0; }`;
    document.head.append(style);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.head.querySelector("style[data-test-layout]")?.remove();
  });

  it("holds only the pages near the view, and keeps the scroll extent and page offsets of the whole list", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { container, attached, spacers, pageDiv } = await openViewer(sizes);

    expect(attached()[0]).toBe(1);
    expect(attached().length).toBeLessThan(20);
    expect(container.scrollHeight).toBe(extentOf(sizes));
    for (const number of attached()) expect(pageDiv(number).offsetTop).toBe(offsetOf(sizes, number));
    // One spacer after the window stands in for the other pages.
    expect(spacers()).toHaveLength(1);
    expect(spacers()[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("moves with scrolling, and never takes out a page that stays in it", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { viewer, attached, pageDiv, scrollTo, container, pdfViewer } = await openViewer(sizes);
    const removed = new Set<Node>();
    const observer = new MutationObserver((records) => {
      for (const record of records) record.removedNodes.forEach((node) => removed.add(node));
    });
    observer.observe(viewer, { childList: true });

    // Within the window: nothing changes.
    scrollTo(offsetOf(sizes, 2));
    await settle();
    expect(observer.takeRecords()).toHaveLength(0);

    const page40 = offsetOf(sizes, 40);
    scrollTo(page40);
    await settle();
    expect(attached()).toContain(40);
    expect(attached()).not.toContain(1);
    expect(container.scrollTop).toBe(page40);
    expect(container.scrollHeight).toBe(extentOf(sizes));
    expect(pdfViewer.currentPageNumber).toBe(40);
    for (const number of attached()) expect(pageDiv(number).offsetTop).toBe(offsetOf(sizes, number));
    const kept = pageDiv(41);
    scrollTo(offsetOf(sizes, 44));
    await settle();
    expect(attached()).toContain(41);
    expect(removed.has(kept)).toBe(false);
    observer.disconnect();
  });

  it("jumps to a page outside the window from the page number, the link service and destinations", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { pdfViewer, linkService, container, attached, pageDiv } = await openViewer(sizes);

    pdfViewer.currentPageNumber = 300;
    expect(attached()).toContain(300);
    expect(container.scrollTop).toBe(offsetOf(sizes, 300));
    expect(pageDiv(300).offsetTop).toBe(offsetOf(sizes, 300));
    pdfViewer.update();
    expect(pdfViewer.currentPageNumber).toBe(300);

    linkService.goToPage(12);
    expect(attached()).toContain(12);
    expect(container.scrollTop).toBe(offsetOf(sizes, 12));

    // An XYZ destination 100pt below the top of page 250.
    pdfViewer.scrollPageIntoView({ pageNumber: 250, destArray: [null, { name: "XYZ" }, 0, 692, null] });
    expect(container.scrollTop).toBeCloseTo(offsetOf(sizes, 250) + 100 * CSS_UNITS);
    expect(attached()).toContain(250);
  });

  it("finds matches on pages outside the window and steps to them with next and previous", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const texts = new Map([[3, "the lattice needle"], [350, "another needle"], [380, "a last needle"]]);
    const { eventBus, container, attached, pdfViewer } = await openViewer(sizes, { texts });
    let matches = { current: 0, total: 0 };
    eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: typeof matches }) => { matches = matchesCount; });
    eventBus.on("updatefindcontrolstate", ({ matchesCount, state }: { matchesCount: typeof matches; state: number }) => {
      if (state !== 3) matches = matchesCount;
    });
    const find = (type: string, findPrevious = false) => eventBus.dispatch("find", {
      source: null, type, query: "needle", caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false,
    });

    find("");
    await vi.waitFor(() => expect(matches).toEqual({ current: 1, total: 3 }));
    expect(pdfViewer.currentPageNumber).toBe(3);

    find("again");
    await vi.waitFor(() => expect(matches.current).toBe(2));
    expect(pdfViewer.currentPageNumber).toBe(350);
    expect(attached()).toContain(350);
    expect(container.scrollTop).toBe(offsetOf(sizes, 350));

    find("again");
    await vi.waitFor(() => expect(matches.current).toBe(3));
    expect(attached()).toContain(380);
    expect(container.scrollTop).toBe(offsetOf(sizes, 380));

    find("again", true);
    await vi.waitFor(() => expect(matches.current).toBe(2));
    expect(container.scrollTop).toBe(offsetOf(sizes, 350));
    expect(matches.total).toBe(3);
  });

  it("re-sizes the window and its spacers when the zoom changes, keeping the current page", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { pdfViewer, container, attached, pageDiv, scrollTo } = await openViewer(sizes);
    scrollTo(offsetOf(sizes, 200));

    pdfViewer.currentScale = 2;
    pdfViewer.update();
    expect(container.scrollHeight).toBe(extentOf(sizes, 2));
    expect(pdfViewer.currentPageNumber).toBe(200);
    expect(container.scrollTop).toBe(offsetOf(sizes, 200, 2));
    for (const number of attached()) expect(pageDiv(number).offsetTop).toBe(offsetOf(sizes, number, 2));

    pdfViewer.currentScale = 0.5;
    pdfViewer.update();
    expect(container.scrollHeight).toBe(extentOf(sizes, 0.5));
    expect(container.scrollTop).toBe(offsetOf(sizes, 200, 0.5));
    // Everything the view would show zoomed out to the window's minimum scale
    // (0.25, half this one) around any point in it: the view's height (the
    // window's, if taller) twice over on either side.
    const height = Math.max(VIEW_HEIGHT, window.innerHeight);
    const reach = height * 0.5 / 0.25;
    const top = container.scrollTop;
    const pageHeight = Math.floor(LETTER[1] * 0.5 * CSS_UNITS);
    const needed = sizes.map((_, index) => index + 1)
      .filter((number) => offsetOf(sizes, number, 0.5) + pageHeight > top - reach && offsetOf(sizes, number, 0.5) < top + height + reach);
    expect(needed.length).toBeGreaterThan(5);
    expect(attached()).toEqual(expect.arrayContaining(needed));
  });

  it("keeps a page holding focus while it is scrolled out of the window", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { pageDiv, attached, spacers, scrollTo, linkService } = await openViewer(sizes);
    const field = document.createElement("input");
    pageDiv(2).append(field);
    field.focus();

    linkService.goToPage(300);
    expect(attached()).toContain(2);
    expect(attached()).toContain(300);
    expect(document.activeElement).toBe(field);
    expect(pageDiv(2).offsetTop).toBe(offsetOf(sizes, 2));
    expect(pageDiv(300).offsetTop).toBe(offsetOf(sizes, 300));
    // Before page 2 (page 1), between it and the window, and after the window.
    expect(spacers()).toHaveLength(3);

    field.blur();
    scrollTo(offsetOf(sizes, 200));
    expect(attached()).not.toContain(2);
  });

  it("keeps every page a selection runs through, so copying it after scrolling away copies all of it", async () => {
    const sizes = Array.from({ length: 400 }, () => LETTER);
    const { pageDiv, attached, scrollTo } = await openViewer(sizes);
    // A text layer on each of pages 1 to 4, under the production copy handler.
    const glyphs = [1, 2, 3, 4].map((number) => {
      const layer = document.createElement("div");
      layer.className = "textLayer";
      const span = document.createElement("span");
      span.textContent = `Page ${number} text. `;
      layer.append(span);
      pageDiv(number).append(layer);
      return { span, uninstall: installPdfTextLayerSelection(layer) };
    });
    const copy = () => {
      const stored = new Map<string, string>();
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { setData: (type: string, value: string) => stored.set(type, value), getData: (type: string) => stored.get(type) ?? "" },
      });
      document.dispatchEvent(event);
      return stored.get("text/plain");
    };
    try {
      // From the start of page 1 to the end of page 3, as a drag across them leaves it.
      const range = document.createRange();
      range.setStart(glyphs[0]!.span.firstChild!, 0);
      range.setEnd(glyphs[2]!.span.firstChild!, glyphs[2]!.span.textContent!.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      const before = copy();
      expect(before).toBe("Page 1 text. Page 2 text. Page 3 text.");

      scrollTo(offsetOf(sizes, 300));
      expect(attached()).toContain(300);
      // Page 2 holds neither end of the range, but its text is in it.
      expect(attached()).toEqual(expect.arrayContaining([1, 2, 3]));
      expect(attached()).not.toContain(4);
      expect(copy()).toBe(before);

      // Cleared, the selection holds nothing back.
      document.getSelection()!.removeAllRanges();
      scrollTo(offsetOf(sizes, 200));
      expect(attached()).not.toContain(2);
    } finally {
      for (const { uninstall } of glyphs) uninstall();
    }
  });

  it("sizes spacers from each page's own box, as pages load with sizes of their own", async () => {
    // Page 9 is landscape; until it loads, PDF.js gives every page the first one's size.
    const sizes: Size[] = Array.from({ length: 120 }, (_, index) => (index === 8 ? [792, 612] : LETTER));
    const { pdfViewer, container, pdfDocument, spacers, scrollTo, pageDiv } = await openViewer(sizes);
    scrollTo(offsetOf(sizes, 100));
    expect(container.scrollHeight).toBe(extentOf(sizes.map(() => LETTER)));

    pdfViewer.getPageView(8).setPdfPage(await pdfDocument.getPage(9));
    pdfViewer.update();
    expect(container.scrollHeight).toBe(extentOf(sizes));
    expect(pageDiv(100).offsetTop).toBe(offsetOf(sizes, 100));
    // The scroll width is the widest page's, wherever it is.
    expect(spacers()[0]!.style.width).toBe(`${Math.floor(792 * CSS_UNITS)}px`);
    expect(container.scrollWidth).toBe(Math.max(VIEW_WIDTH, Math.floor(792 * CSS_UNITS)));
  });

  it("keeps every page in the DOM unless the viewer opts in", async () => {
    const sizes = Array.from({ length: 50 }, () => LETTER);
    const { attached, spacers } = await openViewer(sizes, { pageWindowMinScale: 0 });

    expect(attached()).toHaveLength(50);
    expect(spacers()).toHaveLength(0);
  });
});
