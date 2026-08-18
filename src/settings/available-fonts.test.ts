import { describe, expect, it } from "vitest";
import {
  EDITOR_FONT_OPTIONS,
  FIXED_EDITOR_FONT,
  UI_FONT_OPTIONS,
  availableFontOptions,
  isFontAvailable,
  resolveFontValue,
} from "./available-fonts";

describe("available fonts", () => {
  it("keeps fixed application fonts even when they measure like monospace", () => {
    const measure = () => 100;
    expect(availableFontOptions(UI_FONT_OPTIONS, measure).map((option) => option.family))
      .toEqual(["Inter Variable"]);
    expect(availableFontOptions(EDITOR_FONT_OPTIONS, measure).map((option) => option.family))
      .toEqual(["Ioskeley Mono"]);
  });

  it("normalizes a stored alternate editor font to the fixed code stack", () => {
    const measure = () => 100;
    expect(
      resolveFontValue('"MonoLisa", Menlo, monospace', EDITOR_FONT_OPTIONS, "Menlo, ui-monospace, monospace", measure),
    ).toBe(FIXED_EDITOR_FONT);
  });

  it("keeps the fixed code stack when it is already stored", () => {
    const measure = () => 100;
    expect(
      resolveFontValue(FIXED_EDITOR_FONT, EDITOR_FONT_OPTIONS, "Menlo, ui-monospace, monospace", measure),
    ).toBe(FIXED_EDITOR_FONT);
  });

  it("uses bundled Ioskeley Mono as the true default editor face", () => {
    expect(FIXED_EDITOR_FONT.startsWith('"Ioskeley Mono"')).toBe(true);
    expect(FIXED_EDITOR_FONT).not.toContain("JetBrains Mono");
    expect(FIXED_EDITOR_FONT).not.toContain("TX-02");
  });

  it("treats the system UI stack as always available", () => {
    expect(isFontAvailable("-apple-system", () => 100)).toBe(true);
  });
});
