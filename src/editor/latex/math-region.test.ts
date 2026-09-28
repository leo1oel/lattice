import { describe, expect, it } from "vitest";
import { matchingMathDelimiter, mathRegionAt } from "./math-region";

describe("math region extraction", () => {
  it.each([
    ["Value $a+b$ here", 8, "a+b", false],
    ["See \\[x^2\\] done", 7, "x^2", true],
    ["\\begin{equation}\n  a = b\n\\end{equation}", 20, "a = b", true],
  ])("finds the math in %j under the cursor", (text, cursor, source, display) => {
    expect(mathRegionAt(text, cursor)).toMatchObject({ source, display });
  });

  it("jumps between math delimiters", () => {
    const inline = "Value $a+b$ here";
    const open = inline.indexOf("$");
    const close = inline.lastIndexOf("$");
    expect(matchingMathDelimiter(inline, open)).toEqual({ from: close, to: close + 1 });
    expect(matchingMathDelimiter(inline, close)).toEqual({ from: open, to: open + 1 });
    expect(matchingMathDelimiter(inline, open + 2)).toEqual({ from: open, to: open + 1 });
    const display = "See \\[x^2\\] done";
    const closeDisplay = display.indexOf("\\]");
    expect(matchingMathDelimiter(display, display.indexOf("\\["))).toEqual({ from: closeDisplay, to: closeDisplay + 2 });
  });
});
