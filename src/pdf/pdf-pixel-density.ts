/**
 * Display pixel-density changes, for redrawing the PDF at the new density.
 *
 * PDF.js sizes a page's canvas from devicePixelRatio only when it computes
 * that page's output scale (when the page view is built, and on update()), and
 * neither PDF.js nor PDFSlick listens for a change. A window dragged from a
 * Retina display to a 1x one kept every page, drawn or not yet drawn, at the
 * old density: blurry the other way round, and oversampled this way.
 */

/**
 * A window dragged across the boundary between two displays can switch back
 * and forth several times before it is dropped; redraw once it settles.
 */
const PIXEL_DENSITY_SETTLE_MS = 150;

const pixelRatio = () => window.devicePixelRatio || 1;

/**
 * Call `onChange` after the display's pixel density has changed and settled.
 * A density that ends where it started (a drag that went back) calls nothing.
 * The returned call stops watching.
 */
export function watchPixelDensity(onChange: () => void): () => void {
  let drawnRatio = pixelRatio();
  let timer: number | null = null;
  let disarm = () => {};
  const settle = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const ratio = pixelRatio();
      if (ratio === drawnRatio) return;
      drawnRatio = ratio;
      onChange();
    }, PIXEL_DENSITY_SETTLE_MS);
  };
  // There is no event for devicePixelRatio itself. A resolution query names
  // one exact ratio, so it reports the change away from it once and then has
  // to be replaced by a query for the new ratio.
  const arm = () => {
    const media = window.matchMedia(`(resolution: ${pixelRatio()}dppx)`);
    const onMediaChange = () => {
      disarm();
      arm();
      settle();
    };
    media.addEventListener("change", onMediaChange);
    disarm = () => media.removeEventListener("change", onMediaChange);
  };
  arm();
  return () => {
    disarm();
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}
