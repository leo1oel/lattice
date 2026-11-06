import { projectCommands, projectSnapshot, refreshableProject, expectEditorText, expectInvoked, pause, SINGLE_TRANSFORMER } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("downloads a cited preprint the library has not fetched, then opens it, from the card's title", async () => {
    const citedOnly = { ...SINGLE_TRANSFORMER, hasFullText: false };
    let fetched = false;
    renderApp({
      // The download refreshes the project before it opens the Paper.
      ...refreshableProject(projectSnapshot(), SOURCE),
      list_citations: () => CITATIONS,
      list_papers: () => [{ ...citedOnly, hasFullText: fetched }],
      fetch_paper: () => {
        fetched = true;
        return { arxivId: citedOnly.arxivId, paperPath: `.research/papers/${citedOnly.arxivId}/paper.md` };
      },
      read_paper: "# Paper body",
    });
    const view = await expectEditorText(SOURCE);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: SOURCE.indexOf("chen") + 2 } });
    });
    const card = await keyboardCard(view);
    fireEvent.click(within(card).getByRole("button", { name: "A Single Transformer" }));
    await expectInvoked("fetch_paper", { arxivId: citedOnly.arxivId, requestId: expect.any(String) });
    await expectInvoked("read_paper", { arxivId: citedOnly.arxivId });
  });

  it("opens a cited web page in the browser rather than capturing it", async () => {
    const page = "https://example.com/a-blog-post";
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE),
      list_citations: () => ({ skipped: [], citations: [{ ...CITATIONS.citations[0], url: page }] }),
      list_papers: () => [{ arxivId: "", url: page, title: "A Single Transformer", citationKey: "chen2024single", hasFullText: false, hasBlog: false }],
    });
    const view = await expectEditorText(SOURCE);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: SOURCE.indexOf("chen") + 2 } });
    });
    const card = await keyboardCard(view);
    fireEvent.click(within(card).getByRole("button", { name: "A Single Transformer" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(page));
    expect(invoke).not.toHaveBeenCalledWith("fetch_web_reference", expect.anything());
  });

  it("opens the cited source in the browser when the preprint's download fails", async () => {
    const citedOnly = { ...SINGLE_TRANSFORMER, hasFullText: false };
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE),
      list_citations: () => ({ skipped: [], citations: [{ ...CITATIONS.citations[0], arxivId: citedOnly.arxivId }] }),
      list_papers: () => [citedOnly],
      fetch_paper: () => Promise.reject(new Error("arXiv is unreachable")),
    });
    const view = await expectEditorText(SOURCE);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: SOURCE.indexOf("chen") + 2 } });
    });
    const card = await keyboardCard(view);
    fireEvent.click(within(card).getByRole("button", { name: OPEN_PAPER }));
    await expectInvoked("fetch_paper", { arxivId: citedOnly.arxivId, requestId: expect.any(String) });
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(`https://arxiv.org/pdf/${citedOnly.arxivId}`));
  });
});
