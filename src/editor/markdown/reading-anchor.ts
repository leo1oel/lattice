/**
 * A reading position in a visual Markdown document that survives a change of
 * layout: the top-level block at the top of the viewport, by its index in the
 * document, and how far that block's top sits from the viewport's.
 *
 * A pixel offset does not survive one. The same Paper is drawn by its full
 * reader (with a masthead, figures loaded as they were scrolled past) and by
 * Trellis's read-only snapshot beside the notes (without either, often at
 * another width), so one offset lands sections apart in the other. A long
 * read-only document is drawn as passive chunks, of which only those near the
 * viewport hold blocks; each chunk carries the index of its first block.
 */
import type { VisualMarkdownViewState } from "../../app-types";

export type ReadingAnchor = NonNullable<VisualMarkdownViewState["anchor"]>;

const CHUNK = "[data-visual-chunk-first]";

const chunkFirst = (chunk: HTMLElement) => Number(chunk.dataset.visualChunkFirst);

/** A drawn chunk's (or the whole editor's) top-level blocks: the outermost ProseMirror's children. */
const blocksIn = (root: ParentNode) => root.querySelector(".ProseMirror")?.children;

/** The first of `elements` (in vertical order) whose bottom is below `top`; their length when none is. */
function firstReaching(elements: ArrayLike<Element>, top: number) {
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (elements[middle]!.getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The block at the top of `viewport`, or undefined while none is drawn there. */
export function captureReadingAnchor(viewport: HTMLElement): ReadingAnchor | undefined {
  const top = viewport.getBoundingClientRect().top;
  const chunks = viewport.querySelectorAll<HTMLElement>(CHUNK);
  const chunk = chunks.length ? chunks[firstReaching(chunks, top)] : null;
  if (chunks.length && !chunk) return undefined;
  const blocks = blocksIn(chunk ?? viewport);
  if (!blocks?.length) return undefined;
  const index = firstReaching(blocks, top);
  const block = blocks[index];
  if (!block) return undefined;
  return { block: (chunk ? chunkFirst(chunk) : 0) + index, top: block.getBoundingClientRect().top - top };
}

/**
 * Scroll `viewport` so `anchor`'s block sits where it was. False until that
 * block is drawn and in place: a passive chunk draws only once it is near the
 * viewport, so the caller tries again on a later frame.
 */
export function restoreReadingAnchor(viewport: HTMLElement, anchor: ReadingAnchor): boolean {
  const top = viewport.getBoundingClientRect().top;
  const chunks = viewport.querySelectorAll<HTMLElement>(CHUNK);
  let block: Element | undefined;
  if (chunks.length) {
    let chunk: HTMLElement | undefined;
    for (const candidate of chunks) {
      if (chunkFirst(candidate) > anchor.block) break;
      chunk = candidate;
    }
    if (!chunk) return false;
    block = blocksIn(chunk)?.[anchor.block - chunkFirst(chunk)];
    if (!block) {
      // Bring the chunk to the viewport, which draws it.
      viewport.scrollTop += chunk.getBoundingClientRect().top - top;
      return false;
    }
  } else {
    block = blocksIn(viewport)?.[anchor.block];
    if (!block) return false;
  }
  const offset = block.getBoundingClientRect().top - top - anchor.top;
  if (Math.abs(offset) < 1) return true;
  const before = viewport.scrollTop;
  viewport.scrollTop = before + offset;
  // At either end of the range the block cannot move any further.
  return viewport.scrollTop === before;
}
