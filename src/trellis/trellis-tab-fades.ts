/**
 * The fade on a tab strip's clipped side (trellis.css), set from script.
 *
 * Past its cap a strip scrolls, and a fade on the side that hides tabs reads
 * as "more tabs" instead of a tab cut off by the actions. A scroll-driven CSS
 * animation (`animation-timeline: scroll(self inline)`) drew it before, but
 * WebKit counts such an animation as running for as long as the strip exists,
 * scrolled or not, and keeps resolving style and committing layers every
 * frame: about a third of an idle window's WebContent CPU in the perf lab. So
 * the strip carries `data-fade-start` / `data-fade-end` only while it actually
 * overflows on that side, updated when it scrolls, resizes, or the layout
 * changes, and nothing runs while the window sits still.
 */

const STRIP = '[data-trellis-part="tabs"]';
/** Sub-pixel scroll offsets are layout rounding, not a hidden tab. */
const EPSILON = 1;

function setFlag(element: HTMLElement, name: string, on: boolean) {
  if (element.hasAttribute(name) !== on) element.toggleAttribute(name, on);
}

export function updateTabStripFade(strip: HTMLElement) {
  const hidden = strip.scrollWidth - strip.clientWidth;
  const scrolled = Math.abs(strip.scrollLeft);
  setFlag(strip, "data-fade-start", hidden > EPSILON && scrolled > EPSILON);
  setFlag(strip, "data-fade-end", hidden > EPSILON && scrolled < hidden - EPSILON);
}

/**
 * Keeps every strip under `root` faded on its overflowing sides. `subscribe`
 * reports layout changes (Trellis's `ws.subscribe`), after which strips may be
 * new, gone or holding other tabs.
 */
export function observeTabStripFades(root: HTMLElement, subscribe: (listener: () => void) => () => void): () => void {
  let frame = 0;
  // A strip's own box and each tab's: a tab coming, going or growing changes
  // what overflows without resizing the strip.
  const resize = new ResizeObserver((entries) => {
    const strips = new Set<HTMLElement>();
    for (const entry of entries) {
      const strip = entry.target instanceof HTMLElement ? entry.target.closest<HTMLElement>(STRIP) : null;
      if (strip) strips.add(strip);
    }
    strips.forEach(updateTabStripFade);
  });
  const scan = () => {
    frame = 0;
    resize.disconnect();
    for (const strip of root.querySelectorAll<HTMLElement>(STRIP)) {
      resize.observe(strip);
      for (const tab of strip.children) resize.observe(tab);
      updateTabStripFade(strip);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(scan);
  };
  // Scroll does not bubble; one capturing listener sees every strip's.
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(STRIP)) updateTabStripFade(target);
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  const unsubscribe = subscribe(schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    unsubscribe();
    resize.disconnect();
    root.removeEventListener("scroll", onScroll, { capture: true });
  };
}
