import { afterEach, describe, expect, it } from "vitest";
import { capturePreviewViewport, restorePreviewAnchor } from "./markdown-preview-sync";

const captureAnchor = (viewport: HTMLElement) => capturePreviewViewport(viewport).anchor;

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
    element.getBoundingClientRect = () => ({ top: 100 + offset - scrollTop, bottom: 100 + offset - scrollTop + height, height }) as DOMRect;
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

describe("preview viewport anchor", () => {
  it("finds the same block in a layout that differs above it", () => {
    // The reader: a masthead above twenty 100px blocks, read from block 12.
    const reader = scroller(Array(20).fill(100), { lead: 80 });
    reader.scrollTop = 80 + 12 * 100 + 30;
    const anchor = captureAnchor(reader)!;
    expect(anchor).toEqual({ block: 12, top: -30, height: 100 });
    // The snapshot: no masthead and a figure above that has not loaded, so
    // the reader's offset would land almost three blocks further down.
    const snapshot = scroller([100, 100, 0, ...Array(17).fill(100)]);
    snapshot.scrollTop = reader.scrollTop;
    expect(captureAnchor(snapshot)!.block).toBe(14);
    while (!restorePreviewAnchor(snapshot, anchor));
    expect(captureAnchor(snapshot)).toEqual({ block: 12, top: -30, height: 100 });
  });

  it("keeps the same share of a rewrapped block above the viewport", () => {
    // Read 150px into a 300px paragraph; at a wider panel it is 200px tall.
    const anchor = { block: 3, top: -150, height: 300 };
    const wider = scroller([100, 100, 100, 200, 100]);
    while (!restorePreviewAnchor(wider, anchor));
    expect(captureAnchor(wider)).toEqual({ block: 3, top: -100, height: 200 });
  });

  it("draws a passive chunk before placing a block inside it", () => {
    const heights = Array(96).fill(50);
    const drawn = new Set<number>([0]);
    let snapshot = scroller(heights, { chunks: 24, drawn });
    // Block 60 sits in the chunk starting at 48, not drawn: the chunk comes into view first.
    expect(restorePreviewAnchor(snapshot, { block: 60, top: -10 })).toBe(false);
    expect(snapshot.scrollTop).toBe(48 * 50);
    drawn.add(48);
    const scrollTop = snapshot.scrollTop;
    snapshot = scroller(heights, { chunks: 24, drawn });
    snapshot.scrollTop = scrollTop;
    while (!restorePreviewAnchor(snapshot, { block: 60, top: -10 }));
    expect(snapshot.scrollTop).toBe(60 * 50 + 10);
    expect(captureAnchor(snapshot)).toEqual({ block: 60, top: -10, height: 50 });
  });

  it("holds the place over a passive chunk not drawn yet", () => {
    // A jump to a later heading lands in chunk 24 before it draws.
    const heights = Array(48).fill(50);
    const reader = scroller(heights, { chunks: 24, drawn: new Set([0]) });
    reader.scrollTop = 30 * 50;
    const anchor = captureAnchor(reader)!;
    expect(anchor).toEqual({ block: 24, top: -6 * 50 });
    // Reopened, the chunk draws and its first block comes back to the same offset.
    const drawn = new Set([0]);
    let snapshot = scroller(heights, { chunks: 24, drawn });
    expect(restorePreviewAnchor(snapshot, anchor)).toBe(false);
    drawn.add(24);
    const scrollTop = snapshot.scrollTop;
    snapshot = scroller(heights, { chunks: 24, drawn });
    snapshot.scrollTop = scrollTop;
    while (!restorePreviewAnchor(snapshot, anchor));
    expect(snapshot.scrollTop).toBe(30 * 50);
  });
});
