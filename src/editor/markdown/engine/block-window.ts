/**
 * Viewport rendering for long documents (spec R-PERF-3): a document of many
 * top-level blocks draws only the blocks near the viewport, plus the blocks
 * the selection is in. Every other top-level block is a placeholder of its
 * measured height (or an estimate until it has been drawn once), so the DOM
 * stays the size of the viewport however long the document is. Editing,
 * selection, IME, find and undo work on the document, never on the DOM, so
 * they do not depend on what is drawn.
 *
 * How it fits ProseMirror:
 * - Every block node view is wrapped (`blockWindow`). While the window is
 *   active, a top-level block becomes a placeholder unless a decoration from
 *   the plugin marks it live; the wrapped view refuses the update that flips
 *   it, so ProseMirror redraws just that block.
 * - The plugin state holds the window as document positions, mapped through
 *   edits, and pins the selection's blocks (and their neighbours, for arrow
 *   keys) inside it. Nothing in the state reads the DOM, so a transaction
 *   draws the right blocks before ProseMirror updates the view.
 * - The plugin view watches the scroller. When the drawn blocks no longer
 *   cover the viewport with room to spare, it measures the blocks about to be
 *   released, moves the window, and keeps the block the reader is looking at
 *   where it was on screen (the browser's own scroll anchoring is off, since
 *   WebKit and Chromium differ in it).
 *
 * Small documents, and environments without layout (no IntersectionObserver,
 * as in tests), are drawn whole, exactly as before.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension, callOrReturn, getExtensionField, type AnyExtension, type NodeViewRenderer, type NodeViewRendererProps } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type DecorationSource, type EditorView, type NodeView } from "@tiptap/pm/view";

/** A document of fewer top-level blocks is drawn whole. */
const MIN_BLOCKS = 250;
/** Blocks are drawn this many viewport heights beyond each edge… */
const KEEP_VIEWPORTS = 1.5;
/** …and the window moves once fewer than this many remain drawn beyond an edge. */
const LEAD_VIEWPORTS = 0.5;
/** Before the viewport is known (a first load), assume one this tall. */
const ASSUMED_VIEWPORT = 1000;

/** A placeholder's box: its height and the margins it collapses with its neighbours by. */
type Size = { height: number; marginTop: number; marginBottom: number };
/** What estimates are made from: the surface's text metrics and width, and the viewport height. */
type Metrics = { fontSize: number; lineHeight: number; width: number; viewport: number };
/** The drawn blocks, as top-level positions: every block starting in `from`…`to`. */
type Window = { from: number; to: number };
type WindowState = { window: Window | null; pins: readonly number[]; decorations: DecorationSet };

export type BlockWindowOptions = {
  /**
   * The ids a block's views draw for links and jumps to land on; a
   * placeholder carries them too, with any a decoration inside it names.
   */
  anchors?: (node: PmNode) => readonly string[];
};

const blockWindowKey = new PluginKey<WindowState>("latticeBlockWindow");
const INACTIVE: WindowState = { window: null, pins: [], decorations: DecorationSet.empty };
const LIVE = { latticeLiveBlock: true };
const VIRTUAL_ATTRIBUTE = "data-lx-virtual";

const HEADING_EM = [1.8, 1.4, 1.17, 1, 0.92, 0.92];

/** Where the editor scrolls: the document pane, or the nearest scrolling ancestor. */
export function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || parent.classList.contains("editor-doc-scroll")) return parent;
  }
  return null;
}

/** Real layout: the browser can measure what it draws (tests in jsdom cannot). */
const layoutAvailable = () => typeof IntersectionObserver !== "undefined";

/**
 * Whether Markdown of this length may be drawn in a window, read without
 * parsing it: a document has no more top-level blocks than lines.
 */
export function mayDrawInWindow(text: string): boolean {
  if (!layoutAvailable()) return false;
  let lines = 1;
  for (let index = text.indexOf("\n"); index >= 0 && lines < MIN_BLOCKS; index = text.indexOf("\n", index + 1)) lines += 1;
  return lines >= MIN_BLOCKS;
}

