import type { Transition } from "motion/react";

// Installed from https://www.fluidfunctionalism.com/r/springs.json.
// Fluid Functionalism (https://github.com/mickadesign/fluid-functionalism): MIT License, Copyright (c) 2026 Micka Touillaud.
// Full license text: THIRD_PARTY_NOTICES.md.
// The app's one motion system. CSS runs the same three tiers as `--motion-*`
// in styles/foundations.css, whose curves are these springs sampled into
// `linear()`; tokens.test.ts holds the two together.
export const spring = {
  fast: { type: "spring", duration: 0.08, bounce: 0 },
  moderate: { type: "spring", duration: 0.16, bounce: 0 },
  slow: { type: "spring", duration: 0.24, bounce: 0.12 },
} satisfies Record<string, Transition>;

export const springExit = {
  fast: { duration: 0.06 },
  moderate: { duration: 0.12 },
  slow: { duration: 0.16 },
} satisfies Record<string, Transition>;

/** Snappy press/hover feel for buttons — quick settle, no overshoot wobble. */
export const PRESS_SPRING = spring.fast;

/**
 * The one physics spring: a magnetic pull that trails the pointer. It follows
 * a moving target instead of making one timed change, so it has no duration
 * and no tier.
 */
export const MAGNET_SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 22,
  mass: 0.5,
};

/** Entrance spring for popovers/menus/cards, with no overshoot. */
export const POP_SPRING = spring.moderate;

type Tier = keyof typeof spring;
const tierEasing = new Map<Tier, string>();

/**
 * A tier as a millisecond duration and a CSS easing, for motion run outside
 * motion/react (`element.animate()`, a library's own transition): the CSS
 * token's sampled curve, so it lands like a CSS transition of the same tier.
 */
export function animationTiming(tier: Tier): { duration: number; easing: string } {
  let easing = tierEasing.get(tier);
  if (!easing) {
    easing = getComputedStyle(document.documentElement).getPropertyValue(`--ease-${tier}`).trim();
    if (easing) tierEasing.set(tier, easing);
  }
  return { duration: spring[tier].duration * 1000, easing: easing || "ease-out" };
}
