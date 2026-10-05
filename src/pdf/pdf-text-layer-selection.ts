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

import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAgentEntryTarget } from "../agent/agent-entry";
import { addListeners, normalizePdfSelection } from "./pdf-viewer-utils";

const GLYPH_SPANS = "span:not(.markedContent):not(.endOfContent)";

const textLayers = new Map<HTMLElement, HTMLElement>();
const ownedEndOfContent = new WeakSet<HTMLElement>();
let selectionAbort: AbortController | null = null;
let previousRange: Range | null = null;
let lastPdfCopyText = "";
/** The text layers the cached selection was made in, so each viewer reports only its own. */
let lastPdfSelectionLayers: HTMLElement[] = [];
let copyField: HTMLTextAreaElement | null = null;
const clipboardTimers: number[] = [];

export const PDF_TEXT_SELECTION_CLEARED_EVENT = "lattice:pdf-text-selection-cleared";

const pageOf = (textLayer: Element) => textLayer.closest(".page");

function resetLayer(textLayer: HTMLElement, endOfContent: HTMLElement) {
  if (endOfContent.parentElement !== textLayer) textLayer.append(endOfContent);
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  textLayer.classList.remove("selecting");
  pageOf(textLayer)?.classList.remove("is-selecting-text");
}

function resetLayers() {
  for (const [textLayer, endOfContent] of textLayers) resetLayer(textLayer, endOfContent);
}

export function isPdfCopyField(node: EventTarget | null): boolean {
  return node instanceof HTMLTextAreaElement && node.classList.contains("pdf-copy-field");
}

export function isEditableSelectAllTarget(node: EventTarget | null): boolean {
  if (!(node instanceof Element) || isPdfCopyField(node)) return false;
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return !node.readOnly;
  return Boolean(node.closest("input, textarea, [contenteditable=true], .cm-editor, .cm-content, .tiptap, .ProseMirror"));
}

function fieldHasOwnSelection(node: EventTarget | null): boolean {
  return (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
    && !isPdfCopyField(node)
    && node.selectionStart !== node.selectionEnd;
}

/** Command-A must not select every PDF glyph span in the webview. */
export function shouldPreventPdfSelectAll(
  target: EventTarget | null,
  activeElement: Element | null = document.activeElement,
  layerCount = textLayers.size,
): boolean {
  return layerCount > 0 && !isEditableSelectAllTarget(target) && !isEditableSelectAllTarget(activeElement);
}

function selectionRanges(selection: Selection | null): Range[] {
  return Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index));
}

function selectionIntersectsLayer(selection: Selection | null, textLayer: HTMLElement): boolean {
  return !!selection && !selection.isCollapsed && selectionRanges(selection).some((range) => range.intersectsNode(textLayer));
}

function selectionIntersectsPdf(selection: Selection | null): boolean {
  return [...textLayers.keys()].some((textLayer) => selectionIntersectsLayer(selection, textLayer));
}

function selectionIsCopyField(selection: Selection | null): boolean {
  const node = selection?.anchorNode;
  return !!copyField && !!node && (node === copyField || copyField.contains(node));
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
  return span?.matches(GLYPH_SPANS) ? span : null;
}

/**
 * True when the event is on a glyph's *visible* box. Transformed PDF spans have
 * oversized hit-testing boxes in WebKit, so "empty" page clicks often land on a
 * span that does not visually contain the pointer.
 */
export function isVisualPdfGlyphEvent({ target, clientX, clientY }: Pick<MouseEvent, "target" | "clientX" | "clientY">): boolean {
  const span = glyphSpanFromTarget(target);
  return !!span && [...span.getClientRects()].some((rect) => (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  ));
}

