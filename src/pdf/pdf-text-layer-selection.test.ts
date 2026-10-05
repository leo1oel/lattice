import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  alignPdfTextLayerGlyphs,
  installPdfTextLayerSelection,
  isEditableSelectAllTarget,
  isVisualPdfGlyphEvent,
  PDF_TEXT_SELECTION_CLEARED_EVENT,
  pdfSelectedOrCachedPlainText,
  placeEndOfContentForRange,
  shouldPreventPdfSelectAll,
} from "./pdf-text-layer-selection";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function glyphLayer(...words: string[]) {
  const layer = document.createElement("div");
  layer.className = "textLayer pdf-text-layer";
  const spans = words.map((word) => {
    const span = document.createElement("span");
    span.textContent = word;
    layer.append(span);
    return span;
  });
  document.body.append(layer);
  return { layer, spans };
}

type Box = { left: number; top: number; right: number; bottom: number };
const HELLO_BOX: Box = { left: 10, top: 10, right: 40, bottom: 22 };
const WIDE_BOX: Box = { left: 10, top: 10, right: 80, bottom: 22 };

function mockGlyphBox(span: HTMLElement, box: Box) {
  const rect = { ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON() { return this; } };
  span.getBoundingClientRect = () => rect as DOMRect;
  span.getClientRects = () => [rect] as unknown as DOMRectList;
}

/** Install selection on `layer` for the duration of `run`. */
async function withSelection(layer: HTMLElement, run: () => void | Promise<void>) {
  const uninstall = installPdfTextLayerSelection(layer);
  try {
    await run();
  } finally {
    uninstall();
  }
}

/** A primary-button press inside HELLO_BOX / WIDE_BOX. */
const pointerDown = (target: EventTarget) => target.dispatchEvent(new PointerEvent("pointerdown", {
  bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 16,
}));
const pointerUp = () => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
const modifierKey = (key: string) => new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });

function selectRange(range: Range) {
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

function selectGlyph(span: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(span);
  Object.defineProperty(range, "getClientRects", { value: () => [] as unknown as DOMRectList });
  selectRange(range);
}

/** Press on `span`, select all of its text, and release: a completed drag over one glyph. */
function dragSelect(span: HTMLElement) {
  pointerDown(span);
  const range = document.createRange();
  range.selectNodeContents(span);
  selectRange(range);
  pointerUp();
}

function sentinelLayer(...words: string[]) {
  const { layer, spans } = glyphLayer(...words);
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  return { spans, end, layers: new Map<HTMLElement, HTMLElement>([[layer, end]]) };
}

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.mocked(invoke).mockClear();
  vi.mocked(writeText).mockClear();
});

