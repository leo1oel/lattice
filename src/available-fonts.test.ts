import { describe, expect, it } from "vitest";
import {
  EDITOR_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  availableFontOptions,
  isFontAvailable,
  resolveFontValue,
} from "./available-fonts";

describe("available fonts", () => {
  it("keeps bundled UI fonts even when every face measures like monospace", () => {
    const measure = () => 100;
    const available = availableFontOptions(UI_FONT_OPTIONS, measure);
    expect(available.map((option) => option.family)).toEqual(["DM Sans", "-apple-system"]);
  });

  it("hides MonoLisa when metrics match the monospace fallback", () => {
    const measure = (font: string) => (font.includes("SF Mono") ? 130 : 100);
    const available = availableFontOptions(EDITOR_FONT_OPTIONS, measure);
    expect(available.map((option) => option.family)).toEqual(["Menlo", "JetBrains Mono", "SF Mono"]);
    expect(available.some((option) => option.family === "MonoLisa")).toBe(false);
  });

  it("falls back from a stored MonoLisa preference when missing", () => {
    const measure = () => 100;
    expect(
      resolveFontValue('"MonoLisa", Menlo, monospace', EDITOR_FONT_OPTIONS, "Menlo, ui-monospace, monospace", measure),
    ).toBe("Menlo, ui-monospace, monospace");
  });

  it("keeps a stored Menlo preference when available", () => {
    const measure = () => 100;
    expect(
      resolveFontValue("Menlo, ui-monospace, monospace", EDITOR_FONT_OPTIONS, "Menlo, ui-monospace, monospace", measure),
    ).toBe("Menlo, ui-monospace, monospace");
  });

  it("treats the system UI stack as always available", () => {
    expect(isFontAvailable("-apple-system", () => 100)).toBe(true);
  });
});
