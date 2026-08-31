import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  alignPdfTextLayerGlyphs,
  installPdfTextLayerSelection,
  isEditableSelectAllTarget,
  isVisualPdfGlyphEvent,
  pdfSelectionOverlayRect,
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

function mockGlyphBox(span: HTMLElement, box: { left: number; top: number; right: number; bottom: number }) {
  const rect = {
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
    x: box.left,
    y: box.top,
    toJSON() { return this; },
  };
  span.getBoundingClientRect = () => rect as DOMRect;
  span.getClientRects = () => [rect] as unknown as DOMRectList;
}

describe("PDF text-layer selection clipping", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
  });

  it("installs an endOfContent sentinel and marks the layer selecting on mousedown", () => {
    const { layer, spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 40, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      const sentinel = layer.querySelector(".endOfContent");
      expect(sentinel).toBeInstanceOf(HTMLDivElement);
      expect(layer.lastElementChild).toBe(sentinel);
      spans[0]!.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 16,
      }));
      expect(layer.classList.contains("selecting")).toBe(true);
    } finally {
      uninstall();
    }
    expect(layer.querySelector(".endOfContent")).toBeNull();
    expect(layer.classList.contains("selecting")).toBe(false);
  });

  it("parks endOfContent after the selected glyph so the range cannot cover the page", () => {
    const { layer, spans } = glyphLayer("Hello", "world", "again");
    const end = document.createElement("div");
    end.className = "endOfContent";
    layer.append(end);
    const layers = new Map<HTMLElement, HTMLElement>([[layer, end]]);
    const range = document.createRange();
    range.selectNodeContents(spans[0]!);
    placeEndOfContentForRange(range, null, layers);
    expect(spans[0]!.nextSibling).toBe(end);
    expect(spans[1]!.previousSibling).toBe(end);
  });

  it("walks back when the range ends at the start of the next glyph", () => {
    const { layer, spans } = glyphLayer("Hello", "world");
    const end = document.createElement("div");
    end.className = "endOfContent";
    layer.append(end);
    const layers = new Map<HTMLElement, HTMLElement>([[layer, end]]);
    const range = document.createRange();
    range.setStart(spans[0]!.firstChild!, 0);
    range.setEnd(spans[1]!, 0);
    placeEndOfContentForRange(range, null, layers);
    expect(spans[0]!.nextSibling).toBe(end);
  });

  it("does not paint WebKit's page-sized range rectangle as selected text", () => {
    const { layer, spans } = glyphLayer("Hello", "world");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 50, bottom: 22 });
    mockGlyphBox(spans[1]!, { left: 55, top: 10, right: 95, bottom: 22 });
    layer.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
      x: 0,
      y: 0,
      toJSON() { return this; },
    }) as DOMRect;
    const originalGetClientRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const text = this.cloneContents().textContent ?? "";
        if (text === "elloworl") {
          return [{ left: 0, top: 0, width: 600, height: 800 }] as unknown as DOMRectList;
        }
        if (text === "ello") {
          return [{ left: 18, top: 10, width: 32, height: 12 }] as unknown as DOMRectList;
        }
        if (text === "worl") {
          return [{ left: 55, top: 10, width: 32, height: 12 }] as unknown as DOMRectList;
        }
        return [] as unknown as DOMRectList;
      },
    });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      spans[0]!.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 16,
      }));
      const range = document.createRange();
      range.setStart(spans[0]!.firstChild!, 1);
      range.setEnd(spans[1]!.firstChild!, 4);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      const overlays = Array.from(layer.querySelectorAll<HTMLElement>(".pdf-sel-rect"));
      expect(overlays).toHaveLength(2);
      expect(overlays.map((overlay) => ({
        left: overlay.style.left,
        top: overlay.style.top,
        width: overlay.style.width,
        height: overlay.style.height,
      }))).toEqual([
        { left: "18px", top: "10px", width: "32px", height: "12px" },
        { left: "55px", top: "10px", width: "32px", height: "12px" },
      ]);
    } finally {
      uninstall();
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: originalGetClientRects,
      });
    }
  });
});

describe("PDF text-layer selection styles", () => {
  const css = String(readFileSync("src/pdf/pdf-viewer.css", "utf8"));

  it("keeps the page box unselectable and scopes the highlight to glyph spans", () => {
    expect(css).toContain("pointer-events: none; user-select: none;");
    expect(css).toContain(".pdf-text-layer span::selection, .pdf-text-layer br::selection, .pdf-text-layer .endOfContent::selection");
    expect(css).toContain(".pdf-text-layer .endOfContent {");
    expect(css).toContain(".pdf-text-layer.selecting .endOfContent { top: 0; }");
    expect(css).toContain(".pdf-text-layer.selecting :is(span, br),");
    expect(css).toContain(".pdf-text-layer.has-selection :is(span, br) { user-select: text; }");
    expect(css).toContain(".pdf-text-layer span:not(.markedContent) { line-height: 1; height: 1em; overflow: clip; }");
    expect(css).toContain(".pdf-text-layer .pdf-sel-rect {");
    expect(css).toContain(".pdf-copy-field {");
    expect(css).toContain(".pdf-page-content.is-selecting-text .pdf-link-annotation { pointer-events: none; }");
  });
});

describe("PDF Command-A", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
  });

  it("treats the editor and form fields as editable select-all targets", () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    content.className = "cm-content";
    editor.append(content);
    document.body.append(editor);
    expect(isEditableSelectAllTarget(content)).toBe(true);
    const input = document.createElement("input");
    document.body.append(input);
    expect(isEditableSelectAllTarget(input)).toBe(true);
    expect(isEditableSelectAllTarget(document.body)).toBe(false);
  });

  it("does not let Command-A select PDF glyphs unless a field is focused", () => {
    expect(shouldPreventPdfSelectAll(document.body, document.body, 1)).toBe(true);
    expect(shouldPreventPdfSelectAll(document.body, document.body, 0)).toBe(false);
    const input = document.createElement("input");
    expect(shouldPreventPdfSelectAll(input, input, 1)).toBe(false);
  });

  it("prevents document-wide Command-A once a text layer is installed", () => {
    const { layer } = glyphLayer("Hello");
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      uninstall();
    }
  });
});

