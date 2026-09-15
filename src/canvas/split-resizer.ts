/** Share temporary boundary displacement with the grip and both adjacent panes. */
export function setSplitResizerResistance(grip: HTMLElement, overshoot: number) {
  const split = grip.parentElement;
  if (!split) return;
  const offset = Math.sign(overshoot) * 24 * (1 - Math.exp(-Math.abs(overshoot) / 100));
  // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS custom property names, not user-facing text.
  const property = split.classList.contains("columns-canvas") && grip === split.children[3] ? "--split-pdf-offset" : "--split-resizer-offset";
  split.style.setProperty(property, `${offset}px`);
}
