/** The editor side of pasting an editable figure: kept apart so the rest of the module needs no CodeMirror at startup. */
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editableFigureFromHtml, type EditableFigureManifest } from "./editable-figure";

/** Pastes carrying a figure manifest go to `onPasteFigure`, ahead of the image paste. */
export function editableFigurePaste(onPasteFigure: (manifest: EditableFigureManifest, view: EditorView) => void): Extension {
  return Prec.high(EditorView.domEventHandlers({
    paste(event, view) {
      const html = event.clipboardData?.getData("text/html") ?? "";
      const manifest = html ? editableFigureFromHtml(html) : null;
      if (!manifest) return false;
      event.preventDefault();
      onPasteFigure(manifest, view);
      return true;
    },
  }));
}
