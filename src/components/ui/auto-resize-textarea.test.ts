import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeTextareaToContent } from "./auto-resize-textarea";

afterEach(() => vi.restoreAllMocks());

function textareaWithHeight(scrollHeight: number) {
  const textarea = document.createElement("textarea");
  Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: scrollHeight });
  return textarea;
}

function mockHeightLimits(minHeight: string, maxHeight: string) {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    minHeight,
    maxHeight,
  } as CSSStyleDeclaration);
}

describe("resizeTextareaToContent", () => {
  it("uses the CSS minimum for a one-line composer", () => {
    const textarea = textareaWithHeight(18);
    mockHeightLimits("30px", "160px");

    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe("30px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("caps long content at the CSS maximum and enables scrolling", () => {
    const textarea = textareaWithHeight(220);
    mockHeightLimits("30px", "160px");

    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
  });
});
