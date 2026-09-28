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
  it.each([
    ["uses the CSS minimum for a one-line composer", 18, "30px", "hidden"],
    ["caps long content at the CSS maximum and enables scrolling", 220, "160px", "auto"],
  ])("%s", (_name, scrollHeight, height, overflowY) => {
    const textarea = textareaWithHeight(scrollHeight);
    mockHeightLimits("30px", "160px");

    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe(height);
    expect(textarea.style.overflowY).toBe(overflowY);
  });
});
