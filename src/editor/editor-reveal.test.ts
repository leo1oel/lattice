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

  it("takes focus once its surface is shown when it lands while still hidden", async () => {
    const view = editor("one\ntwo");
    // A Trellis tab about to show is hidden and inert, and the browser refuses focus there.
    let hidden = true;
    const focusShown = view.contentDOM.focus.bind(view.contentDOM);
    view.contentDOM.focus = (options?: FocusOptions) => { if (!hidden) focusShown(options); };
    revealInEditor(view, lineTarget(view, 2));
    expect(view.hasFocus).toBe(false);
    hidden = false;
    await vi.waitFor(() => expect(view.hasFocus).toBe(true));
  });

  it("centers the target again as its scroll draws it, if the lines above it were taller than estimated", () => {
    const view = editor("one\ntwo\nthree");
    const center = vi.spyOn(EditorView, "scrollIntoView");
    vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 800));
    vi.spyOn(view.scrollDOM, "clientHeight", "get").mockReturnValue(800);
    // Drawn, the target sits near the bottom edge rather than the middle.
    let targetTop = 760;
    vi.spyOn(view, "coordsAtPos").mockImplementation(() => ({ left: 0, right: 10, top: targetTop, bottom: targetTop + 20 }));
    revealInEditor(view, { from: 8 });
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(center).toHaveBeenCalledTimes(2);
    expect(center).toHaveBeenLastCalledWith(8, { y: "center" });
    // A centered target is left alone…
    targetTop = 390;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(center).toHaveBeenCalledTimes(2);
    // …until a later redraw corrects the heights above it again and clamps the scroll.
    targetTop = 760;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(center).toHaveBeenCalledTimes(3);
    // Where the jump did land in the middle, it is left alone.
    center.mockClear();
    targetTop = 390;
    revealInEditor(view, { from: 4 });
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(center).toHaveBeenCalledTimes(1);
  });

  it("does not pull the view back once the writer has moved on", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = editor("one\ntwo\nthree");
    const center = vi.spyOn(EditorView, "scrollIntoView");
    vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 800));
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 760, bottom: 780 });
    revealInEditor(view, { from: 8 });
    view.dispatch({ selection: { anchor: 1 } });
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    // Nor does the writer's own scrolling, while the jump is still settling…
    revealInEditor(view, { from: 8 });
    view.dom.dispatchEvent(new Event("wheel"));
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    // …or once it has.
    revealInEditor(view, { from: 8 });
    vi.advanceTimersByTime(3000);
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(center).toHaveBeenCalledTimes(3);
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
