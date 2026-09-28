import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConfirmActionHandler } from "../app-utils";
import { CollabDialog } from "./collab-dialog";
import type { CollabProjectRecordV2 } from "./collab-rooms";

function baseProps() {
  return {
    open: true,
    mode: "start" as const,
    role: "host" as const,
    host: "lattice-collab.example.workers.dev",
    room: "LT-ABC123",
    displayName: "Ada",
    projectName: "Attention paper",
    inviteText: "",
    status: "synced" as const,
    statusDetail: null,
    peerCount: 1,
    fileCount: 4,
    connectedRoom: "LT-ABC123",
    onClose: vi.fn(), onModeChange: vi.fn(), onRoomChange: vi.fn(), onDisplayNameChange: vi.fn(),
    onProjectNameChange: vi.fn(), onInviteChange: vi.fn(), onStartShare: vi.fn(), onJoinShare: vi.fn(),
    onDisconnect: vi.fn(), onCopyInvite: vi.fn(),
  };
}

/** The dialog before any share is live. */
const disconnected = { status: "disconnected", connectedRoom: null } as const;

/** A remembered v2 room; the defaults describe one this machine hosts. */
function room(overrides: Partial<CollabProjectRecordV2> = {}): CollabProjectRecordV2 {
  return { version: 2, projectInstanceId: "project_12345678", host: "https://sync.example", credentialRef: "cred_1", permission: "host", title: "Paper", projectRoot: "/paper", lastUsed: 1, ...overrides };
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
    render(<CollabDialog {...baseProps()} {...disconnected} />);
    expect(screen.queryByText(/Advanced \(sync host\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Collab host")).not.toBeInTheDocument();
    expect(screen.queryByText(/Starting a share puts this project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Use the full invite from Copy invite/i)).not.toBeInTheDocument();
  });

  it("uses the hover-revealed scrollbar for the join invite", () => {
    render(<CollabDialog {...baseProps()} mode="join" {...disconnected} />);
    expect(screen.getByLabelText("Collab invite")).toHaveClass("native-hover-scrollbar");
  });

  it("uses the Lattice scrollbar for remembered rooms on both axes", () => {
    render(<CollabDialog {...baseProps()} {...disconnected} recentProjectsV2={[room()]} />);
    const viewport = screen.getByLabelText("Rooms you host");
    expect(viewport).toHaveAttribute("data-slot", "scroll-area-viewport");
    expect(viewport.closest("[data-slot='scroll-area']")).toHaveClass("collab-recent-scroll");
    // Host actions sit beside the room id and are what forces sideways overflow.
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(viewport).toHaveStyle({ height: "auto", maxHeight: "168px" });
  });

  it("offers cancellation instead of another start attempt while a share is connecting", () => {
    const onStartShare = vi.fn(); const onDisconnect = vi.fn();
    render(<CollabDialog {...baseProps()} status="connecting" statusDetail="Uploading project files… 3/8" connectedRoom={null} onStartShare={onStartShare} onDisconnect={onDisconnect} />);
    expect(screen.getByRole("status")).toHaveTextContent("Uploading project files… 3/8");
    const button = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(button);
    expect(onStartShare).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("labels a live project as sharing all project files", () => {
    render(<CollabDialog {...baseProps()} />);
    expect(screen.getByText(/all project files/)).toBeInTheDocument();
  });

  it("lets the host remove an authenticated collaborator with an explicit warning", async () => {
    // Not `window.confirm`: Tauri's dialog plugin replaces that global with an
    // ACL-rejected async call, so the prompt goes through confirmAction.
    const onRemovePeer = vi.fn(); const confirm = vi.fn().mockResolvedValue(true);
    const release = registerConfirmActionHandler(confirm);
    const peer = { clientId: 7, name: "Bo", color: "#123456", path: "paper.md", grantId: "grant-bo" };
    render(<CollabDialog {...baseProps()} peers={[peer]} onRemovePeer={onRemovePeer} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Bo from this share" }));
    expect(confirm).toHaveBeenCalledWith({ message: expect.stringContaining("Anyone who joined with the same invite") });
    await vi.waitFor(() => expect(onRemovePeer).toHaveBeenCalledWith(peer));
    release();
  });

  it("names the host in the roster so a guest can tell who started the share", () => {
    const host = { clientId: 3, name: "Ada", color: "#123456", path: "paper.tex", permission: "host" as const };
    const other = { clientId: 9, name: "Cy", color: "#654321", path: null, permission: "write" as const };
    render(<CollabDialog {...baseProps()} role="guest" displayName="Bo" peers={[host, other]} />);
    const rows = screen.getAllByRole("listitem");
    // You first, then the peers in the order given.
    expect(rows[0]).toHaveTextContent("Bo (you)");
    expect(rows[0]).not.toHaveTextContent("host");
    expect(rows[1]).toHaveTextContent("Ada");
    expect(within(rows[1]).getByText("host")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("Cy");
    expect(within(rows[2]).queryByText("host")).not.toBeInTheDocument();
  });

  it("marks you as the host in your own roster row", () => {
    render(<CollabDialog {...baseProps()} role="host" displayName="Ada" peers={[]} />);
    const row = screen.getAllByRole("listitem")[0];
    expect(row).toHaveTextContent("Ada (you)");
    expect(within(row).getByText("host")).toBeInTheDocument();
  });

  it("gives the host both exits, and only ends the room for everyone after a confirmation", async () => {
    const onDisconnect = vi.fn(); const onLeaveShare = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    const release = registerConfirmActionHandler(confirm);
    render(<CollabDialog {...baseProps()} role="host" onDisconnect={onDisconnect} onLeaveShare={onLeaveShare} />);

    // Leaving keeps the room running, so it asks nothing and never disconnects everyone.
    fireEvent.click(screen.getByRole("button", { name: "Leave share" }));
    expect(onLeaveShare).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({ message: expect.stringContaining("Stop sharing for everyone?") });
    release();
  });

  it("keeps a guest to a single exit that does not end the room", () => {
    const onDisconnect = vi.fn(); const onLeaveShare = vi.fn();
    render(<CollabDialog {...baseProps()} role="guest" onDisconnect={onDisconnect} onLeaveShare={onLeaveShare} />);
    expect(screen.queryByRole("button", { name: "Stop sharing" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave share" }));
    // A guest has no room to keep running, so this is the plain disconnect.
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onLeaveShare).not.toHaveBeenCalled();
  });

  it("renders remembered v2 projects separately and routes rejoin and forget", () => {
    const onRejoinProjectV2 = vi.fn(); const onForgetProjectV2 = vi.fn();
    render(<CollabDialog {...baseProps()} mode="join" {...disconnected} recentProjectsV2={[room({ permission: "write" })]} onRejoinProjectV2={onRejoinProjectV2} onForgetProjectV2={onForgetProjectV2} />);
    expect(screen.getByText("joined")).toBeInTheDocument(); expect(screen.getByText("project_12345678 · write")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Rejoin Paper")); expect(onRejoinProjectV2).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Remove project_12345678 from recent shares")); expect(onForgetProjectV2).toHaveBeenCalledTimes(1);
  });

  it("keeps hosted and joined rooms on the tab that can act on them", () => {
    const rooms = [
      room({ projectInstanceId: "project_hosted12", credentialRef: "cred_h", title: "Mine", projectRoot: "/mine", lastUsed: 2 }),
      room({ projectInstanceId: "project_joined12", credentialRef: "cred_g", permission: "write", title: "Theirs", projectRoot: "/theirs" }),
    ];

    // Start sharing offers rooms you can reopen and end. Listing a room you are
    // only a guest in offered to "start" something that is not yours.
    const start = render(<CollabDialog {...baseProps()} mode="start" {...disconnected} recentProjectsV2={rooms} />);
    expect(screen.getByText("Rooms you host")).toBeInTheDocument();
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.queryByText("Theirs")).not.toBeInTheDocument();
    start.unmount();

    render(<CollabDialog {...baseProps()} mode="join" {...disconnected} recentProjectsV2={rooms} />);
    expect(screen.getByText("Rooms you joined")).toBeInTheDocument();
    expect(screen.getByText("Theirs")).toBeInTheDocument();
    expect(screen.queryByText("Mine")).not.toBeInTheDocument();
  });

  it("lets a host rename or close a remembered room, but not remove a live room from the list", () => {
    const hosted = room();
    const onRenameProjectV2 = vi.fn(); const onCloseProjectV2 = vi.fn(); const onForgetProjectV2 = vi.fn();
    render(<CollabDialog {...baseProps()} {...disconnected} recentProjectsV2={[hosted]} onRenameProjectV2={onRenameProjectV2} onCloseProjectV2={onCloseProjectV2} onForgetProjectV2={onForgetProjectV2} />);
    expect(screen.queryByLabelText("Remove project_12345678 from recent shares")).not.toBeInTheDocument();
    expect(onForgetProjectV2).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const renameInput = screen.getByLabelText("Rename Paper");
    fireEvent.change(renameInput, { target: { value: "Final paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameProjectV2).toHaveBeenCalledWith(hosted, "Final paper");
    fireEvent.click(screen.getByRole("button", { name: "Close for everyone" }));
    expect(onCloseProjectV2).toHaveBeenCalledWith(hosted);
  });

  it("orders remembered rooms by creation time and shows their localized age", () => {
    const now = Date.now();
    const older = room({ projectInstanceId: "project_older123", credentialRef: "cred_old", title: "Older paper", projectRoot: "/older", createdAt: now - 26 * 60 * 60 * 1000, lastUsed: now });
    const newer = room({ projectInstanceId: "project_newer123", credentialRef: "cred_new", title: "Newer paper", projectRoot: "/newer", createdAt: now - 2 * 60 * 60 * 1000, lastUsed: now - 60_000 });

    render(<CollabDialog {...baseProps()} {...disconnected} recentProjectsV2={[older, newer]} />);

    expect(screen.getAllByTitle(/^Rejoin /).map((row) => row.getAttribute("title"))).toEqual([
      "Rejoin Newer paper",
      "Rejoin Older paper",
    ]);
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("yesterday")).toBeInTheDocument();
  });

  it("cancels an in-progress room rename without calling the handler", () => {
    const onRenameProjectV2 = vi.fn();
    render(<CollabDialog {...baseProps()} {...disconnected} recentProjectsV2={[room()]} onRenameProjectV2={onRenameProjectV2} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename Paper"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRenameProjectV2).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("badges the chat tab with the unread count, and clears it once that tab is opened", () => {
    const onChatOpen = vi.fn();
    const message = { id: "m1", authorId: "guest-1", authorName: "Bo", body: "hi there", at: Date.now() };
    render(<CollabDialog {...baseProps()} chatMessages={[message]} chatSelfId="host-1" chatUnread={2} onChatSend={vi.fn()} onChatOpen={onChatOpen} />);
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
    render(<CollabDialog {...baseProps()} chatMessages={[]} chatSelfId="host-1" onChatSend={onChatSend} onChatOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "on my way" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChatSend).toHaveBeenCalledWith("on my way");
  });
});
