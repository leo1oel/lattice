import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { history, undo } from "@tiptap/pm/history";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginPaperDrag, PAPER_DRAG_TYPE } from "../../papers/paper-drag";
import type { PaperSummary } from "../../app-types";
import { matchPapers } from "./visual-paper-citation-suggestion";
import { VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager } from "./visual-markdown-schema";

const PAPERS: PaperSummary[] = [
  { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true, hasBlog: true },
  { arxivId: "2010.11929", title: "An Image is Worth 16x16 Words", citationKey: "dosovitskiy2021image", hasFullText: false, hasBlog: true },
  // Cited-only: nothing on disk to link to.
  { arxivId: "", title: "Cited Only Work", citationKey: "cited2020only", hasFullText: false, hasBlog: false },
];

afterEach(cleanup);

function renderEditor(activePath = "notes.md", papers = PAPERS, text = "") {
  render(<VisualMarkdownEditor text={text} activePath={activePath} projectRoot="/project" papers={papers} onChangeMarkdown={() => true} onUndo={() => false} onRedo={() => false} />);
  const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
  return (surface as HTMLElement & { editor: Editor }).editor;
}

const markdown = (editor: Editor) => getMarkdownManager().serialize(editor.getJSON());
const pressKey = (key: string) => fireEvent.keyDown(screen.getByRole("combobox"), { key });
const expectMarkdownToContain = (editor: Editor, text: string) => waitFor(() => expect(markdown(editor)).toContain(text));

function openMenu(editor: Editor, typed: string) {
  editor.chain().focus().insertContent(typed).run();
  return screen.findByRole("listbox", { name: "Paper citation suggestions" });
}

