/**
 * PDF.js text layers are a stack of absolutely positioned glyph spans over a
 * canvas. Browsers select in DOM order, not visual order: dragging into the
 * empty space between lines (or onto the page box) extends the range through
 * every sibling span, so `::selection` paints the whole page blue.
 *
 * Command-A is worse: it is a document-wide select-all, so the transparent
 * glyph spans join the editor selection and the page washes blue/grey. Glyphs
 * stay `user-select: none` until the user is actually dragging in the PDF, and
 * Command-A is ignored unless the event came from an editor or field.
 *
 * Native `::selection` in WKWebView does not reliably follow PDF.js's scaled
 * font sizes. We hide that paint and draw `.pdf-sel-rect` overlays from the
 * scaled line boxes, keeping descenders covered while preserving font size.
 *
 * Command-C never sees those spans: macOS delivers it to Edit → Copy, and
 * native copy of transparent absolutely-positioned text is empty. After a drag
 * we park the glyph string in a hidden textarea and focus it, so the system
 * copy path has a real selected field. We also synchronize that string to the
 * native KeyDown monitor, which writes and consumes Command-C before AppKit can
 * replace the clipboard with transparent text.
 *
 * Titles (and other wide runs) are one span stretched with `--scale-x` so the
 * fallback font matches the PDF width. Native caret mapping uses the unscaled
 * box, so the highlight stops around 1/scaleX of the visual line. Letter-spacing
 * the extra width and dropping the stretch makes the layout box match the page.
 *
 * Mozilla's viewer also clips drags with a `.endOfContent` sentinel
 * (TextLayerBuilder). Reuse that sentinel when the viewer supplies one, and
 * create it only for older direct-TextLayer consumers.
 */

/* eslint lingui/no-unlocalized-strings: "off" -- DOM selectors and native command identifiers only. */

import { invoke } from "@tauri-apps/api/core";
import { normalizePdfSelection } from "./pdf-viewer-utils";

/** Keep the full scaled line box so low glyphs and descenders stay highlighted. */
const PDF_SELECTION_HEIGHT_RATIO = 1;

const textLayers = new Map<HTMLElement, HTMLElement>();
const ownedEndOfContent = new WeakSet<HTMLElement>();
let selectionAbort: AbortController | null = null;
let previousRange: Range | null = null;
let lastPdfCopyText = "";
let copyField: HTMLTextAreaElement | null = null;
const clipboardTimers: number[] = [];

function resetLayer(textLayer: HTMLElement, endOfContent: HTMLElement) {
  if (endOfContent.parentElement !== textLayer) textLayer.append(endOfContent);
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  textLayer.classList.remove("selecting");
  textLayer.closest(".pdf-page-content, .page")?.classList.remove("is-selecting-text");
}

export function isEditableSelectAllTarget(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;
  if (isPdfCopyField(node)) return false;
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return !node.readOnly;
  return Boolean(node.closest("input, textarea, [contenteditable=true], .cm-editor, .cm-content, .tiptap, .ProseMirror"));
}

function isPdfCopyField(node: EventTarget | null): boolean {
  return node instanceof HTMLTextAreaElement && node.classList.contains("pdf-copy-field");
}

function fieldHasOwnSelection(node: EventTarget | null): boolean {
  if (isPdfCopyField(node)) return false;
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    return node.selectionStart !== node.selectionEnd;
  }
  return false;
}

/** Command-A must not select every PDF glyph span in the webview. */
export function shouldPreventPdfSelectAll(
  target: EventTarget | null,
  activeElement: Element | null = document.activeElement,
  layerCount = textLayers.size,
): boolean {
  if (layerCount === 0) return false;
  if (isEditableSelectAllTarget(target) || isEditableSelectAllTarget(activeElement)) return false;
  return true;
}

function selectionIntersectsLayer(selection: Selection | null, textLayer: HTMLElement): boolean {
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(textLayer)) return true;
  }
  return false;
}

function selectionIntersectsPdf(selection: Selection | null): boolean {
  for (const textLayer of textLayers.keys()) {
    if (selectionIntersectsLayer(selection, textLayer)) return true;
  }
  return false;
}

function selectionIsCopyField(selection: Selection | null): boolean {
  if (!copyField || !selection) return false;
  const node = selection.anchorNode;
  return node === copyField || (node != null && copyField.contains(node));
}

