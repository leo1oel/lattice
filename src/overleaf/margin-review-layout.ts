/**
 * How margin review (overleaf-margin-review.tsx) lays out the source: wide,
 * the text at the reading measure with the cards in the width beyond it, or
 * markers in the outline rail's gutter with the text at full width.
 *
 * The rule lives here rather than in the layer's chunk, and reads nothing
 * CodeMirror measures later: a file that opens with review beside it is laid
 * out from the editor's first frame (app-overleaf-drawer.tsx sets the pane's
 * `data-margin-review` before it paints), and its skeleton is drawn at the
 * same text width before that (document-skeleton.tsx). Deciding a frame late
 * drew the text at full width first and rewrapped every line into the
 * narrower column a moment after.
 */
import type { EditorView } from "@codemirror/view";
import "./margin-review-layout.css";

export type MarginLayout = { kind: "wide" | "markers"; narrow: boolean };

export const MARKERS_LAYOUT: MarginLayout = { kind: "markers", narrow: false };

/** A card's width, and the gap between the text and the cards. */
export const CARD_WIDTH = 268;
export const CARD_GAP = 24;
/** The outline rail's gutter (`--outline-rail-clearance`, editor-workspace.css). */
const RAIL_CLEARANCE = 36;
/** Below this much text width a card beside the line would cover most of it, so the rail opens instead. */
const NARROW_TEXT = 480;

/**
 * Wide when the window's choice allows it and the pane holds the measure
 * (with the gutter before it) and a card beside it, clear of the rail.
 */
export function marginLayoutFor({ wantWide, width, gutters, measure, textWidth }: {
  /** Auto, and not focus mode. */
  wantWide: boolean;
  /** The scroller's width. */
  width: number;
  /** The line-number gutter's width. */
  gutters: number;
  /** The text's width at the reading measure (sourceColumns). */
  measure: number;
  /** The text's width without the measure, for markers. */
  textWidth: number;
}): MarginLayout {
  const wide = wantWide && width >= gutters + measure + CARD_GAP + CARD_WIDTH + RAIL_CLEARANCE;
  return { kind: wide ? "wide" : "markers", narrow: !wide && textWidth < NARROW_TEXT };
}

export const sameMarginLayout = (a: MarginLayout, b: MarginLayout) => a.kind === b.kind && a.narrow === b.narrow;

/** The last probes taken in each element, kept while its face (and so its character width) is the same. */
const probes = new WeakMap<HTMLElement, { key: string; measure: number; gutter: number }>();

/**
 * The width the wide layout gives the text and the width of the line-number
 * gutter (margin-review-layout.css), read from probes in `within`'s face:
 * both are in that face's own `ch`, which CodeMirror's
 * `defaultCharacterWidth` only knows a frame after the editor is built.
 * `face` stands for the font: the probes are taken again when it changes,
 * never per keystroke.
 */
export function sourceColumns(within: HTMLElement, face: string): { measure: number; gutter: number } {
  const cached = probes.get(within);
  if (cached?.key === face) return cached;
  const probe = (part: string) => {
    const element = within.ownerDocument.createElement("div");
    element.className = "margin-review-measure";
    element.dataset.part = part;
    within.append(element);
    return element;
  };
  const measure = probe("measure");
  const gutter = probe("gutter");
  const taken = { key: face, measure: measure.getBoundingClientRect().width, gutter: gutter.getBoundingClientRect().width };
  measure.remove();
  gutter.remove();
  probes.set(within, taken);
  return taken;
}

/** The layout `view` shows review in now, from its geometry. */
export function measureMarginLayout(view: EditorView, wantWide: boolean): MarginLayout {
  const scroller = view.scrollDOM;
  if (!scroller.isConnected) return MARKERS_LAYOUT;
  return marginLayoutFor({
    wantWide,
    width: scroller.clientWidth,
    gutters: view.dom.querySelector(".cm-gutters")?.getBoundingClientRect().width ?? 0,
    // CodeMirror's character width moves with the font, and only with it.
    measure: sourceColumns(scroller, String(view.defaultCharacterWidth)).measure,
    textWidth: view.contentDOM.getBoundingClientRect().width,
  });
}

/**
 * The layout a source skeleton stands in for (document-skeleton.tsx): the
 * one the editor replacing it will decide, from the skeleton's own width.
 */
export function skeletonMarginLayout(source: HTMLElement, wantWide: boolean): MarginLayout {
  const style = getComputedStyle(source);
  const { measure, gutter } = sourceColumns(source, `${style.fontFamily} ${style.fontSize}`);
  const width = source.clientWidth;
  return marginLayoutFor({ wantWide, width, gutters: gutter, measure, textWidth: width - gutter - RAIL_CLEARANCE });
}
