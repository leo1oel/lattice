/**
 * The work each pointer move of a PDF drag costs must not grow with the page
 * or the selection (#865). WebKit walks every Range it has not yet collected
 * on each DOM insertion and removal, so ranges made per glyph on every
 * selectionchange slowed a drag over a dense page down with every move.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPdfTextLayerSelection } from "./pdf-text-layer-selection";
import { glyphLayer, markBox, mockGlyphBox, pointerUp, selectRange } from "./pdf-text-layer-test-utils";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

const GLYPHS = 300;

/** A page of GLYPHS one-word glyphs, one per 12px line, each measuring as its whole box. */
function densePage() {
  const { layer, spans } = glyphLayer(...Array.from({ length: GLYPHS }, (_, index) => `w${index}`));
  mockGlyphBox(layer, { left: 0, top: 0, right: 600, bottom: 12 * GLYPHS });
  spans.forEach((span, index) => mockGlyphBox(span, { left: 10, top: 12 * index, right: 110, bottom: 12 * index + 12 }));
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const { startContainer } = this;
    const glyph = startContainer instanceof Element ? startContainer : startContainer.parentElement;
    return (glyph ? [glyph.getBoundingClientRect()] : []) as unknown as DOMRectList;
  });
  return { layer, spans };
}

describe("PDF drag over a dense page", () => {
  it("makes a fixed number of ranges per move and reads the text once, at release", () => {
    const { layer, spans } = densePage();
    const dispose = installPdfTextLayerSelection(layer, {});
    try {
      const first = spans[0]!;
      first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 6 }));
      const createRange = vi.spyOn(document, "createRange");
      const cloneRange = vi.spyOn(Range.prototype, "cloneRange");
      const cloneContents = vi.spyOn(Range.prototype, "cloneContents");
      const rangesMade = () => createRange.mock.calls.length + cloneRange.mock.calls.length;

      // Out to the foot of the page, then swept most of the way back.
      const sweep = [...Array.from({ length: 10 }, (_, step) => 30 * (step + 1) - 1), 200, 100, 9];
      const made: number[] = [];
      for (const last of sweep) {
        const range = document.createRange();
        range.setStart(first.firstChild!, 0);
        range.setEnd(spans[last]!.firstChild!, spans[last]!.textContent!.length);
        selectRange(range);
        const before = rangesMade();
        document.dispatchEvent(new Event("selectionchange"));
        made.push(rangesMade() - before);
      }
      // A scratch range for measuring and the sentinel's copy of the range,
      // however many glyphs the selection covers.
      expect(Math.max(...made)).toBeLessThanOrEqual(2);
      expect(cloneContents).not.toHaveBeenCalled();
      expect([...layer.querySelectorAll<HTMLElement>(".pdf-sel-rect")].map((mark) => markBox(mark, 600, 12 * GLYPHS).top))
        .toEqual(Array.from({ length: 10 }, (_, index) => 12 * index));

      pointerUp();
      expect(document.querySelector<HTMLTextAreaElement>(".pdf-copy-field")?.value)
        .toBe(Array.from({ length: 10 }, (_, index) => `w${index}`).join(""));
    } finally {
      dispose();
    }
  });
});
