/**
 * Where the guided tour draws its spotlight and puts its card, as pure
 * geometry over window coordinates (guided-tour.tsx measures; this decides).
 */

/** Breathing room around a spotlighted place, and between it and the card. */
const SPOTLIGHT_PADDING = 6;
const CARD_GAP = 14;
const VIEWPORT_MARGIN = 16;

export type Rect = { left: number; top: number; width: number; height: number };
export type Placement = { left: number; top: number; side: "right" | "left" | "bottom" | "top" | "inside" | "center" };

export function sameRect(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** The spotlight: the target grown by its padding, kept inside the window. */
export function spotlightOf(rect: Rect, viewport: { width: number; height: number }): Rect {
  const left = Math.max(2, rect.left - SPOTLIGHT_PADDING);
  const top = Math.max(2, rect.top - SPOTLIGHT_PADDING);
  const right = Math.min(viewport.width - 2, rect.left + rect.width + SPOTLIGHT_PADDING);
  const bottom = Math.min(viewport.height - 2, rect.top + rect.height + SPOTLIGHT_PADDING);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Where the card goes: beside the spotlight on the side with the most room
 * that fits it whole, else inside the spotlight's lower corner (a panel that
 * fills most of the window), else centered.
 */
export function placeCard(
  spot: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const clamp = (value: number, size: number, extent: number) =>
    Math.min(Math.max(value, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, extent - size - VIEWPORT_MARGIN));
  const center = {
    left: clamp((viewport.width - card.width) / 2, card.width, viewport.width),
    top: clamp((viewport.height - card.height) / 2, card.height, viewport.height),
  };
  if (!spot) return { ...center, side: "center" };
  const right = spot.left + spot.width;
  const bottom = spot.top + spot.height;
  const room = {
    right: viewport.width - right - CARD_GAP - VIEWPORT_MARGIN,
    left: spot.left - CARD_GAP - VIEWPORT_MARGIN,
    bottom: viewport.height - bottom - CARD_GAP - VIEWPORT_MARGIN,
    top: spot.top - CARD_GAP - VIEWPORT_MARGIN,
  };
  const fits = {
    right: room.right >= card.width,
    left: room.left >= card.width,
    bottom: room.bottom >= card.height,
    top: room.top >= card.height,
  };
  const sides = (["right", "left", "bottom", "top"] as const)
    .filter((side) => fits[side])
    .sort((a, b) => room[b] - room[a]);
  const side = sides[0];
  const alongY = clamp(spot.top, card.height, viewport.height);
  const alongX = clamp(spot.left + spot.width / 2 - card.width / 2, card.width, viewport.width);
  switch (side) {
    case "right": return { left: right + CARD_GAP, top: alongY, side };
    case "left": return { left: spot.left - CARD_GAP - card.width, top: alongY, side };
    case "bottom": return { left: alongX, top: bottom + CARD_GAP, side };
    case "top": return { left: alongX, top: spot.top - CARD_GAP - card.height, side };
    default: {
      if (spot.width >= card.width + 2 * CARD_GAP && spot.height >= card.height + 2 * CARD_GAP) {
        return {
          left: clamp(right - CARD_GAP - card.width, card.width, viewport.width),
          top: clamp(bottom - CARD_GAP - card.height, card.height, viewport.height),
          side: "inside",
        };
      }
      return { ...center, side: "center" };
    }
  }
}