/** Whether a transaction moved the window: the drawn blocks changed without an edit. */
export function blockWindowMoved(state: EditorState, previous: EditorState): boolean {
  if (state.doc !== previous.doc) return false;
  const now = blockWindowKey.getState(state)?.window;
  const before = blockWindowKey.getState(previous)?.window;
  return now?.from !== before?.from || now?.to !== before?.to;
}

const isLive = (decorations: readonly Decoration[]) => decorations.some((decoration) => (decoration.spec as { latticeLiveBlock?: boolean }).latticeLiveBlock);
const windowOf = (view: EditorView) => blockWindowKey.getState(view.state)?.window ?? null;

const topLevelStarts = new WeakMap<PmNode, Set<number>>();
/** Whether `pos` is where a top-level block of `doc` starts (cached per document, so node views stay cheap). */
function isTopLevel(doc: PmNode, pos: number): boolean {
  let starts = topLevelStarts.get(doc);
  if (!starts) {
    const found = new Set<number>();
    doc.forEach((_node, offset) => found.add(offset));
    topLevelStarts.set(doc, starts = found);
  }
  return starts.has(pos);
}

/** Sizes and estimates for one editor, shared by its plugin and its node views. */
class Sizes {
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
    const estimated = estimate(node, this.metrics);
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
function estimate(node: PmNode, { fontSize, lineHeight, width }: Metrics): Size {
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

function applySize(element: HTMLElement, size: Size) {
  element.style.height = `${size.height}px`;
  element.style.marginTop = `${size.marginTop}px`;
  element.style.marginBottom = `${size.marginBottom}px`;
}

/**
 * The ids a block draws: those its views draw, and those decorations inside
 * it give (a decoration names one with `spec.anchorId`, as a heading inside a
 * component does).
 */
function anchorsOf(node: PmNode, inner: DecorationSource, sizes: Sizes): string[] {
  const ids = [...sizes.anchors(node)];
  inner.forEachSet((set) => {
    for (const decoration of set.find(undefined, undefined, (spec: { anchorId?: unknown }) => typeof spec.anchorId === "string")) {
      ids.push((decoration.spec as { anchorId: string }).anchorId);
    }
  });
  return ids;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** A top-level block not drawn: an empty box of its size, holding its anchors. */
function placeholder(node: PmNode, inner: DecorationSource, view: EditorView, sizes: Sizes): NodeView {
  const dom = document.createElement("div");
  dom.setAttribute(VIRTUAL_ATTRIBUTE, "");
  let current = node;
  const anchors = anchorsOf(node, inner, sizes);
  for (const id of anchors) {
    const target = document.createElement("span");
    target.id = id;
    dom.append(target);
  }
  applySize(dom, sizes.of(current));
  return {
    dom,
    update(next, decorations, innerDecorations) {
      if (!windowOf(view) || isLive(decorations) || next.type !== current.type) return false;
      if (!sameIds(anchorsOf(next, innerDecorations, sizes), anchors)) return false;
      if (next !== current) {
        current = next;
        applySize(dom, sizes.of(current));
      }
      return true;
    },
    ignoreMutation: () => true,
  };
}

/** A drawn top-level block that gives way to a placeholder when the window leaves it. */
function releasable(spec: Partial<NodeView>, node: PmNode, view: EditorView): NodeView {
  const own = spec.update?.bind(spec);
  let current = node;
  spec.update = (next, decorations, inner) => {
    if (windowOf(view) && !isLive(decorations)) return false;
    if (own) return own(next, decorations, inner);
    // ProseMirror's rule for a view it draws itself: same node type and attributes.
    if (!next.sameMarkup(current)) return false;
    current = next;
    return true;
  };
  // Without a `dom`, ProseMirror draws the node from its schema, as it would with no view.
  return spec as NodeView;
}

/**
 * The node view for a block type: its own view (if any) while drawn, a
 * placeholder while not. A top-level block is drawn releasable even while the
 * document is short: ProseMirror reuses a block's view for whatever node takes
 * its place, so a view from a short document can end up in a long one.
 */
function windowedView(inner: NodeViewRenderer | null, sizes: Sizes): NodeViewRenderer {
  return (props: NodeViewRendererProps) => {
    const { node, view, getPos, decorations } = props;
    const drawn = () => (inner ? inner(props) : null);
    const pos = layoutAvailable() ? getPos() : undefined;
    // A block inside another, or no layout to window by: exactly the node's own view (null: ProseMirror draws it).
    if (pos === undefined || !isTopLevel(view.state.doc, pos)) return drawn() as NodeView;
    if (windowOf(view) && !isLive(decorations)) return placeholder(node, props.innerDecorations, view, sizes);
    return releasable(drawn() ?? {}, node, view);
  };
}

const isBlockNode = (extension: AnyExtension) => {
  if (extension.type !== "node") return false;
  // The context Tiptap reads schema fields with (a group can depend on options, as an inline image's does).
  const context = { name: extension.name, options: extension.options, storage: extension.storage };
  const group = callOrReturn(getExtensionField(extension, "group", context as never)) as string | undefined;
  return /\bblock\b/.test(group ?? "");
};

/** `extension` with every block node view windowed, inside kits too. */
function windowed(extension: AnyExtension, sizes: Sizes): AnyExtension {
  if (isBlockNode(extension)) {
    return extension.extend({
      addNodeView() {
        const inner = (this as { parent?: () => NodeViewRenderer | null }).parent?.() ?? null;
        return windowedView(inner, sizes);
      },
    });
  }
  if (!getExtensionField(extension, "addExtensions")) return extension;
  return extension.extend({
    addExtensions() {
      return ((this as { parent?: () => AnyExtension[] }).parent?.() ?? []).map((child) => windowed(child, sizes));
    },
  });
}

/** Start and end of the top-level block `pos` is in or before. */
function blockAround(doc: PmNode, pos: number): Window | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.depth) return { from: $pos.before(1), to: $pos.after(1) };
  const node = doc.nodeAt(clamped);
  return node ? { from: clamped, to: clamped + node.nodeSize } : null;
}

/**
 * The blocks the selection is in, and the blocks either side of the head
 * (where the arrow keys go next), all drawn wherever the window is.
 */
function pinnedBlocks(state: EditorState): number[] {
  const { doc, selection } = state;
  const pins = new Set<number>();
  const pin = (block: Window | null, neighbours: boolean) => {
    if (!block) return;
    pins.add(block.from);
    if (!neighbours) return;
    const index = doc.resolve(block.from).index(0);
    if (index > 0) pins.add(block.from - doc.child(index - 1).nodeSize);
    if (block.to < doc.content.size) pins.add(block.to);
  };
  // A position between blocks (a gap cursor, all selected) is in no block.
  const inBlock = (pos: number) => (doc.resolve(pos).depth ? blockAround(doc, pos) : null);
  if (selection instanceof NodeSelection && selection.$from.depth === 0) {
    pin(blockAround(doc, selection.from), true);
  } else {
    pin(inBlock(selection.anchor), false);
    pin(inBlock(selection.head), true);
  }
  return [...pins].sort((a, b) => a - b);
}

/**
 * The window snapped to block boundaries, and long enough to fill a viewport
 * from where it starts: a load or a large replacement leaves it collapsed, and
 * it is redrawn before the view has measured anything.
 */
function covering(doc: PmNode, window: Window, sizes: Sizes): Window {
  const size = doc.content.size;
  let from = blockAround(doc, Math.min(window.from, size - 1))?.from ?? 0;
  let to = Math.max(from, Math.min(window.to, size));
  if (to < size && doc.resolve(to).depth) to = doc.resolve(to).after(1);
  const needed = (sizes.metrics.viewport || ASSUMED_VIEWPORT) * (1 + KEEP_VIEWPORTS);
  let height = 0;
  doc.nodesBetween(from, to, (node) => {
    height += sizes.of(node).height;
    return false;
  });
  while (height < needed && to < size) {
    const node = doc.nodeAt(to)!;
    height += sizes.of(node).height;
    to += node.nodeSize;
  }
  while (height < needed && from > 0) {
    const node = doc.resolve(from).nodeBefore!;
    height += sizes.of(node).height;
    from -= node.nodeSize;
  }
  return { from, to };
}

function liveDecorations(doc: PmNode, window: Window, pins: readonly number[]): DecorationSet {
  const decorations: Decoration[] = [];
  const live = (pos: number, node: PmNode) => decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, LIVE));
  for (const pos of pins) {
    if (pos < window.from) live(pos, doc.nodeAt(pos)!);
  }
  doc.nodesBetween(window.from, window.to, (node, pos) => {
    live(pos, node);
    return false;
  });
  for (const pos of pins) {
    if (pos >= window.to) live(pos, doc.nodeAt(pos)!);
  }
  return DecorationSet.create(doc, decorations);
}

