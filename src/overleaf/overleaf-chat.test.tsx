import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderHook, act } from "@testing-library/react";
import { OverleafChatPanel } from "./overleaf-chat";
import { useOverleafChat } from "./use-overleaf-chat";
import type { OverleafMessage } from "../app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function message(overrides: Partial<OverleafMessage> = {}): OverleafMessage {
  return {
    id: "m1",
    content: "Section 3 reads well now",
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.edu",
    timestamp: 1_700_000_000_000,
    mine: false,
    ...overrides,
  };
}

describe("Overleaf chat panel", () => {
  beforeEach(cleanup);

  it("shows the conversation and sends on Enter", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <OverleafChatPanel
        projectName="Attention Paper"
        messages={[message(), message({ id: "m2", content: "thanks!", mine: true, authorName: "Robin" })]}
        loading={false}
        error={null}
        onSend={onSend}
      />,
    );
    expect(screen.getByText("Section 3 reads well now")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // Our own messages are labelled and sided rather than repeating our name.
    expect(screen.getByText("You")).toBeInTheDocument();

    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "on it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("on it"));
    // Sent text clears; Shift+Enter must not send.
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <OverleafChatPanel
        projectName="Attention Paper"
        messages={[]}
        loading={false}
        error="Could not reach Overleaf"
        onSend={onSend}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach Overleaf");
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "still here" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect((box as HTMLTextAreaElement).value).toBe("still here");
  });

  it("anchors the initial conversation history to the latest message", () => {
    const props = {
      projectName: "Attention Paper",
      error: null,
      onSend: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(
      <OverleafChatPanel {...props} messages={[]} loading />,
    );
    const list = document.querySelector(".overleaf-chat-list") as HTMLDivElement;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 600 });

    rerender(<OverleafChatPanel {...props} messages={[message()]} loading={false} />);

    expect(list.scrollTop).toBe(600);
  });

  it("does not interrupt someone reading history when a new message arrives", () => {
    const props = {
      projectName: "Attention Paper",
      loading: false,
      error: null,
      onSend: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<OverleafChatPanel {...props} messages={[message()]} />);
    const list = document.querySelector(".overleaf-chat-list") as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 120;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <OverleafChatPanel
        {...props}
        messages={[message(), message({ id: "m2", content: "A new reply" })]}
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
      <OverleafChatPanel
        {...props}
        messages={[
          message(),
          message({ id: "m2", content: "A new reply" }),
          message({ id: "m3", content: "Another reply" }),
        ]}
      />,
    );
    expect(list.scrollTop).toBe(800);
  });

  it("clears the unread-history state when the conversation is reset", () => {
    const props = {
      projectName: "Attention Paper",
      loading: false,
      error: null,
      onSend: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<OverleafChatPanel {...props} messages={[message()]} />);
    const list = screen.getByRole("region", { name: "Overleaf chat messages" });
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 120;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <OverleafChatPanel
        {...props}
        messages={[message(), message({ id: "m2", content: "A new reply" })]}
      />,
    );
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();

    rerender(<OverleafChatPanel {...props} messages={[]} />);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
    expect(screen.getByText("No messages yet. Say something and everyone in the project sees it.")).toBeInTheDocument();
  });

  it("continues following messages while the reader is near the bottom", () => {
    const props = {
      projectName: "Attention Paper",
      loading: false,
      error: null,
      onSend: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<OverleafChatPanel {...props} messages={[message()]} />);
    const list = document.querySelector(".overleaf-chat-list") as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    list.scrollTop = 375;
    fireEvent.scroll(list);
    scrollHeight = 700;
    rerender(
      <OverleafChatPanel
        {...props}
        messages={[message(), message({ id: "m2", content: "A new reply" })]}
      />,
    );

    expect(list.scrollTop).toBe(700);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument();
  });
});

describe("useOverleafChat", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("appends realtime messages once, and marks our own as ours", async () => {
    let emit: ((event: { payload: unknown }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      emit = handler as (event: { payload: unknown }) => void;
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") {
        return { connected: true, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" };
      }
      if (command === "overleaf_chat_messages") return [message()];
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useOverleafChat({
      enabled: true,
      projectRoot: "/tmp/project",
    }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      emit?.({
        payload: {
          type: "chatMessage",
          id: "m2",
          content: "pushed the figures",
          authorName: "Ada Lovelace",
          authorEmail: "ada@example.edu",
          timestamp: 1_700_000_100_000,
        },
      });
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].mine).toBe(false);
    expect(result.current.unread).toBe(1);

    // The same message again — a reconnect replay — must not double up.
    await act(async () => {
      emit?.({
        payload: {
          type: "chatMessage",
          id: "m2",
          content: "pushed the figures",
          authorName: "Ada Lovelace",
          authorEmail: "ada@example.edu",
          timestamp: 1_700_000_100_000,
        },
      });
    });
    expect(result.current.messages).toHaveLength(2);

    // Our own echo is ours, and never counts as unread.
    await act(async () => {
      emit?.({
        payload: {
          type: "chatMessage",
          id: "m3",
          content: "on it",
          authorName: "Robin",
          authorEmail: "RESEARCHER@example.edu",
          timestamp: 1_700_000_200_000,
        },
      });
    });
    expect(result.current.messages[2].mine).toBe(true);
    expect(result.current.unread).toBe(1);

    act(() => result.current.markRead());
    expect(result.current.unread).toBe(0);
  });
});
