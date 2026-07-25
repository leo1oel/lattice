import { invoke } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverleafPickerDialog, OverleafSettingsSection } from "./overleaf-connect";
import type { OverleafProject, OverleafStatus } from "./app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const disconnected: OverleafStatus = {
  connected: false,
  email: null,
  name: null,
  host: "https://www.overleaf.com",
};
const connected: OverleafStatus = {
  connected: true,
  email: "leo@uw.edu",
  name: "Leo",
  host: "https://www.overleaf.com",
};

const projects: OverleafProject[] = [
  {
    id: "p1",
    name: "Attention Paper",
    lastUpdated: "2026-07-24T00:00:00Z",
    ownerEmail: "leo@uw.edu",
    ownerName: "Leo",
    accessLevel: "owner",
    archived: false,
    trashed: false,
  },
  {
    id: "p2",
    name: "Thesis Draft",
    lastUpdated: "2026-07-20T00:00:00Z",
    ownerEmail: "ada@uw.edu",
    ownerName: "Ada",
    accessLevel: "readAndWrite",
    archived: false,
    trashed: false,
  },
  {
    id: "p3",
    name: "Old Notes",
    lastUpdated: null,
    ownerEmail: null,
    ownerName: null,
    accessLevel: "owner",
    archived: true,
    trashed: false,
  },
];

function mockConnectedPicker() {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "overleaf_status") return connected;
    if (command === "overleaf_list_projects") return projects;
    if (command === "overleaf_clone_project") return "/tmp/cloned/Attention Paper";
    throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Overleaf settings section", () => {
  it("renders disconnected guidance and connects through begin_login + polling", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_begin_login") return undefined;
      if (command === "overleaf_poll_login") return { status: "connected", session: connected };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    expect(await screen.findByText(/Connect your Overleaf account to open and sync/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_begin_login"));
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("tells the app when the project is unlinked, so the toolbar stops showing it as linked", async () => {
    const onLinkChanged = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_link") {
        return { projectId: "p1", projectName: "Attention Paper", host: "https://www.overleaf.com", lastSync: null };
      }
      if (command === "overleaf_unlink") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <OverleafSettingsSection
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="off"
        channelDetail={null}
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={onLinkChanged}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Stop syncing" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_unlink"));
    // Without this the cloud button, live channel and chat all kept running
    // against a project that was no longer linked.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Stop syncing" })).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("shows the waiting state while the login window is open and cancels cleanly", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_begin_login") return undefined;
      if (command === "overleaf_poll_login") return { status: "pending", session: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/Sign-in was cancelled/)).toBeInTheDocument();
  });

  it("stores a manual session cookie for a self-hosted server", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_store_cookie") return { ...connected, host: "https://overleaf.example.edu" };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    await screen.findByRole("button", { name: /Connect to Overleaf/ });
    fireEvent.change(screen.getByLabelText("Server address"), {
      target: { value: "https://overleaf.example.edu" },
    });
    fireEvent.change(screen.getByLabelText("Session cookie"), {
      target: { value: "overleaf_session2=abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_store_cookie", {
      host: "https://overleaf.example.edu",
      cookie: "overleaf_session2=abc",
    }));
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
  });

  it("says why live editing is unavailable instead of failing silently", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { rerender } = render(
      <OverleafSettingsSection
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="error"
        channelDetail="the websocket was refused"
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={() => {}}
      />,
    );
    expect(
      await screen.findByText(/Live editing could not start: the websocket was refused/),
    ).toBeInTheDocument();
    rerender(
      <OverleafSettingsSection
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="live"
        channelDetail={null}
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={() => {}}
      />,
    );
    expect(screen.getByText(/Connected to Overleaf's editing channel/)).toBeInTheDocument();
  });

  it("surfaces disconnect and lets the user reconnect", async () => {
    let current = connected;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return current;
      if (command === "overleaf_disconnect") {
        current = disconnected;
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
  });
});

describe("Overleaf picker dialog", () => {
  it("lists projects with owner and update time, and filters by search", async () => {
    mockConnectedPicker();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(screen.getByText("Thesis Draft")).toBeInTheDocument();
    expect(screen.getByText(/Ada · updated/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search Overleaf projects"), {
      target: { value: "atten" },
    });
    expect(screen.getByText("Attention Paper")).toBeInTheDocument();
    expect(screen.queryByText("Thesis Draft")).not.toBeInTheDocument();
  });

  it("hides archived projects until the checkbox is ticked", async () => {
    mockConnectedPicker();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    await screen.findByText("Attention Paper");
    expect(screen.queryByText("Old Notes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByText("Old Notes")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("clones the selected project and reports the new root", async () => {
    mockConnectedPicker();
    const onCloned = vi.fn();
    const onClose = vi.fn();
    render(
      <OverleafPickerDialog open onClose={onClose} onCloned={onCloned} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      adopt: false,
    }));
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers to link a folder left behind by Stop syncing rather than downloading a second copy", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_target") {
        return { kind: "occupied", path: "/tmp/cloned/Attention Paper", folder: "Attention Paper" };
      }
      if (command === "overleaf_clone_project") return "/tmp/cloned/Attention Paper";
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onCloned = vi.fn();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={onCloned} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]![0]).toContain("local conflict");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      adopt: true,
    }));
    confirmSpy.mockRestore();
  });

  it("downloads a separate copy when the offer to link the existing folder is declined", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_target") {
        return { kind: "occupied", path: "/tmp/cloned/Attention Paper", folder: "Attention Paper" };
      }
      if (command === "overleaf_clone_project") return "/tmp/cloned/Attention Paper (2)";
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      adopt: false,
    }));
    confirmSpy.mockRestore();
  });

  it("opens a project that is already downloaded instead of refusing", async () => {
    // The backend answers with the folder it is already in, so from here this
    // is an ordinary open. It used to fail and tell the reader to go and find
    // the folder themselves, for the commonest thing anyone does here.
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_project") return "/tmp/cloned/Attention Paper";
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();
    const onCloned = vi.fn();
    render(
      <OverleafPickerDialog open onClose={onClose} onCloned={onCloned} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still shows a real failure inline rather than closing", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_project") throw new Error("Could not reach Overleaf.");
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();
    render(
      <OverleafPickerDialog open onClose={onClose} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach Overleaf/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs the connect flow inside the dialog when not connected", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_begin_login") return undefined;
      if (command === "overleaf_poll_login") return { status: "connected", session: connected };
      if (command === "overleaf_list_projects") return projects;
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(await screen.findByText(/isn’t connected yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
  });

  it("routes the advanced link to settings and closes the picker", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      throw new Error(`Unexpected command: ${command}`);
    });
    const onOpenSettings = vi.fn();
    const onClose = vi.fn();
    render(
      <OverleafPickerDialog open onClose={onClose} onCloned={vi.fn()} onOpenSettings={onOpenSettings} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Advanced options" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape only while no download is in flight", async () => {
    let resolveClone: (root: string) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_project") {
        return new Promise<string>((resolve) => { resolveClone = resolve; });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();
    render(
      <OverleafPickerDialog open onClose={onClose} onCloned={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Downloading Attention Paper from Overleaf/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    resolveClone("/tmp/cloned/Attention Paper");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
