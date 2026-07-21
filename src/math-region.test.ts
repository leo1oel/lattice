import { describe, expect, it } from "vitest";
import { matchingMathDelimiter, mathRegionAt } from "./math-region";

describe("math region extraction", () => {
  it("finds inline and display math under the cursor", () => {
    expect(mathRegionAt("Value $a+b$ here", 8)).toMatchObject({
      source: "a+b",
      display: false,
    });
    expect(mathRegionAt("See \\[x^2\\] done", 7)).toMatchObject({
      source: "x^2",
      display: true,
    });
  });

  it("extracts equation environments", () => {
    const source = "\\begin{equation}\n  a = b\n\\end{equation}";
    expect(mathRegionAt(source, 20)).toMatchObject({
      source: "a = b",
      display: true,
    });
  });

  it("jumps between math delimiters", () => {
    const inline = "Value $a+b$ here";
    const open = inline.indexOf("$");
    const close = inline.lastIndexOf("$");
    expect(matchingMathDelimiter(inline, open)).toEqual({ from: close, to: close + 1 });
    expect(matchingMathDelimiter(inline, close)).toEqual({ from: open, to: open + 1 });
    expect(matchingMathDelimiter(inline, open + 2)).toEqual({ from: open, to: open + 1 });
    const display = "See \\[x^2\\] done";
    const openDisplay = display.indexOf("\\[");
    const closeDisplay = display.indexOf("\\]");
    expect(matchingMathDelimiter(display, openDisplay)).toEqual({
      from: closeDisplay,
      to: closeDisplay + 2,
    });
  });
});
