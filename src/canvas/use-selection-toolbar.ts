/**
 * The source editor's selection toolbar: where it sits for the selection, as
 * the selection, the document and the editor's place on screen change, and
 * when it goes away.
 */
import { useCallback, useEffect, useReducer, useRef, type RefObject } from "react";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { SELECTION_TOOLBAR_SURFACES } from "../editor/latex/latex-selection-toolbar";
import { selectionToolbarPlacement, type SelectionToolbarPlacement } from "../editor/latex/selection-toolbar-placement";
import { pointerSelectionSettled } from "../editor/pointer-selection";
import { onLayoutChange } from "../app/effect-helpers";

export function useSelectionToolbar() {
  // A placement replaces the last; the same one renders nothing.
  const [placement, setPlacement] = useReducer(
    (_shown: SelectionToolbarPlacement | null, next: SelectionToolbarPlacement | null) => next,
    null,
  );
  // The placement shown, or on its way to the screen; null once dismissed.
  const ownerRef = useRef<SelectionToolbarPlacement | null>(null);
  const dismiss = useCallback(() => {
    ownerRef.current = null;
    setPlacement(null);
  }, []);
  const update = useCallback((view: EditorView, path: string) => {
    const next = selectionToolbarPlacement(view, path, ownerRef.current);
    if (!next) return dismiss();
    ownerRef.current = next;
    setPlacement(next);
  }, [dismiss]);
  /** Its answer to a source editor update; `path` is the file the canvas shows. */
  const follow = useCallback((editorUpdate: ViewUpdate, path: string) => {
    const { view } = editorUpdate;
    // Focus moving to another control (a tab, a panel, a command) hides
    // the toolbar; its own menus and the link field keep it.
    const focused = view.dom.ownerDocument.activeElement;
    const focusLeft = editorUpdate.focusChanged && focused && focused !== view.dom.ownerDocument.body
      && !view.dom.contains(focused) && !focused.closest(SELECTION_TOOLBAR_SURFACES);
    if (focusLeft) dismiss();
    // A dismissed toolbar stays dismissed until the selection changes. The
    // blur that follows a click outside (which dismissed it) used to show
    // it again, left floating over whatever panel replaced the editor. A
    // selection being dragged out never gets here (use-source-session.ts):
    // the update that ends the drag places the toolbar for it.
    else if (editorUpdate.selectionSet || editorUpdate.docChanged || pointerSelectionSettled(editorUpdate) || ownerRef.current) {
      update(view, path);
    }
  }, [dismiss, update]);
  return { placement, ownerRef, dismiss, update, follow };
}

/**
 * Keeps a shown toolbar on its selection while the source editor's box moves
 * or resizes, and drops it when the file changes or the source editor goes.
 */
export function useSelectionToolbarOnScreen(
  toolbar: ReturnType<typeof useSelectionToolbar>,
  viewRef: RefObject<EditorView | null>,
  activeFile: string,
  sourceHidden: boolean,
) {
  const { ownerRef, update, dismiss } = toolbar;
  useEffect(() => onLayoutChange(
    [viewRef.current?.dom.closest(".source-editor")],
    () => {
      const owner = ownerRef.current;
      const view = viewRef.current;
      if (owner && view) update(view, owner.path);
    },
  ), [activeFile, ownerRef, update, viewRef]);
  useEffect(dismiss, [activeFile, dismiss, sourceHidden]);
}
