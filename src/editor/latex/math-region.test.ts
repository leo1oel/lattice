import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { matchingMathDelimiter, mathRegionAt, mathRegionInDocument } from "./math-region";

describe("math region extraction", () => {
  it.each([
    ["Value $a+b$ here", 8, "a+b", false],
    ["See \\[x^2\\] done", 7, "x^2", true],
    ["\\begin{equation}\n  a = b\n\\end{equation}", 20, "a = b", true],
  ])("finds the math in %j under the cursor", (text, cursor, source, display) => {
    expect(mathRegionAt(text, cursor)).toMatchObject({ source, display });
  });

  it("looks only within the caret's paragraph", () => {
    // TeX ends a paragraph at a blank line and refuses one inside math, so an
    // unclosed $ two paragraphs up cannot pair with one under the caret.
    const text = "Costs 5$ each.\n\nPlain text.\n  \nValue $a+b$ and\n$c$ here\n";
    expect(mathRegionAt(text, text.indexOf("+"))).toMatchObject({ from: text.indexOf("$a"), source: "a+b" });
    expect(mathRegionAt(text, text.indexOf("c$"))).toMatchObject({ from: text.indexOf("$c"), source: "c" });
    expect(mathRegionAt(text, text.indexOf("Plain"))).toBeNull();
    expect(mathRegionAt(text, text.indexOf("\n\n") + 1)).toBeNull();
    const display = "\\begin{equation}\n  a = b\n\\end{equation}\n\nAfter.";
    expect(mathRegionAt(display, display.indexOf("a ="))).toMatchObject({ from: 0, source: "a = b", display: true });
  });

  it("finds the same region in an editor document", () => {
    const text = "Intro $x$.\n\nSee \\[\n  y^2\n\\] done\n\nEnd $z$";
    const doc = Text.of(text.split("\n"));
    for (let position = 0; position <= text.length; position += 1) {
      expect(mathRegionInDocument(doc, position)).toEqual(mathRegionAt(text, position));
    }
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
