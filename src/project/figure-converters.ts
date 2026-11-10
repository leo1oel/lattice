/**
 * Figures kept as an Inkscape or draw.io drawing: the host renders them with
 * the installed program, once when asked and again whenever the drawing
 * changes on disk (docs/editable-figures.md).
 */
import type { EditorView } from "@codemirror/view";
import { useEffect } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError, notifyInfo } from "../telemetry/app-notify";
import { onProjectFilesChanged } from "./project-files-changed";

const CONVERTIBLE_DRAWING = /\.(?:svg|drawio|dio)$/i;
const REFRESH_DELAY_MS = 800;
const NO_DOCUMENTS: readonly string[] = [];

export const isConvertibleDrawing = (path: string) => CONVERTIBLE_DRAWING.test(path);

const failed = (reason: unknown) => notifyError(i18n._(msg`Could not update the figure`), toMessage(reason));
const actions = () => import("./figure-converters-actions");
const needsActions = () => import("./figure-needs-actions");

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

/** What the host made of a request to render a figure's drawing again. */
type FigureRefresh = "noFigure" | "awaitingConsent" | "rendered";

/**
 * Renders a figure's drawing again after it changed on disk. The new output
 * starts the usual build.
 *
 * A drawing is a drawing program's untrusted input and can arrive from an
 * Overleaf collaborator or a clone, so the host renders a change nobody asked
 * for only in a trusted project, and only for a drawing someone here rendered
 * once. Otherwise it answers `awaitingConsent` and the figure updates when the
 * user says so.
 */
function refreshDrawing(path: string, root: string): Promise<unknown> {
  return invoke<FigureRefresh>("refresh_figure_source", { path, unattended: true, projectRoot: root }).then((outcome) => {
    if (outcome !== "awaitingConsent") return;
    notifyInfo(i18n._(msg`Figures`), i18n._(msg`A drawing changed: ${path}`), {
      detail: i18n._(msg`A drawing can come from anyone, so Lattice runs the drawing program only when you ask. Turn on Allow shell escape in this project's settings to update its figures as their drawings change.`),
      // One notice per drawing, however many times it changes.
      dedupeKey: `figure-refresh:${path}`,
      timeoutMs: 0,
      primaryAction: {
        label: i18n._(msg`Update figure`),
        onClick: async () => {
          try {
            await invoke<FigureRefresh>("refresh_figure_source", { path, unattended: false, projectRoot: root });
          } catch (reason) {
            failed(reason);
          }
        },
      },
    });
  }).catch(failed);
}

/**
 * Renders a figure's drawing again each time the file changes on disk. The new
 * output starts the usual build. A changed entry file also brings what it now
 * needs into the preamble of `rootDocuments` (figure-needs-actions.ts).
 */
export function useFigureSourceRefresh(root: string, rootDocuments: readonly string[] = NO_DOCUMENTS) {
  const rootDocumentsRef = useLatestRef(rootDocuments);
  useEffect(() => {
    const refreshes = perKeyDebounce(REFRESH_DELAY_MS, (path) => {
      void refreshDrawing(path, root);
    });
    // Editing an entry's page line chooses another page of its drawing.
    const entries = perKeyDebounce(REFRESH_DELAY_MS, (path) => {
      void invoke<string>("read_project_file", { path }).then(async (text) => {
        if (text.startsWith("% editable-figure source: ")) {
          const { completeFigureNeeds } = await needsActions();
          await completeFigureNeeds(path, text, root, rootDocumentsRef.current);
        }
        const source = (await actions()).pagedDrawingOf(path, text);
        if (source) return refreshDrawing(source, root);
      }).catch(failed);
    });
    const stop = onProjectFilesChanged(root, (paths) => {
      for (const path of paths ?? []) {
        if (isConvertibleDrawing(path)) refreshes.call(path);
        else if (/\.tex$/i.test(path)) entries.call(path);
      }
    });
    return () => { stop(); refreshes.stop(); entries.stop(); };
  }, [root, rootDocumentsRef]);
}
