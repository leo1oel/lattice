import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealExtension, revealInEditor } from "../editor/editor-reveal";
import { CodeMirrorScrollbar } from "./codemirror-scrollbar";

const VIEWPORT = 800;
const DOCUMENT = 20_000;
const views: EditorView[] = [];

afterEach(() => {
  cleanup();
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
});

/**
 * A source editor with its overlay scrollbar beside it, as the canvas lays
 * them out: the bar is a sibling of the editor, outside `view.dom`. Just
 * after a jump, its target is drawn off-center (the heights above it are
 * still being corrected), so the jump's hold is ready to center it again.
 */
function sourceEditorJustJumped() {
  const view = new EditorView({ state: EditorState.create({ doc: "one\ntwo\nthree", extensions: [revealExtension()] }) });
  views.push(view);
  const { scrollDOM } = view;
  let scrollTop = 0;
  vi.spyOn(scrollDOM, "scrollTop", "get").mockImplementation(() => scrollTop);
  vi.spyOn(scrollDOM, "scrollTop", "set").mockImplementation((top: number) => {
    scrollTop = top;
  });
  vi.spyOn(scrollDOM, "scrollHeight", "get").mockReturnValue(DOCUMENT);
  vi.spyOn(scrollDOM, "clientHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, VIEWPORT));
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 760, bottom: 780 });
  const { container } = render(<CodeMirrorScrollbar view={view} />);
  container.prepend(view.dom);
  const bar = container.querySelector<HTMLElement>(".cm-overlay-scrollbar")!;
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(590, 0, 10, VIEWPORT));
  bar.setPointerCapture = () => {};
  bar.hasPointerCapture = () => false;
  revealInEditor(view, { from: 8 });
  const center = vi.spyOn(EditorView, "scrollIntoView");
  return {
    view,
    bar,
    thumb: bar.querySelector<HTMLElement>(".cm-overlay-scrollbar-thumb")!,
    center,
    scrollTop: () => scrollTop,
    /** The scroll the bar's gesture causes reaching the view's listeners. */
    scrolled: () => act(() => {
      scrollDOM.dispatchEvent(new Event("scroll"));
    }),
  };
}

describe("CodeMirrorScrollbar", () => {
  it("keeps a thumb drag the writer makes while a jump is still settling", () => {
    const { bar, thumb, center, scrollTop, scrolled } = sourceEditorJustJumped();
    fireEvent.pointerDown(thumb, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientY: 140, pointerId: 1 });
    scrolled();
    fireEvent.pointerUp(bar, { pointerId: 1 });
    expect(scrollTop()).toBeGreaterThan(0);
    expect(center).not.toHaveBeenCalled();
  });

  it("keeps a click on its track the writer makes while a jump is still settling", () => {
    const { bar, center, scrollTop, scrolled } = sourceEditorJustJumped();
    fireEvent.pointerDown(bar, { clientY: VIEWPORT / 2, pointerId: 1 });
    scrolled();
    fireEvent.pointerUp(bar, { pointerId: 1 });
    expect(scrollTop()).toBe((DOCUMENT - VIEWPORT) / 2);
    expect(center).not.toHaveBeenCalled();
  });
});
