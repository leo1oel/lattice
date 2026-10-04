import { expect, it } from "vitest";
import { adaptPdfSlickL10n } from "./pdf-viewer-utils";

// PDFSlick 4.0.2 passes a third `fallback` to L10n.get for its document-
// properties strings and print warning; PDF.js 6.4 dropped that parameter, so
// a message missing from the catalog came back undefined. Exercise the
// installed PDF.js L10n, so an upgrade that changes it again fails here.
it("keeps PDFSlick's L10n fallbacks and legacy IDs working on the installed PDF.js", async () => {
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { GenericL10n } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  const l10n = new GenericL10n("en-US");
  adaptPdfSlickL10n(l10n);
  const get = l10n.get as (ids: string, args: null, fallback?: string) => Promise<string | undefined>;
  const warning = "Warning: The PDF is not fully loaded for printing.";
  expect(await get("printing_not_ready", null, warning)).toBe(warning);
  expect(await get("document_properties_page_size_unit_inches", null, "inches")).toBe("in");
  expect(await get("document_properties_page_size_name_a4", null, "a4")).toBe("A4");
  expect(await get("lattice-no-such-message", null)).toBeUndefined();
});