const samePins = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((pos, index) => pos === b[index]);

function nextState(transaction: Transaction, value: WindowState, state: EditorState, sizes: Sizes): WindowState {
  const { doc } = state;
  if (!layoutAvailable() || doc.childCount < MIN_BLOCKS) return value.window ? INACTIVE : value;
  const requested = transaction.getMeta(blockWindowKey) as Window | undefined;
  let window = requested ?? value.window;
  if (!requested && window && transaction.docChanged) {
    window = { from: transaction.mapping.map(window.from, 1), to: transaction.mapping.map(window.to, -1) };
  }
  const pins = pinnedBlocks(state);
  if (window === value.window && !transaction.docChanged && samePins(pins, value.pins)) return value;
  window = covering(doc, window ?? { from: 0, to: 0 }, sizes);
  return { window, pins, decorations: liveDecorations(doc, window, pins) };
}

/** The top-level child of the surface at vertical position `y` (or the nearest one), by bisection. */
function childAt(children: HTMLCollection, y: number): HTMLElement | null {
  let low = 0;
  let high = children.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const rect = children[middle]!.getBoundingClientRect();
    if (y < rect.top) high = middle - 1;
    else if (y >= rect.bottom) low = middle + 1;
    else return children[middle] as HTMLElement;
  }
  return (children[Math.max(0, Math.min(high, children.length - 1))] as HTMLElement | undefined) ?? null;
}

