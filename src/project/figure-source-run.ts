/** Opening a figure's source, loaded when used: see figure-source-open.ts. */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";

/** The host opens a drawing format and only reveals anything else in the file manager. */
export async function openFigureSource(source: string): Promise<void> {
  try {
    await invoke("open_figure_source", { path: source });
  } catch (reason) {
    notifyError(i18n._(msg`Could not open the drawing`), toMessage(reason));
  }
}

/** Opens the drawing the first of these entry files that is a figure was made from; false when none is. */
export async function openDrawingOf(...entryPaths: string[]): Promise<boolean> {
  const { figureSourcePath } = await import("../editor/insert/editable-figure");
  for (const path of entryPaths) {
    const text = await invoke<string>("read_project_file", { path }).catch(() => "");
    const source = figureSourcePath(path, text);
    if (source) {
      await openFigureSource(source);
      return true;
    }
  }
  return false;
}
