/**
 * Figures kept as an Inkscape or draw.io drawing: the host renders them with
 * the installed program, once when asked and again whenever the drawing
 * changes on disk (docs/editable-figures.md).
 */
import type { EditorView } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";

const CONVERTIBLE_DRAWING = /\.(?:svg|drawio|dio)$/i;

export const isConvertibleDrawing = (path: string) => CONVERTIBLE_DRAWING.test(path);

export const failed = (reason: unknown) => notifyError(i18n._(msg`Could not update the figure`), toMessage(reason));
export const actions = () => import("./figure-converters-actions");

/** Renders the drawing, then puts the figure into the editor last in use. */
export const makeEditableFigure = (path: string, projectRoot: string) => actions().then(({ makeEditableFigure: make }) => make(path, projectRoot));

/** Saves a pasted drawing file under `figures/`, renders it, and puts the figure in `view`. */
export const pasteDrawingFile = (file: File, view: EditorView, projectRoot: string) => actions().then(({ pasteDrawingFile: paste }) => paste(file, view, projectRoot));

/** A drawing dropped from the file manager onto the editor at `point`; false for anything else, left to the usual drop. */
export function dropDrawingFile(paths: readonly string[], point: { x: number; y: number }, projectRoot: string): boolean {
  if (paths.length !== 1 || !isConvertibleDrawing(paths[0])) return false;
  void actions().then(({ dropDrawingAt }) => dropDrawingAt(paths[0], point, projectRoot));
  return true;
}

/** The one drawing among files pasted from the system, or null. */
export function convertibleFile<T extends { name: string }>(files: readonly T[]): T | null {
  return files.length === 1 && isConvertibleDrawing(files[0].name) ? files[0] : null;
}
