/* eslint-disable lingui/no-unlocalized-strings -- test-only DOM helpers */
import { EditorView } from "@codemirror/view";
import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** Waits for `selector` to match and returns the element. */
export function findElement<T extends Element = HTMLElement>(selector: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const element = document.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
  }, options);
}

export const findFrame = (title = "Agent") => findElement<HTMLIFrameElement>(`iframe[title="${title}"]:not([hidden])`);

/** The CodeMirror view mounted at `selector` right now. */
export function editorViewAt(selector = ".cm-editor") {
  const element = document.querySelector<HTMLElement>(selector);
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view mounted at `selector`. */
export async function findEditorView(selector = ".cm-editor", options?: Parameters<typeof waitFor>[1]) {
  const view = EditorView.findFromDOM(await findElement(selector, options));
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view at `selector` and types `text` at its end. */
export async function appendToEditor(text: string, selector?: string) {
  const view = await findEditorView(selector);
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  return view;
}

/** Waits until the CodeMirror view at `selector` holds exactly `text`, and returns it. */
export function expectEditorText(text: string, selector?: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const view = editorViewAt(selector);
    expect(view.state.doc.toString()).toBe(text);
    return view;
  }, options);
}
