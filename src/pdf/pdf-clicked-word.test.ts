import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfClickedWord } from "./pdf-clicked-word";

const CHAR_WIDTH = 10;
const boxes = new WeakMap<Element, DOMRect>();

/** A page whose text layer draws each span's characters `CHAR_WIDTH` apart from `left`, on a 20px line at `top`. */
function page(spans: Array<{ text: string; left: number; top: number }>) {
  const root = document.createElement("div");
  const layer = document.createElement("div");
  layer.className = "textLayer";
  root.append(layer);
  for (const { text, left, top } of spans) {
    const span = document.createElement("span");
    span.textContent = text;
    boxes.set(span, new DOMRect(left, top, text.length * CHAR_WIDTH, 20));
    span.getBoundingClientRect = () => boxes.get(span)!;
    layer.append(span);
  }
  return root;
}

// jsdom lays nothing out: a glyph's box is its offset within the span's box.
vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
  const box = boxes.get(this.startContainer.parentElement!)!;
  return new DOMRect(box.left + this.startOffset * CHAR_WIDTH, box.top, (this.endOffset - this.startOffset) * CHAR_WIDTH, 20);
});
afterEach(() => document.body.replaceChildren());

describe("pdfClickedWord", () => {
  it("reads the word under the click and its line, joined across the spans level with it", () => {
    const root = page([
      { text: "The model is", left: 0, top: 0 },
      // The pen moved mid-word: no gap, so no space.
      { text: "We then eval", left: 0, top: 30 },
      { text: "uate the", left: 120, top: 30 },
      // A gap between spans is a space.
      { text: "model.", left: 220, top: 30 },
    ]);
    // On the "t" of "the" in the second span of the second line.
    expect(pdfClickedWord(root, 120 + 5 * CHAR_WIDTH + 2, 40)).toEqual({
      word: "the", occurrence: 0, count: 1, before: "evaluate", after: "model",
    });
  });

  it("is null off the text or between words", () => {
    const root = page([{ text: "two words", left: 0, top: 0 }]);
    expect(pdfClickedWord(root, 500, 10)).toBeNull();
    expect(pdfClickedWord(root, 3 * CHAR_WIDTH + 2, 10)).toBeNull();
  });
});
