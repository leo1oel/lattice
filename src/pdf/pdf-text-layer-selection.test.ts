import { readFileSync } from "node:fs";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  alignPdfTextLayerGlyphs,
  clearParkedPdfTextSelection,
  installPdfTextLayerSelection,
  isEditableSelectAllTarget,
  isVisualPdfGlyphEvent,
  PDF_TEXT_SELECTION_CLEARED_EVENT,
  pdfSelectedOrCachedPlainText,
  pdfSelectedPlainTextWithin,
  placeEndOfContentForRange,
  refreshPdfTextLayerSelection,
  shouldPreventPdfSelectAll,
  usePdfSelectionReport,
} from "./pdf-text-layer-selection";

import { AGENT_ENTRY_ATTRIBUTE } from "../agent/agent-entry";

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
  const uninstall = installPdfTextLayerSelection(layer, layer);
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

/** A highlight mark's box in px of a `width`×`height` layer. */
function markBox({ style }: HTMLElement, width: number, height: number) {
  const px = (value: string, size: number) => Math.round(Number.parseFloat(value) * size / 100 * 1000) / 1000;
  expect([style.left, style.top, style.width, style.height].every((value) => value.endsWith("%"))).toBe(true);
  return { left: px(style.left, width), top: px(style.top, height), width: px(style.width, width), height: px(style.height, height) };
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
        // In fractions of the 600×800 layer, so a zoom keeps them on their glyphs.
        expect(overlays.map((mark) => markBox(mark, 600, 800))).toEqual([
          { left: 18, top: 10, width: 32, height: 12 },
          { left: 55, top: 10, width: 32, height: 12 },
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

describe("PDF selection on the way to the Agent", () => {
  /** A Trellis tab as Trellis draws it, for the view `view`. */
  function trellisTab(view: string) {
    const tab = document.createElement("div");
    tab.dataset.trellisPart = "tab";
    tab.dataset.view = view;
    const title = document.createElement("span");
    title.dataset.trellisPart = "tab-title";
    title.textContent = view;
    tab.append(title);
    document.body.append(tab);
    return title;
  }

  // The Agent shares a panel with Project by default: selecting PDF text and
  // then clicking the Agent tab cleared the selection, and the Agent opened
  // without it as context.
  it("keeps the selection through a press on the Agent tab or a control that opens the Agent", async () => {
    const { layer, spans } = glyphLayer("Attention turns tokens");
    mockGlyphBox(spans[0]!, WIDE_BOX);
    const agentToggle = document.createElement("button");
    agentToggle.setAttribute(AGENT_ENTRY_ATTRIBUTE, "");
    const icon = agentToggle.appendChild(document.createElement("svg"));
    document.body.append(agentToggle);
    const cleared = vi.fn();
    document.addEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    try {
      await withSelection(layer, () => {
        dragSelect(spans[0]!);
        for (const target of [trellisTab("agent"), icon]) {
          pointerDown(target);
          expect(pdfSelectedOrCachedPlainText()).toBe("Attention turns tokens");
        }
        expect(cleared).not.toHaveBeenCalled();

        // Any other control is still a deliberate dismissal.
        pointerDown(trellisTab("project"));
        expect(pdfSelectedOrCachedPlainText()).toBe("");
        expect(cleared).toHaveBeenCalledOnce();
      });
    } finally {
      document.removeEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    }
  });

  it("attributes a selection to the viewer whose text layer holds it", async () => {
    const preview = document.createElement("div");
    const reader = document.createElement("div");
    const first = glyphLayer("Compiled text");
    const second = glyphLayer("Document text");
    preview.append(first.layer);
    reader.append(second.layer);
    document.body.append(preview, reader);
    mockGlyphBox(first.spans[0]!, WIDE_BOX);
    mockGlyphBox(second.spans[0]!, WIDE_BOX);
    await withSelection(first.layer, () => withSelection(second.layer, () => {
      dragSelect(second.spans[0]!);
      expect(pdfSelectedPlainTextWithin(reader)).toBe("Document text");
      expect(pdfSelectedPlainTextWithin(preview)).toBe("");

      // Once the drag has moved into the copy field, the cache still knows its viewer.
      document.getSelection()?.removeAllRanges();
      expect(pdfSelectedPlainTextWithin(reader)).toBe("Document text");
      expect(pdfSelectedPlainTextWithin(preview)).toBe("");

      dragSelect(first.spans[0]!);
      expect(pdfSelectedPlainTextWithin(preview)).toBe("Compiled text");
      expect(pdfSelectedPlainTextWithin(reader)).toBe("");
    }));
  });

  // A project PDF open as a document sits beside the compiled preview: each
  // must report only its own selection, or the Agent is told the document's
  // text came from the preview (and its page).
  it("reports a selection only from the viewer it was made in", async () => {
    const preview = document.createElement("div");
    const reader = document.createElement("div");
    const first = glyphLayer("Compiled text");
    const second = glyphLayer("Document text");
    preview.append(first.layer);
    reader.append(second.layer);
    document.body.append(preview, reader);
    mockGlyphBox(first.spans[0]!, WIDE_BOX);
    mockGlyphBox(second.spans[0]!, WIDE_BOX);
    const fromPreview = vi.fn();
    const fromReader = vi.fn();
    const reporter = (root: HTMLElement, onTextSelect: (text: string) => void) => renderHook(() => (
      usePdfSelectionReport({ current: { root } }, 1, { current: { onTextSelect } })
    ));
    const select = (span: HTMLElement) => {
      dragSelect(span);
      document.dispatchEvent(new Event("selectionchange"));
    };
    await withSelection(first.layer, () => withSelection(second.layer, () => {
      const hooks = [reporter(preview, fromPreview), reporter(reader, fromReader)];
      select(second.spans[0]!);
      expect(fromReader).toHaveBeenLastCalledWith("Document text");
      expect(fromPreview).not.toHaveBeenCalled();

      select(first.spans[0]!);
      expect(fromPreview).toHaveBeenLastCalledWith("Compiled text");
      expect(fromReader).toHaveBeenCalledOnce();

      // The same text selected again in the document is a new selection there.
      select(second.spans[0]!);
      expect(fromReader).toHaveBeenCalledTimes(2);
      expect(fromReader).toHaveBeenLastCalledWith("Document text");
      for (const hook of hooks) hook.unmount();
    }));
  });
});

describe("PDF text-layer disposal with a completed drag", () => {
  /** A completed drag on `span`, its text parked in the copy field as a browser leaves it. */
  function parkedDrag(span: HTMLElement) {
    mockGlyphBox(span, HELLO_BOX);
    dragSelect(span);
    const field = document.querySelector<HTMLTextAreaElement>(".pdf-copy-field")!;
    document.getSelection()?.collapse(field, 0);
    return field;
  }

  /** A viewer's selected page and another viewer's page, both installed; the drag is parked. */
  async function withParkedDrag(run: (state: {
    viewer: object;
    other: object;
    field: HTMLTextAreaElement;
    disposeSelected: () => void;
    cleared: ReturnType<typeof vi.fn>;
  }) => void | Promise<void>) {
    const { layer, spans } = glyphLayer("Hello");
    const { layer: otherLayer } = glyphLayer("Other");
    const viewer = {};
    const other = {};
    const cleared = vi.fn();
    const disposeOther = installPdfTextLayerSelection(otherLayer, other);
    const disposeSelected = installPdfTextLayerSelection(layer, viewer);
    document.addEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
    try {
      const field = parkedDrag(spans[0]!);
      expect(layer.classList.contains("has-selection")).toBe(true);
      await run({ viewer, other, field, disposeSelected, cleared });
    } finally {
      document.removeEventListener(PDF_TEXT_SELECTION_CLEARED_EVENT, cleared);
      disposeSelected();
      disposeOther();
    }
  }

  it("keeps the parked text when PDF.js evicts a selected page", async () => {
    await withParkedDrag(({ field, disposeSelected, cleared }) => {
      disposeSelected();
      expect(field.value).toBe("Hello");
      expect(pdfSelectedOrCachedPlainText()).toBe("Hello");
      expect(cleared).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["with its selected page still installed", false],
    ["after PDF.js evicted its selected page", true],
  ])("clears the parked text when the viewer that owns it is destroyed, %s", async (_name, evicted) => {
    await withParkedDrag(async ({ viewer, other, field, disposeSelected, cleared }) => {
      if (evicted) disposeSelected();
      clearParkedPdfTextSelection(other);
      expect(field.value).toBe("Hello");
      expect(cleared).not.toHaveBeenCalled();

      clearParkedPdfTextSelection(viewer);
      expect(field.value).toBe("");
      expect(pdfSelectedOrCachedPlainText()).toBe("");
      expect(cleared).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_pdf_copy_text", { text: null }));
    });
  });
});

describe("PDF highlight of a completed drag", () => {
  /** Page `number` with a text layer of `words`, laid out at `scale` (glyph boxes 100×12 px apart). */
  function pageLayer(number: number, scale: number, ...words: string[]) {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = String(number);
    const { layer, spans } = glyphLayer(...words);
    page.append(layer);
    document.body.append(page);
    layOut(layer, spans, scale);
    return { page, layer, spans };
  }

  function layOut(layer: HTMLElement, spans: HTMLElement[], scale: number) {
    mockGlyphBox(layer, { left: 0, top: 0, right: 600 * scale, bottom: 800 * scale });
    spans.forEach((span, index) => mockGlyphBox(span, {
      left: 100 * index * scale, top: 10 * scale, right: (100 * index + 100) * scale, bottom: 22 * scale,
    }));
  }

  /** Measure a glyph range as its whole glyph's box, as the line box the overlay covers. */
  function withRangeRects(run: () => Promise<void>) {
    const original = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const { startContainer } = this;
        const glyph = startContainer instanceof Element ? startContainer : startContainer.parentElement;
        return (glyph ? [glyph.getBoundingClientRect()] : []) as unknown as DOMRectList;
      },
    });
    return run().finally(() => Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: original }));
  }

  /** Press on `first`, select through `last`, release: the text is parked in the copy field. */
  function parkDrag(first: HTMLElement, last: HTMLElement) {
    const box = first.getBoundingClientRect();
    first.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, clientX: box.left + 1, clientY: box.top + 1,
    }));
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(last.firstChild!, last.textContent!.length);
    selectRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    pointerUp();
    const field = document.querySelector<HTMLTextAreaElement>(".pdf-copy-field")!;
    document.getSelection()?.collapse(field, 0);
    return field;
  }

  const marks = (layer: HTMLElement, scale: number) => [...layer.querySelectorAll<HTMLElement>(".pdf-sel-rect")]
    .map((mark) => markBox(mark, 600 * scale, 800 * scale));

  it("keeps the highlight on its glyphs when a zoom draws the page again", () => withRangeRects(async () => {
    const { layer, spans } = pageLayer(1, 1, "Alpha", "Beta", "Gamma");
    const owner = {};
    const dispose = installPdfTextLayerSelection(layer, owner);
    try {
      const field = parkDrag(spans[0]!, spans[1]!);
      expect(marks(layer, 1)).toEqual([{ left: 0, top: 10, width: 100, height: 12 }, { left: 100, top: 10, width: 100, height: 12 }]);

      layOut(layer, spans, 2);
      refreshPdfTextLayerSelection(layer);
      expect(marks(layer, 2)).toEqual([{ left: 0, top: 20, width: 200, height: 24 }, { left: 200, top: 20, width: 200, height: 24 }]);
      expect(field.value).toBe("AlphaBeta");
    } finally {
      dispose();
    }
  }));

  it("keeps a zoomed parked drag when PDF.js later evicts its page", () => withRangeRects(async () => {
    const { layer, spans } = pageLayer(1, 1, "Alpha", "Beta", "Gamma");
    const { layer: farLayer } = pageLayer(12, 1, "Far");
    const owner = {};
    const disposeFar = installPdfTextLayerSelection(farLayer, owner);
    const dispose = installPdfTextLayerSelection(layer, owner);
    try {
      const field = parkDrag(spans[0]!, spans[1]!);
      // WebKit and Chromium anchor the copy field's selection on <body>, not in the field.
      document.getSelection()?.collapse(document.body, 0);
      layOut(layer, spans, 2);
      refreshPdfTextLayerSelection(layer);
      expect(layer.classList.contains("has-selection")).toBe(true);

      layer.remove();
      dispose();
      expect(field.value).toBe("AlphaBeta");
      expect(pdfSelectedOrCachedPlainText()).toBe("AlphaBeta");
    } finally {
      dispose();
      disposeFar();
    }
  }));

  it("shows the highlight again on the layer of a page scrolled away and back", () => withRangeRects(async () => {
    const { page, layer, spans } = pageLayer(1, 1, "Alpha", "Beta", "Gamma");
    const { layer: farLayer } = pageLayer(12, 1, "Far");
    const owner = {};
    const disposeFar = installPdfTextLayerSelection(farLayer, owner);
    let dispose = installPdfTextLayerSelection(layer, owner);
    try {
      const field = parkDrag(spans[1]!, spans[2]!);

      // PDF.js evicts page 1's layer as the view scrolls on, then draws a new one.
      layer.remove();
      dispose();
      expect(field.value).toBe("BetaGamma");
      const { layer: redrawn, spans: redrawnSpans } = glyphLayer("Alpha", "Beta", "Gamma");
      page.append(redrawn);
      layOut(redrawn, redrawnSpans, 1.5);
      dispose = installPdfTextLayerSelection(redrawn, owner);

      expect(marks(redrawn, 1.5)).toEqual([{ left: 150, top: 15, width: 150, height: 18 }, { left: 300, top: 15, width: 150, height: 18 }]);
      expect(redrawn.classList.contains("has-selection")).toBe(true);
      expect(pdfSelectedOrCachedPlainText()).toBe("BetaGamma");
    } finally {
      dispose();
      disposeFar();
    }
  }));
});
