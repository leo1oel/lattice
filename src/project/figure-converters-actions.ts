/** What runs when a drawing becomes a figure, loaded only then: the startup bundle holds the rest (figure-converters.ts). */
import type { EditorView } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { figureSourcePath, type ImportedFigure } from "../editor/insert/editable-figure";
import { i18n } from "../i18n";
import { notifyError, notifySuccess } from "../telemetry/app-notify";
import { isConvertibleDrawing } from "./figure-converters";

const failed = (reason: unknown) => notifyError(i18n._(msg`Could not update the figure`), toMessage(reason));

/** The drawing an entry with a page line renders, or null for any other `.tex`. */
export function pagedDrawingOf(entryPath: string, entryText: string): string | null {
  if (!/^% editable-figure page: /.test(entryText.split(/\r?\n/, 2)[1] ?? "")) return null;
  const source = figureSourcePath(entryPath, entryText);
  return source && isConvertibleDrawing(source) ? source : null;
}

/** Renders the drawing, then puts the figure into the editor last in use. */
export async function makeEditableFigure(path: string): Promise<void> {
  try {
    const figure = await invoke<ImportedFigure>("make_editable_figure", { path });
    const [{ lastFigureEditor }, { insertImportedFigure }] = await Promise.all([
      import("../editor/insert/editable-figure-paste-handler"),
      import("../app/editable-figure-paste"),
    ]);
    const editor = lastFigureEditor();
    if (editor) await insertImportedFigure(editor, figure);
    else notifySuccess(i18n._(msg`Figures`), i18n._(msg`Figure ready: ${figure.entry}. Open a LaTeX file to include it.`));
  } catch (reason) {
    failed(reason);
  }
}

function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
}

/** A drawing file pasted into the editor: saved under `figures/`, rendered, and put in `view`. */
export async function pasteDrawingFile(file: File, view: EditorView): Promise<void> {
  try {
    // Where the system names the file, use it: a webview may give the name but not the bytes.
    const copied = await invoke<string | null>("clipboard_file_path").catch(() => null);
    const figure = copied?.endsWith(`/${file.name}`)
      ? await invoke<ImportedFigure>("drop_drawing_file", { path: copied })
      : await invoke<ImportedFigure>("paste_drawing_file", { name: file.name, data: base64Of(new Uint8Array(await file.arrayBuffer())) });
    const { insertImportedFigure } = await import("../app/editable-figure-paste");
    await insertImportedFigure(view, figure);
  } catch (reason) {
    failed(reason);
  }
}

/** A drawing dropped from the file manager onto the editor at `point`. */
export async function dropDrawingAt(path: string, point: { x: number; y: number }): Promise<void> {
  try {
    const figure = await invoke<ImportedFigure>("drop_drawing_file", { path });
    const [{ lastFigureEditor }, { insertImportedFigure }] = await Promise.all([
      import("../editor/insert/editable-figure-paste-handler"),
      import("../app/editable-figure-paste"),
    ]);
    const editor = lastFigureEditor();
    if (!editor) return;
    const position = editor.posAtCoords(point);
    if (position != null) editor.dispatch({ selection: { anchor: position } });
    await insertImportedFigure(editor, figure);
  } catch (reason) {
    failed(reason);
  }
}
