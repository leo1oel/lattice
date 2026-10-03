import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorCommentsPanel } from "./editor-comments-panel";
import { createEditorComment } from "./editor-comment-data";
import { activateAppLocale } from "../../i18n";

describe("EditorCommentsPanel", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("puts Edit's caret at the end of the comment, and Escape cancels it", () => {
    const comment = createEditorComment({
      path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Tighten this", authorId: "ada", authorName: "Ada",
    })!;
    const onUpdateBody = vi.fn();
    render(
      <EditorCommentsPanel
        embedded comments={[comment]} activePath="main.tex" currentAuthorId="ada"
        onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()} onUpdateBody={onUpdateBody} onReply={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByPlaceholderText("Update comment…") as HTMLTextAreaElement;
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([12, 12]);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Update comment…")).toBeNull();
    expect(onUpdateBody).not.toHaveBeenCalled();
  });

  it("offers the way back to the writing file from an empty list, and a file picker with none open", () => {
    const onReturnToEditor = vi.fn();
    const panel = (writingFile: string | null) => (
      <EditorCommentsPanel
        embedded comments={[]} activePath={writingFile} writingFile={writingFile} onReturnToEditor={onReturnToEditor}
        currentAuthorId="ada" onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()}
        onUpdateBody={vi.fn()} onReply={vi.fn()}
      />
    );
    const { rerender } = render(panel("chapters/intro.tex"));
    expect(screen.getByText("No comments yet. Select text in the editor and click Comment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to intro.tex" }));
    expect(onReturnToEditor).toHaveBeenCalledTimes(1);
    rerender(panel(null));
    expect(screen.getByText("No comments yet. Open a file, select text and click Comment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open a file" }));
    expect(onReturnToEditor).toHaveBeenCalledTimes(2);
  });

  it("keeps the way back out of a list that has comments", () => {
    const comment = createEditorComment({
      path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Tighten this", authorId: "ada", authorName: "Ada",
    })!;
    render(
      <EditorCommentsPanel
        embedded comments={[{ ...comment, resolved: true }]} activePath="main.tex" writingFile="main.tex" onReturnToEditor={vi.fn()}
        currentAuthorId="ada" onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()}
        onUpdateBody={vi.fn()} onReply={vi.fn()}
      />,
    );
    expect(screen.getByText("No open comments")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Return to/ })).not.toBeInTheDocument();
  });
});
