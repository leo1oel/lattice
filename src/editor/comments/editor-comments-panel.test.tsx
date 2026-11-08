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

  it("draws an empty list as a desk object with a title, and a file picker only with no file open", () => {
    const onOpenFile = vi.fn();
    const panel = (open: (() => void) | undefined) => (
      <EditorCommentsPanel
        embedded comments={[]} activePath="chapters/intro.tex" onOpenFile={open}
        currentAuthorId="ada" onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()}
        onUpdateBody={vi.fn()} onReply={vi.fn()}
      />
    );
    const { container, rerender } = render(panel(undefined));
    const empty = screen.getByText("No annotations yet").closest<HTMLElement>("[data-slot='empty-state']")!;
    expect(empty).toHaveAttribute("data-fill");
    expect(empty.querySelector("svg.research-art")).toHaveAttribute("data-kind", "annotation-flags");
    // Beside the file being written there is nowhere to go back to.
    expect(container.querySelector("button")).toBeNull();
    rerender(panel(onOpenFile));
    fireEvent.click(screen.getByRole("button", { name: "Open a file" }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the way back out of a list that has comments", () => {
    const comment = createEditorComment({
      path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Tighten this", authorId: "ada", authorName: "Ada",
    })!;
    render(
      <EditorCommentsPanel
        embedded comments={[{ ...comment, resolved: true }]} activePath="main.tex" onOpenFile={vi.fn()}
        currentAuthorId="ada" onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()}
        onUpdateBody={vi.fn()} onReply={vi.fn()}
      />,
    );
    // With every note settled, the empty Open list fills the panel and centres, its drawing a page of checked pins.
    const empty = screen.getByText("No open annotations").closest<HTMLElement>("[data-slot='empty-state']")!;
    expect(empty).toHaveAttribute("data-fill");
    expect(empty).toHaveAttribute("data-align", "center");
    expect(empty.querySelector(".empty-illustration")).toHaveAttribute("data-kind", "annotations-clear");
    expect(screen.queryByRole("button", { name: "Open a file" })).not.toBeInTheDocument();
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

  it("names itself only by its tab, sets a quote's math and LaTeX as the PDF does, and places a note by its source line", () => {
    const source = "Intro.\n\nThe factor $1/\\sqrt{d_k}$ controls score magnitude~\\cite{vaswani}.";
    const from = source.indexOf("The");
    const comment = createEditorComment({
      path: "main.tex", source, from, to: source.length, body: "Why?", authorId: "ada", authorName: "Ada",
    })!;
    render(
      <EditorCommentsPanel
        comments={[{ ...comment, number: 5, pdf: { page: 1, rects: [] } as never }]} activePath="notes.md" currentAuthorId="ada"
        sourceFor={(path) => (path === "main.tex" ? source : undefined)}
        onClose={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} onToggleResolved={vi.fn()} onUpdateBody={vi.fn()} onReply={vi.fn()}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Annotations" })).toBeNull();
    const quote = document.querySelector(".annotation-card-quote")!;
    expect(quote.textContent).toBe("The factor 1/√dk controls score magnitude [vaswani].");
    expect(quote.querySelector(".annotation-card-math sub")).toHaveTextContent("k");
    expect(document.querySelector(".annotation-card-where")).toHaveTextContent("main.tex:3");
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
