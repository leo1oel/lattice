import type { Transition } from "motion/react";

// Installed from https://www.fluidfunctionalism.com/r/springs.json.
// Keep the three speeds beside the app's existing motion contracts.
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

/** Softer spring for the magnetic pull, so it trails the cursor smoothly. */
export const MAGNET_SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 22,
  mass: 0.5,
};

/** Entrance spring for popovers/menus/cards, with no overshoot. */
export const POP_SPRING = spring.moderate;

/** Tabs and switch thumbs share the same short, non-overshooting travel. */
export const SETTLE_SPRING = spring.moderate;
