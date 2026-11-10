/** Text layers, glyph boxes and pointer input for the PDF text-layer selection tests. */
import { expect } from "vitest";
import { installPdfTextLayerSelection } from "./pdf-text-layer-selection";

export function glyphLayer(...words: string[]) {
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
export const HELLO_BOX: Box = { left: 10, top: 10, right: 40, bottom: 22 };
export const WIDE_BOX: Box = { left: 10, top: 10, right: 80, bottom: 22 };

export function mockGlyphBox(span: HTMLElement, box: Box) {
  const rect = { ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON() { return this; } };
  span.getBoundingClientRect = () => rect as DOMRect;
  span.getClientRects = () => [rect] as unknown as DOMRectList;
}

/** Install selection on `layer` for the duration of `run`. */
export async function withSelection(layer: HTMLElement, run: () => void | Promise<void>) {
  const uninstall = installPdfTextLayerSelection(layer, layer);
  try {
    await run();
  } finally {
    uninstall();
  }
}

/** A primary-button press inside HELLO_BOX / WIDE_BOX. */
export const pointerDown = (target: EventTarget) => target.dispatchEvent(new PointerEvent("pointerdown", {
  bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 16,
}));
export const pointerUp = () => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
export const modifierKey = (key: string) => new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });

export function selectRange(range: Range) {
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

export function selectGlyph(span: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(span);
  Object.defineProperty(range, "getClientRects", { value: () => [] as unknown as DOMRectList });
  selectRange(range);
}

/** Press on `span`, select all of its text, and release: a completed drag over one glyph. */
export function dragSelect(span: HTMLElement) {
  pointerDown(span);
  const range = document.createRange();
  range.selectNodeContents(span);
  selectRange(range);
  pointerUp();
}

/** A highlight mark's box in px of a `width`×`height` layer. */
export function markBox({ style }: HTMLElement, width: number, height: number) {
  const px = (value: string, size: number) => Math.round(Number.parseFloat(value) * size / 100 * 1000) / 1000;
  expect([style.left, style.top, style.width, style.height].every((value) => value.endsWith("%"))).toBe(true);
  return { left: px(style.left, width), top: px(style.top, height), width: px(style.width, width), height: px(style.height, height) };
}

export function sentinelLayer(...words: string[]) {
  const { layer, spans } = glyphLayer(...words);
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  return { spans, end, layers: new Map<HTMLElement, HTMLElement>([[layer, end]]) };
}
