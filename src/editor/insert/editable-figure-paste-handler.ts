/** The editor side of pasting an editable figure: kept apart so the rest of the module needs no CodeMirror at startup. */
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { convertibleFile, pasteDrawingFile } from "../../project/figure-converters";
import { editableFigureFromHtml, type EditableFigureManifest } from "./editable-figure";

/** A drawing file copied in the system's file manager becomes a figure, ahead of the image paste. */
function pasteDrawing(event: ClipboardEvent, view: EditorView): boolean {
  const file = convertibleFile([...event.clipboardData?.files ?? []]);
  if (!file) return false;
  event.preventDefault();
  void pasteDrawingFile(file, view);
  return true;
}

/** Pastes carrying a figure manifest go to `onPasteFigure`, ahead of the image paste. */
export function editableFigurePaste(onPasteFigure: (manifest: EditableFigureManifest, view: EditorView) => void): Extension {
  return Prec.high(EditorView.domEventHandlers({
    paste(event, view) {
      const html = event.clipboardData?.getData("text/html") ?? "";
      const manifest = html ? editableFigureFromHtml(html) : null;
      if (!manifest) return pasteDrawing(event, view);
      event.preventDefault();
      onPasteFigure(manifest, view);
      return true;
    },
  }));
}

let lastEditor: EditorView | null = null;

/** The LaTeX editor last in use, if it is still on screen: where a figure made from the project tree goes. */
export const lastFigureEditor = () => (lastEditor?.dom.isConnected ? lastEditor : null);

export const trackFigureEditor = EditorView.domEventHandlers({
  focus: (_event, view) => { lastEditor = view; },
});
