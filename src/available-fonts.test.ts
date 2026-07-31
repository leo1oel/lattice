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
      .toEqual(["JetBrains Mono Variable"]);
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

  it("prefers TX-02 before the bundled JetBrains Mono fallback", () => {
    expect(FIXED_EDITOR_FONT.indexOf('"TX-02 Variable"')).toBeLessThan(
      FIXED_EDITOR_FONT.indexOf('"JetBrains Mono Variable"'),
    );
  });

  it("treats the system UI stack as always available", () => {
    expect(isFontAvailable("-apple-system", () => 100)).toBe(true);
  });
});
