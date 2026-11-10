import { act, renderHook } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationRounds } from "../app/annotation-rounds";
import { pointerSelection } from "../editor/pointer-selection";
import type { DocumentCanvasProps } from "./canvas-model";
import { createProofreadBridge } from "./proofread-bridge";
import { useSourceSession } from "./use-source-session";

/** What the session reads of the canvas's props, for a plain-text file. */
function sessionProps() {
  return {
    document: { activeFile: "notes.txt", editorKey: "notes", onCompletionActiveChange: vi.fn() },
    status: { buildDiagnostics: [], texlabDiagnostics: [] },
    review: { editorComments: [], overleafPresenceCursors: [], annotationRounds: new AnnotationRounds() },
    preferences: { editorKeymap: "default", editorSpellcheck: false, spellingWords: [], grammarIgnores: [] },
    bibliography: { indexPending: false, citationKeys: [] },
    navigation: { onEditorPosition: vi.fn(), onViewState: vi.fn() },
    selection: { setSelection: vi.fn() },
  } as unknown as DocumentCanvasProps;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useSourceSession", () => {
  // Each report re-rendered App, and a drag past the edge reports on every
  // autoscroll step: selecting more than the screen stuttered (#777).
  it("reports a selection dragged out with the pointer once, when the press ends", () => {
    const props = sessionProps();
    const onEditorUpdate = vi.fn();
    const options = { latestRef: { current: props }, proofread: createProofreadBridge(), pinLabel: String, onEditorUpdate };
    const { result } = renderHook(() => useSourceSession(props, options));
    const view = new EditorView({
      doc: "Hello bold world\nand a second line",
      extensions: [pointerSelection, EditorView.updateListener.of((update) => result.current.host.onUpdate(update))],
      parent: document.body,
    });
    const { setSelection } = props.selection;
    const { onEditorPosition } = props.navigation;

    view.contentDOM.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    for (const head of [8, 12, 20, 24]) act(() => view.dispatch({ selection: { anchor: 6, head }, userEvent: "select.pointer" }));
    expect(setSelection).not.toHaveBeenCalled();
    expect(onEditorPosition).not.toHaveBeenCalled();
    expect(onEditorUpdate).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0 }));
    });
    expect(setSelection).toHaveBeenCalledExactlyOnceWith("bold world\nand a s", { start: 1, end: 2 });
    expect(onEditorPosition).toHaveBeenCalledExactlyOnceWith({ path: "notes.txt", line: 2, column: 7 });
    expect(onEditorUpdate).toHaveBeenCalledOnce();
    expect(result.current.selectedText).toBe("bold world\nand a s");

    // A scroll leaves the selection as it was: nothing to slice and report again.
    act(() => view.dispatch({}));
    expect(setSelection).toHaveBeenCalledOnce();
    view.destroy();
  });
});
