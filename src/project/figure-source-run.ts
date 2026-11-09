/** Opening a figure's source, loaded when used: see figure-source-open.ts. */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction, toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";

/**
 * The host opens a drawing format and only reveals anything else in the file
 * manager. An SVG opens only once the user agrees, each time: a project names
 * the file, and its default program is often a browser that runs its script.
 */
export async function openFigureSource(source: string): Promise<void> {
  try {
    if (await invoke<boolean>("open_figure_source", { path: source })) return;
    const name = source.slice(source.lastIndexOf("/") + 1);
    const agreed = await confirmAction({
      message: i18n._(msg`Open ${name} in its default app? An SVG file often opens in a web browser, which runs any script it holds.`),
      confirmLabel: i18n._(msg`Open`),
    });
    if (agreed) await invoke("open_figure_source", { path: source, agreed: true });
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
