/**
 * Whether the person asked the system for less motion, read at the moment of
 * the call. False where `matchMedia` is missing (jsdom without a stub).
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
