/** Matches the thumb's `margin` in scroll-area.css, so both ends stay inset. */
export const EXTERNAL_SCROLLBAR_TRACK_INSET = 4;

export type ScrollAxisGeometry = {
  canScrollEnd: boolean;
  canScrollStart: boolean;
  maxOffset: number;
  /** The scroll position, clamped into range. */
  offset: number;
  overflow: boolean;
  thumbOffset: number;
  thumbSize: number;
  travel: number;
};

export type ScrollAxisInput = {
  /** Scroll extent along the axis (`scrollHeight` / `scrollWidth`). */
  content: number;
  /** Current scroll position (`scrollTop` / `scrollLeft`). */
  offset: number;
  /** Length of the scrollbar track, which may be shorter than the viewport. */
  track: number;
  /** Visible length along the axis (`clientHeight` / `clientWidth`). */
  viewport: number;
};

/**
 * Maps a scroll position onto the inset thumb track for one axis. The track
 * length is passed in rather than derived from the viewport: an overlay bar
 * spans the whole pane (including any padding the scroller reserves) and gets
 * shortened when the other axis needs the corner. `minOverflow` is how many
 * pixels of extent count as overflow at all.
 */
export function calculateScrollAxisGeometry(
  { content, offset, track, viewport }: ScrollAxisInput,
  { minThumb, minOverflow }: { minThumb: number; minOverflow: number },
): ScrollAxisGeometry {
  const maxOffset = Math.max(0, content - viewport);
  const overflow = maxOffset > minOverflow && viewport > 0;
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  const available = Math.max(0, track - EXTERNAL_SCROLLBAR_TRACK_INSET * 2);
  const proportional = content > 0 ? available * (viewport / content) : available;
  const thumbSize = overflow ? Math.min(available, Math.max(minThumb, proportional)) : available;
  const travel = Math.max(0, available - thumbSize);
  return {
    canScrollEnd: overflow && clamped < maxOffset,
    canScrollStart: overflow && clamped > 0,
    maxOffset,
    offset: clamped,
    overflow,
    thumbOffset: maxOffset > 0 ? travel * (clamped / maxOffset) : 0,
    thumbSize,
    travel,
  };
}

/** The external scrollbar's metrics: an 18px minimum thumb, any overflow counts. */
export const EXTERNAL_THUMB = { minThumb: 18, minOverflow: 0 };

export type VerticalScrollGeometry = {
  height: number;
  maxScrollTop: number;
  overflow: boolean;
  scrollTop: number;
  thumbHeight: number;
  thumbOffset: number;
  top: number;
};

/** A full-height vertical track beside a viewport, `top` pixels down its surface. */
export function calculateVerticalScrollGeometry(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  top = 0,
): VerticalScrollGeometry {
  const height = Math.max(0, viewport.clientHeight);
  const axis = calculateScrollAxisGeometry(
    { content: viewport.scrollHeight, offset: viewport.scrollTop, track: height, viewport: height },
    EXTERNAL_THUMB,
  );
  return {
    height,
    maxScrollTop: axis.maxOffset,
    overflow: axis.overflow,
    scrollTop: axis.offset,
    thumbHeight: axis.thumbSize,
    thumbOffset: axis.thumbOffset,
    top,
  };
}