async function openLinkEditor(name: string) {
  fireEvent.mouseOver(await screen.findByRole("link", { name }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit link" }));
}

describe("matchPapers", () => {
  it("drops papers without local content and matches every token", () => {
    const ids = (query: string) => matchPapers(PAPERS, query).map((paper) => paper.arxivId);
    expect(ids("")).toEqual(["1706.03762", "2010.11929"]);
    expect(ids("attention need")).toEqual(["1706.03762"]);
    expect(ids("dosovitskiy")).toEqual(["2010.11929"]);
    expect(ids("cited")).toEqual([]);
  });
});

describe("visual paper citation suggestion", () => {
  it("drops an @ citation atom at the pointer and preserves it in Markdown", async () => {
    const editor = renderEditor("notes/reading.md", PAPERS, "Before after");
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 8, inside: 0 });
    const values = new Map<string, string>();
    const data = { types: [PAPER_DRAG_TYPE], setData: (type: string, value: string) => { values.set(type, value); }, getData: (type: string) => values.get(type) ?? "" } as unknown as DataTransfer;
    beginPaperDrag(data, "/project", PAPERS[0]);
    fireEvent.drop(editor.view.dom, { dataTransfer: data, clientX: 20, clientY: 20 });
    expect(markdown(editor).trimEnd()).toBe("Before [@vaswani2017attention](../.research/papers/1706.03762/paper.md)after");
    expect((await screen.findByRole("link", { name: "@vaswani2017attention" })).querySelector("[data-paper-citation]")).not.toBeNull();
    beginPaperDrag(data, "/other-project", PAPERS[1]);
    fireEvent.drop(editor.view.dom, { dataTransfer: data });
    expect(markdown(editor)).not.toContain("dosovitskiy");
    editor.setEditable(false);
    beginPaperDrag(data, "/project", PAPERS[1]);
    fireEvent.drop(editor.view.dom, { dataTransfer: data });
    expect(markdown(editor)).not.toContain("dosovitskiy");
  });

  it.each(["Backspace", "Delete"])("deletes an inserted citation as a whole with %s", async (key) => {
    const editor = renderEditor();
    await openMenu(editor, "Before @attention");
    pressKey("Enter");
    editor.commands.insertContent("after");
    const link = await screen.findByRole("link", { name: PAPERS[0].title });
    expect(link.querySelector("[data-paper-citation]")).toHaveAttribute("contenteditable", "false");
    const from = editor.view.posAtDOM(link, 0);
    const to = editor.view.posAtDOM(link, link.childNodes.length);
    expect(to - from).toBe(1);
    editor.commands.setTextSelection(key === "Backspace" ? to : from);
    editor.registerPlugin(history());
    fireEvent.keyDown(editor.view.dom, { key });
    expect(markdown(editor).trimEnd()).toBe("Before  after");
    expect(editor.view.dom).not.toHaveTextContent(PAPERS[0].title);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(markdown(editor).trimEnd()).toBe("Before [Attention Is All You Need](.research/papers/1706.03762/paper.md) after");
  });

  it("restores atomic citations from Markdown without converting ordinary links", async () => {
    const source = "Before [Attention](../.research/papers/1706.03762/paper.md) and [Docs](https://example.com).";
    const editor = renderEditor("notes/reading.md", PAPERS, source);
    const citation = await screen.findByRole("link", { name: "Attention" });
    expect(citation.querySelector("[data-paper-citation]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Docs" }).querySelector("[data-paper-citation]")).toBeNull();
    expect(markdown(editor).trimEnd()).toBe(source);
    expect(editor.state.doc.textContent).toBe("Before Attention and Docs.");
    editor.commands.setTextSelection(editor.view.posAtDOM(citation, 0));
    fireEvent.keyDown(editor.view.dom, { key: "Delete" });
    expect(markdown(editor).trimEnd()).toBe("Before  and [Docs](https://example.com).");
  });

  it("edits the title and URL through the hover pencil, then removes the link as plain text", async () => {
    const editor = renderEditor("notes.md", PAPERS, "Before [Attention](.research/papers/1706.03762/paper.md) after");
    await openLinkEditor("Attention");
    const title = await screen.findByRole("textbox", { name: "Citation title" });
    expect(title).toHaveValue("Attention");
    fireEvent.change(title, { target: { value: "My reading notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), { target: { value: ".research/papers/1706.03762/blog.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(markdown(editor).trimEnd()).toBe("Before [My reading notes](.research/papers/1706.03762/blog.md) after");
    await openLinkEditor("My reading notes");
    await screen.findByRole("textbox", { name: "Citation title" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(markdown(editor).trimEnd()).toBe("Before My reading notes after");
    expect(editor.view.dom.querySelector("[data-paper-citation]")).toBeNull();
  });

  it("round-trips punctuation in paper titles and keeps the citation after HTML copy/paste", async () => {
    const papers = [{ ...PAPERS[0], title: "A [B] & C: *results*" }];
    const editor = renderEditor("notes.md", papers);
    await openMenu(editor, "@results");
    pressKey("Enter");
    const saved = markdown(editor);
    expect(getMarkdownManager().parse(saved).content?.[0]?.content?.[0]).toMatchObject({ type: "paperCitation", attrs: { label: papers[0].title } });
    editor.commands.setContent(editor.getHTML());
    expect(markdown(editor)).toBe(saved);
    expect(editor.view.dom.querySelector("[data-paper-citation]")).toHaveTextContent(papers[0].title);
  });

  it("cancels title edits and only converts to an ordinary link for a safe external URL", async () => {
    const source = "[Attention](.research/papers/1706.03762/paper.md)";
    const editor = renderEditor("notes.md", PAPERS, source);
    await openLinkEditor("Attention");
    const title = await screen.findByRole("textbox", { name: "Citation title" });
    fireEvent.change(title, { target: { value: "Cancelled" } });
    fireEvent.keyDown(title, { key: "Escape" });
    expect(markdown(editor).trimEnd()).toBe(source);
    await openLinkEditor("Attention");
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(markdown(editor).trimEnd()).toBe(source);
    fireEvent.change(url, { target: { value: "https://example.com/paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(markdown(editor).trimEnd()).toBe("[Attention](https://example.com/paper)");
    expect(editor.view.dom.querySelector("[data-paper-citation]")).toBeNull();
  });

  it("lists all matches and lets keyboard navigation select beyond the eighth paper", async () => {
    const papers = Array.from({ length: 12 }, (_, index) => ({
      title: `Research paper ${index + 1}`,
      arxivId: `2401.${String(index + 1).padStart(5, "0")}`,
      hasFullText: true,
      hasBlog: false,
    }));
    const editor = renderEditor("notes.md", papers);
    const menu = await openMenu(editor, "@");
    expect(within(menu).getAllByRole("option")).toHaveLength(12);
    expect(menu).not.toHaveTextContent("Showing top");
    expect(menu).toHaveAttribute("data-slot", "scroll-area-viewport");
    // jsdom has no layout/overflow; the shared ScrollArea mounts its thumb
    // only when the browser measures content taller than this viewport.
    expect(menu.closest('[data-slot="scroll-area"]')).toBeInTheDocument();
    for (let index = 0; index < 9; index += 1) pressKey("ArrowDown");
    await waitFor(() => expect(within(menu).getByRole("option", { selected: true })).toHaveTextContent("Research paper 10"));
    pressKey("Enter");
    await expectMarkdownToContain(editor, "[Research paper 10](.research/papers/2401.00010/paper.md)");
  });

  it("shows an empty state instead of stale options when nothing matches", async () => {
    const editor = renderEditor();
    await openMenu(editor, "@");
    editor.commands.insertContent("nonexistent-paper");
    expect(await screen.findByRole("status")).toHaveTextContent("No matching papers");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("opens on @, keeps one keyboard selection, accepts with Tab, then filters to the full text", async () => {
    const editor = renderEditor();
    const menu = await openMenu(editor, "@");
    expect(menu).toHaveTextContent("Attention Is All You Need");
    expect(menu).toHaveTextContent("An Image is Worth 16x16 Words");
    expect(menu).not.toHaveTextContent("Cited Only Work");
    const options = within(menu).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    pressKey("ArrowDown");
    await waitFor(() => expect(options[1]).toHaveAttribute("aria-selected", "true"));
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    pressKey("Tab");
    await expectMarkdownToContain(editor, "[An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)");
    const filtered = await openMenu(editor, " @");
    editor.commands.insertContent("attention");
    await waitFor(() => expect(filtered).not.toHaveTextContent("An Image is Worth 16x16 Words"));
    pressKey("Enter");
    await expectMarkdownToContain(editor, "[Attention Is All You Need](.research/papers/1706.03762/paper.md)");
  });

  it.each([
    ["a blog-only paper to its overview", "notes.md", "@image", /An Image is Worth/, "[An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)"],
    ["relative to a nested note", "notes/reading.md", "@attention", /Attention Is All/, "[Attention Is All You Need](../.research/papers/1706.03762/paper.md)"],
  ])("links %s via mouse selection", async (_name, activePath, typed, option, expected) => {
    const editor = renderEditor(activePath);
    fireEvent.mouseDown(within(await openMenu(editor, typed)).getByRole("option", { name: option }));
    await expectMarkdownToContain(editor, expected);
  });
});
