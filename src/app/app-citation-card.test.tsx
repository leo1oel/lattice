import { projectCommands, projectSnapshot, expectEditorText, expectInvoked, pause, SINGLE_TRANSFORMER } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import type { EditorView } from "@codemirror/view";
import { act, fireEvent, within } from "@testing-library/react";
import { describe, it } from "vitest";

/**
 * The source editor's citation card opens what the PDF's does: the cited
 * Paper from its title and its Open paper.
 */
const { renderApp } = appHarness({ documentCanvas });

const SOURCE = "As shown by \\citep{chen2024single}.";
// Opened from the keyboard, the lead action also names its key, ↩.
const OPEN_PAPER = /^Open paper/;
const CITATIONS = {
  skipped: [],
  citations: [{ key: "chen2024single", title: "A Single Transformer", authors: "Chen, Yangyi", year: "2024", venue: "arXiv" }],
};

/**
 * ⌥⌘K (Ctrl-Alt-K off macOS) opens the card the pointer gets on hover, once
 * the library has landed. Not from inside `waitFor`: each press rebuilds the
 * card, and that DOM change reruns its callback before the library's reads can settle.
 */
async function keyboardCard(view: EditorView): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    fireEvent.keyDown(view.contentDOM, { key: "k", code: "KeyK", keyCode: 75, altKey: true, ctrlKey: true });
    const card = view.dom.querySelector<HTMLElement>(".citation-hover-card");
    if (card && within(card).queryByRole("button", { name: OPEN_PAPER })) return card;
    // Not yet: Escape closes it and gives the caret back, as a writer would.
    if (card) fireEvent.keyDown(card, { key: "Escape" });
    await pause(50);
  }
  throw new Error("the citation card never offered Open paper");
}

describe("citation card in the source editor", () => {
  it.each(["title", "Open paper"])("opens the cited library Paper from its %s", async (control) => {
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE),
      list_citations: () => CITATIONS,
      list_papers: () => [SINGLE_TRANSFORMER],
      read_paper: "# Paper body",
    });
    const view = await expectEditorText(SOURCE);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: SOURCE.indexOf("chen") + 2 } });
    });
    const card = await keyboardCard(view);
    fireEvent.click(within(card).getByRole("button", { name: control === "title" ? "A Single Transformer" : OPEN_PAPER }));
    await expectInvoked("read_paper", { arxivId: SINGLE_TRANSFORMER.arxivId });
  });
});
