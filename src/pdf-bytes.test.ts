import { describe, expect, it } from "vitest";
import { pdfBase64Fingerprint, pdfBase64ToBytes } from "./pdf-bytes";

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
});