/** A drawn block's box, with the space it keeps from its neighbours as margins. */
function measure(element: HTMLElement): Size {
  const rect = element.getBoundingClientRect();
  const previous = element.previousElementSibling;
  const next = element.nextElementSibling;
  return {
    height: rect.height,
    marginTop: previous ? Math.max(0, rect.top - previous.getBoundingClientRect().bottom) : 0,
    marginBottom: next ? Math.max(0, next.getBoundingClientRect().top - rect.bottom) : Number.parseFloat(getComputedStyle(element).marginBottom) || 0,
  };
}

/** A block kept still on screen while the blocks around it are drawn or released. */
type Anchor = { pos: number; top: number };

class BlockWindowView {
  private scroller: HTMLElement | null = null;
  private frame: number | null = null;
  private resize: ResizeObserver | null = null;
  private surfaceSize: ResizeObserver | null = null;
  private anchor: Anchor | null = null;
  private anchorFrame: number | null = null;
  private moving = false;
  private stale = false;

  constructor(readonly view: EditorView, private readonly sizes: Sizes) {
    sizes.view = view;
    this.schedule();
  }

  update(view: EditorView, previous: EditorState) {
    const now = blockWindowKey.getState(view.state);
    if (!now?.window || this.moving) return;
    const before = blockWindowKey.getState(previous)?.window;
    // A new or reshaped document (a load, a paste, an edit before the window)
    // may leave the viewport undrawn or draw far too much. Typing inside the
    // window moves neither its start nor the block count.
    if (this.stale || !before || now.window.from !== before.from || view.state.doc.childCount !== previous.doc.childCount) this.schedule();
  }

