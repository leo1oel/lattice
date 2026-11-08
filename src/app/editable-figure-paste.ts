/**
 * A figure pasted with its drawing's source file (an editable-figure
 * manifest, docs/editable-figures.md): its files are copied into the
 * project's `figures/`, then the line that includes it replaces the
 * selection and the packages it needs go into the preamble.
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { toMessage } from "../app-utils";
import {
  editableFigureBlockSnippet, editableFigureChanges, pastesFigureBlock, preambleFiles, type EditableFigureManifest, type ImportedFigure,
} from "../editor/insert/editable-figure";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { showError } from "./notify";

export async function pasteEditableFigure(
  view: EditorView,
  manifest: EditableFigureManifest,
  { projectRoot, refreshProject }: { projectRoot: string; refreshProject: () => Promise<unknown> },
): Promise<void> {
  let figure: ImportedFigure;
  try {
    figure = await invoke<ImportedFigure>("import_editable_figure", { manifest, targetDirectory: "figures", projectRoot });
  } catch (reason) {
    showError(toMessage(reason), i18n._(msg`Figures`));
    return;
  }
  await refreshProject().catch(() => undefined);
  await insertImportedFigure(view, { ...figure, preamble: manifest.preamble });
}

/** Puts a figure whose files are in the project into `view`: its include at the selection, what it needs in the preamble. */
export async function insertImportedFigure(view: EditorView, figure: ImportedFigure): Promise<void> {
  const source = view.state.doc.toString();
  const selection = view.state.selection.main;
  const known = figure.preamble?.length
    ? (await Promise.all(preambleFiles(source).map((path) => invoke<string>("read_project_file", { path }).catch(() => "")))).join("\n")
    : "";
  const { changes, unplaced } = editableFigureChanges(source, selection, figure, known);
  if (pastesFigureBlock(source, selection)) {
    // The preamble first: the snippet then goes where the selection has moved to.
    view.dispatch({ changes: changes.slice(1), userEvent: "input.paste" });
    const { from, to } = view.state.selection.main;
    // Loaded here: the paste path is part of the startup bundle, and this editor library is not.
    const { snippet } = await import("@codemirror/autocomplete");
    snippet(editableFigureBlockSnippet(figure))(view, null, from, to);
  } else {
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input.paste" });
  }
  view.focus();
  if (unplaced.length) {
    const lines = unplaced.join(" ");
    notifyInfo(i18n._(msg`Figures`), i18n._(msg`Add to the main document's preamble: ${lines}`));
  }
}
