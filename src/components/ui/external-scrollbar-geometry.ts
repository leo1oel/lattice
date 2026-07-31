export type VerticalScrollGeometry = {
  height: number;
  maxScrollTop: number;
  overflow: boolean;
  scrollTop: number;
  thumbHeight: number;
  thumbOffset: number;
  top: number;
};

export const EXTERNAL_SCROLLBAR_TRACK_INSET = 4;

const MIN_THUMB_HEIGHT = 18;

export function calculateVerticalScrollGeometry(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  top = 0,
): VerticalScrollGeometry {
  const height = Math.max(0, viewport.clientHeight);
  const maxScrollTop = Math.max(0, viewport.scrollHeight - height);
  const overflow = maxScrollTop > 0 && height > 0;
  const scrollTop = Math.min(Math.max(0, viewport.scrollTop), maxScrollTop);
  const availableTrack = Math.max(
    0,
    height - EXTERNAL_SCROLLBAR_TRACK_INSET * 2,
  );
  const proportionalHeight = viewport.scrollHeight > 0
    ? availableTrack * (height / viewport.scrollHeight)
    : availableTrack;
  const thumbHeight = overflow
    ? Math.min(availableTrack, Math.max(MIN_THUMB_HEIGHT, proportionalHeight))
    : availableTrack;
  const travel = Math.max(0, availableTrack - thumbHeight);
  const thumbOffset = maxScrollTop > 0 ? travel * (scrollTop / maxScrollTop) : 0;

  return {
    height,
    maxScrollTop,
    overflow,
    scrollTop,
    thumbHeight,
    thumbOffset,
    top,
  };
}