  destroy() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    if (this.anchorFrame != null) cancelAnimationFrame(this.anchorFrame);
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.resize?.disconnect();
    this.surfaceSize?.disconnect();
    if (this.sizes.view === this.view) this.sizes.view = null;
  }

  private attach(): HTMLElement | null {
    if (this.scroller || !this.view.dom.isConnected) return this.scroller;
    const scroller = scrollerOf(this.view.dom);
    if (!scroller) return null;
    this.scroller = scroller;
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => {
        this.sizes.refresh(scroller.clientHeight);
        this.schedule();
      });
      this.resize.observe(scroller);
      this.resize.observe(this.view.dom);
      // Drawn content can still grow after the window moved (React node views
      // fill in on a microtask): the anchor is held until the frame is painted.
      this.surfaceSize = new ResizeObserver(() => this.holdAnchor());
      this.surfaceSize.observe(this.view.dom);
    }
    this.sizes.refresh(scroller.clientHeight);
    return scroller;
  }

  private readonly onScroll = () => this.check();

  private schedule() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.check();
    });
  }

  /** The first and last block within `top`…`bottom` on screen, as a window. */
  private blocksBetween(top: number, bottom: number): Window | null {
    const { children } = this.view.dom;
    const first = childAt(children, top);
    const last = childAt(children, bottom);
    if (!first || !last) return null;
    const start = this.blockOf(first);
    const end = this.blockOf(last);
    return start && end ? { from: start.from, to: Math.max(start.to, end.to) } : null;
  }

  private blockOf(element: Element): Window | null {
    try {
      return blockAround(this.view.state.doc, this.view.posAtDOM(element, 0));
    } catch {
      return null;
    }
  }

  /** Move the window if the viewport, with some lead, is not all drawn, or far more than it is. */
  private check() {
    const { view, sizes } = this;
    const scroller = this.attach();
    const state = blockWindowKey.getState(view.state);
    if (!scroller || !state?.window || this.moving) return;
    if (view.composing) {
      this.stale = true;
      return;
    }
    const box = scroller.getBoundingClientRect();
    if (box.height <= 0) return;
    this.stale = false;
    sizes.metrics.viewport = box.height;
    const lead = box.height * LEAD_VIEWPORTS;
    const needed = this.blocksBetween(box.top - lead, box.bottom + lead);
    const next = this.blocksBetween(box.top - box.height * KEEP_VIEWPORTS, box.bottom + box.height * KEEP_VIEWPORTS);
    if (!needed || !next) return;
    const { window } = state;
    const covered = needed.from >= window.from && needed.to <= window.to;
    // A paste or a reveal can leave far more drawn than the viewport needs.
    const oversized = window.to - window.from > 3 * (next.to - next.from);
    if (covered && !oversized) return;
    this.release(window, next, state.pins);
    const anchor = this.anchorIn(box);
    this.moving = true;
    try {
      view.dispatch(view.state.tr.setMeta(blockWindowKey, next).setMeta("addToHistory", false));
    } finally {
      this.moving = false;
    }
    this.anchor = anchor;
    this.holdAnchor();
    if (this.anchorFrame != null) cancelAnimationFrame(this.anchorFrame);
    this.anchorFrame = requestAnimationFrame(() => {
      this.anchorFrame = null;
      this.anchor = null;
    });
  }

  /** Measure the drawn blocks the window is about to release, so their placeholders keep their size. */
  private release(window: Window, next: Window, pins: readonly number[]) {
    const { view, sizes } = this;
    view.state.doc.nodesBetween(window.from, window.to, (node, pos) => {
      if ((pos >= next.from && pos < next.to) || pins.includes(pos)) return false;
      const element = view.nodeDOM(pos);
      if (element instanceof HTMLElement && !element.hasAttribute(VIRTUAL_ATTRIBUTE)) sizes.remember(node, measure(element));
      return false;
    });
  }

  /** The block to keep still: the selection's when it is on screen, else the one in the middle of the screen. */
  private anchorIn(box: DOMRect): Anchor | null {
    const { view } = this;
    const head = blockAround(view.state.doc, view.state.selection.head);
    const selected = head && view.state.doc.resolve(Math.min(view.state.selection.head, view.state.doc.content.size)).depth ? view.nodeDOM(head.from) : null;
    if (selected instanceof HTMLElement) {
      const rect = selected.getBoundingClientRect();
      if (rect.bottom > box.top && rect.top < box.bottom) return { pos: head!.from, top: rect.top };
    }
    const middle = childAt(view.dom.children, box.top + box.height / 2);
    const block = middle && this.blockOf(middle);
    return middle && block ? { pos: block.from, top: middle.getBoundingClientRect().top } : null;
  }

  /** Scroll so the anchor block is back where it was on screen. */
  private holdAnchor() {
    const { anchor, scroller, view } = this;
    if (!anchor || !scroller) return;
    const element = view.nodeDOM(anchor.pos);
    if (!(element instanceof HTMLElement)) return;
    const shift = element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) >= 0.5) scroller.scrollTop += shift;
  }

  /** Draw the blocks around `pos` now, before anything scrolls to it. */
  reveal(pos: number) {
    const { view, sizes } = this;
    const state = blockWindowKey.getState(view.state);
    const block = state?.window ? blockAround(view.state.doc, pos) : null;
    if (!block || (block.from >= state!.window!.from && block.to <= state!.window!.to)) return;
    const reach = (sizes.metrics.viewport || ASSUMED_VIEWPORT) * (1 + KEEP_VIEWPORTS);
    const { doc } = view.state;
    let from = block.from;
    for (let height = 0; height < reach && from > 0;) {
      const node = doc.resolve(from).nodeBefore!;
      height += sizes.of(node).height;
      from -= node.nodeSize;
    }
    let to = block.to;
    for (let height = 0; height < reach && to < doc.content.size;) {
      const node = doc.nodeAt(to)!;
      height += sizes.of(node).height;
      to += node.nodeSize;
    }
    if (state?.window) this.release(state.window, { from, to }, state.pins);
    this.moving = true;
    try {
      view.dispatch(view.state.tr.setMeta(blockWindowKey, { from, to }).setMeta("addToHistory", false));
    } finally {
      this.moving = false;
    }
  }
}

