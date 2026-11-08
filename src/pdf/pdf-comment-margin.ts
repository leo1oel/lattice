/**
 * Where the PDF's comment column stands each card (pdf-comment-column.tsx):
 * beside its mark, the way Word and Google Docs keep a comment level with
 * its passage. Pure, so the alignment is tested without a PDF.
 */

/** A card to place: the height its mark stands at (in the pages' scroll coordinates) and its own height. */
export type MarginCard = { id: string; anchor: number; height: number };

/** The space between two cards that would otherwise touch. */
export const MARGIN_CARD_GAP = 8;

/**
 * Each card's top. A card stands level with its mark unless the card above
 * reaches past it, when it moves down just clear of that one. The open card
 * (`activeId`) is the exception: it always stands level with its mark, the
 * cards after it move down clear of it and the cards before it move up, so
 * the one being read or answered never drifts from its passage.
 *
 * Cards are taken in their marks' order down the pages; two at one height
 * keep the order they were given in.
 */
export function layoutMarginCards(
  cards: readonly MarginCard[],
  activeId: string | null = null,
  gap = MARGIN_CARD_GAP,
): Map<string, number> {
  const order = cards.map((card, index) => ({ card, index }))
    .sort((left, right) => left.card.anchor - right.card.anchor || left.index - right.index)
    .map(({ card }) => card);
  const tops = new Map<string, number>();
  const pinned = activeId === null ? -1 : order.findIndex((card) => card.id === activeId);
  const start = Math.max(0, pinned);
  let floor = -Infinity;
  for (const card of order.slice(start)) {
    const top = Math.max(card.anchor, floor);
    tops.set(card.id, top);
    floor = top + card.height + gap;
  }
  if (pinned <= 0) return tops;
  let ceiling = tops.get(order[pinned]!.id)! - gap;
  for (const card of order.slice(0, pinned).reverse()) {
    const top = Math.min(card.anchor, ceiling - card.height);
    tops.set(card.id, top);
    ceiling = top - gap;
  }
  return tops;
}
