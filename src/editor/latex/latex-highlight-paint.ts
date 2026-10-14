import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { latexHighlights } from "./latex-highlights";

/**
 * A highlight looks like one in the source, not only in the PDF: its argument
 * is painted with its paper tint (in the light editor under the paper's black
 * ink, as it prints; in the dark one as a wash and an underline in its color,
 * since a pastel block would put the editor's light ink on a light ground),
 * and the `\colorbox[HTML]{…}{` wrapper recedes behind a swatch of its color.
 *
 * Only what is on screen is scanned, with a margin either side so a highlight
 * that starts or ends just off screen is still found whole; a document of
 * megabytes costs what its viewport costs.
 */
const MARGIN = 2000;

class Swatch extends WidgetType {
  constructor(readonly hex: string) {
    super();
  }
  eq(other: Swatch) {
    return other.hex === this.hex;
  }
  toDOM() {
    const swatch = document.createElement("span");
    swatch.className = "cm-hl-swatch";
    swatch.style.background = this.hex;
    swatch.setAttribute("aria-hidden", "true");
    return swatch;
  }
  ignoreEvent() {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const marks: Array<[number, number, Decoration]> = [];
  const seen = new Set<number>();
  for (const range of view.visibleRanges) {
    const from = Math.max(0, range.from - MARGIN);
    const to = Math.min(view.state.doc.length, range.to + MARGIN);
    for (const highlight of latexHighlights(view.state.sliceDoc(from, to))) {
      const start = from + highlight.from;
      const hex = highlight.color && /^#[0-9A-F]{6}$/i.test(highlight.color) ? highlight.color : null;
      if (!hex || seen.has(start)) continue;
      seen.add(start);
      const style = `--hl: ${hex}`;
      marks.push([start, start, Decoration.widget({ widget: new Swatch(hex), side: -1 })]);
      marks.push([start, from + highlight.contentFrom, Decoration.mark({ class: "cm-hl-wrap" })]);
      if (highlight.contentTo > highlight.contentFrom) {
        marks.push([from + highlight.contentFrom, from + highlight.contentTo, Decoration.mark({ class: "cm-hl-paint", attributes: { style } })]);
      }
      marks.push([from + highlight.contentTo, from + highlight.to, Decoration.mark({ class: "cm-hl-wrap" })]);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const builder = new RangeSetBuilder<Decoration>();
  for (const [from, to, decoration] of marks) builder.add(from, to, decoration);
  return builder.finish();
}

export function highlightPaint() {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  }, { decorations: (plugin) => plugin.decorations });
}
