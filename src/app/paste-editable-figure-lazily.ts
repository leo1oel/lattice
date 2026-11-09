/** A figure paste loads its code when used; a plain function, since the component that calls it is memoized. */
import type { EditorView } from "@codemirror/view";
import type { EditableFigureManifest } from "../editor/insert/editable-figure";

export function pasteEditableFigureLazily(
  view: EditorView,
  manifest: EditableFigureManifest,
  options: { projectRoot: string; refreshProject: () => Promise<unknown> },
): void {
  void import("./editable-figure-paste").then(({ pasteEditableFigure }) => pasteEditableFigure(view, manifest, options));
}