describe("PDF text-layer selection clipping", () => {
  it("installs an endOfContent sentinel and marks the layer selecting on mousedown", async () => {
    const { layer, spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, HELLO_BOX);
    await withSelection(layer, () => {
      const sentinel = layer.querySelector(".endOfContent");
      expect(sentinel).toBeInstanceOf(HTMLDivElement);
      expect(layer.lastElementChild).toBe(sentinel);
      spans[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 20, clientY: 16 }));
      expect(layer.classList.contains("selecting")).toBe(true);
    });
    expect(layer.querySelector(".endOfContent")).toBeNull();
    expect(layer.classList.contains("selecting")).toBe(false);
  });

  it("reuses and preserves PDF.js's own endOfContent sentinel", async () => {
    const { layer } = glyphLayer("Hello");
    const supplied = document.createElement("div");
    supplied.className = "endOfContent";
    layer.append(supplied);

    await withSelection(layer, () => {
      expect(layer.querySelectorAll(".endOfContent")).toHaveLength(1);
      expect(layer.querySelector(".endOfContent")).toBe(supplied);
    });
    expect(layer.querySelector(".endOfContent")).toBe(supplied);
  });

  it.each([
    ["parks endOfContent after the selected glyph so the range cannot cover the page",
      (range: Range, spans: HTMLElement[]) => range.selectNodeContents(spans[0]!)],
    ["walks back when the range ends at the start of the next glyph", (range: Range, spans: HTMLElement[]) => {
      range.setStart(spans[0]!.firstChild!, 0);
      range.setEnd(spans[1]!, 0);
    }],
  ])("%s", (_case, select) => {
    const { spans, end, layers } = sentinelLayer("Hello", "world", "again");
    const range = document.createRange();
    select(range, spans);
    placeEndOfContentForRange(range, null, layers);
    expect(spans[0]!.nextSibling).toBe(end);
    expect(spans[1]!.previousSibling).toBe(end);
  });

  it("does not paint WebKit's page-sized range rectangle as selected text", async () => {
    const { layer, spans } = glyphLayer("Hello", "world");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 50, bottom: 22 });
    mockGlyphBox(spans[1]!, { left: 55, top: 10, right: 95, bottom: 22 });
    mockGlyphBox(layer, { left: 0, top: 0, right: 600, bottom: 800 });
    const originalGetClientRects = Range.prototype.getClientRects;
    const overlaysDuringMeasurement: number[] = [];
    const rectsByText: Record<string, object[]> = {
      elloworl: [{ left: 0, top: 0, width: 600, height: 800 }],
      ello: [{ left: 18, top: 10, width: 32, height: 12 }],
      worl: [{ left: 55, top: 10, width: 32, height: 12 }],
    };
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        overlaysDuringMeasurement.push(layer.querySelectorAll(".pdf-sel-rect").length);
        return (rectsByText[this.cloneContents().textContent ?? ""] ?? []) as unknown as DOMRectList;
      },
    });
    try {
      await withSelection(layer, () => {
        pointerDown(spans[0]!);
        const range = document.createRange();
        range.setStart(spans[0]!.firstChild!, 1);
        range.setEnd(spans[1]!.firstChild!, 4);
        selectRange(range);
        document.dispatchEvent(new Event("selectionchange"));

        const overlays = Array.from(layer.querySelectorAll<HTMLElement>(".pdf-sel-rect"));
        // Appending each mark before measuring the next glyph forces layout for
        // every run. All reads must precede the first connected DOM write.
        expect(overlaysDuringMeasurement).toEqual([0, 0]);
        // Each mark keeps the full scaled line box so descenders remain covered.
        expect(overlays.map(({ style: { left, top, width, height } }) => ({ left, top, width, height }))).toEqual([
          { left: "18px", top: "10px", width: "32px", height: "12px" },
          { left: "55px", top: "10px", width: "32px", height: "12px" },
        ]);
      });
    } finally {
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: originalGetClientRects });
    }
  });
});

describe("PDF text-layer selection styles", () => {
  const css = String(readFileSync("src/pdf/pdf-viewer.css", "utf8"));

  it("hit-tests line gaps inside the text layer only while dragging", () => {
    // WebKit otherwise hits the canvas when a horizontal drag strays just
    // outside a glyph box, extending the native range back to the page start.
    // Keeping has-selection click-through also preserves blank-click clearing.
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const { layer } = glyphLayer("Hello");
    try {
      expect(getComputedStyle(layer).pointerEvents).toBe("none");
      layer.classList.add("selecting");
      expect(getComputedStyle(layer).pointerEvents).toBe("auto");
      expect(getComputedStyle(layer).userSelect).toBe("none");
      layer.classList.remove("selecting");
      layer.classList.add("has-selection");
      expect(getComputedStyle(layer).pointerEvents).toBe("none");
    } finally {
      style.remove();
    }
  });

  it("keeps the page box unselectable and scopes the highlight to glyph spans", () => {
    for (const rule of [
      "pointer-events: none; user-select: none;",
      ".pdf-text-layer span::selection, .pdf-text-layer br::selection, .pdf-text-layer .endOfContent::selection",
      ".pdf-text-layer .endOfContent {",
      ".pdf-text-layer.selecting .endOfContent { top: 0; }",
      ".pdf-text-layer.selecting :is(span, br),",
      ".pdf-text-layer.has-selection :is(span, br) { user-select: text; }",
      ".pdf-text-layer span:not(.markedContent) { line-height: 1; height: 1em; overflow: clip; }",
      ".pdf-text-layer .pdf-sel-rect {",
      ".pdf-copy-field {",
      ".pdfViewer .page.is-selecting-text .annotationLayer { pointer-events: none; }",
    ]) expect(css).toContain(rule);
  });
});

