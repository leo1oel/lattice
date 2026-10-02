import { expect, it, vi } from "vitest";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?worker&url";
import { invoke } from "@tauri-apps/api/core";
import { referenceAssetPreviewDataUrl } from "./reference-preview";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
  PDFDataRangeTransport: class {
    length: number;
    received: Array<[number, Uint8Array]> = [];
    constructor(length: number) { this.length = length; }
    onDataRange(begin: number, chunk: Uint8Array) { this.received.push([begin, chunk]); }
    abort() {}
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => false, readBrowserHostAsset: vi.fn() }));

const PROBE = { path: "figures/probe.pdf", mimeType: "application/pdf", ranges: { length: 8, version: "v1" } };
type RangeParams = { range: { requestDataRange(begin: number, end: number): void; received: Array<[number, Uint8Array]> } };

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
    await expect(referenceAssetPreviewDataUrl(PROBE)).resolves.toBe(preview);
    // Only the byte ranges the first page needs are read.
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 8 }), disableAutoFetch: true, disableStream: true,
    }));
    expect(render).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  } finally {
    toDataURL.mockRestore();
    if (nativeWithResolvers) Object.defineProperty(Promise, "withResolvers", nativeWithResolvers);
  }
});

it("reads a hovered PDF's ranges over raw IPC and ends the load when a read fails", async () => {
  const destroy = vi.fn(() => Promise.resolve());
  let params: RangeParams | undefined;
  vi.mocked(getDocument).mockImplementation((source) => {
    params = source as unknown as RangeParams;
    return { promise: new Promise(() => {}), destroy } as never;
  });
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([37, 80, 68, 70]).buffer);
  void referenceAssetPreviewDataUrl(PROBE);
  await vi.waitFor(() => expect(params).toBeDefined());
  params!.range.requestDataRange(0, 4);
  await vi.waitFor(() => expect(params!.range.received).toEqual([[0, new Uint8Array([37, 80, 68, 70])]]));
  expect(invoke).toHaveBeenCalledWith("read_project_asset_range", { path: "figures/probe.pdf", version: "v1", start: 0, end: 4 });

  vi.mocked(invoke).mockRejectedValueOnce(new Error("This PDF changed on disk. Open it again."));
  params!.range.requestDataRange(4, 8);
  await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
});
