import { describe, expect, it } from "vitest";
import { paperImportStageLabel } from "./paper-import-progress";

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
