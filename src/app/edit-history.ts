/**
 * Edit ▸ Undo and Redo in the macOS menu bar (src-tauri/src/native_locale.rs).
 *
 * The page sees ⌘Z and ⇧⌘Z before the menu does, and each editor takes them
 * into its own history: CodeMirror, the visual editor, the bibliography
 * editor. The menu items still run for a click on them, and for a ⌘Z no
 * editor took. Either way the focused element gets the same key press, so
 * the editor holding focus answers it exactly as it answers the key. With no
 * editor there, WebKit's own undo serves a text field or a frame, as the
 * predefined menu items did.
 */
import { invoke } from "@tauri-apps/api/core";
import { disposeWhenSettled } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";

export type EditHistoryDirection = "undo" | "redo";

/** What the menu sends to the window it was used in. */
const MENU_EVENT = "edit-history";

/** The focused element, inside any shadow roots on the way (the project tree's fields). */
function focusedElement(): Element {
  let focused: Element | null = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return focused ?? document.body;
}

/** Offer the focused element ⌘Z (⇧⌘Z to redo); whether an editor took it. */
export function stepFocusedEditor(direction: EditHistoryDirection, target: Element = focusedElement()): boolean {
  const redo = direction === "redo";
  // As the keyboard reports it: ⇧ makes the key "Z", and CodeMirror finds
  // ⇧⌘Z through the key code then.
  const press = new KeyboardEvent("keydown", {
    key: redo ? "Z" : "z", code: "KeyZ", keyCode: 90, metaKey: true, shiftKey: redo, bubbles: true, cancelable: true, composed: true,
  });
  target.dispatchEvent(press);
  return press.defaultPrevented;
}

export function runEditHistory(direction: EditHistoryDirection): void {
  if (stepFocusedEditor(direction)) return;
  void invoke("native_edit_history", { redo: direction === "redo" }).catch(() => {
    // Tests and browser previews have no native host, and no menu either.
  });
}

/** Take this window's Undo and Redo from the menu bar until the returned function runs. */
export function installEditHistoryMenu(): () => void {
  return disposeWhenSettled(listenInThisWindow<string>(MENU_EVENT, ({ payload }) => {
    if (payload === "undo" || payload === "redo") runEditHistory(payload);
  }));
}
