/**
 * Content that is costly to lay out again at every width keeps the width it
 * had while a panel divider (or a floating panel's edge) is dragged, and takes
 * the final width once, on release. It opts in with `data-holds-width`.
 *
 * Trellis resizes the panels on every frame of a drag, and a long visual
 * document lays out each of its thousands of block placeholders and repaints
 * its pane on every one of those frames; WebKit does that on the main thread,
 * about twice as slowly as Chromium, so dragging a divider beside a 2 MB
 * Markdown document ran at 37 fps there. Held, the drag keeps the display's
 * frame rate and the text rewraps once when the divider is let go.
 */

/** The attribute that asks to keep the width while a drag is resizing panels. */
export const HOLDS_WIDTH_ATTRIBUTE = "data-holds-width";

/** Hold opted-in widths under `root` while Trellis marks it `data-resizing`; returns the disposer. */
export function holdWidthsWhileResizing(root: HTMLElement): () => void {
  let held: Array<{ element: HTMLElement; width: string }> = [];
  const release = () => {
    for (const { element, width } of held) element.style.width = width;
    held = [];
  };
  const update = () => {
    const resizing = root.hasAttribute("data-resizing");
    if (resizing && !held.length) {
      const elements = [...root.querySelectorAll<HTMLElement>(`[${HOLDS_WIDTH_ATTRIBUTE}]`)];
      // Read every width before writing any, so one layout serves them all.
      const widths = elements.map((element) => getComputedStyle(element).width);
      held = elements.map((element) => ({ element, width: element.style.width }));
      elements.forEach((element, index) => {
        element.style.width = widths[index]!;
      });
    } else if (!resizing && held.length) {
      release();
    }
  };
  // Trellis sets the attribute in its pointerdown handler; the observer runs
  // right after it, before the first resized frame is laid out.
  const observer = new MutationObserver(update);
  observer.observe(root, { attributes: true, attributeFilter: ["data-resizing"] });
  return () => {
    observer.disconnect();
    release();
  };
}
