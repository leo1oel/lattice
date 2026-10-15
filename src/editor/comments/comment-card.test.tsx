import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../../i18n";
import { CommentCard, CommentPreview } from "./comment-card";
import { createEditorComment, createEditorCommentReply, type EditorComment } from "./editor-comment-data";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function comment(overrides: Partial<EditorComment> = {}): EditorComment {
  return {
    ...createEditorComment({
      path: "main.tex", source: "alpha beta gamma", from: 6, to: 10, body: "please clarify", authorId: "ada", authorName: "Ada Lovelace",
    })!,
    createdAt: "2026-01-01T11:57:00.000Z",
    updatedAt: "",
    ...overrides,
  };
}

function renderCard(comments: EditorComment[], extra: Partial<Parameters<typeof CommentCard>[0]> = {}) {
  const props = {
    comments, author: { id: "me", name: "Me" }, now: NOW,
    onResolve: vi.fn(), onReply: vi.fn(), onClose: vi.fn(), onResolving: vi.fn(), ...extra,
  };
  render(<CommentCard {...props} />);
  return props;
}

describe("CommentCard", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows who, when and the note, with its replies, and no labelled Resolve or Reply buttons", () => {
    const item = { ...comment(), replies: [createEditorCommentReply({ body: "will do", authorId: "bo", authorName: "Bo" })!] };
    renderCard([item]);
    const card = screen.getByRole("dialog", { name: "Comment" });
    expect(within(card).getByTitle("Ada Lovelace")).toHaveTextContent("Ada Lovelace");
    expect(card).toHaveTextContent("3 min. ago");
    expect(card).toHaveTextContent("please clarify");
    expect(card).toHaveTextContent("will do");
    expect(within(card).getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Resolve comment" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Reply…" })).toBeInTheDocument();
  });

  it("leaves before it resolves: the check presses, the passage fades, then the resolve and the close land", () => {
    vi.useFakeTimers();
    const item = comment();
    const props = renderCard([item]);
    const resolve = screen.getByRole("button", { name: "Resolve" });
    fireEvent.click(resolve);
    expect(resolve).toHaveAttribute("data-done");
    expect(resolve).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-leaving");
    expect(props.onResolving).toHaveBeenCalledWith(item.id);
    expect(props.onResolve).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(props.onResolve).toHaveBeenCalledWith(item.id);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("resolves one thread of several in place, keeping the card", () => {
    vi.useFakeTimers();
    const first = comment();
    const second = comment({ id: "second", body: "another" });
    const props = renderCard([first, second]);
    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0]!);
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-leaving");
    act(() => vi.advanceTimersByTime(200));
    expect(props.onResolve).toHaveBeenCalledWith(first.id);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("opens the reply field in place, sends on Enter and shows the reply at once", () => {
    const item = comment();
    const props = renderCard([item]);
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    expect(props.onReplyStart).toBeUndefined();
    const field = screen.getByRole("textbox", { name: "Reply" });
    expect(field).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "on it" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onReply).toHaveBeenCalledWith(item.id, "on it");
    expect(field).toHaveValue("");
    expect(screen.getByRole("dialog")).toHaveTextContent("on it");
    expect(screen.getByRole("dialog")).toHaveTextContent("Me");
  });

  it("asks a hover card to pin itself when a reply starts, and opens pinned with the field", () => {
    const item = comment();
    const onReplyStart = vi.fn();
    renderCard([item], { onReplyStart });
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    expect(onReplyStart).toHaveBeenCalledWith(item.id);
    cleanup();
    renderCard([item], { replyingTo: item.id, still: true });
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveFocus();
    expect(screen.getByRole("dialog")).not.toHaveClass("popup-motion");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    // Pinned, it still leaves on the popup exit.
    expect(screen.getByRole("dialog")).toHaveClass("popup-motion");
  });

  it("closes on Esc, after first dropping a reply being written", () => {
    const props = renderCard([comment()]);
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    const field = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(field, { target: { value: "half a thought" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Reply…" }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("says who wrote it in Chinese, with the anonymous name and an empty note", async () => {
    await activateAppLocale("zh-CN");
    renderCard([comment({ authorName: "Anonymous", body: "" })]);
    const card = screen.getByRole("dialog");
    expect(card).toHaveTextContent("3分钟前");
    expect(card.textContent).not.toContain("Anonymous");
  });
});

describe("CommentPreview", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("shows the note and its first replies, counts the rest, and has nothing to press", () => {
    const replies = ["ok", "sure", "done"].map((body) => createEditorCommentReply({ body, authorId: "bo", authorName: "Bo" })!);
    render(<CommentPreview comments={[{ ...comment(), replies }]} now={NOW} />);
    expect(screen.getByText("please clarify")).toBeInTheDocument();
    expect(screen.getByText("sure")).toBeInTheDocument();
    expect(screen.queryByText("done")).toBeNull();
    expect(screen.getByText("1 more reply")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