function updateHasSelection(selection: Selection | null) {
  if (selectionIsCopyField(selection)) return;
  for (const textLayer of textLayers.keys()) {
    textLayer.classList.toggle("has-selection", selectionIntersectsLayer(selection, textLayer));
  }
}

function glyphSpanFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.classList.contains("endOfContent") || target.classList.contains("pdf-sel-rect")) return null;
  const span = target.closest<HTMLElement>(".textLayer span, .pdf-text-layer span");
  if (!span || span.classList.contains("markedContent") || span.classList.contains("endOfContent")) {
    return null;
  }
  return span;
}

function pointHitsRect(x: number, y: number, rect: DOMRectReadOnly): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * True when the event is on a glyph's *visible* box. Transformed PDF spans have
 * oversized hit-testing boxes in WebKit, so "empty" page clicks often land on a
 * span that does not visually contain the pointer.
 */
export function isVisualPdfGlyphEvent(event: Pick<MouseEvent, "target" | "clientX" | "clientY">): boolean {
  const span = glyphSpanFromTarget(event.target);
  if (!span) return false;
  const rects = span.getClientRects();
  for (const rect of rects) {
    if (pointHitsRect(event.clientX, event.clientY, rect)) return true;
  }
  return false;
}

function clearSelectionOverlays() {
  for (const textLayer of textLayers.keys()) {
    textLayer.querySelectorAll(".pdf-sel-rect").forEach((node) => node.remove());
  }
}

/** Size the visual highlight relative to the browser's scaled line box. */
export function pdfSelectionOverlayRect(
  rect: { left: number; top: number; width: number; height: number },
  ratio = PDF_SELECTION_HEIGHT_RATIO,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: Math.max(0, rect.height * ratio),
  };
}

function rangeInsideGlyph(range: Range, glyph: HTMLElement): Range | null {
  if (!range.intersectsNode(glyph)) return null;
  const glyphRange = document.createRange();
  glyphRange.selectNodeContents(glyph);
  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(Range.START_TO_START, glyphRange) < 0) {
    clipped.setStart(glyphRange.startContainer, glyphRange.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, glyphRange) > 0) {
    clipped.setEnd(glyphRange.endContainer, glyphRange.endOffset);
  }
  return clipped.collapsed ? null : clipped;
}

function paintSelectionOverlays(selection: Selection | null) {
  clearSelectionOverlays();
  if (!selection || selection.isCollapsed || selectionIsCopyField(selection)) return;
  for (const textLayer of textLayers.keys()) {
    if (!selectionIntersectsLayer(selection, textLayer)) continue;
    const origin = textLayer.getBoundingClientRect();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (!range.intersectsNode(textLayer)) continue;
      // WebKit includes PDF.js's full-page endOfContent sentinel in the range
      // rectangle list. Measure each selected glyph separately so an internal
      // clipping node can never become a page-sized visual highlight.
      for (const glyph of textLayer.querySelectorAll<HTMLElement>("span:not(.markedContent)")) {
        const clipped = rangeInsideGlyph(range, glyph);
        if (!clipped) continue;
        for (const rect of clipped.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          const overlay = pdfSelectionOverlayRect(rect);
          const mark = document.createElement("div");
          mark.className = "pdf-sel-rect";
          mark.setAttribute("aria-hidden", "true");
          mark.style.left = `${overlay.left - origin.left}px`;
          mark.style.top = `${overlay.top - origin.top}px`;
          mark.style.width = `${overlay.width}px`;
          mark.style.height = `${overlay.height}px`;
          textLayer.append(mark);
        }
      }
    }
  }
}

function textFromRange(range: Range): string {
  const contents = range.cloneContents().textContent ?? "";
  if (contents.trim()) return contents;
  return range.toString();
}

function ensureCopyField(): HTMLTextAreaElement {
  if (copyField?.isConnected) return copyField;
  const field = document.createElement("textarea");
  field.className = "pdf-copy-field";
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  document.body.append(field);
  copyField = field;
  return field;
}

function syncNativePdfCopyText(text: string) {
  void invoke("set_pdf_copy_text", { text: text || null }).catch(() => undefined);
}

