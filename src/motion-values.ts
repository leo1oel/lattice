import type { Transition } from "motion/react";

/** Snappy press/hover feel for buttons — quick settle, no overshoot wobble. */
export const PRESS_SPRING: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 32,
  mass: 0.6,
};

/** Softer spring for the magnetic pull, so it trails the cursor smoothly. */
export const MAGNET_SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 22,
  mass: 0.5,
};

/** Entrance spring for popovers/menus/cards — a small, confident pop. */
export const POP_SPRING: Transition = {
  type: "spring",
  stiffness: 460,
  damping: 34,
  mass: 0.7,
};

/** Heavier settling motion for state indicators that travel between positions. */
export const SETTLE_SPRING: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 26,
  mass: 1,
};