function clearSelectionOverlays() {
  for (const textLayer of textLayers.keys()) {
    textLayer.querySelectorAll(".pdf-sel-rect").forEach((node) => node.remove());
  }
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
  if (!selection || selection.isCollapsed || selectionIsCopyField(selection)) {
    clearSelectionOverlays();
    return;
  }
  // Keep every layout read ahead of connected DOM writes, including across
  // pages. Interleaving measurements with appended marks forces one layout
  // per glyph on each selectionchange, making paragraph drags stutter.
  const fragments = new Map<HTMLElement, DocumentFragment>();
  for (const textLayer of textLayers.keys()) {
    if (!selectionIntersectsLayer(selection, textLayer)) continue;
    const origin = textLayer.getBoundingClientRect();
    const fragment = document.createDocumentFragment();
    fragments.set(textLayer, fragment);
    for (const range of selectionRanges(selection)) {
      if (!range.intersectsNode(textLayer)) continue;
      // WebKit includes PDF.js's full-page endOfContent sentinel in the range
      // rectangle list. Measure each selected glyph separately so an internal
      // clipping node can never become a page-sized visual highlight.
      for (const glyph of textLayer.querySelectorAll<HTMLElement>(GLYPH_SPANS)) {
        // The full scaled line box keeps low glyphs and descenders highlighted.
        for (const rect of rangeInsideGlyph(range, glyph)?.getClientRects() ?? []) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          const mark = document.createElement("div");
          mark.className = "pdf-sel-rect";
          mark.setAttribute("aria-hidden", "true");
          Object.assign(mark.style, {
            left: `${rect.left - origin.left}px`,
            top: `${rect.top - origin.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
          fragment.append(mark);
        }
      }
    }
  }
  clearSelectionOverlays();
  for (const [textLayer, fragment] of fragments) textLayer.append(fragment);
}

function textFromRange(range: Range): string {
  const contents = range.cloneContents().textContent ?? "";
  return contents.trim() ? contents : range.toString();
}

function syncNativePdfCopyText(text: string) {
  void invoke("set_pdf_copy_text", { text: text || null }).catch(() => undefined);
}

function armPdfCopyField(text: string) {
  lastPdfCopyText = text;
  syncNativePdfCopyText(text);
  if (!copyField?.isConnected) {
    copyField = document.createElement("textarea");
    copyField.className = "pdf-copy-field";
    copyField.readOnly = true;
    copyField.tabIndex = -1;
    copyField.setAttribute("aria-hidden", "true");
    document.body.append(copyField);
  }
  copyField.value = text;
  copyField.focus({ preventScroll: true });
  copyField.select();
}

function disarmPdfCopyField() {
  syncNativePdfCopyText("");
  if (!copyField) return;
  copyField.value = "";
  if (document.activeElement === copyField) copyField.blur();
}

/** Drop a PDF text-layer range. Leaves an editor-only selection alone. */
function clearPdfTextSelection() {
  const selection = document.getSelection();
  const selectionOwnedByPdf = selectionIntersectsPdf(selection) || selectionIsCopyField(selection);
  const hadPdfSelection = selectionOwnedByPdf || Boolean(lastPdfCopyText);
  if (selectionOwnedByPdf) selection?.removeAllRanges();
  previousRange = null;
  lastPdfCopyText = "";
  lastPdfSelectionLayers = [];
  clearSelectionOverlays();
  disarmPdfCopyField();
  resetLayers();
  for (const textLayer of textLayers.keys()) textLayer.classList.remove("has-selection");
  // WebKit parks a completed PDF drag in the hidden copy field and does not
  // reliably publish the programmatic clear. Notify PdfViewer so its Agent
  // context cannot retain text after the visible highlight is gone.
  if (hadPdfSelection) {
    document.dispatchEvent(new Event(PDF_TEXT_SELECTION_CLEARED_EVENT));
    document.dispatchEvent(new Event("selectionchange"));
  }
}

function pdfSelectedPlainText(selection: Selection | null = document.getSelection()): string {
  if (selectionIsCopyField(selection)) return lastPdfCopyText || copyField?.value || "";
  if (!selectionIntersectsPdf(selection)) return "";
  const ranges = selectionRanges(selection);
  const joined = normalizePdfSelection(ranges.map(textFromRange).join(""));
  if (joined) return joined;
  const fallback: string[] = [];
  for (const textLayer of textLayers.keys()) {
    if (!selectionIntersectsLayer(selection, textLayer)) continue;
    for (const span of textLayer.querySelectorAll<HTMLElement>(GLYPH_SPANS)) {
      if (ranges.some((range) => range.intersectsNode(span))) fallback.push(span.textContent ?? "");
    }
  }
  return normalizePdfSelection(fallback.join(""));
}

export function pdfSelectedOrCachedPlainText(selection: Selection | null = document.getSelection()): string {
  return pdfSelectedPlainText(selection) || lastPdfCopyText || copyField?.value || "";
}

function layersHoldingSelection(selection: Selection | null): HTMLElement[] {
  return [...textLayers.keys()].filter((textLayer) => selectionIntersectsLayer(selection, textLayer));
}

function rememberPdfSelection(text: string, selection: Selection | null) {
  lastPdfCopyText = text;
  lastPdfSelectionLayers = layersHoldingSelection(selection);
}

/**
 * The PDF selection's text when it was made inside `root`. The cache and the
 * copy field are shared by every PDF on screen (a project PDF open as a
 * document beside the compiled preview), but each selection belongs to one.
 */
export function pdfSelectedPlainTextWithin(root: Node, selection: Selection | null = document.getSelection()): string {
  const layers = selectionIntersectsPdf(selection) ? layersHoldingSelection(selection) : lastPdfSelectionLayers;
  return layers.some((textLayer) => root.contains(textLayer)) ? pdfSelectedOrCachedPlainText(selection) : "";
}

async function writeClipboardText(text: string) {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text);
  }
}

function clearClipboardTimers() {
  for (const timer of clipboardTimers) window.clearTimeout(timer);
  clipboardTimers.length = 0;
}

function copyPdfSelection(event: Event & { clipboardData?: DataTransfer | null }) {
  const text = fieldHasOwnSelection(event.target) || fieldHasOwnSelection(document.activeElement)
    ? ""
    : pdfSelectedOrCachedPlainText();
  if (!text) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.clipboardData?.setData("text/plain", text);
  clearClipboardTimers();
  void writeClipboardText(text);
  for (const delay of [0, 40]) clipboardTimers.push(window.setTimeout(() => void writeClipboardText(text), delay));
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
  const adjustments: { span: HTMLElement; spacing: number }[] = [];
  // Read all geometry before writing any styles. Interleaving these forces a
  // full text-layer layout for every run and stalls scrolling on dense pages.
  for (const span of textLayer.querySelectorAll<HTMLElement>(GLYPH_SPANS)) {
    const glyphs = [...(span.textContent ?? "")];
    if (glyphs.length <= 1) continue;
    const scaleX = glyphScaleX(span);
    if (Math.abs(scaleX - 1) < 0.02) continue;
    const layoutWidth = span.offsetWidth;
    if (!(layoutWidth > 0)) continue;
    const extra = layoutWidth * (Math.abs(scaleX) - 1);
    if (Math.abs(extra) < 0.5) continue;
    adjustments.push({ span, spacing: extra / (glyphs.length - 1) });
  }
  for (const { span, spacing } of adjustments) {
    span.style.letterSpacing = `${spacing}px`;
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
      const active = document.activeElement;
      if (active instanceof HTMLElement && isEditableSelectAllTarget(active)) active.blur();
      const span = glyphSpanFromTarget(event.target);
      if (span) pageOf(span)?.classList.add("is-selecting-text");
      return;
    }
    pointerDown = false;
    if (glyphSpanFromTarget(event.target)) event.preventDefault();
    // Opening the Agent is how the selection becomes its context: the Agent
    // tab shares a panel with Project by default, so clearing here would
    // remove the context in the very click that goes to use it.
    if (isAgentEntryTarget(event.target)) return;
    clearPdfTextSelection();
  }, { capture: true, signal });
  document.addEventListener("pointerup", () => {
    if (!pointerDown) return;
    pointerDown = false;
    previousRange = null;
    const selection = document.getSelection();
    updateHasSelection(selection);
    const live = pdfSelectedPlainText(selection);
    // A click on a glyph can collapse the old range without creating a new
    // one. Clear its copy cache and notify the viewer, just like a blank click.
    if (!live) {
      clearPdfTextSelection();
      return;
    }
    rememberPdfSelection(live, selection);
    paintSelectionOverlays(selection);
    resetLayers();
    armPdfCopyField(live);
  }, { signal });
  window.addEventListener("blur", () => {
    pointerDown = false;
  }, { signal });
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "a" && shouldPreventPdfSelectAll(event.target, document.activeElement)) event.preventDefault();
    if (key === "c" || key === "x") copyPdfSelection(event);
  }, { capture: true, signal });
  for (const type of ["copy", "cut"]) document.addEventListener(type, copyPdfSelection, { capture: true, signal });
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (selectionIsCopyField(selection)) return;
    if (!selection || selection.rangeCount === 0) {
      updateHasSelection(selection);
      if (!pointerDown) {
        previousRange = null;
        resetLayers();
      }
      return;
    }
    // `.selecting` is only for an in-progress drag. Re-adding it after mouseup
    // stretches `.endOfContent` over the page and makes empty space eat clicks.
    if (pointerDown) {
      const ranges = selectionRanges(selection);
      for (const [textLayer, endOfContent] of textLayers) {
        if (ranges.some((range) => range.intersectsNode(textLayer))) textLayer.classList.add("selecting");
        else resetLayer(textLayer, endOfContent);
      }
      placeEndOfContentForRange(ranges[0]!, previousRange, textLayers);
      previousRange = ranges[0]!.cloneRange();
      paintSelectionOverlays(selection);
    }
    updateHasSelection(selection);
    const live = pdfSelectedPlainText(selection);
    if (live) rememberPdfSelection(live, selection);
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
  lastPdfSelectionLayers = [];
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
  if (previousEndOfContent && ownedEndOfContent.has(previousEndOfContent)) previousEndOfContent.remove();
  textLayers.delete(textLayer);
  alignPdfTextLayerGlyphs(textLayer);
  let endOfContent = textLayer.querySelector<HTMLElement>(":scope > .endOfContent");
  if (!endOfContent) {
    endOfContent = document.createElement("div");
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
    pageOf(textLayer)?.classList.add("is-selecting-text");
  };
  // Capture so `user-select: text` is on before WebKit starts the range.
  textLayer.addEventListener("mousedown", onMouseDown, true);

  return () => {
    if (textLayer.classList.contains("has-selection") && !selectionIsCopyField(document.getSelection())) clearPdfTextSelection();
    textLayer.removeEventListener("mousedown", onMouseDown, true);
    if (textLayers.get(textLayer) === endOfContent) textLayers.delete(textLayer);
    if (ownedEndOfContent.has(endOfContent)) endOfContent.remove();
    textLayer.querySelectorAll(".pdf-sel-rect").forEach((node) => node.remove());
    textLayer.classList.remove("selecting", "has-selection");
    pageOf(textLayer)?.classList.remove("is-selecting-text");
    disableGlobalSelectionListenerIfIdle();
  };
}

/**
 * A text layer PDF.js drew again over the same nodes: a zoom, or a page our
 * PDF.js patch kept the text of while a live drag ran through it (see
 * PDFPageViewBuffer there) scrolled back into view. A range in it is still
 * valid, so only the glyph alignment and the highlight are redone.
 */
export function refreshPdfTextLayerSelection(textLayer: HTMLElement): void {
  alignPdfTextLayerGlyphs(textLayer);
  textLayer.querySelectorAll(".pdf-sel-rect").forEach((node) => node.remove());
  const selection = document.getSelection();
  if (!selectionIsCopyField(selection) && selectionIntersectsLayer(selection, textLayer)) paintSelectionOverlays(selection);
}

/**
 * Report the viewer's PDF selection as agent context, and its clearing. A
 * completed PDF drag moves the native selection into the hidden copy field
 * while its overlay remains visible, so this reads the text-layer cache.
 * Global selection changes may publish a new selection made in this viewer,
 * but only an interaction inside it is authoritative enough to clear one.
 * A selection in another PDF is that viewer's to report; this one only
 * forgets what it reported, so the same text selected here again is new.
 */
export function usePdfSelectionReport(
  viewerRef: RefObject<{ root: HTMLElement } | null>,
  generation: number,
  callbacks: RefObject<{ onTextSelect?: (text: string) => void }>,
) {
  useEffect(() => {
    const root = viewerRef.current?.root;
    if (!generation || !root) return;
    let lastReported = "";
    let frame: number | null = null;
    const report = (clearCollapsed: boolean) => {
      frame = null;
      const selection = window.getSelection();
      const next = pdfSelectedPlainTextWithin(root, selection);
      if (!next && pdfSelectedOrCachedPlainText(selection)) {
        lastReported = "";
        return;
      }
      const unchanged = next ? next === lastReported : !clearCollapsed || !lastReported;
      if (unchanged) return;
      lastReported = next;
      callbacks.current.onTextSelect?.(next);
    };
    const cancelFrame = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
    const removeRootListeners = addListeners(root, {
      mouseup: () => {
        cancelFrame();
        frame = window.requestAnimationFrame(() => report(true));
      },
      keyup: () => report(true),
    });
    const removeDocumentListeners = addListeners(document, {
      selectionchange: () => report(false),
      [PDF_TEXT_SELECTION_CLEARED_EVENT]: () => report(true),
    });
    return () => {
      cancelFrame();
      removeRootListeners();
      removeDocumentListeners();
    };
  }, [callbacks, generation, viewerRef]);
}
