import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PaperSummary } from "../app-types";
import { paperDropExtension } from "../editor/paper-drop";
import { PaperLibrary, type PaperLibraryProps } from "./paper-library";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const paper: PaperSummary = {
  arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani and Shazeer",
  citationKey: "vaswani2017", hasFullText: true, hasBlog: false,
};
const projectRoot = "/projects/Research";

afterEach(cleanup);

function dataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    get types() { return [...values.keys()]; },
    setData: (type: string, value: string) => { values.set(type, value); },
    getData: (type: string) => values.get(type) ?? "",
  };
}

it("cites a paper dragged from the Papers panel into a .tex file", () => {
  const props = {
    mode: "papers", projectKey: projectRoot, papers: [paper], activePaper: null,
    paperFetchStates: {}, importInput: "", importing: false,
  } as unknown as PaperLibraryProps;
  for (const handler of ["onReveal", "onPaper", "onFetchFullText", "onDeletePaper", "onEditBibEntry", "setImportInput", "onImport", "onCancelImport"]) {
    (props as Record<string, unknown>)[handler] = vi.fn();
  }
  render(<PaperLibrary {...props} />);
  const data = dataTransfer();
  fireEvent.dragStart(screen.getByText("Attention Is All You Need").closest(".paper-row")!, { dataTransfer: data });

  const source = "As shown by prior work.";
  const view = new EditorView({
    state: EditorState.create({ doc: source, extensions: [paperDropExtension("sections/intro.tex", () => ({ projectRoot, papers: [paper] }))] }),
    parent: document.body,
  });
  // jsdom has no layout, so the drop point is supplied directly.
  vi.spyOn(view, "posAtCoords").mockReturnValue(source.indexOf("."));
  try {
    expect(fireEvent.dragOver(view.contentDOM, { dataTransfer: data })).toBe(false);
    fireEvent.drop(view.contentDOM, { dataTransfer: data });
    expect(view.state.doc.toString()).toBe(String.raw`As shown by prior work~\citep{vaswani2017}.`);
  } finally {
    view.destroy();
  }
});
