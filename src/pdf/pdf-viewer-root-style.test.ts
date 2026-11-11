/**
 * Our PDF.js patch (patches/pdfjs-dist@*.patch) keeps PDFViewer's
 * `--viewer-container-height` on the viewer's container. Upstream sets it on
 * <html>, where every change of the container's height restyles the whole
 * window.
 */
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--viewer-container-height");
});

it("keeps the viewer's container height off the root element", async () => {
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { EventBus, PDFLinkService, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  const container = document.createElement("div");
  const viewer = document.createElement("div");
  viewer.className = "pdfViewer";
  container.append(viewer);
  document.body.append(container);
  Object.defineProperty(container, "clientHeight", { configurable: true, get: () => 640 });
  const eventBus = new EventBus();
  const l10n = { translate: async () => undefined, pause: () => undefined, resume: () => undefined, get: async () => "" };
  new PDFViewer({
    container, viewer, eventBus, linkService: new PDFLinkService({ eventBus }), l10n,
  } as unknown as ConstructorParameters<typeof PDFViewer>[0]);

  expect(container.style.getPropertyValue("--viewer-container-height")).toBe("640px");
  expect(document.documentElement.style.getPropertyValue("--viewer-container-height")).toBe("");
});
