import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorCommentsPanel } from "./editor-comments-panel";
import { createEditorComment } from "./editor-comment-data";
import { activateAppLocale } from "../../i18n";
import { CONFIRM_MS, LEAVE_MS } from "./use-card-outcomes";

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
    const field = screen.getByPlaceholderText("Update annotation…") as HTMLTextAreaElement;
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([12, 12]);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Update annotation…")).toBeNull();
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
    expect(screen.getByText("No annotations yet. Select text in the editor or the PDF and click Annotate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to intro.tex" }));
    expect(onReturnToEditor).toHaveBeenCalledTimes(1);
    rerender(panel(null));
    expect(screen.getByText("No annotations yet. Open a file, select text and click Annotate")).toBeInTheDocument();
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
    expect(screen.getByText("No open annotations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Return to/ })).not.toBeInTheDocument();
  });

  describe("answers each action on the card", () => {
    const note = createEditorComment({
      path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Tighten this", authorId: "ada", authorName: "Ada",
    })!;
    const handlers = () => ({
      onClose: vi.fn(), onOpen: vi.fn(), onDelete: vi.fn(), onToggleResolved: vi.fn(), onUpdateBody: vi.fn(), onReply: vi.fn(),
    });
    const card = () => screen.getByRole("button", { name: /Tighten this/ }).closest("article")!;
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("plays a resolved card out of the open list before the change lands, and lists it again on undo", () => {
      const on = handlers();
      const { rerender } = render(<EditorCommentsPanel embedded comments={[note]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      const resolve = screen.getByRole("button", { name: "Resolve" });
      fireEvent.click(resolve);
      // The check holds its green plate and the card leaves; nothing has changed yet.
      expect(card()).toHaveAttribute("data-leaving");
      expect(resolve).toHaveAttribute("data-done");
      expect(resolve).toBeDisabled();
      expect(on.onToggleResolved).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(LEAVE_MS));
      expect(on.onToggleResolved).toHaveBeenCalledExactlyOnceWith(note);

      rerender(<EditorCommentsPanel embedded comments={[{ ...note, resolved: true }]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      expect(screen.getByText("No open annotations")).toBeInTheDocument();
      // The toast's undo reopens it (use-editor-comments); the card comes back whole.
      rerender(<EditorCommentsPanel embedded comments={[note]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      expect(card()).not.toHaveAttribute("data-leaving");
      expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
    });

    it("tints a card that stays in the list and says it was reopened, then settles", () => {
      const on = handlers();
      render(<EditorCommentsPanel embedded comments={[{ ...note, resolved: true }]} focusCommentId={null} activePath="main.tex" currentAuthorId="ada" {...on} />);
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
      expect(on.onToggleResolved).toHaveBeenCalledTimes(1);
      expect(card()).toHaveAttribute("data-outcome", "reopened");
      expect(screen.getByRole("status")).toHaveTextContent("Reopened");
      act(() => vi.advanceTimersByTime(CONFIRM_MS));
      expect(card()).not.toHaveAttribute("data-outcome");
    });

    it("says an edit was saved, and only when it changed", () => {
      const on = handlers();
      render(<EditorCommentsPanel embedded comments={[note]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(card()).not.toHaveAttribute("data-outcome");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByPlaceholderText("Update annotation…"), { target: { value: "Cut this" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(on.onUpdateBody).toHaveBeenLastCalledWith(note, "Cut this");
      expect(card()).toHaveAttribute("data-outcome", "saved");
    });

    it("brings a sent reply into the thread", () => {
      const on = handlers();
      const { rerender } = render(<EditorCommentsPanel embedded comments={[note]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      fireEvent.change(screen.getByPlaceholderText("Reply to Ada"), { target: { value: "Done" } });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      expect(on.onReply).toHaveBeenCalledWith(note, "Done");
      const reply = { id: "r1", body: "Done", authorId: "ada", authorName: "Ada", createdAt: "2026-10-22T00:00:00Z" };
      rerender(<EditorCommentsPanel embedded comments={[{ ...note, replies: [reply] }]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      expect(card()).toHaveAttribute("data-outcome", "replied");
      expect(screen.getByText("Done").closest(".editor-comment-reply")).toHaveAttribute("data-new");
    });

    it("plays a deleted card out before it goes", () => {
      const on = handlers();
      render(<EditorCommentsPanel embedded comments={[note]} activePath="main.tex" currentAuthorId="ada" {...on} />);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(card()).toHaveAttribute("data-leaving");
      expect(on.onDelete).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(LEAVE_MS));
      expect(on.onDelete).toHaveBeenCalledExactlyOnceWith(note.id);
    });
  });

  it("no longer says where annotations are stored", () => {
    const comment = createEditorComment({
      path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Tighten this", authorId: "ada", authorName: "Ada",
    })!;
    const snapshot = { running: new Set<string>(), reviewPdfReady: false };
    const rounds = {
      subscribe: () => () => {}, getSnapshot: () => snapshot,
      revise: vi.fn(), openReview: vi.fn(), retry: vi.fn(), answer: vi.fn(), openRounds: vi.fn(), openReviewPdf: vi.fn(),
    } as unknown as Parameters<typeof EditorCommentsPanel>[0]["annotationRounds"];
    render(
      <EditorCommentsPanel
        embedded comments={[comment]} activePath="main.tex" currentAuthorId="ada" annotationRounds={rounds}
        onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()} onUpdateBody={vi.fn()} onReply={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Revise from/ })).toBeInTheDocument();
    expect(screen.queryByText(/annotations\.json|no server/)).not.toBeInTheDocument();
  });
});