function armPdfCopyField(text: string) {
  lastPdfCopyText = text;
  syncNativePdfCopyText(text);
  const field = ensureCopyField();
  field.value = text;
  field.focus({ preventScroll: true });
  field.select();
}

function disarmPdfCopyField() {
  syncNativePdfCopyText("");
  if (!copyField) return;
  copyField.value = "";
  if (document.activeElement === copyField) copyField.blur();
}

/** Drop a PDF text-layer range. Leaves an editor-only selection alone. */
export function clearPdfTextSelection() {
  const selection = document.getSelection();
  const selectionOwnedByPdf =
    selectionIntersectsPdf(selection) || selectionIsCopyField(selection);
  const hadPdfSelection = selectionOwnedByPdf || Boolean(lastPdfCopyText);
  if (selectionOwnedByPdf) selection?.removeAllRanges();
  previousRange = null;
  lastPdfCopyText = "";
  clearSelectionOverlays();
  disarmPdfCopyField();
  for (const [textLayer, endOfContent] of textLayers) {
    resetLayer(textLayer, endOfContent);
    textLayer.classList.remove("has-selection");
  }
  // WebKit parks a completed PDF drag in the hidden copy field and does not
  // reliably publish the programmatic clear. Notify PdfViewer so its Agent
  // context cannot retain text after the visible highlight is gone.
  if (hadPdfSelection) document.dispatchEvent(new Event("selectionchange"));
}

function blurEditableFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !isEditableSelectAllTarget(active)) return;
  active.blur();
}

export function pdfSelectedPlainText(selection: Selection | null = document.getSelection()): string {
  if (selectionIsCopyField(selection)) return lastPdfCopyText || copyField?.value || "";
  if (!selectionIntersectsPdf(selection)) return "";
  const pieces: string[] = [];
  for (let index = 0; index < (selection?.rangeCount ?? 0); index += 1) {
    pieces.push(textFromRange(selection!.getRangeAt(index)));
  }
  const joined = normalizePdfSelection(pieces.join(""));
  if (joined) return joined;
  const fallback: string[] = [];
  for (const textLayer of textLayers.keys()) {
    if (!selectionIntersectsLayer(selection, textLayer)) continue;
    for (const span of textLayer.querySelectorAll<HTMLElement>("span")) {
      if (span.classList.contains("markedContent") || span.classList.contains("endOfContent")) continue;
      for (let index = 0; index < (selection?.rangeCount ?? 0); index += 1) {
        if (selection?.getRangeAt(index).intersectsNode(span)) {
          fallback.push(span.textContent ?? "");
          break;
        }
      }
    }
  }
  return normalizePdfSelection(fallback.join(""));
}

export function pdfSelectedOrCachedPlainText(selection: Selection | null = document.getSelection()): string {
  return pdfSelectedPlainText(selection) || lastPdfCopyText || copyField?.value || "";
}

function copyTextForEvent(target: EventTarget | null): string {
  if (fieldHasOwnSelection(target) || fieldHasOwnSelection(document.activeElement)) return "";
  return pdfSelectedOrCachedPlainText();
}

async function writeClipboardText(text: string) {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  } catch {
    await navigator.clipboard?.writeText(text);
  }
}

function clearClipboardTimers() {
  for (const timer of clipboardTimers) window.clearTimeout(timer);
  clipboardTimers.length = 0;
}

function writePdfClipboard(text: string) {
  clearClipboardTimers();
  void writeClipboardText(text);
  clipboardTimers.push(window.setTimeout(() => void writeClipboardText(text), 0));
  clipboardTimers.push(window.setTimeout(() => void writeClipboardText(text), 40));
}

function copyPdfSelection(event: Event & { clipboardData?: DataTransfer | null }, target: EventTarget | null) {
  const text = copyTextForEvent(target);
  if (!text) return false;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  event.clipboardData?.setData("text/plain", text);
  writePdfClipboard(text);
  return true;
}

