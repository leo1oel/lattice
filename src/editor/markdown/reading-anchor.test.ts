import { afterEach, describe, expect, it } from "vitest";
import { captureReadingAnchor, restoreReadingAnchor } from "./reading-anchor";

/**
 * A scroller over `heights` blocks, laid out top to bottom after `lead` pixels
 * of content that is not a block (a masthead); `chunks` groups the blocks into
 * passive chunks of that size, of which only `drawn` hold their blocks.
 */
function scroller(heights: number[], { lead = 0, chunks = 0, drawn = new Set<number>() } = {}) {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(viewport, "scrollTop", { get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, value); } });
  viewport.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
  const place = (element: Element, offset: number, height: number) => {
    element.getBoundingClientRect = () => ({ top: 100 + offset - scrollTop, bottom: 100 + offset - scrollTop + height }) as DOMRect;
  };
  const offsets = heights.map((_, index) => lead + heights.slice(0, index).reduce((sum, height) => sum + height, 0));
  const block = (index: number) => {
    const element = document.createElement("p");
    place(element, offsets[index]!, heights[index]!);
    return element;
  };
  if (!chunks) {
    const prose = viewport.appendChild(document.createElement("div"));
    prose.className = "ProseMirror";
    heights.forEach((_, index) => prose.appendChild(block(index)));
  } else {
    for (let first = 0; first < heights.length; first += chunks) {
      const chunk = viewport.appendChild(document.createElement("section"));
      chunk.dataset.visualChunkFirst = String(first);
      const last = Math.min(heights.length, first + chunks) - 1;
      place(chunk, offsets[first]!, offsets[last]! + heights[last]! - offsets[first]!);
      if (!drawn.has(first)) continue;
      const prose = chunk.appendChild(document.createElement("div"));
      prose.className = "ProseMirror";
      for (let index = first; index <= last; index += 1) prose.appendChild(block(index));
    }
  }
  return viewport;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("reading anchor", () => {
  it("finds the same block in a layout that differs above it", () => {
    // The reader: a masthead above twenty 100px blocks, read from block 12.
    const reader = scroller(Array(20).fill(100), { lead: 80 });
    reader.scrollTop = 80 + 12 * 100 + 30;
    const anchor = captureReadingAnchor(reader)!;
    expect(anchor).toEqual({ block: 12, top: -30 });
    // The snapshot: no masthead and a figure above that has not loaded, so
    // the reader's offset would land almost three blocks further down.
    const snapshot = scroller([100, 100, 0, ...Array(17).fill(100)]);
    snapshot.scrollTop = reader.scrollTop;
    expect(captureReadingAnchor(snapshot)!.block).toBe(14);
    while (!restoreReadingAnchor(snapshot, anchor));
    expect(captureReadingAnchor(snapshot)).toEqual({ block: 12, top: -30 });
  });

  it("draws a passive chunk before placing a block inside it", () => {
    const heights = Array(96).fill(50);
    const drawn = new Set<number>([0]);
    let snapshot = scroller(heights, { chunks: 24, drawn });
    // Block 60 sits in the chunk starting at 48, not drawn: the chunk comes into view first.
    expect(restoreReadingAnchor(snapshot, { block: 60, top: -10 })).toBe(false);
    expect(snapshot.scrollTop).toBe(48 * 50);
    drawn.add(48);
    const scrollTop = snapshot.scrollTop;
    snapshot = scroller(heights, { chunks: 24, drawn });
    snapshot.scrollTop = scrollTop;
    while (!restoreReadingAnchor(snapshot, { block: 60, top: -10 }));
    expect(snapshot.scrollTop).toBe(60 * 50 + 10);
    expect(captureReadingAnchor(snapshot)).toEqual({ block: 60, top: -10 });
  });

  it("has no anchor while nothing at the top is drawn", () => {
    const snapshot = scroller(Array(48).fill(50), { chunks: 24, drawn: new Set([0]) });
    snapshot.scrollTop = 30 * 50;
    expect(captureReadingAnchor(snapshot)).toBeUndefined();
  });
});
