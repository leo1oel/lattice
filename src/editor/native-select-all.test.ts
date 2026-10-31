import { afterEach, expect, it } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { nativeSelectAllSelectsDocument } from "./native-select-all";

// The browser end of this (WebKit's Select All reaching only rendered lines)
// is checked in WebKit by the `source-menu-select-all` layout check
// (scripts/perf-bench/layout-checks.mjs); jsdom stands in for the browser
// here by doing what WebKit does: fire `selectstart` at the editable root,
// then select its DOM.

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.getSelection()?.removeAllRanges();
});

const LINES = 4000;

function longEditor() {
  const doc = Array.from({ length: LINES }, (_, index) => `line ${index} \\section{Heading} lorem ipsum`).join("\n");
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [nativeSelectAllSelectsDocument] }), parent: document.body });
  views.push(view);
  view.focus();
  return view;
}

/**
 * What the browser's SelectAll command does in a contenteditable:
 * `selectstart` at `target`, then a selection from the start of the first
 * of `lines` to the end of the last (WebKit ends it in the gap after them).
 */
async function browserSelect(target: Element, lines: Element[]) {
  target.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
  const last = lines.at(-1)!;
  document.getSelection()!.setBaseAndExtent(lines[0], 0, last, last.childNodes.length);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const renderedLines = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")];

const selected = (view: EditorView) => {
  const { main } = view.state.selection;
  return { from: main.from, to: main.to };
};

it("widens the browser's Select All over the rendered lines to the whole document", async () => {
  const view = longEditor();
  // The premise: only part of the document is in the DOM.
  expect(renderedLines(view).length).toBeLessThan(LINES);
  await browserSelect(view.contentDOM, renderedLines(view));
  expect(selected(view)).toEqual({ from: 0, to: view.state.doc.length });
});

it("is what widens it: CodeMirror alone keeps the rendered lines' selection", async () => {
  const view = longEditor();
  view.dispatch({ effects: StateEffect.reconfigure.of([]) });
  await browserSelect(view.contentDOM, renderedLines(view));
  expect(selected(view)).toEqual({ from: 0, to: view.viewport.to });
});

it("leaves a selection that does not reach across every rendered line", async () => {
  const view = longEditor();
  await browserSelect(view.contentDOM, renderedLines(view).slice(0, -1));
  expect(selected(view).to).toBeLessThan(view.state.doc.length);
});

it("leaves a selection started anywhere but the editable root, as the pointer's are", async () => {
  const view = longEditor();
  await browserSelect(renderedLines(view)[0], renderedLines(view));
  expect(selected(view).to).toBeLessThan(view.state.doc.length);
});
