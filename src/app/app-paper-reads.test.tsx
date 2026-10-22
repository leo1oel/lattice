import { type Commands, projectCommands, refreshableProject, attentionPaper, ROOT, projectSnapshot, markdownSnapshot, PAPER_ABSTRACT, readPathContent, deferred, papersList, openPaper, findProjectTreeItem, expectInvoked, invokeCalls, paneContent, visualEditorOf, fileNodes } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Opening a Paper while another document is open or another read is in
 * flight: the outgoing notes are saved and never written into the Paper, a
 * late read never replaces what the writer did since, and the last request wins.
 */
const { renderApp } = appHarness({ documentCanvas });

describe("paper reads", () => {
  // The outgoing notes must never be saved over the Paper being opened.
  const NOTES_INTO_PAPER = expect.objectContaining({
    path: ".research/papers/2407.06438/paper.md", content: expect.stringContaining("Original notes"),
  });

  /** Opens notes.md ("Original notes") in the visual editor beside the Paper `title`, returning that editor. */
  const renderNotesBesidePaper = async (title: string, commands: Commands) => {
    renderApp({
      ...refreshableProject(markdownSnapshot(), "Original notes"),
      list_papers: () => [{ arxivId: "2407.06438", title, hasFullText: true }], ...commands,
    });
    return visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
  };

  it("publishes the current visual document before opening a Paper", async () => {
    let resolveWrite: (() => void) | null = null;
    const editor = await renderNotesBesidePaper("Paper target", {
      read_paper: "# Paper body",
      write_project_file: () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " updated"));
    fireEvent.click(await screen.findByRole("button", { name: /Paper target.*2407\.06438/i }));
    expect(screen.getByText("Opening Paper target…")).toBeInTheDocument();
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    // The target Paper read is independent of writing the outgoing notes, so
    // both should be in flight rather than paying write latency first.
    expect(resolveWrite).not.toBeNull();
    act(() => resolveWrite?.());
    await waitFor(() => expect(vi.mocked(invoke).mock.calls).toContainEqual(["write_project_file", expect.objectContaining({
      path: "notes.md", content: expect.stringMatching(/Original notes[\s\S]*updated/), projectRoot: ROOT,
    })]));
    expect(await screen.findByRole("heading", { name: "Paper body" })).toBeInTheDocument();
    expect(screen.queryByText("Original notes updated")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps the current document when it is edited during a delayed Paper read", async () => {
    const paperRead = deferred<string>();
    const editor = await renderNotesBesidePaper("Delayed paper", { read_paper: () => paperRead.promise, write_project_file: undefined });
    fireEvent.click(await screen.findByRole("button", { name: /Delayed paper.*2407\.06438/i }));
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " late edit"));
    act(() => paperRead.resolve("# Paper must not replace the edit"));
    await act(async () => { await Promise.resolve(); });
    expect(editor.getText()).toMatch(/Original notes[\s\S]*late edit/);
    expect(screen.queryByRole("heading", { name: "Paper must not replace the edit" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps only the latest Paper when overlapping reads finish out of order", async () => {
    const paperResolvers = new Map<string, (value: string) => void>();
    renderApp({
      ...refreshableProject(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        { arxivId: "2407.06438", title: "First paper", hasFullText: true },
        { arxivId: "2103.00020", title: "Second paper", hasFullText: true },
      ],
      read_paper: (args) => new Promise<string>((resolve) => { paperResolvers.set((args as { arxivId: string }).arxivId, resolve); }),
    });
    await openPaper("First paper");
    await waitFor(() => expect(paperResolvers.has("2407.06438")).toBe(true));
    fireEvent.click(screen.getByTitle("Second paper"));
    await waitFor(() => expect(paperResolvers.has("2103.00020")).toBe(true));
    act(() => paperResolvers.get("2103.00020")?.("# Second body"));
    expect(await screen.findByRole("heading", { name: "Second body" })).toBeInTheDocument();
    act(() => paperResolvers.get("2407.06438")?.("# First body"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Second paper", { selector: ".active-document span" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second body" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First body" })).toBeNull();
  });

  it("cancels a pending Paper when the user opens a local file", async () => {
    const paperRead = deferred<string>();
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") })), read_project_file: readPathContent,
      list_papers: () => [{ arxivId: "2407.06438", title: "Delayed paper", hasFullText: true }],
      read_paper: () => paperRead.promise, read_paper_blog_local: null,
    });
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:main.tex"));
    await openPaper("Delayed paper");
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    expect(screen.getByText("Opening Delayed paper…")).toBeInTheDocument();
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:notes.md"));
    expect(screen.queryByText("Opening Delayed paper…")).toBeNull();
    act(() => paperRead.resolve("# Paper must stay closed"));
    await act(async () => { await Promise.resolve(); });
    expect(paneContent("primary")).toHaveTextContent("content:notes.md");
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { name: "Paper must stay closed" })).toBeNull();
  });

  it("remembers the selected paper content when reopening an article", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"), list_papers: () => [attentionPaper({ hasBlog: true })],
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: "# Attention overview\n\nBlog content.",
    });
    await openPaper("Attention Is All You Need");
    const paperContent = await screen.findByRole("tablist", { name: "Paper content" });
    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    await waitFor(() => expect(within(paperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    const paper = await (await papersList()).findByTitle("Attention Is All You Need");
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
    fireEvent.click(paper);
    await waitFor(() => expect(invokeCalls("read_paper")).toHaveLength(2));
    const reopenedPaperContent = await screen.findByRole("tablist", { name: "Paper content" });
    await waitFor(() => expect(within(reopenedPaperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
  });
});
