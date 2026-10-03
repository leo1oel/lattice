import { useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OverleafMessage } from "../app-types";
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
      projectRoot: "/tmp/project", type: "chatMessage", id, content: "pushed the figures", authorName: "Ada", authorEmail, timestamp: 1_700_000_100_000,
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

  it("keeps a late message from the previous project out of the next one", async () => {
    const emit = mockListen();
    mockInvoke({ overleaf_status: { connected: true, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" } });
    const { result, rerender } = renderHook(
      ({ projectRoot }) => useOverleafChat({ enabled: true, projectRoot }),
      { initialProps: { projectRoot: "/tmp/project-a" } },
    );
    rerender({ projectRoot: "/tmp/project-b" });

    // Queued by project A's connection before the switch cancelled it.
    emit({
      projectRoot: "/tmp/project-a", type: "chatMessage", id: "a-1", content: "project-A text",
      authorName: "Ada", authorEmail: "ada@example.edu", timestamp: 1_700_000_100_000,
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.unread).toBe(0);

    emit({
      projectRoot: "/tmp/project-b", type: "chatMessage", id: "b-1", content: "project-B text",
      authorName: "Ada", authorEmail: "ada@example.edu", timestamp: 1_700_000_200_000,
    });
    expect(result.current.messages.map((message) => message.content)).toEqual(["project-B text"]);
    expect(result.current.unread).toBe(1);
  });

  it("keeps a message out of the next project while the previous project's listener is still attached", async () => {
    const handlers = new Set<(event: { payload: unknown }) => void>();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      const typed = handler as (event: { payload: unknown }) => void;
      handlers.add(typed);
      return () => { handlers.delete(typed); };
    });
    mockInvoke({ overleaf_status: { connected: true, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" } });
    const { result, rerender } = renderHook(({ projectRoot }) => {
      const chat = useOverleafChat({ enabled: true, projectRoot });
      // Runs in the commit that switches to B: B's session is current, but A's
      // listener is only removed by the passive cleanup that follows.
      useLayoutEffect(() => {
        if (projectRoot !== "/tmp/project-b") return;
        const payload = {
          projectRoot: "/tmp/project-a", type: "chatMessage", id: "a-1", content: "project-A text",
          authorName: "Ada", authorEmail: "ada@example.edu", timestamp: 1_700_000_100_000,
        };
        for (const handler of [...handlers]) handler({ payload });
      }, [projectRoot]);
      return chat;
    }, { initialProps: { projectRoot: "/tmp/project-a" } });
    await act(async () => {});
    rerender({ projectRoot: "/tmp/project-b" });
    expect(result.current.messages).toEqual([]);
    expect(result.current.unread).toBe(0);
  });

  it("shows only the current project's history when an older read answers late", async () => {
    mockListen();
    const pending = new Map<string, (messages: OverleafMessage[]) => void>();
    mockInvoke({
      overleaf_status: { connected: true, email: "researcher@example.edu", name: "Robin", host: "https://www.overleaf.com" },
      overleaf_chat_messages: ({ projectRoot }: { projectRoot: string }) =>
        new Promise<OverleafMessage[]>((resolve) => { pending.set(projectRoot, resolve); }),
    });
    const { result, rerender } = renderHook(
      ({ projectRoot }) => useOverleafChat({ enabled: true, projectRoot }),
      { initialProps: { projectRoot: "/tmp/project-a" } },
    );
    let readingA!: Promise<void>;
    act(() => { readingA = result.current.refresh(); });
    expect(result.current.loading).toBe(true);

    rerender({ projectRoot: "/tmp/project-b" });
    expect(result.current.loading).toBe(false);
    let readingB!: Promise<void>;
    act(() => { readingB = result.current.refresh(); });
    await act(async () => {
      pending.get("/tmp/project-b")!([{ ...history, id: "b-1", content: "project-B history" }]);
      await readingB;
    });
    await act(async () => {
      pending.get("/tmp/project-a")!([{ ...history, id: "a-1", content: "project-A history" }]);
      await readingA;
    });

    expect(result.current.messages.map((message) => message.content)).toEqual(["project-B history"]);
    expect(result.current.loading).toBe(false);
  });
});
