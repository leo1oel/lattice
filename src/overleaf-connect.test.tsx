import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverleafPickerDialog, OverleafSettingsSection } from "./overleaf-connect";
import { AppToastStack } from "./app-log";
import { clearAppLogs } from "./app-log-store";
import type { OverleafLink, OverleafProject, OverleafStatus } from "./app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
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
const linkedProject: OverleafLink = {
  projectId: "p1",
  projectName: "Attention Paper",
  host: "https://www.overleaf.com",
  lastSync: "2026-07-24T00:00:00Z",
  paused: false,
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
  clearAppLogs();
  vi.mocked(confirm).mockReset();
  vi.clearAllMocks();
});

describe("Overleaf settings section", () => {
  it("presents sync mode and deletion behavior as dropdowns", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      throw new Error(`Unexpected command: ${command}`);
    });
    const onSyncModeChange = vi.fn();
    const onRemoteDeleteChange = vi.fn();
    const { rerender } = render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={onSyncModeChange} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={onRemoteDeleteChange} onLinkChanged={() => {}} />);

    const syncMode = screen.getByRole("combobox", { name: "Sync mode" });
    const deletionBehavior = screen.getByRole("combobox", { name: "When you delete a file here" });

    expect(syncMode).toHaveTextContent("Live sync");
    expect(syncMode.closest("[data-slot='settings-row']")?.querySelector(".ui-settings-row-description"))
      .toHaveTextContent("Edits sync live with Overleaf.");
    fireEvent.pointerDown(syncMode, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Manual" }));
    expect(onSyncModeChange).toHaveBeenCalledWith("manual");
    rerender(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="manual" onSyncModeChange={onSyncModeChange} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={onRemoteDeleteChange} onLinkChanged={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Sync mode" }).closest("[data-slot='settings-row']")
      ?.querySelector(".ui-settings-row-description"))
      .toHaveTextContent("Sync only when you click the sync button.");
    expect(deletionBehavior).toHaveTextContent("Ask before deleting");
    fireEvent.pointerDown(deletionBehavior, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Delete on Overleaf too" }));
    expect(onRemoteDeleteChange).toHaveBeenCalledWith("always");
    expect(screen.queryByText("Open a linked project to start editing live.")).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced connection settings")).not.toBeInTheDocument();
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
  });

  it("renders disconnected guidance and connects through begin_login + polling", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_begin_login") return undefined;
      if (command === "overleaf_poll_login") return { status: "connected", session: connected };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    expect(await screen.findByText(/Open and sync Overleaf projects in Lattice/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_begin_login"));
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("pauses and resumes syncing, telling the app each time so the toolbar follows", async () => {
    const onLinkChanged = vi.fn();
    let paused = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_link") {
        return {
          projectId: "p1",
          projectName: "Attention Paper",
          host: "https://www.overleaf.com",
          lastSync: null,
          paused,
        };
      }
      if (command === "overleaf_set_paused") {
        paused = (args as { paused: boolean }).paused;
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.mocked(confirm).mockResolvedValue(true);
    render(
      <OverleafSettingsSection
        projectRoot="/tmp/project"
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="off"
        channelDetail={null}
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={onLinkChanged}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pause syncing" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_set_paused", {
      projectRoot: "/tmp/project",
      paused: true,
    }));
    // Without this the cloud button, live channel and chat all kept running
    // against a project that had just been told to stop.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalled());

    // The link is still here — that is the whole point, so resuming can merge
    // rather than start over.
    const resume = await screen.findByRole("button", { name: "Resume syncing" });
    expect(screen.getByText(/Syncing with .*Attention Paper.* is paused/)).toBeInTheDocument();

    fireEvent.click(resume);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_set_paused", {
      projectRoot: "/tmp/project",
      paused: false,
    }));
    expect(await screen.findByRole("button", { name: "Pause syncing" })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("shows the waiting state while the login window is open and cancels cleanly", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      if (command === "overleaf_begin_login") return undefined;
      if (command === "overleaf_poll_login") return { status: "pending", session: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/Sign-in was cancelled/)).toBeInTheDocument();
  });

  it("shows concise live-editing status without expanding the settings row", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { rerender } = render(
      <OverleafSettingsSection
        projectRoot="/tmp/project"
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="error"
        channelDetail="the websocket was refused"
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={() => {}}
      />,
    );
    const unavailable = await screen.findByText("Live editing is unavailable; regular syncing continues.");
    expect(unavailable).toHaveAttribute("title", "the websocket was refused");
    rerender(
      <OverleafSettingsSection
        projectRoot="/tmp/project"
        syncMode="live"
        onSyncModeChange={() => {}}
        channel="live"
        channelDetail={null}
        remoteDelete="ask"
        onRemoteDeleteChange={() => {}}
        onLinkChanged={() => {}}
      />,
    );
    expect(screen.getByText("Live editing is connected.")).toBeInTheDocument();
  });

  it("surfaces disconnect and lets the user reconnect", async () => {
    let current = connected;
    const onLinkChanged = vi.fn();
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return current;
      if (command === "overleaf_link") return linkedProject;
      if (command === "overleaf_disconnect") {
        current = disconnected;
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={onLinkChanged} />);
    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/Sign out of Overleaf\?[\s\S]*list your Overleaf projects[\s\S]*sync linked projects[\s\S]*live editing[\s\S]*Files already downloaded to this Mac will not be deleted/),
      expect.objectContaining({ kind: "warning" }),
    ));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_disconnect"));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    expect(screen.getByText(/Sign in to resume syncing and live editing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
    expect(onLinkChanged).toHaveBeenCalled();
  });

  it("keeps the Overleaf session connected when sign-out is cancelled", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);

    expect(await screen.findByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith("overleaf_disconnect");
    expect(screen.getByText(/Connected as leo@uw\.edu/)).toBeInTheDocument();
  });

  it("keeps a linked project inactive when the account belongs to another host", async () => {
    const otherHost: OverleafStatus = {
      ...connected,
      host: "https://overleaf-b.example",
    };
    const selfHostedLink: OverleafLink = {
      ...linkedProject,
      host: "https://overleaf-a.example",
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return otherHost;
      if (command === "overleaf_link") return selfHostedLink;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);

    expect(await screen.findByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    expect(screen.getByText(/This project uses https:\/\/overleaf-a\.example/)).toBeInTheDocument();
    expect(screen.getByText(/Sign out above, then connect to that host/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
  });

  it("keeps linked-project controls unavailable when connection status cannot be read", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") throw new Error("Keychain is unavailable");
      if (command === "overleaf_link") return linkedProject;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);

    expect(await screen.findByText("Keychain is unavailable")).toBeInTheDocument();
    expect(screen.getByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    expect(screen.getByText(/Connection status is unavailable/)).toHaveTextContent("https://www.overleaf.com");
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
  });

  it("keeps legacy links without a stored host active on the current session", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_link") return { ...linkedProject, host: "" };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafSettingsSection projectRoot="/tmp/project" syncMode="live" onSyncModeChange={() => {}} channel="off" channelDetail={null} remoteDelete="ask" onRemoteDeleteChange={() => {}} onLinkChanged={() => {}} />);

    expect(await screen.findByText(/This project syncs with “Attention Paper”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause syncing" })).toBeInTheDocument();
    expect(screen.queryByText(/This project uses \./)).not.toBeInTheDocument();
  });
});

describe("Overleaf picker dialog", () => {
  it("lists projects with owner and update time, and filters by search", async () => {
    mockConnectedPicker();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
    );
    const drawer = screen.getByLabelText("Open from Overleaf");
    expect(drawer).toHaveClass("resizable-drawer");
    expect(within(drawer).getByRole("separator", { name: "Resize right panel" })).toBeInTheDocument();
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(screen.getByText("Thesis Draft")).toBeInTheDocument();
    expect(screen.getByText(/Ada · updated/)).toBeInTheDocument();
    const projectListViewport = screen.getByLabelText("Overleaf projects");
    expect(projectListViewport).toHaveAttribute("data-slot", "scroll-area-viewport");
    expect(projectListViewport.querySelectorAll("[data-slot='scroll-area-viewport']")).toHaveLength(0);
    expect(projectListViewport.closest("[data-slot='scroll-area']"))
      .toHaveClass("overleaf-project-list-scroll");
    fireEvent.change(screen.getByLabelText("Search Overleaf projects"), {
      target: { value: "atten" },
    });
    expect(screen.getByText("Attention Paper")).toBeInTheDocument();
    expect(screen.queryByText("Thesis Draft")).not.toBeInTheDocument();
  });

  it("hides archived projects until the checkbox is ticked", async () => {
    mockConnectedPicker();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
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
    const onBeforeClone = vi.fn();
    render(
      <OverleafPickerDialog
        open
        onClose={onClose}
        onBeforeClone={onBeforeClone}
        onCloned={onCloned}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      accessLevel: "owner",
      adopt: false,
    }));
    expect(onBeforeClone).toHaveBeenCalledOnce();
    expect(onBeforeClone.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invoke).mock.invocationCallOrder.find((_, index) => (
        vi.mocked(invoke).mock.calls[index]?.[0] === "overleaf_clone_project"
      ))!,
    );
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not change roots when the current project is still syncing", async () => {
    mockConnectedPicker();
    const onCloned = vi.fn();
    const onBeforeClone = vi.fn(() => false);
    render(
      <OverleafPickerDialog
        open
        onClose={vi.fn()}
        onBeforeClone={onBeforeClone}
        onCloned={onCloned}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(onBeforeClone).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith(
      "overleaf_clone_project",
      expect.anything(),
    );
    expect(onCloned).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", "owner"],
    ["readAndWrite", "readAndWrite"],
    ["readOnly", "readOnly"],
    ["review", "review"],
    ["unknown", "unknown"],
    ["null", null],
  ] as const)("preserves the %s access level when cloning", async (_label, accessLevel) => {
    const project: OverleafProject = {
      ...projects[0]!,
      accessLevel,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return [project];
      if (command === "overleaf_clone_project") return "/tmp/cloned/Attention Paper";
      throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
    });
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      accessLevel,
      adopt: false,
    }));
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
    const confirmSpy = vi.mocked(confirm).mockResolvedValue(true);
    const onCloned = vi.fn();
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={onCloned} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]![0]).toContain("local conflict");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      accessLevel: "owner",
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
    const confirmSpy = vi.mocked(confirm).mockResolvedValue(false);
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: "p1",
      name: "Attention Paper",
      accessLevel: "owner",
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
      <OverleafPickerDialog open onClose={onClose} onCloned={onCloned} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still reports a real failure and keeps the dialog open", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return connected;
      if (command === "overleaf_list_projects") return projects;
      if (command === "overleaf_clone_project") throw new Error("Could not reach Overleaf.");
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();
    const onBeforeClone = vi.fn();
    const onCloneCancelled = vi.fn();
    render(
      <>
        <OverleafPickerDialog
          open
          onClose={onClose}
          onBeforeClone={onBeforeClone}
          onCloneCancelled={onCloneCancelled}
          onCloned={vi.fn()}
        />
        <AppToastStack />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    // The failure is a toast now, not a line inside the dialog; it still has to
    // reach the user, and the dialog still has to stay open behind it.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach Overleaf/);
    expect(onBeforeClone).toHaveBeenCalledOnce();
    expect(onCloneCancelled).toHaveBeenCalledOnce();
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
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
    );
    expect(await screen.findByText(/isn’t connected yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
  });

  it("keeps the disconnected state focused on standard sign-in", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_status") return disconnected;
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <OverleafPickerDialog open onClose={vi.fn()} onCloned={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: "Connect to Overleaf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Advanced options" })).not.toBeInTheDocument();
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
      <OverleafPickerDialog open onClose={onClose} onCloned={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Downloading Attention Paper from Overleaf/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeDisabled();
    resolveClone("/tmp/cloned/Attention Paper");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
