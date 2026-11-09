/** Opening a figure's source, loaded when used: see figure-source-open.ts. */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction, toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";

/** File types the person has agreed to open from figures, for this session. */
const agreedExtensions = new Set<string>();

export async function openFigureSource(source: string): Promise<void> {
  const extension = source.slice(source.lastIndexOf(".") + 1).toLowerCase();
  try {
    if (await invoke<boolean>("open_figure_source", { path: source, allowOther: agreedExtensions.has(extension) })) return;
    const name = source.slice(source.lastIndexOf("/") + 1);
    if (!await confirmAction({ message: i18n._(msg`Open ${name} in its default app?`) })) return;
    agreedExtensions.add(extension);
    await invoke("open_figure_source", { path: source, allowOther: true });
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