const windowViews = new WeakMap<HTMLElement, BlockWindowView>();

/**
 * The element to scroll to for `element`: itself, or, when it stands in for
 * a block that is not drawn (a placeholder, or an anchor it carries), the
 * same anchor once that block has been drawn, so a jump lands exactly. A
 * block drawn by React fills in its ids a moment later; then the jump lands
 * on the block itself.
 */
export function drawnTarget(element: HTMLElement): HTMLElement {
  const holder = element.closest<HTMLElement>(`[${VIRTUAL_ATTRIBUTE}]`);
  const surface = holder?.parentElement;
  const windowView = surface ? windowViews.get(surface) : undefined;
  if (!holder || !surface || !windowView) return element;
  const { view } = windowView;
  const block = blockAround(view.state.doc, view.posAtDOM(holder, 0));
  if (!block) return element;
  windowView.reveal(block.from);
  const anchor = element.id ? surface.querySelector<HTMLElement>(`[id="${CSS.escape(element.id)}"]`) : null;
  if (anchor && !anchor.closest(`[${VIRTUAL_ATTRIBUTE}]`)) return anchor;
  const drawn = view.nodeDOM(block.from);
  return drawn instanceof HTMLElement && !drawn.hasAttribute(VIRTUAL_ATTRIBUTE) ? drawn : element;
}

/**
 * The editor's extensions with long documents drawn in a window: every block
 * node view (kits included) is wrapped, and the plugin that moves the window
 * is added.
 */
export function blockWindow(extensions: readonly AnyExtension[], options: BlockWindowOptions = {}): AnyExtension[] {
  const sizes = new Sizes(options.anchors ?? (() => []));
  const plugin = Extension.create({
    name: "latticeBlockWindow",
    addProseMirrorPlugins: () => [new Plugin<WindowState>({
      key: blockWindowKey,
      state: {
        init: () => INACTIVE,
        apply: (transaction, value, _previous, state) => nextState(transaction, value, state, sizes),
      },
      props: {
        decorations: (state) => blockWindowKey.getState(state)?.decorations,
        // The block window holds the reader's place itself, the same way in every engine.
        attributes: (state): Record<string, string> => (blockWindowKey.getState(state)?.window ? { "data-lx-windowed": "" } : {}),
      },
      view: (view) => {
        const windowView = new BlockWindowView(view, sizes);
        windowViews.set(view.dom, windowView);
        return windowView;
      },
    })],
  });
  return [...extensions.map((extension) => windowed(extension, sizes)), plugin];
}
