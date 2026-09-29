import { expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";

it("leaves an idle PDF text layer untouched while typing elsewhere in the window", async () => {
  // Exercise the installed (patched) TextLayerBuilder: its page-wide selection
  // listener runs on every keyup and selectionchange, including keystrokes in
  // an editor beside the PDF, and must not re-append or re-class an idle layer.
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { TextLayerBuilder } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  const pdfPage = {
    streamTextContent: () => new ReadableStream({
      start(controller) {
        controller.enqueue({ items: [], styles: {}, lang: null });
        controller.close();
      },
    }),
  } as unknown as PDFPageProxy;
  // jsdom has no 2D canvas; the text layer only needs one to measure text.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  const builder = new TextLayerBuilder({ pdfPage });
  document.body.append(builder.div);
  const viewport = { scale: 1, rotation: 0, rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 } };
  await builder.render({ viewport } as unknown as Parameters<typeof builder.render>[0]);

  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(builder.div, { subtree: true, childList: true, attributes: true });
  for (let key = 0; key < 5; key += 1) {
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    document.dispatchEvent(new Event("selectionchange"));
  }
  records.push(...observer.takeRecords());
  observer.disconnect();
  builder.cancel();
  builder.div.remove();
  vi.restoreAllMocks();

  expect(records.map((record) => record.attributeName ?? record.type)).toEqual([]);
});
