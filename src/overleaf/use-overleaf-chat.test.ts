import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockInvoke, mockListen } from "../platform/tauri-test-mocks";
import { useOverleafChat } from "./use-overleaf-chat";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const history = { id: "m1", content: "Section 3 reads well now", authorName: "Ada Lovelace", authorEmail: "ada@example.edu", timestamp: 1_700_000_000_000, mine: false };

describe("useOverleafChat", () => {
  it("appends realtime messages once, and marks our own as ours", async () => {
    const emit = mockListen();
    mockInvoke({
      overleaf_status: { connected: true, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" },
      overleaf_chat_messages: [history],
    });
    const { result } = renderHook(() => useOverleafChat({ enabled: true, projectRoot: "/tmp/project" }));
    await act(() => result.current.refresh());
    expect(result.current.messages).toHaveLength(1);

    const pushed = (id: string, authorEmail: string) => ({
      type: "chatMessage", id, content: "pushed the figures", authorName: "Ada", authorEmail, timestamp: 1_700_000_100_000,
    });
    emit(pushed("m2", "ada@example.edu"));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].mine).toBe(false);
    expect(result.current.unread).toBe(1);

    // The same message again — a reconnect replay — must not double up.
    emit(pushed("m2", "ada@example.edu"));
    expect(result.current.messages).toHaveLength(2);

    // Our own echo is ours, and never counts as unread.
    emit(pushed("m3", "RESEARCHER@example.edu"));
    expect(result.current.messages[2].mine).toBe(true);
    expect(result.current.unread).toBe(1);

    act(() => result.current.markRead());
    expect(result.current.unread).toBe(0);
  });
});
