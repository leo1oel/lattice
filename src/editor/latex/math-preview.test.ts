import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mathPreview } from "./math-preview";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));
// KaTeX loads on the first formula; load it once up front so cards set at once.
beforeAll(() => import("./equation-card"));

function previewView(doc: string, anchor: number, macros: Record<string, string> = {}) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor }, extensions: mathPreview(() => macros) }),
  });
  views.push(view);
  return view;
}

const card = (view: EditorView) => view.dom.querySelector<HTMLElement>(".math-preview-card");
const shown = (view: EditorView) => {
  const element = card(view);
  return element && !element.hidden ? element : null;
};

describe("live math preview", () => {
  it("sets the formula at the caret in a card, inline or display, and updates it as you type", async () => {
    const view = previewView("Energy $E = mc^2$ and\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}", 10);
    await waitFor(() => expect(shown(view)).not.toBeNull());
    expect(shown(view)!.getAttribute("aria-label")).toBe("Math preview");
    expect(shown(view)!.querySelector(".katex")).not.toBeNull();
    expect(shown(view)!.querySelector(".katex-display")).toBeNull();
    const before = card(view);

    view.dispatch({ changes: { from: 16, insert: "+1" } });
    expect(card(view)).toBe(before);
    expect(card(view)!.textContent).toContain("+1");

    // Into the align: a new card, display math, its `&` rows set as `aligned`.
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("c &=") } });
    expect(card(view)).not.toBe(before);
    expect(shown(view)!.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps the last good picture, dimmed, while the formula cannot be set", () => {
    const view = previewView("$\\frac{a}{b}$", 3);
    const good = shown(view)!.innerHTML;
    view.dispatch({ changes: { from: 12, insert: "\\frac{" } });
    expect(shown(view)!.hasAttribute("data-stale")).toBe(true);
    expect(shown(view)!.innerHTML).toContain(good.slice(0, 40));
    expect(shown(view)!.querySelector(".katex-error")).toBeNull();
    view.dispatch({ changes: { from: 12, to: 18 } });
    expect(shown(view)!.hasAttribute("data-stale")).toBe(false);
  });

  it("uses the project's macros", () => {
    const view = previewView("$\\R$", 2, { "\\R": "\\mathbb{R}" });
    expect(shown(view)!.querySelector(".mathbb, .amsrm")).not.toBeNull();
  });

  it("goes when the caret leaves math, and Escape closes it until the caret leaves that formula", () => {
    const view = previewView("$x$ text $y$", 1);
    expect(shown(view)).not.toBeNull();
    view.dispatch({ selection: { anchor: 6 } });
    expect(card(view)).toBeNull();

    view.dispatch({ selection: { anchor: 10 } });
    expect(shown(view)).not.toBeNull();
    fireEvent.keyDown(view.contentDOM, { key: "Escape" });
    expect(card(view)).toBeNull();
    view.dispatch({ changes: { from: 10, insert: "z" } });
    expect(card(view)).toBeNull();

    view.dispatch({ selection: { anchor: 1 } });
    expect(shown(view)).not.toBeNull();
    view.dispatch({ selection: { anchor: 11 } });
    expect(shown(view)).not.toBeNull();
  });

  it("shows nothing for an empty formula and takes no focus", () => {
    const view = previewView("$ $", 1);
    expect(shown(view)).toBeNull();
    view.focus();
    view.dispatch({ changes: { from: 1, to: 2, insert: "x" } });
    expect(shown(view)).not.toBeNull();
    expect(fireEvent.mouseDown(card(view)!)).toBe(false);
    expect(view.hasFocus).toBe(true);
  });
});
