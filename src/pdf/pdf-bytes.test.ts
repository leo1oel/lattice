import { describe, expect, it } from "vitest";
import { pdfBytesFingerprint, utf8ToBase64 } from "./pdf-bytes";

describe("pdf bytes helpers", () => {
  it("fingerprints raw buffers by length and ends without encoding them, so identical PDFs match", () => {
    const first = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer;
    const same = first.slice(0);
    const changed = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2e]).buffer;
    expect(pdfBytesFingerprint(first)).toBe(pdfBytesFingerprint(same));
    expect(pdfBytesFingerprint(first)).not.toBe(pdfBytesFingerprint(changed));
  });

  it("encodes Unicode save destinations as UTF-8 metadata", () => {
    expect(atob(utf8ToBase64("论文.pdf"))).toBe("\u00e8\u00ae\u00ba\u00e6\u0096\u0087.pdf");
  });
});
