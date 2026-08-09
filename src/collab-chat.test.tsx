import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollabChatPanel } from "./collab-chat";
import type { CollabChatMessage } from "./collab-session";

function message(overrides: Partial<CollabChatMessage> = {}): CollabChatMessage {
  return {
    id: "m1",
    authorId: "guest-1",
    authorName: "Ada Lovelace",
    body: "Section 3 reads well now",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CollabChatPanel", () => {
  beforeEach(cleanup);

  it("shows the conversation, siding the viewer's own messages", () => {
    render(
      <CollabChatPanel
        messages={[message(), message({ id: "m2", body: "thanks!", authorId: "host-1", authorName: "Leo" })]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByText("Section 3 reads well now")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // Our own messages are labelled "You" rather than repeating our name.
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("shows the empty state when nobody has said anything yet", () => {
    render(<CollabChatPanel messages={[]} selfId="host-1" onSend={vi.fn()} />);
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument();
  });

  it("uses the hover-revealed scrollbar for the message list", () => {
    render(<CollabChatPanel messages={[]} selfId="host-1" onSend={vi.fn()} />);
    expect(document.querySelector(".collab-chat-list")).toHaveClass("native-hover-scrollbar");
  });

  it("anchors the initial conversation history to the latest message", () => {
    const { rerender } = render(
      <CollabChatPanel messages={[]} selfId="host-1" onSend={vi.fn()} />,
    );
    const list = document.querySelector(".collab-chat-list") as HTMLDivElement;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 600 });

    rerender(<CollabChatPanel messages={[message()]} selfId="host-1" onSend={vi.fn()} />);

    expect(list.scrollTop).toBe(600);
  });

  it("does not interrupt someone reading history when a new message arrives", () => {
    const { rerender } = render(
      <CollabChatPanel messages={[message()]} selfId="host-1" onSend={vi.fn()} />,
    );
    const list = document.querySelector(".collab-chat-list") as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 120;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <CollabChatPanel
        messages={[message(), message({ id: "m2", body: "A new reply" })]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );

    expect(list.scrollTop).toBe(120);
    const jump = screen.getByRole("button", { name: "New messages · Jump to latest" });
    fireEvent.click(jump);
    expect(list.scrollTop).toBe(700);
    expect(list).toHaveFocus();
    expect(jump).not.toBeInTheDocument();

    scrollHeight = 800;
    rerender(
      <CollabChatPanel
        messages={[
          message(),
          message({ id: "m2", body: "A new reply" }),
          message({ id: "m3", body: "Another reply" }),
        ]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );
    expect(list.scrollTop).toBe(800);
  });

  it("clears the unread-history state when the conversation is reset", () => {
    const { rerender } = render(
      <CollabChatPanel messages={[message()]} selfId="host-1" onSend={vi.fn()} />,
    );
    const list = screen.getByRole("region", { name: "Chat messages" });
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 120;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <CollabChatPanel
        messages={[message(), message({ id: "m2", body: "A new reply" })]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();

    rerender(<CollabChatPanel messages={[]} selfId="host-1" onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
    expect(screen.getByText("No messages yet. Say something and everyone in the room sees it.")).toBeInTheDocument();
  });

  it("continues following messages while the reader is near the bottom", () => {
    const { rerender } = render(
      <CollabChatPanel messages={[message()]} selfId="host-1" onSend={vi.fn()} />,
    );
    const list = document.querySelector(".collab-chat-list") as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 375;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <CollabChatPanel
        messages={[message(), message({ id: "m2", body: "A new reply" })]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );

    expect(list.scrollTop).toBe(700);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
  });

  it("sends on Enter, clears the draft, and never sends on Shift+Enter", async () => {
    const onSend = vi.fn();
    render(<CollabChatPanel messages={[]} selfId="host-1" onSend={onSend} />);

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "on it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("on it");
    await waitFor(() => expect(box.value).toBe(""));

    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("line one");
  });

  it("never sends while an IME composition is in progress", () => {
    const onSend = vi.fn();
    render(<CollabChatPanel messages={[]} selfId="host-1" onSend={onSend} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;

    // Candidate window open (isComposing true): Enter picks a candidate, it
    // must not also submit the message.
    fireEvent.change(box, { target: { value: "你好" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    // Safari/older browsers signal composition with keyCode 229 instead of
    // isComposing; the guard has to catch both.
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    // Once composition ends, a plain Enter must still work.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("你好");
  });

  it("does not repeat the speaker's name for a quick run of messages from the same author", () => {
    render(
      <CollabChatPanel
        messages={[
          message({ id: "m1", at: 1_700_000_000_000 }),
          message({ id: "m2", at: 1_700_000_010_000, body: "second line" }),
        ]}
        selfId="host-1"
        onSend={vi.fn()}
      />,
    );
    // The name/timestamp header renders once per run, not once per message.
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(1);
    expect(screen.getByText("second line")).toBeInTheDocument();
  });
});