describe("PDF Command-C", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
    vi.mocked(invoke).mockClear();
    vi.mocked(writeText).mockClear();
  });

  function selectGlyph(span: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(span);
    Object.defineProperty(range, "getClientRects", {
      value: () => [] as unknown as DOMRectList,
    });
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }

  it("writes the PDF glyph range on copy, even if an editor still has focus", async () => {
    const { layer, spans } = glyphLayer("你好世界");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 80, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
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
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("你好世界");
      });
    } finally {
      uninstall();
    }
  });

  it("blurs the editor when a PDF drag starts so Command-C is not delivered to CodeMirror", () => {
    const { layer, spans } = glyphLayer("你好");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 40, bottom: 22 });
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      expect(document.activeElement).toBe(editor);
      spans[0]!.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 16,
      }));
      expect(document.activeElement).not.toBe(editor);
    } finally {
      uninstall();
    }
  });

  it("synchronizes a completed drag for the native macOS Command-C handler", async () => {
    const { layer, spans } = glyphLayer("可复制标题");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 80, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      spans[0]!.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 16,
      }));
      selectGlyph(spans[0]!);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("set_pdf_copy_text", { text: "可复制标题" });
      });
    } finally {
      uninstall();
    }
  });

  it("still copies after the webview drops the native range", async () => {
    const { layer, spans } = glyphLayer("标题文字");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 80, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      selectGlyph(spans[0]!);
      document.dispatchEvent(new Event("selectionchange"));
      document.getSelection()?.removeAllRanges();
      const event = new KeyboardEvent("keydown", {
        key: "c",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("标题文字");
      });
    } finally {
      uninstall();
    }
  });

  it("copies on Command-C so CodeMirror cannot steal the shortcut", async () => {
    const { layer, spans } = glyphLayer("标题文字");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 80, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      selectGlyph(spans[0]!);
      const event = new KeyboardEvent("keydown", {
        key: "c",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("标题文字");
      });
    } finally {
      uninstall();
    }
  });

  it("leaves Command-C alone when a form field has its own selected text", () => {
    const { layer, spans } = glyphLayer("PDF");
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      selectGlyph(spans[0]!);
      const input = document.createElement("input");
      input.value = "query";
      document.body.append(input);
      input.setSelectionRange(0, 5);
      const event = new KeyboardEvent("keydown", {
        key: "c",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});

describe("PDF title glyph scaling", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("replaces horizontal stretch with letter-spacing so a title can be selected across its visual width", () => {
    const { layer, spans } = glyphLayer("深度学习研究");
    const title = spans[0]!;
    title.style.setProperty("--scale-x", "1.6");
    Object.defineProperty(title, "offsetWidth", { configurable: true, value: 100 });
    alignPdfTextLayerGlyphs(layer);
    expect(title.style.getPropertyValue("--scale-x")).toBe("1");
    expect(Number.parseFloat(title.style.letterSpacing)).toBeCloseTo(60 / ("深度学习研究".length - 1));
  });

  it("leaves single-glyph spans stretched, because letter-spacing has no gap to pad", () => {
    const { layer, spans } = glyphLayer("深");
    spans[0]!.style.setProperty("--scale-x", "1.6");
    Object.defineProperty(spans[0]!, "offsetWidth", { configurable: true, value: 20 });
    alignPdfTextLayerGlyphs(layer);
    expect(spans[0]!.style.getPropertyValue("--scale-x")).toBe("1.6");
    expect(spans[0]!.style.letterSpacing).toBe("");
  });

  it("keeps the full scaled line box so descenders remain covered", () => {
    const overlay = pdfSelectionOverlayRect({ left: 10, top: 20, width: 80, height: 20 });
    expect(overlay).toMatchObject({ left: 10, top: 20, width: 80 });
    expect(overlay.height).toBeCloseTo(20);
  });
});

describe("PDF empty-page clicks", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
  });

  it("treats a pointer outside a glyph's visible box as empty page, even if the span is the target", () => {
    const { spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 40, bottom: 22 });
    expect(isVisualPdfGlyphEvent({ target: spans[0]!, clientX: 20, clientY: 16 })).toBe(true);
    expect(isVisualPdfGlyphEvent({ target: spans[0]!, clientX: 200, clientY: 16 })).toBe(false);
  });

  it("publishes the cleared selection on the first click after a completed PDF drag", () => {
    const { layer, spans } = glyphLayer("Hello");
    mockGlyphBox(spans[0]!, { left: 10, top: 10, right: 40, bottom: 22 });
    const uninstall = installPdfTextLayerSelection(layer);
    try {
      spans[0]!.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 16,
      }));
      const range = document.createRange();
      range.selectNodeContents(spans[0]!);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));

      let reportedSelection = "Hello";
      const reportSelection = () => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          reportedSelection = "";
        }
      };
      document.addEventListener("selectionchange", reportSelection);
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 8,
        clientY: 8,
      }));
      document.removeEventListener("selectionchange", reportSelection);

      expect(document.getSelection()?.isCollapsed).toBe(true);
      expect(reportedSelection).toBe("");
      expect(layer.classList.contains("has-selection")).toBe(false);
      expect(layer.classList.contains("selecting")).toBe(false);
    } finally {
      uninstall();
    }
  });
});