function glyphScaleX(span: HTMLElement): number {
  const raw = span.style.getPropertyValue("--scale-x") || getComputedStyle(span).getPropertyValue("--scale-x") || "1";
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Replace `--scale-x` stretching with letter-spacing so caret mapping covers
 * the visual run. Single-glyph spans keep the stretch: there is no gap to pad.
 */
export function alignPdfTextLayerGlyphs(textLayer: HTMLElement): void {
  for (const span of textLayer.querySelectorAll<HTMLElement>("span")) {
    if (span.classList.contains("markedContent") || span.classList.contains("endOfContent")) continue;
    const glyphs = [...(span.textContent ?? "")];
    if (glyphs.length <= 1) continue;
    const scaleX = glyphScaleX(span);
    if (Math.abs(scaleX - 1) < 0.02) continue;
    const layoutWidth = span.offsetWidth;
    if (!(layoutWidth > 0)) continue;
    const extra = layoutWidth * (Math.abs(scaleX) - 1);
    if (Math.abs(extra) < 0.5) continue;
    span.style.letterSpacing = `${extra / (glyphs.length - 1)}px`;
    span.style.setProperty("--scale-x", "1");
  }
}

function enableGlobalSelectionListener() {
  if (selectionAbort) return;
  selectionAbort = new AbortController();
  const { signal } = selectionAbort;
  let pointerDown = false;

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (isVisualPdfGlyphEvent(event)) {
      pointerDown = true;
      blurEditableFocus();
      const span = glyphSpanFromTarget(event.target);
      span?.closest(".pdf-page-content, .page")?.classList.add("is-selecting-text");
      return;
    }
    pointerDown = false;
    if (glyphSpanFromTarget(event.target)) event.preventDefault();
    clearPdfTextSelection();
  }, { capture: true, signal });
  const endDrag = () => {
    if (!pointerDown) return;
    pointerDown = false;
    previousRange = null;
    const selection = document.getSelection();
    updateHasSelection(selection);
    const live = pdfSelectedPlainText(selection);
    if (live) lastPdfCopyText = live;
    paintSelectionOverlays(selection);
    for (const [textLayer, endOfContent] of textLayers) {
      resetLayer(textLayer, endOfContent);
    }
    if (live) armPdfCopyField(live);
  };
  document.addEventListener("pointerup", endDrag, { signal });
  window.addEventListener("blur", () => {
    pointerDown = false;
  }, { signal });
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    if (key === "a" && !event.shiftKey) {
      if (!shouldPreventPdfSelectAll(event.target, document.activeElement)) return;
      event.preventDefault();
      return;
    }
    if ((key === "c" || key === "x") && !event.shiftKey) {
      copyPdfSelection(event, event.target);
    }
  }, { capture: true, signal });
  document.addEventListener("copy", (event) => {
    copyPdfSelection(event, event.target);
  }, { capture: true, signal });
  document.addEventListener("cut", (event) => {
    copyPdfSelection(event, event.target);
  }, { capture: true, signal });
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (selectionIsCopyField(selection)) return;
    if (!selection || selection.rangeCount === 0) {
      updateHasSelection(selection);
      if (!pointerDown) {
        previousRange = null;
        for (const [textLayer, endOfContent] of textLayers) {
          resetLayer(textLayer, endOfContent);
        }
      }
      return;
    }
    // `.selecting` is only for an in-progress drag. Re-adding it after mouseup
    // stretches `.endOfContent` over the page and makes empty space eat clicks.
    if (pointerDown) {
      const active = new Set<HTMLElement>();
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        for (const textLayer of textLayers.keys()) {
          if (range.intersectsNode(textLayer)) active.add(textLayer);
        }
      }
      for (const [textLayer, endOfContent] of textLayers) {
        if (active.has(textLayer)) textLayer.classList.add("selecting");
        else resetLayer(textLayer, endOfContent);
      }
      const range = selection.getRangeAt(0);
      placeEndOfContentForRange(range, previousRange, textLayers);
      previousRange = range.cloneRange();
      paintSelectionOverlays(selection);
    }
    updateHasSelection(selection);
    const live = pdfSelectedPlainText(selection);
    if (live) lastPdfCopyText = live;
  }, { signal });
}

function disableGlobalSelectionListenerIfIdle() {
  if (textLayers.size > 0) return;
  selectionAbort?.abort();
  selectionAbort = null;
  clearClipboardTimers();
  clearSelectionOverlays();
  disarmPdfCopyField();
  copyField?.remove();
  copyField = null;
  previousRange = null;
  lastPdfCopyText = "";
}

function isFirefoxEndOfContent(endOfContent: HTMLElement): boolean {
  return getComputedStyle(endOfContent).getPropertyValue("-moz-user-select") === "none";
}

