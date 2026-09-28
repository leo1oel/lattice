import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, type ChatPanelMessage } from "./chat-panel";

const message = (overrides: Partial<ChatPanelMessage> = {}): ChatPanelMessage => ({
  id: "m1", authorKey: "ada", authorName: "Ada Lovelace", body: "Section 3 reads well now", at: 1_700_000_000_000, mine: false, ...overrides,
});

function renderPanel(messages: ChatPanelMessage[], onSend: (body: string) => Promise<void> | void = vi.fn()) {
  const panel = (next: ChatPanelMessage[]) => (
    <ChatPanel
      header={<p>About this chat</p>} messages={next} listClassName="test-chat-list" listLabel="Chat messages"
      emptyText="No messages yet" placeholder="Message everyone…" onSend={onSend}
    />
  );
  const view = render(panel(messages));
  const list = screen.getByRole("region", { name: "Chat messages" });
  let scrollHeight = 600;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  return {
    list,
    box: screen.getByLabelText("Message") as HTMLTextAreaElement,
    /** Scroll the list to `top`, as the reader would. */
    scrollTo: (top: number) => { list.scrollTop = top; fireEvent.scroll(list); },
    /** Re-render with `next`, the content having grown to `height`. */
    grow: (next: ChatPanelMessage[], height: number) => {
      scrollHeight = height;
      view.rerender(panel(next));
    },
  };
}

const reply = (id: string) => message({ id, body: `reply ${id}` });

afterEach(cleanup);

describe("ChatPanel", () => {
  it("shows the conversation, siding the viewer's own messages and grouping a quick run from one author", () => {
    renderPanel([
      message(),
      message({ id: "m2", at: 1_700_000_010_000, body: "second line" }),
      message({ id: "m3", body: "thanks!", authorKey: "me", authorName: "Robin", mine: true }),
    ]);
    expect(screen.getByText("About this chat")).toBeInTheDocument();
    expect(screen.getByText("Section 3 reads well now")).toBeInTheDocument();
    // The speaker's name is not repeated for the second message of the run.
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(1);
    expect(screen.getByText("second line").closest("article")).toHaveClass("grouped");
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("thanks!").closest("article")).toHaveClass("mine");
  });

  it("anchors the initial conversation history to the latest message", () => {
    const { list, grow } = renderPanel([]);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    grow([message()], 600);
    expect(list.scrollTop).toBe(600);
  });

  it("follows near the bottom, does not interrupt someone reading history, and offers a jump to the latest", () => {
    const { list, grow, scrollTo } = renderPanel([message()]);
    scrollTo(375);
    grow([message(), reply("m2")], 700);
    expect(list.scrollTop).toBe(700);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();

    scrollTo(120);
    grow([message(), reply("m2"), reply("m3")], 800);
    expect(list.scrollTop).toBe(120);

    const jump = screen.getByRole("button", { name: "New messages · Jump to latest" });
    fireEvent.click(jump);
    expect(list.scrollTop).toBe(800);
    expect(list).toHaveFocus();
    expect(jump).not.toBeInTheDocument();

    grow([message(), reply("m2"), reply("m3"), reply("m4")], 900);
    expect(list.scrollTop).toBe(900);

    // Resetting the conversation clears the unread-history state.
    scrollTo(120);
    grow([message(), reply("m2"), reply("m3"), reply("m4"), reply("m5")], 1_000);
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();
    grow([], 1_000);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("sends on Enter and clears the draft, never on Shift+Enter or mid-composition, and keeps a failed draft", async () => {
    const onSend = vi.fn();
    const { box } = renderPanel([], onSend);
    fireEvent.change(box, { target: { value: "on it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("on it");
    await waitFor(() => expect(box.value).toBe(""));

    fireEvent.change(box, { target: { value: "你好" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    // An open candidate window (isComposing, or keyCode 229 on Safari) owns Enter.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("你好");
    await waitFor(() => expect(box.value).toBe(""));

    onSend.mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(box, { target: { value: "still here" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("still here"));
    expect(box.value).toBe("still here");
  });
});