describe("PDF Command-A", () => {
  it("treats the editor and form fields as editable targets, and does not select PDF glyphs unless one is focused", () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    editor.innerHTML = `<div class="cm-content"></div>`;
    const input = document.createElement("input");
    document.body.append(editor, input);
    expect(isEditableSelectAllTarget(editor.firstElementChild)).toBe(true);
    expect(isEditableSelectAllTarget(input)).toBe(true);
    expect(isEditableSelectAllTarget(document.body)).toBe(false);
    expect(shouldPreventPdfSelectAll(document.body, document.body, 1)).toBe(true);
    expect(shouldPreventPdfSelectAll(document.body, document.body, 0)).toBe(false);
    expect(shouldPreventPdfSelectAll(input, input, 1)).toBe(false);
  });

  it("prevents document-wide Command-A once a text layer is installed", async () => {
    const { layer } = glyphLayer("Hello");
    await withSelection(layer, () => {
      const event = modifierKey("a");
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });
});

describe("PDF Command-C", () => {
  it("writes the PDF glyph range on copy, even if an editor still has focus", async () => {
    const { layer, spans } = glyphLayer("你好世界");
    mockGlyphBox(spans[0]!, WIDE_BOX);
    await withSelection(layer, async () => {
      selectGlyph(spans[0]!);
      layer.classList.add("has-selection");
      const stored = new Map<string, string>();
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData: (type: string, value: string) => stored.set(type, value),
          getData: (type: string) => stored.get(type) ?? "",
        },
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(stored.get("text/plain")).toBe("你好世界");
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("你好世界"));
    });
  });

  it("blurs the editor when a PDF drag starts, then synchronizes the completed drag for native macOS Command-C", async () => {
    const { layer, spans } = glyphLayer("可复制标题");
    mockGlyphBox(spans[0]!, WIDE_BOX);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    await withSelection(layer, async () => {
      // Blurred so Command-C is not delivered to CodeMirror.
      expect(document.activeElement).toBe(editor);
      pointerDown(spans[0]!);
      expect(document.activeElement).not.toBe(editor);
      selectGlyph(spans[0]!);
      pointerUp();

      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("set_pdf_copy_text", { text: "可复制标题" }));
      document.getSelection()?.removeAllRanges();
      expect(pdfSelectedOrCachedPlainText()).toBe("可复制标题");
    });
  });

  it.each([
    ["copies on Command-C so CodeMirror cannot steal the shortcut", false],
    ["still copies after the webview drops the native range", true],
  ])("%s", async (_name, dropRange) => {
    const { layer, spans } = glyphLayer("标题文字");
    mockGlyphBox(spans[0]!, WIDE_BOX);
    await withSelection(layer, async () => {
      selectGlyph(spans[0]!);
      if (dropRange) {
        document.dispatchEvent(new Event("selectionchange"));
        document.getSelection()?.removeAllRanges();
      }
      const event = modifierKey("c");
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("标题文字"));
    });
  });

  it("leaves Command-C alone when a form field has its own selected text", async () => {
    const { layer, spans } = glyphLayer("PDF");
    await withSelection(layer, () => {
      selectGlyph(spans[0]!);
      const input = document.createElement("input");
      input.value = "query";
      document.body.append(input);
      input.setSelectionRange(0, 5);
      const event = modifierKey("c");
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });
  });
});

describe("PDF title glyph scaling", () => {
  it.each([
    ["replaces horizontal stretch with letter-spacing so a title can be selected across its visual width",
      "深度学习研究", 100, "1", 60 / ("深度学习研究".length - 1)],
    ["leaves single-glyph spans stretched, because letter-spacing has no gap to pad", "深", 20, "1.6", null],
  ])("%s", (_case, text, width, scaleX, spacing) => {
    const { layer, spans: [span] } = glyphLayer(text);
    span!.style.setProperty("--scale-x", "1.6");
    Object.defineProperty(span, "offsetWidth", { configurable: true, value: width });
    alignPdfTextLayerGlyphs(layer);
    expect(span!.style.getPropertyValue("--scale-x")).toBe(scaleX);
    if (spacing === null) expect(span!.style.letterSpacing).toBe("");
    else expect(Number.parseFloat(span!.style.letterSpacing)).toBeCloseTo(spacing);
  });

  it("measures every run before changing layout, including compressed and astral glyphs", () => {
    const { layer, spans } = glyphLayer("Wide", "😀ab", "Unchanged");
    const scales = [1.5, 0.8, 1.01];
    const widths = [90, 70, 120];
    for (const [index, span] of spans.entries()) {
      span.style.setProperty("--scale-x", String(scales[index]));
      Object.defineProperty(span, "offsetWidth", {
        get: () => {
          // A style write before a later geometry read forces another layout.
          expect(spans.map((run) => run.style.letterSpacing)).toEqual(["", "", ""]);
          return widths[index];
        },
      });
    }
    alignPdfTextLayerGlyphs(layer);
    expect(Number.parseFloat(spans[0]!.style.letterSpacing)).toBeCloseTo(15);
    expect(Number.parseFloat(spans[1]!.style.letterSpacing)).toBeCloseTo(-7);
    expect(spans[2]!.style.letterSpacing).toBe("");
  });
});

