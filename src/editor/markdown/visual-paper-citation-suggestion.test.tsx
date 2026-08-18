import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperSummary } from "../../app-types";
import { matchPapers } from "./visual-paper-citation-suggestion";
import { VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager } from "./visual-markdown-schema";

const PAPERS: PaperSummary[] = [
  {
    arxivId: "1706.03762",
    title: "Attention Is All You Need",
    citationKey: "vaswani2017attention",
    hasFullText: true,
    hasBlog: true,
  },
  {
    arxivId: "2010.11929",
    title: "An Image is Worth 16x16 Words",
    citationKey: "dosovitskiy2021image",
    hasFullText: false,
    hasBlog: true,
  },
  // Cited-only: nothing on disk to link to.
  { arxivId: "", title: "Cited Only Work", citationKey: "cited2020only", hasFullText: false, hasBlog: false },
];

afterEach(cleanup);

function renderEditor(activePath = "notes.md") {
  const result = render(<VisualMarkdownEditor text="" activePath={activePath} papers={PAPERS} onChangeMarkdown={() => true} onUndo={() => false} onRedo={() => false} />);
  const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
  return { ...result, editor: (surface as HTMLElement & { editor: Editor }).editor };
}

function markdown(editor: Editor) {
  return getMarkdownManager().serialize(editor.getJSON());
}

describe("matchPapers", () => {
  it("drops papers without local content and matches every token", () => {
    expect(matchPapers(PAPERS, "").map((paper) => paper.arxivId))
      .toEqual(["1706.03762", "2010.11929"]);
    expect(matchPapers(PAPERS, "attention need").map((paper) => paper.arxivId))
      .toEqual(["1706.03762"]);
    expect(matchPapers(PAPERS, "dosovitskiy").map((paper) => paper.arxivId))
      .toEqual(["2010.11929"]);
    expect(matchPapers(PAPERS, "cited")).toEqual([]);
  });
});

describe("visual paper citation suggestion", () => {
  it("opens on @, filters papers, and inserts a link to the full text", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("@").run();
    const menu = await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    expect(menu).toHaveTextContent("Attention Is All You Need");
    expect(menu).toHaveTextContent("An Image is Worth 16x16 Words");
    expect(menu).not.toHaveTextContent("Cited Only Work");
    editor.commands.insertContent("attention");
    await waitFor(() => expect(menu).not.toHaveTextContent("An Image is Worth 16x16 Words"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(markdown(editor))
      .toContain("[Attention Is All You Need](.research/papers/1706.03762/paper.md)"));
  });

  it("links a blog-only paper to its overview via mouse selection", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("@image").run();
    const menu = await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /An Image is Worth/ }));
    await waitFor(() => expect(markdown(editor))
      .toContain("[An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)"));
  });

  it("makes the href relative to a nested note", async () => {
    const { editor } = renderEditor("notes/reading.md");
    editor.chain().focus().insertContent("@attention").run();
    const menu = await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /Attention Is All/ }));
    await waitFor(() => expect(markdown(editor))
      .toContain("[Attention Is All You Need](../.research/papers/1706.03762/paper.md)"));
  });
});
