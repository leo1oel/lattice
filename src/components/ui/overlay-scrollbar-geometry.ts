export type OverlayAxisGeometry = {
  canScrollEnd: boolean;
  canScrollStart: boolean;
  maxOffset: number;
  overflow: boolean;
  thumbOffset: number;
  thumbSize: number;
  travel: number;
};

export type OverlayAxisInput = {
  /** Scroll extent along the axis (`scrollHeight` / `scrollWidth`). */
  content: number;
  /** Current scroll position (`scrollTop` / `scrollLeft`). */
  offset: number;
  /** Length of the scrollbar track, which may be shorter than the viewport. */
  track: number;
  /** Visible length along the axis (`clientHeight` / `clientWidth`). */
  viewport: number;
};

/** Matches the thumb's `margin` in scroll-area.css, so both ends stay inset. */
export const OVERLAY_SCROLLBAR_TRACK_INSET = 4;

const MIN_THUMB_SIZE = 24;

/**
 * Maps a scroll position onto the inset thumb track for one axis. The track
 * length is passed in rather than derived from the viewport: an overlay bar
 * spans the whole pane (including any padding the scroller reserves) and gets
 * shortened when the other axis needs the corner.
 */
export function calculateOverlayAxisGeometry(
  { content, offset, track, viewport }: OverlayAxisInput,
): OverlayAxisGeometry {
  const maxOffset = Math.max(0, content - viewport);
  // Sub-pixel extents are rounding noise from fractional zoom, not overflow.
  const overflow = maxOffset > 1 && viewport > 0;
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  const available = Math.max(0, track - OVERLAY_SCROLLBAR_TRACK_INSET * 2);
  const proportional = content > 0 ? available * (viewport / content) : available;
  const thumbSize = overflow
    ? Math.min(available, Math.max(MIN_THUMB_SIZE, proportional))
    : available;
  const travel = Math.max(0, available - thumbSize);

  return {
    canScrollEnd: overflow && clamped < maxOffset,
    canScrollStart: overflow && clamped > 0,
    maxOffset,
    overflow,
    thumbOffset: maxOffset > 0 ? travel * (clamped / maxOffset) : 0,
    thumbSize,
    travel,
  };
}
