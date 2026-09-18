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

function renderEditor(activePath = "notes.md", papers = PAPERS) {
  const result = render(<VisualMarkdownEditor text="" activePath={activePath} papers={papers} onChangeMarkdown={() => true} onUndo={() => false} onRedo={() => false} />);
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
  it("lists all matches and lets keyboard navigation select beyond the eighth paper", async () => {
    const papers = Array.from({ length: 12 }, (_, index) => ({
      title: `Research paper ${index + 1}`,
      arxivId: `2401.${String(index + 1).padStart(5, "0")}`,
      hasFullText: true,
      hasBlog: false,
    }));
    const { editor } = renderEditor("notes.md", papers);
    editor.chain().focus().insertContent("@").run();
    const menu = await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    expect(within(menu).getAllByRole("option")).toHaveLength(12);
    expect(menu).not.toHaveTextContent("Showing top");
    expect(menu).toHaveAttribute("data-slot", "scroll-area-viewport");
    // jsdom has no layout/overflow; the shared ScrollArea mounts its thumb
    // only when the browser measures content taller than this viewport.
    expect(menu.closest('[data-slot="scroll-area"]')).toBeInTheDocument();
    for (let index = 0; index < 9; index += 1) {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    }
    await waitFor(() => expect(within(menu).getByRole("option", { selected: true }))
      .toHaveTextContent("Research paper 10"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(markdown(editor))
      .toContain("[Research paper 10](.research/papers/2401.00010/paper.md)"));
  });

  it("keeps a single keyboard selection and accepts the second paper with Tab", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("@").run();
    const menu = await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    const options = within(menu).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await waitFor(() => expect(options[1]).toHaveAttribute("aria-selected", "true"));
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    await waitFor(() => expect(markdown(editor))
      .toContain("[An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)"));
  });

  it("shows an empty state instead of stale options when nothing matches", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("@").run();
    await screen.findByRole("listbox", { name: "Paper citation suggestions" });
    editor.commands.insertContent("nonexistent-paper");
    expect(await screen.findByRole("status")).toHaveTextContent("No matching papers");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

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
