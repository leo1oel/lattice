/**
 * Where the visual editor's reader is: the element the document scrolls in,
 * the top-level block at a height, and the place the reader last left the
 * viewport at, held still through changes of height the way the browser's
 * own scroll anchoring would hold it. The browser's cannot be relied on: the
 * long-document window (block-window.ts) turns it off, since WebKit and
 * Chromium differ in it, so does Split, whose panes follow each other
 * (use-markdown-split-scroll.ts), an older WebKit may have none, and where
 * it is on it lets a block inserted above the viewport (a file changed on
 * disk) push the text down. Where it does adjust, the scroll it makes is a
 * scroll since the place was read, and stands.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

/** Where the editor scrolls: the document pane, or the nearest scrolling ancestor. */
export function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || parent.classList.contains("editor-doc-scroll")) return parent;
  }
  return null;
}

/** The top-level child of the surface at vertical position `y` (or the nearest one), by bisection. */
export function childAt(children: HTMLCollection, y: number): HTMLElement | null {
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

/**
 * What is at the top of the viewport as the reader last left it, from its
 * top-level block down to the deepest element there (a list item, a table
 * row), and the scroll offset it was read at.
 */
export type ReaderAnchor = { chain: { element: Element; top: number }[]; scrollTop: number };
/** How far into a block the reader's anchor is looked for, and how many children are looked at on each level. */
const READER_DEPTH = 6;
const READER_SCAN = 64;

/**
 * The elements at the top edge `top` of the viewport, outermost first: the
 * top-level block there, then, while the element found starts above the edge,
 * its first child that reaches below it, as the browser's own scroll
 * anchoring descends into a partly visible box. It stops at `isLeaf`.
 */
function readerChain(surface: HTMLElement, top: number, isLeaf: (element: Element) => boolean): { element: Element; top: number }[] {
  const chain: { element: Element; top: number }[] = [];
  let element: Element | null = childAt(surface.children, top);
  while (element && chain.length < READER_DEPTH) {
    const rect = element.getBoundingClientRect();
    chain.push({ element, top: rect.top });
    if (rect.top >= top || isLeaf(element)) break;
    let next: Element | null = null;
    const { children } = element;
    for (let index = 0; index < children.length && index < READER_SCAN; index += 1) {
      const child = children[index]!;
      const box = child.getBoundingClientRect();
      if (box.height > 0 && box.bottom > top) {
        next = child;
        break;
      }
    }
    element = next;
  }
  return chain;
}

/** Where holding a place last scrolled each scroller to. */
const heldTops = new WeakMap<HTMLElement, number>();

/** Scroll `scroller` by `shift` to keep something where it was on screen, and note that this scroll was that. */
export function holdScroll(scroller: HTMLElement, shift: number) {
  if (Math.abs(shift) < 0.5) return;
  scroller.scrollTop += shift;
  heldTops.set(scroller, scroller.scrollTop);
}

/**
 * Whether `scroller` is where holding a place last put it: its last scroll
 * kept the page still rather than moving it, so a pane that follows it (Split's
 * source) has nothing to follow.
 */
export function scrolledToHold(scroller: HTMLElement): boolean {
  const top = heldTops.get(scroller);
  return top !== undefined && Math.abs(scroller.scrollTop - top) < 1;
}

/**
 * Note what is at the top of `scroller`'s viewport in `surface` and where it
 * is. Read after every scroll and every change of height that was answered,
 * so it always describes the layout the reader last saw.
 */
export function readReaderAnchor(scroller: HTMLElement, surface: HTMLElement, isLeaf: (element: Element) => boolean): ReaderAnchor | null {
  const box = scroller.getBoundingClientRect();
  const chain = box.height > 0 ? readerChain(surface, box.top, isLeaf) : [];
  return chain.length ? { chain, scrollTop: scroller.scrollTop } : null;
}

/**
 * Scroll so the reader's place is back where it was, by the deepest element
 * of it still in the page (a view that redrew replaces its own elements). A
 * scroll since it was read (the caret scrolled into view, a jump) was meant,
 * so it stands; a block that left the document (deleted, or redrawn by a
 * window move) has nothing to hold.
 */
export function holdReaderAnchor(reader: ReaderAnchor | null, scroller: HTMLElement) {
  if (!reader || scroller.scrollTop !== reader.scrollTop) return;
  let held: ReaderAnchor["chain"][number] | undefined;
  for (const link of reader.chain) if (link.element.isConnected) held = link;
  if (!held) return;
  holdScroll(scroller, held.element.getBoundingClientRect().top - held.top);
}
