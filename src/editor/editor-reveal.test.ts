import { afterEach, describe, expect, it, vi } from "vitest";
import { findNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { textEditorExtensions } from "./latex/latex-editor";
import { lineTarget, REVEAL_FLASH_MS, revealExtension, revealInEditor } from "./editor-reveal";

const views: EditorView[] = [];
function editor(doc: string, extensions = [revealExtension()]) {
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  views.push(view);
  return view;
}
const marked = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-reveal-flash")].map((line) => line.textContent);

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("revealInEditor", () => {
  it("selects the target, centers it, marks its lines for a moment and focuses the editor", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const center = vi.spyOn(EditorView, "scrollIntoView");
    const view = editor("one\ntwo\nthree\nfour");
    revealInEditor(view, { from: 4, to: 13 });
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 13 });
    expect(center).toHaveBeenCalledWith(4, { y: "center" });
    expect(marked(view)).toEqual(["two", "three"]);
    expect(view.hasFocus).toBe(true);
    vi.advanceTimersByTime(REVEAL_FLASH_MS);
    expect(marked(view)).toEqual([]);
  });

  it("keeps the newest mark when jumps follow each other, and clamps a stale target", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = editor("one\ntwo\nthree");
    revealInEditor(view, { from: 0 });
    vi.advanceTimersByTime(REVEAL_FLASH_MS - 100);
    revealInEditor(view, { from: 500 });
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    vi.advanceTimersByTime(200);
    expect(marked(view)).toEqual(["three"]);
  });

  it("still lands in an editor without the mark", () => {
    const view = editor("one\ntwo", []);
    revealInEditor(view, lineTarget(view, 2));
    expect(view.state.selection.main.head).toBe(4);
    expect(marked(view)).toEqual([]);
  });

  it("turns a line number into its start, clamped to the document", () => {
    const view = editor("one\ntwo");
    expect(lineTarget(view, 2)).toEqual({ from: 4 });
    expect(lineTarget(view, 0)).toEqual({ from: 0 });
    expect(lineTarget(view, 99)).toEqual({ from: 4 });
  });
});

describe("source editors", () => {
  it("center a find result like every other jump, and leave room past the end to do so", () => {
    const center = vi.spyOn(EditorView, "scrollIntoView");
    const view = editor("alpha\nbeta\ngamma", textEditorExtensions());
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "gamma" })) });
    findNext(view);
    expect(view.state.selection.main).toMatchObject({ from: 11, to: 16 });
    expect(center).toHaveBeenCalledWith(11, { y: "center" });
    // scrollPastEnd pads the content so the last line can reach the middle of the viewport.
    expect(view.contentDOM.style.paddingBottom).not.toBe("");
  });
});
