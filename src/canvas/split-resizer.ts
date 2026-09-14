/** Boundary feedback moves only the grip, never the editor/PDF layout. */
export function setSplitResizerResistance(grip: HTMLElement, overshoot: number) {
  const offset = Math.sign(overshoot) * 24 * (1 - Math.exp(-Math.abs(overshoot) / 100));
  grip.style.setProperty("--split-resizer-offset", `${offset}px`);
}
