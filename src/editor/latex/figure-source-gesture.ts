/**
 * Cmd/Ctrl+double-click on a line that includes an editable figure opens the
 * drawing it was made from. Cmd/Ctrl+click on an include is the jump to its
 * file, so a single click waits to see that no double-click follows.
 */
import { EditorView } from "@codemirror/view";
import { includedTexPaths } from "../insert/editable-figure";
import { openDrawingOf } from "../../project/figure-source-open";

const SINGLE_CLICK_MS = 260;
let pendingJump: ReturnType<typeof setTimeout> | undefined;

const includesAt = (view: EditorView, position: number, currentPath: string) => (
  includedTexPaths(view.state.doc.lineAt(position).text, currentPath)
);

/** Whether a Cmd/Ctrl+click at `position` was an include's, which `jump` then follows unless a double-click comes. */
export function deferIncludeJump(view: EditorView, position: number, currentPath: string, detail: number, jump: () => void): boolean {
  if (!includesAt(view, position, currentPath).length) return false;
  clearTimeout(pendingJump);
  if (detail === 1) pendingJump = setTimeout(jump, SINGLE_CLICK_MS);
  return true;
}

export function figureSourceDoubleClick(currentPath: string, jump?: (view: EditorView, position: number) => void) {
  return EditorView.domEventHandlers({
    dblclick(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position == null) return false;
      const included = includesAt(view, position, currentPath);
      if (!included.length) return false;
      clearTimeout(pendingJump);
      event.preventDefault();
      // An include that is no figure is still a jump to its file.
      void openDrawingOf(...included).then((opened) => { if (!opened) jump?.(view, position); });
      return true;
    },
  });
}
