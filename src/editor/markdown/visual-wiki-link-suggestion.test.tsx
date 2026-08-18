/*
 * Tests for code adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/extensions/wiki-link-suggestion.ts,
 * packages/app/src/editor/wiki-link-suggestion/WikiLinkSuggestionMenu.tsx.
 * Modified 2026-08-04 for Research Writer's visual editor test harness.
 * Licensed under GPL-3.0-or-later.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../app-types";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager } from "./visual-markdown-schema";

const contents: Record<string, string> = {
  "notes.md": "# Notes",
  "TargetDoc.md": "# Target title\n## Installation Guide\n### Details",
  "other.md": "# Other page\n## Background",
};

function file(path: string): FileNode {
  return { name: path, path, kind: "file", contentKind: "text", children: [] };
}

let index: MarkdownWorkspaceIndex;

beforeEach(async () => {
  index = new MarkdownWorkspaceIndex(async (path) => contents[path]);
  await index.update(Object.keys(contents).map(file));
});
afterEach(cleanup);

function renderEditor(text = "", onOpenProjectPath = vi.fn()) {
  const result = render(<VisualMarkdownEditor text={text} activePath="notes.md" workspaceIndex={index} onOpenProjectPath={onOpenProjectPath} onChangeMarkdown={() => true} onUndo={() => false} onRedo={() => false} />);
  const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
  return { ...result, surface, editor: (surface as HTMLElement & { editor: Editor }).editor, onOpenProjectPath };
}

function markdown(editor: Editor) {
  return getMarkdownManager().serialize(editor.getJSON());
}

describe("visual wiki-link suggestion", () => {
  it("opens on [[, filters pages, and inserts the selected page", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("[[").run();
    const menu = await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    expect(menu).toHaveTextContent("Target title");
    editor.commands.insertContent("Target");
    await waitFor(() => expect(menu).toHaveTextContent("Target title"));
    expect(menu).not.toHaveTextContent("Other page");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(markdown(editor)).toContain("[[TargetDoc]]"));
  });

  it("lists and inserts a page heading after #", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("[[TargetDoc#Install").run();
    const menu = await screen.findByRole("listbox", { name: "Heading suggestions" });
    expect(menu).toHaveTextContent("Installation Guide");
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /Installation Guide/ }));
    await waitFor(() => expect(markdown(editor)).toContain("[[TargetDoc#installation-guide]]"));
  });

  it("creates an unresolved wiki link for a query with no match", async () => {
    const { editor } = renderEditor();
    editor.chain().focus().insertContent("[[NewPage").run();
    const menu = await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    const create = within(menu).getByRole("option", { name: /Create "NewPage"/ });
    expect(create).toBeInTheDocument();
    fireEvent.mouseDown(create);
    await waitFor(() => expect(markdown(editor)).toContain("[[NewPage]]"));
    expect(editor.view.dom.querySelector("[data-wiki-link]")).toHaveAttribute("data-resolved", "false");
  });

  it("unmounts an open suggestion without a React removeChild error", async () => {
    const { editor, unmount } = renderEditor();
    editor.chain().focus().insertContent("[[").run();
    await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    expect(() => unmount()).not.toThrow();
  });

  it("opens the indexed path on meta-click", () => {
    const onOpenProjectPath = vi.fn();
    const { surface } = renderEditor("[[TargetDoc]]", onOpenProjectPath);
    fireEvent.click(surface.querySelector("[data-wiki-link]")!, { metaKey: true });
    expect(onOpenProjectPath).toHaveBeenCalledWith("TargetDoc.md");
  });
});
