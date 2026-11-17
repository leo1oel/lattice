/** The native content overlays the DOM slot. Hide it when the slot is parked
 * or covered by Lattice chrome that must render and receive input above it. */
export function browserPanelBounds(slot: HTMLElement) {
  if (!slot.isConnected || document.hidden || slot.closest("[data-busy]")) return null;
  const rect = slot.getBoundingClientRect();
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right - x < 2 || bottom - y < 2) return null;
  const points = [
    [x + 1, y + 1], [right - 1, y + 1], [x + 1, bottom - 1], [right - 1, bottom - 1],
    [(x + right) / 2, (y + bottom) / 2],
  ] as const;
  if (!points.every(([cx, cy]) => slot.contains(document.elementFromPoint(cx, cy)))) return null;
  return { x, y, width: right - x, height: bottom - y, viewportWidth: window.innerWidth };
}
