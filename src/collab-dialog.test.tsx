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
    onRoomChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    onInviteChange: vi.fn(),
    onStartShare: vi.fn(),
    onJoinShare: vi.fn(),
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

  it("keeps sync-host configuration out of the sharing flow", () => {
    render(<CollabDialog {...baseProps()} status="disconnected" connectedRoom={null} />);
    expect(screen.queryByText(/Advanced \(sync host\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Collab host")).not.toBeInTheDocument();
    expect(screen.queryByText(/Starting a share puts this project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Use the full invite from Copy invite/i)).not.toBeInTheDocument();
  });

  it("labels a live project as sharing all project files", () => {
    render(<CollabDialog {...baseProps()} />);
    expect(screen.getByText(/all project files/)).toBeInTheDocument();
  });

  it("renders remembered v2 projects separately and routes rejoin and forget", () => {
    const onRejoinProjectV2 = vi.fn(); const onForgetProjectV2 = vi.fn();
    render(<CollabDialog {...baseProps()} status="disconnected" connectedRoom={null} recentProjectsV2={[{ version: 2, projectInstanceId: "project_12345678", host: "https://sync.example", credentialRef: "cred_1", permission: "write", title: "Paper", projectRoot: "/paper", lastUsed: 1 }]} onRejoinProjectV2={onRejoinProjectV2} onForgetProjectV2={onForgetProjectV2} />);
    expect(screen.getByText("v2")).toBeInTheDocument(); expect(screen.getByText("project_12345678 · write")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Rejoin Paper")); expect(onRejoinProjectV2).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Remove project_12345678 from recent shares")); expect(onForgetProjectV2).toHaveBeenCalledTimes(1);
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