/**
 * Park `.endOfContent` next to the moving end of the selection so WebKit cannot
 * jump the range across every glyph span on the page. See pdf.js #8092 / #9843.
 */
export function placeEndOfContentForRange(
  range: Range,
  previous: Range | null,
  layers: Map<HTMLElement, HTMLElement> = textLayers,
): void {
  const sample = layers.values().next().value;
  if (!sample || isFirefoxEndOfContent(sample)) return;

  const modifyStart = Boolean(
    previous
    && (
      range.compareBoundaryPoints(Range.END_TO_END, previous) === 0
      || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0
    ),
  );
  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
  const offset = modifyStart ? range.startOffset : range.endOffset;
  if (anchor.nodeType === Node.TEXT_NODE) {
    anchor = anchor.parentNode;
  } else if (!modifyStart && offset === 0) {
    // Range ends at the start of a node (Chrome/WebKit word-drag). Walk back
    // to the previous text-bearing element or we park the sentinel one node
    // too far and the selection grows to the whole page. pdf.js #19785.
    anchor = previousTextBearingNode(anchor);
  }
  if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE) return;
  const parent = anchor.parentElement;
  const textLayer = parent?.closest<HTMLElement>(".textLayer");
  const endOfContent = textLayer ? layers.get(textLayer) : undefined;
  if (!parent || !textLayer || !endOfContent) return;
  endOfContent.style.width = textLayer.style.width;
  endOfContent.style.height = textLayer.style.height;
  parent.insertBefore(endOfContent, modifyStart ? anchor : anchor.nextSibling);
}

function previousTextBearingNode(node: Node): Node | null {
  let current: Node | null = node;
  while (current) {
    const sibling: ChildNode | null = current.previousSibling;
    if (sibling) {
      let candidate: Node = sibling;
      while (candidate.lastChild) candidate = candidate.lastChild;
      if ((candidate.textContent ?? "").length > 0) return candidate.nodeType === Node.ELEMENT_NODE
        ? candidate
        : candidate.parentNode;
      current = candidate;
    } else {
      current = current.parentNode;
    }
  }
  return null;
}

/** Append the pdf.js sentinel and start clipping native selection for this page. */
export function installPdfTextLayerSelection(textLayer: HTMLElement): () => void {
  const previousEndOfContent = textLayers.get(textLayer);
  if (previousEndOfContent && ownedEndOfContent.has(previousEndOfContent)) {
    previousEndOfContent.remove();
  }
  textLayers.delete(textLayer);
  alignPdfTextLayerGlyphs(textLayer);
  const suppliedEndOfContent = Array.from(textLayer.children).find((child) => (
    child instanceof HTMLElement && child.classList.contains("endOfContent")
  ));
  const endOfContent = suppliedEndOfContent instanceof HTMLElement
    ? suppliedEndOfContent
    : document.createElement("div");
  if (!suppliedEndOfContent) {
    endOfContent.className = "endOfContent";
    endOfContent.setAttribute("aria-hidden", "true");
    textLayer.append(endOfContent);
    ownedEndOfContent.add(endOfContent);
  }
  textLayers.set(textLayer, endOfContent);
  enableGlobalSelectionListener();

  const onMouseDown = (event: MouseEvent) => {
    if (!isVisualPdfGlyphEvent(event)) return;
    textLayer.classList.add("selecting");
    textLayer.closest(".pdf-page-content, .page")?.classList.add("is-selecting-text");
  };
  // Capture so `user-select: text` is on before WebKit starts the range.
  textLayer.addEventListener("mousedown", onMouseDown, true);

  return () => {
    if (textLayer.classList.contains("has-selection")) clearPdfTextSelection();
    textLayer.removeEventListener("mousedown", onMouseDown, true);
    if (textLayers.get(textLayer) === endOfContent) textLayers.delete(textLayer);
    if (ownedEndOfContent.has(endOfContent)) endOfContent.remove();
    textLayer.querySelectorAll(".pdf-sel-rect").forEach((node) => node.remove());
    textLayer.classList.remove("selecting");
    textLayer.classList.remove("has-selection");
    textLayer.closest(".pdf-page-content, .page")?.classList.remove("is-selecting-text");
    disableGlobalSelectionListenerIfIdle();
  };
}
