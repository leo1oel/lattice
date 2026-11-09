/**
 * How big a block of the long-document window is (block-window.ts): what a
 * placeholder measures, from the block's own drawn size when it has been
 * drawn, a similar block's, or an estimate from its text and the surface's
 * metrics before then.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { scrollerOf } from "./viewport-anchor";

/** A placeholder's box: its height and the margins it collapses with its neighbours by. */
export type Size = { height: number; marginTop: number; marginBottom: number };
/** What estimates are made from: the surface's text metrics and width, and the viewport height. */
export type Metrics = { fontSize: number; lineHeight: number; width: number; viewport: number };

const HEADING_EM = [1.8, 1.4, 1.17, 1, 0.92, 0.92];

/** Sizes and estimates for one editor, shared by its plugin and its node views. */
export class Sizes {
  view: EditorView | null = null;
  private current: Metrics | null = null;
  private exact = new WeakMap<PmNode, Size>();
  /** Measured sizes by kind and length: a block like one drawn before is likely as tall. */
  private similar = new Map<string, Size>();
  private estimates = new WeakMap<PmNode, Size>();
  private anchorCache = new WeakMap<PmNode, readonly string[]>();

  constructor(private readonly anchorsOf: (node: PmNode) => readonly string[]) {}

  /**
   * The surface's text metrics, read from the page the first time a size is
   * needed: a long document's first window is chosen before the plugin view
   * has measured anything.
   */
  get metrics(): Metrics {
    this.current ??= readMetrics(this.view);
    return this.current;
  }

  of(node: PmNode): Size {
    const known = this.exact.get(node) ?? this.similar.get(similarKey(node)) ?? this.estimates.get(node);
    if (known) return known;
    const estimated = estimateBlockSize(node, this.metrics);
    this.estimates.set(node, estimated);
    return estimated;
  }

  remember(node: PmNode, size: Size) {
    this.exact.set(node, size);
    this.similar.set(similarKey(node), size);
  }

  anchors(node: PmNode): readonly string[] {
    let anchors = this.anchorCache.get(node);
    if (!anchors) this.anchorCache.set(node, anchors = this.anchorsOf(node));
    return anchors;
  }

  /**
   * Read the metrics again. Sizes measured at another width no longer hold;
   * placeholders already drawn keep theirs (restyling thousands of them on
   * every step of a pane resize would cost more than it saves) and are held
   * in place by the anchor as they are drawn.
   */
  refresh(viewport: number) {
    const metrics = readMetrics(this.view, viewport);
    if (this.current && Math.abs(metrics.width - this.current.width) > 1) {
      this.exact = new WeakMap();
      this.similar.clear();
      this.estimates = new WeakMap();
    }
    this.current = metrics;
  }
}

/** The surface's text metrics and width, or a typical page's before it is in the page. */
function readMetrics(view: EditorView | null, viewport?: number): Metrics {
  const dom = view?.dom;
  if (!dom?.isConnected) return { fontSize: 16, lineHeight: 27, width: 760, viewport: viewport ?? 0 };
  viewport ??= scrollerOf(dom)?.clientHeight ?? 0;
  const style = getComputedStyle(dom);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.7;
  const width = dom.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  return { fontSize, lineHeight, width: width > 0 ? width : 760, viewport };
}

const similarKey = (node: PmNode) => `${node.type.name}:${String(node.attrs.level ?? "")}:${node.nodeSize}`;

/** A block's likely size before it has ever been drawn. */
function estimateBlockSize(node: PmNode, { fontSize, lineHeight, width }: Metrics): Size {
  const lines = (characters: number, em = 1) => Math.max(1, Math.ceil((characters * fontSize * em * 0.5) / Math.max(200, width)));
  const flow = fontSize * 0.85;
  switch (node.type.name) {
    case "heading": {
      const em = HEADING_EM[(node.attrs.level as number) - 1] ?? 1;
      return { height: lines(node.textContent.length, em) * fontSize * em * 1.3, marginTop: fontSize * em * 1.6, marginBottom: fontSize * em * 0.45 };
    }
    case "codeBlock":
      return { height: node.textContent.split("\n").length * fontSize * 1.4 + fontSize * 3, marginTop: 0, marginBottom: flow };
    case "horizontalRule":
      return { height: 1, marginTop: fontSize * 2, marginBottom: fontSize * 2 };
    case "table":
      return { height: node.childCount * (lineHeight + fontSize * 0.9), marginTop: 0, marginBottom: flow };
    default: {
      // Prose, lists, quotes and the rest: a wrapped line run per textblock.
      if (node.isTextblock) return { height: lines(node.textContent.length) * lineHeight, marginTop: 0, marginBottom: flow };
      let height = 0;
      let runs = 0;
      node.descendants((child) => {
        if (!child.isTextblock) return true;
        height += lines(child.textContent.length) * lineHeight;
        runs += 1;
        return false;
      });
      return { height: Math.max(lineHeight, height + Math.max(0, runs - 1) * fontSize * 0.3), marginTop: 0, marginBottom: flow };
    }
  }
}

export function applySize(element: HTMLElement, size: Size) {
  element.style.height = `${size.height}px`;
  element.style.marginTop = `${size.marginTop}px`;
  element.style.marginBottom = `${size.marginBottom}px`;
}

/** A drawn block's box, with the space it keeps from its neighbours as margins. */
export function measureBlock(element: HTMLElement): Size {
  const rect = element.getBoundingClientRect();
  const previous = element.previousElementSibling;
  const next = element.nextElementSibling;
  return {
    height: rect.height,
    marginTop: previous ? Math.max(0, rect.top - previous.getBoundingClientRect().bottom) : 0,
    marginBottom: next ? Math.max(0, next.getBoundingClientRect().top - rect.bottom) : Number.parseFloat(getComputedStyle(element).marginBottom) || 0,
  };
}
