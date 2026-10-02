import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverleafCommentsPanel } from "./overleaf-comments";
import type { OverleafCommentAnchor } from "./use-overleaf-comments";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { OverleafComment, OverleafThread } from "../app-types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

const message = (overrides: Partial<OverleafComment> = {}): OverleafComment => ({
  id: "c1", content: "This claim needs a citation", authorName: "Ada Lovelace", authorEmail: "ada@example.edu",
  timestamp: 1_700_000_000_000, mine: false, ...overrides,
});
const thread = (overrides: Partial<OverleafThread> = {}): OverleafThread => ({
  id: "t1", messages: [message()], resolved: false, resolvedBy: null, resolvedAt: null, ...overrides,
});
const anchor = (overrides: Partial<OverleafCommentAnchor> = {}): OverleafCommentAnchor => ({
  threadId: "t1", docId: "doc-open", position: 42, quote: "state of the art", ...overrides,
});

const anchorsByThreadId = (list: OverleafCommentAnchor[]) => new Map(list.map((item) => [item.threadId, item]));
const resolves = () => vi.fn().mockResolvedValue(undefined);

const panel = (overrides: Partial<Parameters<typeof OverleafCommentsPanel>[0]> = {}) => (
  <OverleafCommentsPanel
    threads={[thread()]} anchors={anchorsByThreadId([anchor()])} activeDocId="doc-open" pathForDoc={() => null}
    loading={false} error={null} onReply={resolves()} onResolve={resolves()} onDelete={resolves()}
    onEditMessage={resolves()} onDeleteMessage={resolves()} onReveal={vi.fn()} {...overrides}
  />
);

describe("Overleaf comments panel", () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(confirm).mockReset();
  });

  it("quotes each commented span under its file's heading and reveals it, opening its file, when clicked", () => {
    const onReveal = vi.fn();
    const paths: Record<string, string> = { "doc-open": "chapters/intro.tex", "doc-other": "chapters/methods.tex" };
    render(panel({
      threads: [thread({ id: "t1" }), thread({ id: "t2", messages: [message({ content: "Fix this too" })] })],
      anchors: anchorsByThreadId([
        anchor({ threadId: "t1", docId: "doc-open" }),
        anchor({ threadId: "t2", docId: "doc-other", position: 7, quote: "second file quote" }),
      ]),
      pathForDoc: (id) => paths[id] ?? null,
      onReveal,
    }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByText("In this file")).toBeInTheDocument();
    // A thread from another file is grouped under that file's own heading, with its quote.
    expect(screen.getByText("chapters/methods.tex")).toBeInTheDocument();
    expect(screen.getByText("second file quote")).toBeInTheDocument();
    expect(screen.getByText("Fix this too")).toBeInTheDocument();
    fireEvent.click(screen.getByText("state of the art"));
    expect(onReveal).toHaveBeenCalledWith("chapters/intro.tex", 42);
  });

  it("reveals a resolved inline-reply target and opens its reply composer", () => {
    render(panel({ threads: [thread({ resolved: true })], focusThreadId: "t1" }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveFocus();
  });

  it("replies on Enter (never mid-IME-composition) and resolves through the callbacks", async () => {
    const onReply = resolves();
    const onResolve = resolves();
    render(panel({ onReply, onResolve }));

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "半" } });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onReply).not.toHaveBeenCalled();
    // The real Enter that commits the composed text still sends.
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("t1", "半"));

    fireEvent.click(await screen.findByRole("button", { name: /Resolve/ }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("t1", true));
  });

  // `useOverleafComments` is what actually looks up the right document id
  // (see use-overleaf-comments.test.ts) — from the panel's side, the bug was
  // that acting on a thread from another file was blocked or ignored just
  // because that file was not open. These check the panel dispatches the
  // same way regardless of which file the thread's anchor points at.
  it("resolves and deletes a thread anchored in another (unopened) file exactly like one in the open file", async () => {
    const onResolve = resolves();
    const onDelete = resolves();
    render(panel({
      threads: [thread({ id: "t2" })],
      anchors: anchorsByThreadId([anchor({ threadId: "t2", docId: "doc-other-file" })]),
      pathForDoc: (id) => (id === "doc-other-file" ? "elsewhere.tex" : null),
      onResolve,
      onDelete,
    }));
    fireEvent.click(screen.getByRole("button", { name: /Resolve/ }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("t2", true));
    const remove = screen.getByRole("button", { name: /^Delete$/ });
    // Cancelling the warning deletes nothing.
    vi.mocked(confirm).mockResolvedValueOnce(false);
    fireEvent.click(remove);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete this discussion?"), expect.anything()));
    expect(onDelete).not.toHaveBeenCalled();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    fireEvent.click(remove);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("t2"));
  });

  it("hides resolved threads until asked to include them", () => {
    render(panel({
      threads: [thread({ id: "t2", resolved: true, resolvedBy: "Robin" })],
      anchors: anchorsByThreadId([anchor({ threadId: "t2", docId: "doc-open" })]),
    }));
    expect(screen.queryByText("This claim needs a citation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All (1)" }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByText(/Resolved by Robin/)).toBeInTheDocument();
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

  it("offers edit and delete on your own messages only, editing the one clicked inline and saving on Enter", async () => {
    const onEditMessage = resolves();
    render(panel({
      threads: [thread({
        messages: [
          message({ id: "m1", mine: true, content: "Mine first" }),
          message({ id: "m2", mine: false, content: "Theirs" }),
          message({ id: "m3", mine: true, content: "Mine second" }),
        ],
      })],
      onEditMessage,
    }));
    expect(screen.getAllByRole("button", { name: "Edit message" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete message" })).toHaveLength(2);
    const messageOf = (text: string) => screen.getByText(text).closest(".overleaf-thread-message") as HTMLElement;
    expect(within(messageOf("Theirs")).queryByRole("button", { name: "Edit message" })).toBeNull();
    fireEvent.click(within(messageOf("Mine second")).getByRole("button", { name: "Edit message" }));
    const box = screen.getByLabelText("Edit message text");
    expect(box).toHaveValue("Mine second");
    fireEvent.change(box, { target: { value: "Corrected text" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onEditMessage).toHaveBeenCalledWith("t1", "m3", "Corrected text"));
    // Saving closes the editor and puts the "Edit" action back, not a stuck textbox.
    expect(screen.queryByLabelText("Edit message text")).not.toBeInTheDocument();
  });

  it.each([
    ["deletes a message that is not the only one without warning about the thread", true, "Delete this message?",
      [message({ id: "m0", mine: false, content: "First" }), message({ id: "m1", mine: true, content: "Second, mine" })]],
    // Declining must not call through, whatever the warning said.
    ["warns that deleting the only message deletes the whole thread, and does not delete silently", false,
      "Delete this message? It's the only one in the thread, so this deletes the whole thread.",
      [message({ id: "m1", mine: true, content: "Only message" })]],
  ])("%s", async (_label, confirmed, warning, messages) => {
    const onDeleteMessage = resolves();
    vi.mocked(confirm).mockResolvedValue(confirmed);
    render(panel({ threads: [thread({ messages })], onDeleteMessage }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    expect(confirm).toHaveBeenCalledWith(warning, expect.anything());
    if (confirmed) await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith("t1", "m1"));
    else expect(onDeleteMessage).not.toHaveBeenCalled();
  });
});
