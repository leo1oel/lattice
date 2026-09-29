/**
 * Keeping a Markdown preview still while its content changes (spec R-CHR-5):
 * the block the reader acted on stays where it was on screen, and a block
 * just added below the visible part is scrolled into view with some room
 * under it.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

/** Space left under a revealed block, so it never sits on the pane's bottom edge. */
export const REVEAL_ROOM = 40;

/**
 * Set `viewport`'s scroll from the position it had (`scrollTop`) so that
 * `anchor` is back at `anchorTop` on screen, then bring `reveal` fully into
 * view if the change left it below the pane.
 */
export function restoreViewportAround(
  viewport: HTMLElement,
  scrollTop: number,
  anchor: HTMLElement | null,
  anchorTop: number | null,
  reveal: HTMLElement | null,
) {
  const current = viewport.scrollTop;
  let target = scrollTop;
  if (anchor?.isConnected && anchorTop != null) {
    // Where the anchor is now, had the pane stayed at `scrollTop`.
    target += anchor.getBoundingClientRect().top + (current - scrollTop) - anchorTop;
  }
  if (reveal?.isConnected) {
    const bottom = viewport.getBoundingClientRect().bottom;
    const revealBottom = reveal.getBoundingClientRect().bottom - (target - current);
    if (revealBottom > bottom) target += revealBottom + REVEAL_ROOM - bottom;
  }
  if (target !== current) viewport.scrollTop = target;
}
