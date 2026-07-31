import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderHook, act } from "@testing-library/react";
import { OverleafChatPanel } from "./overleaf-chat";
import { useOverleafChat } from "./use-overleaf-chat";
import type { OverleafMessage } from "./app-types";

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
        messages={[message(), message({ id: "m2", content: "thanks!", mine: true, authorName: "Leo" })]}
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
        return { connected: true, email: "leo@uw.edu", name: "Leo", host: "https://www.overleaf.com" };
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
          authorName: "Leo",
          authorEmail: "LEO@uw.edu",
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
