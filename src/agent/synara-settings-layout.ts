const MIN_SYNARA_SETTINGS_HEIGHT = 470;
/**
 * A defensive ceiling for malformed cross-frame measurements, not a product
 * layout limit. Provider Settings can legitimately exceed 4,000px once the
 * models, picker, and CLI sections are rendered together.
 */
const MAX_SYNARA_SETTINGS_HEIGHT = 64_000;
const SETTINGS_BOTTOM_PIN_TOLERANCE = 24;

export function normalizeSynaraSettingsHeight(height: number): number {
  return Math.min(
    MAX_SYNARA_SETTINGS_HEIGHT,
    Math.max(MIN_SYNARA_SETTINGS_HEIGHT, Math.ceil(height)),
  );
}

export function isSettingsViewportNearBottom(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  tolerance = SETTINGS_BOTTOM_PIN_TOLERANCE,
): boolean {
  const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
  return maxScrollTop > 0 && maxScrollTop - viewport.scrollTop <= tolerance;
}

export function applySynaraSettingsHeight(options: {
  container: Pick<HTMLElement, "style"> | null;
  frame: Pick<HTMLIFrameElement, "style"> | null;
  height: number;
  active: boolean;
}): number {
  const height = normalizeSynaraSettingsHeight(options.height);
  const cssHeight = `${height}px`;
  if (options.container) {
    options.container.style.height = options.active ? cssHeight : "0px";
  }
  if (options.frame) {
    options.frame.style.height = cssHeight;
  }
  return height;
}

type SynaraSettingsViewport = Pick<
  HTMLElement,
  | "clientHeight"
  | "clientWidth"
  | "scrollHeight"
  | "scrollLeft"
  | "scrollTop"
  | "scrollWidth"
>;

export function scrollSynaraSettingsViewportBy(
  viewport: SynaraSettingsViewport,
  deltaY: number,
  deltaX = 0,
): { left: number; top: number } {
  // Reading the ranges after the iframe height is applied forces WebKit to
  // commit the new layout before it clamps the first forwarded wheel gesture.
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const top = Math.min(maxTop, Math.max(0, viewport.scrollTop + deltaY));
  const left = Math.min(maxLeft, Math.max(0, viewport.scrollLeft + deltaX));
  viewport.scrollTop = top;
  viewport.scrollLeft = left;
  return { left, top };
}

export function applySynaraSettingsWheel(
  viewport: SynaraSettingsViewport,
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
): { left: number; top: number } {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? viewport.clientHeight
      : 1;
  return scrollSynaraSettingsViewportBy(
    viewport,
    event.deltaY * scale,
    event.deltaX * scale,
  );
}
