import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferIncludeJump, figureSourceDoubleClick } from "./figure-source-gesture";

const openDrawingOf = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../project/figure-source-open", () => ({ openDrawingOf }));

function doubleClick(doc: string, init: MouseEventInit) {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [figureSourceDoubleClick("main.tex")] }), parent: document.body });
  vi.spyOn(view, "posAtCoords").mockReturnValue(1);
  const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  view.destroy();
  return event;
}

describe("Cmd/Ctrl+double-click on a source line", () => {
  beforeEach(() => { openDrawingOf.mockClear(); });

  it("opens the drawing of the figure the line includes", () => {
    const event = doubleClick(String.raw`\import{figures/}{a.tex}`, { metaKey: true });
    expect(openDrawingOf).toHaveBeenCalledWith("figures/a.tex");
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes Ctrl as well", () => {
    doubleClick(String.raw`\input{a}`, { ctrlKey: true });
    expect(openDrawingOf).toHaveBeenCalledWith("a.tex");
  });

  it("leaves a plain double-click to select the word", () => {
    const event = doubleClick(String.raw`\import{figures/}{a.tex}`, {});
    expect(openDrawingOf).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a line with no include alone", () => {
    doubleClick("plain text", { metaKey: true });
    expect(openDrawingOf).not.toHaveBeenCalled();
  });

  it("holds a single click's jump, and lets a double-click cancel it", () => {
    vi.useFakeTimers();
    const view = new EditorView({ state: EditorState.create({ doc: String.raw`\input{a}`, extensions: [figureSourceDoubleClick("main.tex")] }), parent: document.body });
    vi.spyOn(view, "posAtCoords").mockReturnValue(1);
    const jump = vi.fn();
    expect(deferIncludeJump(view, 1, "main.tex", 1, jump)).toBe(true);
    vi.advanceTimersByTime(400);
    expect(jump).toHaveBeenCalledTimes(1);
    deferIncludeJump(view, 1, "main.tex", 1, jump);
    view.contentDOM.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, metaKey: true }));
    vi.advanceTimersByTime(400);
    expect(jump).toHaveBeenCalledTimes(1);
    view.destroy();
    vi.useRealTimers();
  });

  it("does not claim a click off any include", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "text" }), parent: document.body });
    expect(deferIncludeJump(view, 1, "main.tex", 1, vi.fn())).toBe(false);
    view.destroy();
  });
});