describe("PDF empty-page clicks", () => {
  it("clears cached context when a click on another glyph collapses the selection", async () => {
    const { layer, spans } = glyphLayer("First phrase", "Another phrase");
    for (const span of spans) mockGlyphBox(span, { left: 10, top: 10, right: 100, bottom: 22 });
    const cleared = vi.fn();
    document.addEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    try {
      await withSelection(layer, () => {
        dragSelect(spans[0]!);
        expect(pdfSelectedOrCachedPlainText()).toBe("First phrase");
        expect(cleared).not.toHaveBeenCalled();

        pointerDown(spans[1]!);
        document.getSelection()?.collapse(spans[1]!.firstChild!, 3);
        document.dispatchEvent(new Event("selectionchange"));
        pointerUp();
        expect(pdfSelectedOrCachedPlainText()).toBe("");
        expect(cleared).toHaveBeenCalledOnce();
        expect(layer.classList.contains("has-selection")).toBe(false);
      });
    } finally {
      document.removeEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    }
  });

  it("treats a pointer outside a glyph's visible box as empty page, even if the span is the target", () => {
    const { spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, HELLO_BOX);
    expect(isVisualPdfGlyphEvent({ target: spans[0]!, clientX: 20, clientY: 16 })).toBe(true);
    expect(isVisualPdfGlyphEvent({ target: spans[0]!, clientX: 200, clientY: 16 })).toBe(false);
  });

  it("publishes the cleared selection on the first click after a completed PDF drag", async () => {
    const { layer, spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, HELLO_BOX);
    await withSelection(layer, () => {
      dragSelect(spans[0]!);
      let reportedSelection = "Hello";
      const reportSelection = () => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) reportedSelection = "";
      };
      document.addEventListener("selectionchange", reportSelection);
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 8, clientY: 8 }));
      document.removeEventListener("selectionchange", reportSelection);

      expect(document.getSelection()?.isCollapsed).toBe(true);
      expect(reportedSelection).toBe("");
      expect(layer.classList.contains("has-selection")).toBe(false);
      expect(layer.classList.contains("selecting")).toBe(false);
    });
  });
});

describe("PDF text-layer disposal with a completed drag", () => {
  /** A completed drag on `layer`, its text parked in the copy field as a browser leaves it. */
  function parkedDrag(span: HTMLElement) {
    mockGlyphBox(span, HELLO_BOX);
    dragSelect(span);
    const field = document.querySelector<HTMLTextAreaElement>(".pdf-copy-field")!;
    document.getSelection()?.collapse(field, 0);
    return field;
  }

  it("keeps the parked text when PDF.js evicts a selected page", async () => {
    const { layer, spans } = glyphLayer("Hello");
    const { layer: other } = glyphLayer("Other");
    const cleared = vi.fn();
    document.addEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    try {
      await withSelection(other, () => {
        const dispose = installPdfTextLayerSelection(layer);
        const field = parkedDrag(spans[0]!);
        expect(layer.classList.contains("has-selection")).toBe(true);
        dispose(true);
        expect(field.value).toBe("Hello");
        expect(pdfSelectedOrCachedPlainText()).toBe("Hello");
        expect(cleared).not.toHaveBeenCalled();
      });
    } finally {
      document.removeEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    }
  });

  it("clears the parked text when the viewer that owns it is destroyed", async () => {
    const { layer, spans } = glyphLayer("Hello");
    const { layer: other } = glyphLayer("Other");
    const cleared = vi.fn();
    document.addEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    try {
      await withSelection(other, async () => {
        const dispose = installPdfTextLayerSelection(layer);
        const field = parkedDrag(spans[0]!);
        dispose();
        expect(field.value).toBe("");
        expect(pdfSelectedOrCachedPlainText()).toBe("");
        expect(cleared).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_pdf_copy_text", { text: null }));
      });
    } finally {
      document.removeEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    }
  });
});
