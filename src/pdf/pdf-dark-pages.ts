/**
 * Dark pages: the PDF read as light type on a dark page, one choice for every
 * PDF viewer (the compiled preview, its separate window, papers, project PDFs)
 * in every window, off until the reader turns it on.
 *
 * The pages are drawn as PDF.js paints them and turned dark by a CSS filter on
 * their canvases (pdf-viewer.css), not by PDF.js's own `pageColors`. That
 * option maps every pixel, images included, onto a two-colour gradient, so
 * figures lose their colours, and it is fixed when a viewer is built, so
 * turning it on would mean reopening the document. The filter flips lightness
 * and keeps hue, so a red curve stays red and turns on or off at once. Its one
 * cost: a photograph's lightness flips too. Everything Lattice draws over the
 * pages (highlights, SyncTeX marks, annotations, the selection) sits outside
 * the canvas and keeps its own colours.
 *
 * The choice is drawn as one attribute on the root element, which the
 * stylesheets key on, rather than as React state in each viewer: a viewer
 * re-renders often, and reading the setting there cost a hook call per
 * render from the first frame. Only the toolbar's toggle subscribes.
 */
import { sharedSetting } from "../settings/shared-setting";

const PDF_DARK_PAGES_KEY = "lattice.pdf-dark-pages.v1";

function loadPdfDarkPages(): boolean {
  try {
    return localStorage.getItem(PDF_DARK_PAGES_KEY) === "true";
  } catch {
    return false;
  }
}

export const pdfDarkPagesSetting = sharedSetting(PDF_DARK_PAGES_KEY, loadPdfDarkPages);

let watching = false;

/**
 * Keeps the root's `data-pdf-dark-pages` in step with the setting, here and
 * in other windows. Called once the viewer's module loads, so a window that
 * never shows a PDF never reads the setting.
 */
export function watchPdfDarkPages() {
  if (watching) return;
  watching = true;
  const draw = () => document.documentElement.toggleAttribute("data-pdf-dark-pages", pdfDarkPagesSetting.get());
  pdfDarkPagesSetting.subscribe(draw);
  draw();
}

/** Turns dark pages on or off in every PDF viewer and window. */
export const togglePdfDarkPages = () => pdfDarkPagesSetting.set((dark) => !dark);
