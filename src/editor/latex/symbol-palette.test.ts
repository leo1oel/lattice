import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { matchSymbols, openSymbolPalette } from "./symbol-palette";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function paletteView(doc: string, anchor: number) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, selection: { anchor } }) });
  views.push(view);
  openSymbolPalette(view);
  const input = view.dom.querySelector<HTMLInputElement>(".symbol-palette input")!;
  const search = (query: string) => {
    input.value = query;
    fireEvent.input(input);
  };
  return { view, input, search };
}

const names = (query: string) => matchSymbols(query).map((symbol) => symbol.name);

describe("math symbol palette", () => {
  it("finds a symbol by command name, meaning, or the symbol itself", () => {
    expect(names("alpha")).toEqual(["\\alpha"]);
    expect(names("\\varepsilon")).toEqual(["\\varepsilon"]);
    expect(names("α")).toEqual(["\\alpha"]);
    expect(names("summation")).toEqual(["\\sum"]);
    expect(names("")).toContain("\\frac");
  });

  it("writes the chosen symbol at the caret, in $…$ outside math, with the caret in its first argument", () => {
    const { view, input, search } = paletteView("Let $x = $ and ", 9);
    expect(input.ownerDocument.activeElement).toBe(input);
    search("leq");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("Let $x = \\leq$ and ");
    expect(view.dom.querySelector(".symbol-palette")).toBeNull();

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    openSymbolPalette(view);
    const again = view.dom.querySelector<HTMLInputElement>(".symbol-palette input")!;
    again.value = "frac";
    fireEvent.input(again);
    fireEvent.keyDown(again, { key: "ArrowRight" });
    fireEvent.keyDown(again, { key: "ArrowLeft" });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("Let $x = \\leq$ and $\\frac{}{}$");
    expect(view.state.selection.main.head).toBe("Let $x = \\leq$ and $\\frac{".length);
  });

  it("says when nothing matches, and Escape gives the caret back", () => {
    const { view, input, search } = paletteView("$$", 1);
    search("no such symbol");
    expect(view.dom.querySelector(".symbol-palette-empty")?.hasAttribute("hidden")).toBe(false);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.dom.querySelector(".symbol-palette")).toBeNull();
    expect(view.hasFocus).toBe(true);
  });
});
