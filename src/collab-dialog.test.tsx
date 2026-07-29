import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabDialog } from "./collab-dialog";
import type { CollabChatMessage } from "./collab-session";

function baseProps() {
  return {
    open: true,
    mode: "start" as const,
    role: "host" as const,
    host: "lattice-collab.example.workers.dev",
    room: "LT-ABC123",
    displayName: "Ada",
    inviteText: "",
    status: "synced" as const,
    statusDetail: null,
    peerCount: 1,
    fileCount: 4,
    connectedRoom: "LT-ABC123",
    onClose: vi.fn(),
    onModeChange: vi.fn(),
    onHostChange: vi.fn(),
    onRoomChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    onInviteChange: vi.fn(),
    onStartShare: vi.fn(),
    onJoinShare: vi.fn(),
    recentRooms: [],
    onReconnectRoom: vi.fn(),
    onForgetRoom: vi.fn(),
    onDisconnect: vi.fn(),
    onCopyInvite: vi.fn(),
  };
}

function message(overrides: Partial<CollabChatMessage> = {}): CollabChatMessage {
  return {
    id: "m1",
    authorId: "guest-1",
    authorName: "Bo",
    body: "hi there",
    at: Date.now(),
    ...overrides,
  };
}

describe("CollabDialog chat tab", () => {
  afterEach(cleanup);

  it("hides the tab switcher entirely when the caller does not wire chat", () => {
    render(<CollabDialog {...baseProps()} />);
    const drawer = screen.getByLabelText("Live collaboration");
    expect(drawer).toHaveClass("resizable-drawer");
    expect(within(drawer).getByRole("separator", { name: "Resize right panel" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /chat/i })).not.toBeInTheDocument();
    // The live card's own status line still renders unchanged.
    expect(screen.getByText(/Sharing/)).toBeInTheDocument();
  });

  it("badges the chat tab with the unread count, and clears it once that tab is opened", () => {
    const onChatOpen = vi.fn();
    render(
      <CollabDialog
        {...baseProps()}
        chatMessages={[message()]}
        chatSelfId="host-1"
        chatUnread={2}
        onChatSend={vi.fn()}
        onChatOpen={onChatOpen}
      />,
    );
    // Closed on the status tab: unread shows, and reading has not happened yet.
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(onChatOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    // Switching to the tab is what "opening the panel" means here.
    expect(onChatOpen).toHaveBeenCalled();
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("sends a chat message through the wired handler", () => {
    const onChatSend = vi.fn();
    render(
      <CollabDialog
        {...baseProps()}
        chatMessages={[]}
        chatSelfId="host-1"
        onChatSend={onChatSend}
        onChatOpen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "on my way" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChatSend).toHaveBeenCalledWith("on my way");
  });
});
