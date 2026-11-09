/**
 * Opening a figure's source file in the program the system has for it, from
 * the PDF, a source line or the project tree (docs/editable-figures.md). The
 * host decides what may open; a type it does not know asks first.
 */
/** File types opened on a double-click in the tree. SVG is left out: Lattice previews it itself. */
const DRAWING_FILE = /\.(?:reactio|cdxml|cdx|drawio|dio|ipe|excalidraw|ggb|odg)$/i;
const BESIDE_DRAWING = /\.(?:reactio|cdxml|cdx|svg|drawio|dio|ipe|excalidraw|ggb|odg)$/i;

export const isDrawingFile = (path: string) => DRAWING_FILE.test(path);

const run = () => import("./figure-source-run");

export const openFigureSource = (source: string): Promise<void> => run().then((module) => module.openFigureSource(source));

/** Opens the drawing the first of these entry files that is a figure was made from; false when none is. */
export const openDrawingOf = (...entryPaths: string[]): Promise<boolean> => run().then((module) => module.openDrawingOf(...entryPaths));

/** A name as a drawing tool writes it for LaTeX: no extension, other characters as `_`. */
const figureStem = (name: string) => name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");

/**
 * The entry `.tex` of the figure a `.tex` or `.pdf` in the tree belongs to,
 * when a drawing lies beside it under the same stem; null for any other file.
 */
export function figureEntryBeside(path: string, projectPaths: readonly string[]): string | null {
  if (!/\.(?:tex|pdf)$/i.test(path)) return null;
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const name = path.slice(folder.length);
  const stem = name.replace(/\.[^.]*$/, "");
  const entry = `${folder}${stem}.tex`;
  if (!projectPaths.includes(entry)) return null;
  const hasDrawing = projectPaths.some((other) => (
    BESIDE_DRAWING.test(other) && other.startsWith(folder) && !other.slice(folder.length).includes("/")
    && figureStem(other.slice(folder.length)) === stem
  ));
  return hasDrawing ? entry : null;
}
