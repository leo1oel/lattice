/**
 * Figures kept as an Inkscape or draw.io drawing: the host renders them with
 * the installed program, once when asked and again whenever the drawing
 * changes on disk (docs/editable-figures.md).
 */
import type { EditorView } from "@codemirror/view";
import { useEffect } from "react";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";
import { onProjectFilesChanged } from "./project-files-changed";

const CONVERTIBLE_DRAWING = /\.(?:svg|drawio|dio)$/i;
const REFRESH_DELAY_MS = 800;

export const isConvertibleDrawing = (path: string) => CONVERTIBLE_DRAWING.test(path);

const failed = (reason: unknown) => notifyError(i18n._(msg`Could not update the figure`), toMessage(reason));
const actions = () => import("./figure-converters-actions");

/** Renders the drawing, then puts the figure into the editor last in use. */
export const makeEditableFigure = (path: string) => actions().then(({ makeEditableFigure: make }) => make(path));

/** Saves a pasted drawing file under `figures/`, renders it, and puts the figure in `view`. */
export const pasteDrawingFile = (file: File, view: EditorView) => actions().then(({ pasteDrawingFile: paste }) => paste(file, view));

/** A drawing dropped from the file manager onto the editor at `point`; false for anything else, left to the usual drop. */
export function dropDrawingFile(paths: readonly string[], point: { x: number; y: number }): boolean {
  if (paths.length !== 1 || !isConvertibleDrawing(paths[0])) return false;
  void actions().then(({ dropDrawingAt }) => dropDrawingAt(paths[0], point));
  return true;
}

/** The one drawing among files pasted from the system, or null. */
export function convertibleFile<T extends { name: string }>(files: readonly T[]): T | null {
  return files.length === 1 && isConvertibleDrawing(files[0].name) ? files[0] : null;
}

/** A delayed call per key, the latest change winning; `stop` drops what is pending. */
export function perKeyDebounce(delayMs: number, run: (key: string) => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    call(key: string) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => { timers.delete(key); run(key); }, delayMs));
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Renders a figure's drawing again each time the file changes on disk. The new output starts the usual build. */
export function useFigureSourceRefresh(root: string) {
  useEffect(() => {
    const refreshes = perKeyDebounce(REFRESH_DELAY_MS, (path) => {
      void invoke<boolean>("refresh_figure_source", { path }).catch(failed);
    });
    // Editing an entry's page line chooses another page of its drawing.
    const entries = perKeyDebounce(REFRESH_DELAY_MS, (path) => {
      void invoke<string>("read_project_file", { path }).then(async (text) => {
        const source = (await actions()).pagedDrawingOf(path, text);
        if (source) return invoke<boolean>("refresh_figure_source", { path: source });
      }).catch(failed);
    });
    const stop = onProjectFilesChanged(root, (paths) => {
      for (const path of paths ?? []) {
        if (isConvertibleDrawing(path)) refreshes.call(path);
        else if (/\.tex$/i.test(path)) entries.call(path);
      }
    });
    return () => { stop(); refreshes.stop(); entries.stop(); };
  }, [root]);
}
