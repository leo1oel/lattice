import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertibleFile, dropDrawingFile, isConvertibleDrawing } from "./figure-converters";
import { pagedDrawingOf } from "./figure-converters-actions";
import { perKeyDebounce } from "./figure-source-refresh";

describe("figure converters", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("knows the drawings a program can render", () => {
    expect(isConvertibleDrawing("f/a.SVG")).toBe(true);
    expect(isConvertibleDrawing("f/a.drawio")).toBe(true);
    expect(isConvertibleDrawing("f/a.pdf")).toBe(false);
    expect(isConvertibleDrawing("f/a.reactio")).toBe(false);
  });

  it("takes a single pasted drawing, not an image or several files", () => {
    const drawing = { name: "a.drawio" };
    expect(convertibleFile([drawing])).toBe(drawing);
    expect(convertibleFile([{ name: "a.png" }])).toBeNull();
    expect(convertibleFile([drawing, { name: "b.svg" }])).toBeNull();
    expect(convertibleFile([])).toBeNull();
  });

  it("leaves every other drop to the usual path", () => {
    expect(dropDrawingFile(["/a.png"], { x: 0, y: 0 }, "/p")).toBe(false);
    expect(dropDrawingFile(["/a.svg", "/b.svg"], { x: 0, y: 0 }, "/p")).toBe(false);
  });

  it("finds the drawing of an entry with a page line, and no other", () => {
    const entry = "% editable-figure source: a b.drawio\n% editable-figure page: 2 (of 2: P, Q)\n\\includegraphics{a_b.pdf}\n";
    expect(pagedDrawingOf("figures/a_b.tex", entry)).toBe("figures/a b.drawio");
    expect(pagedDrawingOf("figures/a.tex", "% editable-figure source: a.svg\n\\input{a}")).toBeNull();
    expect(pagedDrawingOf("main.tex", "\\documentclass{article}\n")).toBeNull();
  });

  it("runs once per key after changes pause", () => {
    const run = vi.fn();
    const debounce = perKeyDebounce(100, run);
    debounce.call("a");
    vi.advanceTimersByTime(50);
    debounce.call("a");
    debounce.call("b");
    vi.advanceTimersByTime(100);
    expect(run.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("drops what is pending on stop", () => {
    const run = vi.fn();
    const debounce = perKeyDebounce(100, run);
    debounce.call("a");
    debounce.stop();
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
  });
});
