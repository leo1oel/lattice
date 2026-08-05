import { describe, expect, it } from "vitest";
import {
  pdfBase64Fingerprint,
  pdfBase64ToBytes,
  pdfBytesFingerprint,
  utf8ToBase64,
} from "./pdf-bytes";

describe("pdf bytes helpers", () => {
  it("fingerprints by length and ends so identical PDFs match", () => {
    const sample = "JVBERi0xLjQ=".repeat(4);
    expect(pdfBase64Fingerprint(sample)).toBe(pdfBase64Fingerprint(sample));
    expect(pdfBase64Fingerprint(sample)).not.toBe(pdfBase64Fingerprint(`${sample}x`));
  });

  it("decodes base64 into bytes", () => {
    expect([...pdfBase64ToBytes("JVBERi0xLjQ=")].slice(0, 5)).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d,
    ]);
  });

  it("fingerprints raw PDF buffers without encoding them", () => {
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
