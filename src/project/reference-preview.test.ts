import { expect, it, vi } from "vitest";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { referenceAssetPreviewDataUrl } from "./reference-preview";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

it("initializes the PDF.js runtime before loading a PDF without opening the main viewer", async () => {
  GlobalWorkerOptions.workerSrc = "";
  const nativeWithResolvers = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
  // Simulate a WKWebView that predates Promise.withResolvers.
  Reflect.deleteProperty(Promise, "withResolvers");
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const destroy = vi.fn(() => Promise.resolve());
  vi.mocked(getDocument).mockImplementation(() => {
    expect(GlobalWorkerOptions.workerSrc).toBe(workerUrl);
    expect(typeof Reflect.get(Promise, "withResolvers")).toBe("function");
    return {
      promise: Promise.resolve({
        getPage: vi.fn(() => Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({ width: 500 * scale, height: 300 * scale }),
          render,
        })),
      }),
      destroy,
    } as never;
  });
  const preview = "data:image/png;base64,preview";
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(preview);
  try {
    await expect(referenceAssetPreviewDataUrl({
      path: "figures/probe.pdf",
      mimeType: "application/pdf",
      base64: "JVBERi0xLjQ=",
    })).resolves.toBe(preview);
    expect(render).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  } finally {
    toDataURL.mockRestore();
    if (nativeWithResolvers) Object.defineProperty(Promise, "withResolvers", nativeWithResolvers);
  }
});
