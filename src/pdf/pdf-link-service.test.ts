import { expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";

it("keeps an internal citation destination when its text layer first receives focus", async () => {
  // Exercise the installed link service, not the PDFSlick mock: the extra
  // focus happens asynchronously after destination navigation has finished.
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { EventBus, PDFLinkService } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const destination = [13, { name: "XYZ" }, 83.093, 567.267, null];
  const getDestination = vi.fn(async () => destination);
  linkService.setDocument({ pagesMapper: { pagesNumber: 23 }, getDestination } as unknown as PDFDocumentProxy);
  const scrollPageIntoView = vi.fn();
  linkService.setViewer({ scrollPageIntoView } as unknown as Parameters<typeof linkService.setViewer>[0]);
  const focus = vi.fn();

  await linkService.goToDestination("cite.liu2023llava");
  expect(scrollPageIntoView).toHaveBeenCalledWith({
    pageNumber: 14,
    destArray: destination,
    ignoreDestinationZoom: false,
  });
  expect(focus).not.toHaveBeenCalled();
  eventBus.dispatch("textlayerrendered", { pageNumber: 13, source: { textLayer: { div: { focus } } } });
  expect(focus).not.toHaveBeenCalled();
  eventBus.dispatch("textlayerrendered", { pageNumber: 14, source: { textLayer: { div: { focus } } } });
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });

  // A later repaint must not steal keyboard focus from the reader again.
  eventBus.dispatch("textlayerrendered", { pageNumber: 14, source: { textLayer: { div: { focus } } } });
  expect(focus).toHaveBeenCalledTimes(1);
});
