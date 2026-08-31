import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

const pdfJs = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));
const browserRuntime = vi.hoisted(() => ({
  hosted: false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../platform/browser-runtime", () => ({
  isBrowserHosted: () => browserRuntime.hosted,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {
    render = vi.fn(async () => undefined);
    cancel = vi.fn();
  },
  getDocument: pdfJs.getDocument,
}));

function mockDocument(numPages = 1) {
  const renderPages = Array.from({ length: numPages }, () => vi.fn((_context: {
    transform?: number[];
    viewport: { width: number; height: number };
  }) => ({
    cancel: vi.fn(),
    onContinue: undefined as ((continuation: () => void) => void) | undefined,
    promise: Promise.resolve(),
  })));
  const pages = renderPages.map((renderPage) => ({
    cleanup: vi.fn(),
    getAnnotations: vi.fn(async () => []),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
    })),
    render: renderPage,
    streamTextContent: vi.fn(() => ({})),
  }));
  const documentProxy = {
    cleanup: vi.fn(),
    getData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
    numPages,
  };
  const destroy = vi.fn(async () => undefined);
  pdfJs.getDocument.mockReturnValue({
    destroy,
    promise: Promise.resolve(documentProxy),
  });
  return { documentProxy, renderPage: renderPages[0], renderPages };
}

describe("PDF viewer controls", () => {
  beforeEach(() => {
    browserRuntime.hosted = false;
    pdfJs.getDocument.mockReset();
    localStorage.clear();
  });

  it("does not reserve an outline track when an outline component renders nothing", () => {
    const EmptyOutline = () => null;
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        outline={<EmptyOutline />}
      />,
    );

    const findControls = view.container.querySelector(".pdf-find-controls");
    expect(findControls).not.toBeNull();
    expect(findControls?.querySelector(".pdf-outline-trigger")).toBeNull();
    expect(findControls?.querySelector(".pdf-search")).toBeInTheDocument();
  });

  it("keeps the search input controlled as compiled PDFs appear and disappear", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<PdfPreview url={null} pdfBase64={null} />);

      view.rerender(<PdfPreview url="blob:lattice-compiled-pdf" pdfBase64={null} />);
      view.rerender(<PdfPreview url={null} pdfBase64={null} />);

      const errors = consoleError.mock.calls.flat().join("\n");
      expect(errors).not.toContain("changing an uncontrolled input to be controlled");
      expect(errors).not.toContain("changing a controlled input to be uncontrolled");
      view.unmount();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("starts from a file's local page and zoom without overwriting it before load", () => {
    const onViewState = vi.fn();
    const onPageChange = vi.fn();
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        initialViewState={{
          page: 7,
          scale: 1.75,
          fitMode: null,
          scrollTop: 640,
          scrollLeft: 30,
        }}
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

  it("renders a browser-hosted first paint at target DPI without a refinement pass", async () => {
    browserRuntime.hosted = true;
    const { renderPage } = mockDocument();
    const pixelRatio = vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        pdfBytes={new ArrayBuffer(8)}
        initialViewState={{ page: 1, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 }}
      />,
    );

    await waitFor(() => expect(renderPage).toHaveBeenCalledOnce());
    expect(renderPage.mock.calls[0]?.[0]).toMatchObject({
      transform: [2, 0, 0, 2, 0, 0],
      viewport: { width: 600, height: 800 },
    });
    expect(view.container.querySelector("canvas")).toMatchObject({ width: 1_200, height: 1_600 });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(renderPage).toHaveBeenCalledOnce();

    pixelRatio.mockRestore();
    view.unmount();
  });

  it("retains the progressive low-DPI fallback in WKWebView", async () => {
    const { renderPage } = mockDocument();
    const pixelRatio = vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        pdfBytes={new ArrayBuffer(8)}
        initialViewState={{ page: 1, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 }}
      />,
    );

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    expect(renderPage.mock.calls[0]?.[0]).toMatchObject({
      viewport: { width: 600, height: 800 },
    });
    expect(renderPage.mock.calls[0]?.[0].transform).toBeUndefined();
    expect(renderPage.mock.calls[1]?.[0]).toMatchObject({
      transform: [2, 0, 0, 2, 0, 0],
      viewport: { width: 600, height: 800 },
    });

    pixelRatio.mockRestore();
    view.unmount();
  });

  it("keeps a recently rendered page mounted across viewport-window changes", async () => {
    browserRuntime.hosted = true;
    const { renderPages } = mockDocument(12);
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        pdfBytes={new ArrayBuffer(8)}
        initialViewState={{ page: 1, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 }}
      />,
    );

    await waitFor(() => expect(renderPages[0]).toHaveBeenCalledOnce());
    const firstPageCanvas = view.container.querySelector('[data-pdf-page="1"] canvas');
    expect(firstPageCanvas).not.toBeNull();
    const pageInput = view.getByRole("textbox", { name: "PDF page number" });

    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "11" } });
    fireEvent.blur(pageInput);
    await waitFor(() => expect(renderPages[10]).toHaveBeenCalledOnce());
    expect(view.container.querySelectorAll(".pdf-page-content")).toHaveLength(10);
    expect(view.container.querySelector('[data-pdf-page="1"] canvas')).toBe(firstPageCanvas);

    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "1" } });
    fireEvent.blur(pageInput);
    await waitFor(() => expect(pageInput).toHaveValue("1"));
    expect(view.container.querySelector('[data-pdf-page="1"] canvas')).toBe(firstPageCanvas);
    expect(renderPages[0]).toHaveBeenCalledOnce();
    view.unmount();
  });
});
