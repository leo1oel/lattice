/**
 * Split's scroll coordination on the visual editor's side, as the Tauri app's
 * `use-markdown-split-scroll.ts` does it between CodeMirror and the preview:
 * each pane follows the other through a map of the source-labelled blocks
 * (`[data-source-offset]`), the centre of a block's source lines paired with
 * the centre of its box, interpolated between neighbouring blocks
 * (`interpolateScrollAnchors`), so a long paragraph scrolls smoothly rather
 * than block by block.
 *
 * The source is Zed's editor in the GPUI app, so its side of the map is in
 * lines rather than pixels: the owner sends the line at the source's
 * viewport centre, fractional within a wrapped line, with the range that
 * centre can take (`md:scroll-to`), and hears the line the preview's centre
 * maps to (`md:scrolled`).
 */
import { interpolateScrollAnchors, scrollRange, sourceAnchors } from "../../../src/canvas/markdown-preview-sync";

/** Where each line of `text` starts, for the line of an offset. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) this.starts.push(index + 1);
  }

  /** The 0-based line holding `offset`. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  get lines(): number {
    return this.starts.length;
  }
}

type Pair = { from: number; to: number };

export class SplitScroll {
  private dirty = true;
  private toPreview: Pair[] = [];
  private toSource: Pair[] = [];
  /** The range the source's centre line takes, as the owner last said. */
  private source: { min: number; max: number } | null = null;
  /** The next scroll event is the follow this set, not the reader's. */
  private ignore = false;

  constructor(
    private readonly viewport: HTMLElement,
    /** The file's lines, and where the body the editor renders starts. */
    private readonly text: () => { lines: LineIndex; bodyStart: number },
  ) {}

  /** The preview's layout or text changed: measure the blocks again. */
  invalidate(): void {
    this.dirty = true;
  }

  private refresh(): void {
    if (!this.dirty) return;
    const { lines, bodyStart } = this.text();
    const top = this.viewport.getBoundingClientRect().top;
    const pairs: Array<{ line: number; px: number }> = [];
    for (const anchor of sourceAnchors(this.viewport)) {
      const first = lines.lineOf(bodyStart + anchor.from);
      const last = lines.lineOf(bodyStart + Math.max(anchor.from, anchor.to - 1));
      const rect = anchor.element.getBoundingClientRect();
      const pair = { line: (first + last + 1) / 2, px: Math.max(0, this.viewport.scrollTop + rect.top - top + rect.height / 2) };
      const previous = pairs.at(-1);
      // Nested blocks (a list's items) would fold the map back on itself.
      if (!previous || (pair.line > previous.line && pair.px > previous.px)) pairs.push(pair);
    }
    this.toPreview = pairs.map((pair) => ({ from: pair.line, to: pair.px }));
    this.toSource = pairs.map((pair) => ({ from: pair.px, to: pair.line }));
    this.dirty = false;
  }

  /** The source's centre is at line `center`, within `[min, max]`: follow it. */
  followSource(center: number, min: number, max: number): void {
    this.source = { min, max };
    this.refresh();
    const half = this.viewport.clientHeight / 2;
    const target = interpolateScrollAnchors(center, this.toPreview, min, max, half, scrollRange(this.viewport) + half);
    const next = target - half;
    if (Math.abs(this.viewport.scrollTop - next) <= 1) return;
    this.ignore = true;
    this.viewport.scrollTop = next;
  }

  /** The preview scrolled: the line the source's centre should follow to, or null for a follow's own scroll. */
  sourceCenter(): number | null {
    if (this.ignore) {
      this.ignore = false;
      return null;
    }
    this.refresh();
    const { lines } = this.text();
    const { min, max } = this.source ?? { min: 0, max: lines.lines };
    const half = this.viewport.clientHeight / 2;
    return interpolateScrollAnchors(this.viewport.scrollTop + half, this.toSource, half, scrollRange(this.viewport) + half, min, max);
  }
}
