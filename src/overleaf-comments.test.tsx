import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverleafCommentsPanel } from "./overleaf-comments";
import { anchorsByThreadId, type OverleafCommentAnchor } from "./overleaf-comment-anchors";
import type { OverleafComment, OverleafThread } from "./app-types";

function message(overrides: Partial<OverleafComment> = {}): OverleafComment {
  return {
    id: "c1",
    content: "This claim needs a citation",
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.edu",
    timestamp: 1_700_000_000_000,
    mine: false,
    ...overrides,
  };
}

function thread(overrides: Partial<OverleafThread> = {}): OverleafThread {
  return {
    id: "t1",
    messages: [message()],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  };
}

function anchor(overrides: Partial<OverleafCommentAnchor> = {}): OverleafCommentAnchor {
  return { threadId: "t1", docId: "doc-open", position: 42, quote: "state of the art", ...overrides };
}

function panel(overrides: Partial<Parameters<typeof OverleafCommentsPanel>[0]> = {}) {
  return (
    <OverleafCommentsPanel
      threads={[thread()]}
      anchors={anchorsByThreadId([anchor()])}
      activeDocId="doc-open"
      pathForDoc={() => null}
      loading={false}
      error={null}
      onReply={vi.fn().mockResolvedValue(undefined)}
      onResolve={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onEditMessage={vi.fn().mockResolvedValue(undefined)}
      onDeleteMessage={vi.fn().mockResolvedValue(undefined)}
      onReveal={vi.fn()}
      {...overrides}
    />
  );
}

describe("Overleaf comments panel", () => {
  beforeEach(cleanup);

  it("quotes the commented span and reveals it, opening its file, when clicked", () => {
    const onReveal = vi.fn();
    render(panel({
      pathForDoc: (id) => (id === "doc-open" ? "chapters/intro.tex" : null),
      onReveal,
    }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByText("In this file")).toBeInTheDocument();
    fireEvent.click(screen.getByText("state of the art"));
    expect(onReveal).toHaveBeenCalledWith("chapters/intro.tex", 42);
  });

  it("groups a thread from another file under that file's own heading, with its quote", () => {
    render(panel({
      threads: [thread({ id: "t1" }), thread({ id: "t2", messages: [message({ content: "Fix this too" })] })],
      anchors: anchorsByThreadId([
        anchor({ threadId: "t1", docId: "doc-open" }),
        anchor({ threadId: "t2", docId: "doc-other", position: 7, quote: "second file quote" }),
      ]),
      pathForDoc: (id) => (id === "doc-other" ? "chapters/methods.tex" : null),
    }));
    expect(screen.getByText("In this file")).toBeInTheDocument();
    expect(screen.getByText("chapters/methods.tex")).toBeInTheDocument();
    expect(screen.getByText("second file quote")).toBeInTheDocument();
    expect(screen.getByText("Fix this too")).toBeInTheDocument();
  });

  it("replies on Enter and resolves through the callbacks", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(panel({ onReply, onResolve }));

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "added it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("t1", "added it"));

    fireEvent.click(await screen.findByRole("button", { name: /Resolve/ }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("t1", true));
  });

  it("does not send Enter while an IME composition is in progress", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    render(panel({ onReply }));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "半" } });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onReply).not.toHaveBeenCalled();
    // The real Enter that commits the composed text still sends.
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("t1", "半"));
  });

  // `useOverleafComments` is what actually looks up the right document id
  // (see use-overleaf-comments.test.ts) — from the panel's side, the bug was
  // that acting on a thread from another file was blocked or ignored just
  // because that file was not open. These check the panel dispatches the
  // same way regardless of which file the thread's anchor points at.
  it("resolves a thread anchored in another (unopened) file exactly like one in the open file", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(panel({
      threads: [thread({ id: "t2" })],
      anchors: anchorsByThreadId([anchor({ threadId: "t2", docId: "doc-other-file" })]),
      activeDocId: "doc-open",
      pathForDoc: (id) => (id === "doc-other-file" ? "elsewhere.tex" : null),
      onResolve,
    }));
    const resolveButton = screen.getByRole("button", { name: /Resolve/ });
    expect(resolveButton).toBeEnabled();
    fireEvent.click(resolveButton);
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("t2", true));
  });

  it("deletes a thread anchored in another (unopened) file exactly like one in the open file", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(panel({
      threads: [thread({ id: "t2" })],
      anchors: anchorsByThreadId([anchor({ threadId: "t2", docId: "doc-other-file" })]),
      activeDocId: "doc-open",
      pathForDoc: (id) => (id === "doc-other-file" ? "elsewhere.tex" : null),
      onDelete,
    }));
    const deleteButton = screen.getByRole("button", { name: /Delete/ });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("t2"));
  });

  it("hides resolved threads until asked to include them", () => {
    render(panel({
      threads: [thread({ id: "t2", resolved: true, resolvedBy: "Leo" })],
      anchors: anchorsByThreadId([anchor({ threadId: "t2", docId: "doc-open" })]),
    }));
    expect(screen.queryByText("This claim needs a citation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Include resolved/ }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByText(/Resolved by Leo/)).toBeInTheDocument();
  });

  it("an orphaned thread — no anchor at all — explains itself and cannot be resolved or deleted", () => {
    render(panel({
      threads: [thread({ id: "t2", messages: [message({ content: "Orphan comment" })] })],
      anchors: new Map(),
    }));
    expect(screen.getByText("No longer in the document")).toBeInTheDocument();
    expect(screen.getByText(/Its text was deleted from the document/)).toBeInTheDocument();
    expect(screen.queryByText("state of the art")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resolve/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
    // Replying is unaffected — an orphaned thread can still be discussed.
    expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled();
  });

  it("offers edit and delete on your own message", () => {
    render(panel({
      threads: [thread({ messages: [message({ id: "m1", mine: true, content: "My own note" })] })],
    }));
    expect(screen.getByRole("button", { name: "Edit message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete message" })).toBeInTheDocument();
  });

  it("offers neither edit nor delete on someone else's message", () => {
    render(panel({
      threads: [thread({ messages: [message({ id: "m1", mine: false, content: "Someone else's note" })] })],
    }));
    expect(screen.queryByRole("button", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  });

  it("edits your own message inline and saves on Enter", async () => {
    const onEditMessage = vi.fn().mockResolvedValue(undefined);
    render(panel({
      threads: [thread({ messages: [message({ id: "m1", mine: true, content: "Original text" })] })],
      onEditMessage,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const box = screen.getByLabelText("Edit message text");
    expect(box).toHaveValue("Original text");
    fireEvent.change(box, { target: { value: "Corrected text" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onEditMessage).toHaveBeenCalledWith("t1", "m1", "Corrected text"));
    // Saving closes the editor and puts the "Edit" action back, not a stuck textbox.
    expect(screen.queryByLabelText("Edit message text")).not.toBeInTheDocument();
  });

  it("deletes a message that is not the only one without warning about the thread", async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(panel({
      threads: [thread({
        messages: [
          message({ id: "m1", mine: false, content: "First" }),
          message({ id: "m2", mine: true, content: "Second, mine" }),
        ],
      })],
      onDeleteMessage,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    expect(confirmSpy).toHaveBeenCalledWith("Delete this message?");
    await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith("t1", "m2"));
    confirmSpy.mockRestore();
  });

  it("warns that deleting the only message deletes the whole thread, and does not delete silently", async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(panel({
      threads: [thread({ messages: [message({ id: "m1", mine: true, content: "Only message" })] })],
      onDeleteMessage,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Delete this message? It's the only one in the thread, so this deletes the whole thread.",
    );
    // Declining the confirm must not call through.
    expect(onDeleteMessage).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("scopes edit/delete to the message they were clicked on when a thread has several", () => {
    render(panel({
      threads: [thread({
        messages: [
          message({ id: "m1", mine: true, content: "Mine first" }),
          message({ id: "m2", mine: false, content: "Theirs" }),
          message({ id: "m3", mine: true, content: "Mine second" }),
        ],
      })],
    }));
    const editButtons = screen.getAllByRole("button", { name: "Edit message" });
    expect(editButtons).toHaveLength(2);
    const secondMineArticle = screen.getByText("Mine second").closest(".overleaf-thread-message");
    expect(secondMineArticle).not.toBeNull();
    fireEvent.click(within(secondMineArticle as HTMLElement).getByRole("button", { name: "Edit message" }));
    expect(screen.getByLabelText("Edit message text")).toHaveValue("Mine second");
  });
});
