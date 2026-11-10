/**
 * Whether a primary-button press that began inside an element is still held,
 * as while a writer drags out a selection.
 *
 * A dragged selection changes on every pointer move and, held past an edge, on
 * every autoscroll step: dozens of times a second. Work that answers a
 * selection (the Agent panel's context, the status bar's caret and word
 * count, the selection toolbar) re-rendered App each time, and selecting past
 * the visible text stuttered (#777). Such work asks `held()` and waits for
 * `onRelease`, so it runs once, for the selection the writer let go on.
 */
export type PointerHold = {
  held(): boolean;
  dispose(): void;
};

export function watchPointerHold(root: HTMLElement, onRelease: () => void): PointerHold {
  let held = false;
  let releaseListeners: AbortController | null = null;
  const stopListening = () => {
    releaseListeners?.abort();
    releaseListeners = null;
  };
  const release = () => {
    if (!held) return;
    held = false;
    stopListening();
    onRelease();
  };
  const press = (event: PointerEvent) => {
    const view = root.ownerDocument.defaultView;
    if (event.button !== 0 || held || !view) return;
    held = true;
    releaseListeners = new AbortController();
    const { signal } = releaseListeners;
    // On the window, so a release anywhere ends it. A selection the editor
    // still sets on the mouseup after it is no longer held, so it reports
    // as any other selection does.
    for (const type of ["pointerup", "mouseup", "pointercancel", "dragend", "blur"]) {
      view.addEventListener(type, release, { signal });
    }
  };
  root.addEventListener("pointerdown", press, true);
  return {
    held: () => held,
    dispose() {
      root.removeEventListener("pointerdown", press, true);
      held = false;
      stopListening();
    },
  };
}
