import { describe, expect, it } from "vitest";
import { paperImportProgressAt, paperImportStageLabel } from "./paper-import-progress";

describe("paperImportStageLabel", () => {
  it("names every stage the Rust pipeline emits", () => {
    expect(paperImportStageLabel("resolving")).toBe("Resolving citation metadata…");
    expect(paperImportStageLabel("fulltext")).toBe("Downloading full text and figures…");
    expect(paperImportStageLabel("overview")).toBe("Fetching the paper overview…");
  });

  it("degrades an unknown stage to a generic label, not silence", () => {
    expect(paperImportStageLabel("something-new")).toBe("Working…");
  });
});

describe("estimated import motion", () => {
  it("starts at zero and advances uniformly through the first four seconds", () => {
    expect(paperImportProgressAt(0, "resolving", 0)).toBe(0);
    const samples = [1000, 2000, 3000, 4000].map(time => paperImportProgressAt(0, "resolving", time));
    expect(samples[0]).toBeCloseTo(7.425);
    expect(samples[1] - samples[0]).toBeCloseTo(samples[0]);
    expect(samples[3]).toBeCloseTo(29.7);
  });

  it("keeps moving on slow stages, carries forward without jumps, and never finishes early", () => {
    const previous = paperImportProgressAt(0, "resolving", 6000);
    expect(previous).toBeGreaterThan(paperImportProgressAt(0, "resolving", 4000));
    expect(previous).toBeLessThan(33);
    expect(paperImportProgressAt(previous, "fulltext", 0)).toBe(previous);
    expect(paperImportProgressAt(previous, "fulltext", 1000)).toBeGreaterThan(previous);
    expect(paperImportProgressAt(60, "resolving", 5000)).toBe(60);
    expect(paperImportProgressAt(60, "overview", 1e9)).toBe(95);
  });
});
