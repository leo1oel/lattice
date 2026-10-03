import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measurePdfSearchFold, measurePdfToolbarMinWidth } from "./pdf-toolbar-min-width";

/** A laid-out box of `width` CSS px, as jsdom lays nothing out itself. */
function laidOut(element: Element, width: number) {
  element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) });
  element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
}

/** The narrow live toolbar: pages, Find (with its match controls `trailingWidth` wide), then SyncTeX and the fit. */
function toolbar(trailingWidth: number | null, counterWidth = 54) {
  const root = document.createElement("div");
  root.className = "pdf-toolbar";
  root.style.cssText = "padding: 0 8px; column-gap: 6px;";
  root.innerHTML = `
    <div class="pdf-navigation-controls"><div class="pdf-page-controls"></div></div>
    <div class="pdf-find-controls">
      <span data-slot="search-field" style="padding: 0 6px; column-gap: 4px;">
        <svg class="ui-search-field-icon"></svg>
        <input placeholder="Find in PDF" />
        ${trailingWidth === null ? "" : `<span class="ui-search-field-trailing"><small class="pdf-search-position">0 / 0</small></span>`}
      </span>
    </div>
    <div class="pdf-zoom-controls" style="column-gap: 2px;">
      <button class="pdf-overflow"></button><button></button><button></button>
    </div>`;
  document.body.append(root);
  // jsdom's computed border defaults to "medium" (16px) rather than none.
  for (const element of [root, ...root.querySelectorAll<HTMLElement | SVGElement>("*")]) element.style.borderWidth = "0";
  laidOut(root, 600);
  laidOut(root.querySelector(".pdf-navigation-controls")!, 100);
  laidOut(root.querySelector(".pdf-page-controls")!, 100);
  laidOut(root.querySelector(".pdf-find-controls")!, 300);
  laidOut(root.querySelector(".ui-search-field-icon")!, 12);
  const trailing = root.querySelector(".ui-search-field-trailing");
  if (trailing) {
    laidOut(trailing, trailingWidth!);
    laidOut(trailing.querySelector(".pdf-search-position")!, counterWidth);
  }
  const [overflow, ...kept] = root.querySelectorAll(".pdf-zoom-controls button");
  laidOut(root.querySelector(".pdf-zoom-controls")!, 200);
  laidOut(overflow!, 24);
  for (const button of kept) laidOut(button, 24);
  return root;
}

describe("measurePdfToolbarMinWidth", () => {
  beforeEach(() => {
    // Every character is 6px wide in every font.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      { font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  // Toolbar padding 16 + two column gaps 12, pages 100, the zoom column's two kept
  // buttons and their gap 50, and the field's own padding 12.
  const fixed = 16 + 12 + 100 + 50 + 12;

  it("reserves room for a typed query beside its match controls before the first keystroke", () => {
    // Idle: icon 12 + gap 4 + placeholder 66 = 82. Typing: eight characters 48 + gap 4 + controls 141.
    expect(measurePdfToolbarMinWidth(toolbar(141))).toBe(fixed + 193);
  });

  it("reserves room for a three-digit match count beyond the idle counter", () => {
    // "000 / 000" is 54px; the counter reads "0 / 0" at its 31px minimum, so the controls grow by 23.
    expect(measurePdfToolbarMinWidth(toolbar(141, 31))).toBe(fixed + 193 + 23);
  });

  it("keeps the whole placeholder when that is the wider state", () => {
    expect(measurePdfToolbarMinWidth(toolbar(10))).toBe(fixed + 82);
    // A toolbar with no match controls (no PDF yet) budgets the placeholder alone.
    expect(measurePdfToolbarMinWidth(toolbar(null))).toBe(fixed + 82);
  });

  it("keeps its last reading while a query is typed", () => {
    const root = toolbar(141);
    root.querySelector("input")!.value = "lattice";
    expect(measurePdfToolbarMinWidth(root)).toBeNull();
  });
});

describe("measurePdfSearchFold", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      { font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /** A toolbar whose query box is as wide as `widths` says for each fold (none, 1, 2). */
  function folding(widths: [number, number, number], query = "lattice") {
    const root = toolbar(141);
    const input = root.querySelector("input")!;
    input.value = query;
    input.getBoundingClientRect = () => {
      const width = widths[Number(root.getAttribute("data-search-fold") ?? 0)]!;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) };
    };
    return root;
  }

  it("folds no further than the query needs: eight characters, 48px", () => {
    expect(measurePdfSearchFold(folding([48, 90, 200]))).toBe(0);
    expect(measurePdfSearchFold(folding([0, 48, 200]))).toBe(1);
    expect(measurePdfSearchFold(folding([0, 20, 200]))).toBe(2);
  });

  it("stays unfolded with no query, and leaves the rendered fold in place", () => {
    expect(measurePdfSearchFold(folding([0, 0, 0], ""))).toBe(0);
    const root = folding([0, 48, 200]);
    root.setAttribute("data-search-fold", "2");
    expect(measurePdfSearchFold(root)).toBe(1);
    expect(root.getAttribute("data-search-fold")).toBe("2");
  });
});
