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
});
