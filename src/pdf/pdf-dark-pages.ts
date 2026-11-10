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

/** Turns dark pages on or off in every PDF viewer and window. */
export const togglePdfDarkPages = () => pdfDarkPagesSetting.set((dark) => !dark);
