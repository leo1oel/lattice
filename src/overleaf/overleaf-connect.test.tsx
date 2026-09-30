import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverleafPickerDialog, OverleafSettingsSection } from "./overleaf-connect";
import { AppToastStack } from "../telemetry/app-log";
import { clearAppLogs } from "../telemetry/app-log-store";
import type { OverleafLink, OverleafProject, OverleafStatus } from "../app-types";
import { invokeCalls, mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const disconnected: OverleafStatus = { connected: false, email: null, name: null, host: "https://www.overleaf.com" };
const connected: OverleafStatus = { ...disconnected, connected: true, email: "researcher@example.edu", name: "Robin" };
const linkedProject: OverleafLink = {
  projectId: "p1", projectName: "Attention Paper", host: "https://www.overleaf.com", lastSync: "2026-07-24T00:00:00Z", paused: false,
};
/** A sign-in window that reports the account connected on the first poll. */
const signsIn: CommandTable = { overleaf_begin_login: undefined, overleaf_poll_login: { status: "connected", session: connected } };

const project = (id: string, name: string, overrides: Partial<OverleafProject> = {}): OverleafProject => ({
  id, name, lastUpdated: "2026-07-24T00:00:00Z", ownerEmail: "researcher@example.edu", ownerName: "Robin",
  accessLevel: "owner", archived: false, trashed: false, ...overrides,
});
const projects = [
  project("p1", "Attention Paper"),
  project("p2", "Thesis Draft", { lastUpdated: "2026-07-20T00:00:00Z", ownerEmail: "ada@example.edu", ownerName: "Ada", accessLevel: "readAndWrite" }),
  project("p3", "Old Notes", { lastUpdated: null, ownerEmail: null, ownerName: null, archived: true }),
];

/** A connected account listing `projects`, plus whatever else the test needs answered. */
function mockConnectedPicker(extra: CommandTable = {}) {
  mockInvoke({
    overleaf_status: connected,
    overleaf_list_projects: projects,
    overleaf_clone_project: "/tmp/cloned/Attention Paper",
    ...extra,
  });
}

type SettingsProps = Parameters<typeof OverleafSettingsSection>[0];
const settingsDefaults: SettingsProps = {
  projectRoot: "/tmp/project", syncMode: "live", onSyncModeChange: () => {}, channel: "off", channelDetail: null,
  remoteDelete: "ask", onRemoteDeleteChange: () => {}, onLinkChanged: () => {},
};
const settings = (props: Partial<SettingsProps> = {}) => <OverleafSettingsSection {...settingsDefaults} {...props} />;

/** Render the picker; its callbacks are spies (the optional ones are no-ops unless overridden). */
function renderPicker(props: Partial<Parameters<typeof OverleafPickerDialog>[0]> = {}) {
  const callbacks = { onClose: vi.fn(), onCloned: vi.fn(), onBeforeClone: vi.fn(), onCloneCancelled: vi.fn() };
  render(<OverleafPickerDialog open {...callbacks} {...props} />);
  return callbacks;
}

/** What `overleaf_clone_project` is sent for the Attention Paper row. */
const cloneArgs = (overrides: Record<string, unknown> = {}) => ({
  projectId: "p1", name: "Attention Paper", accessLevel: "owner", adopt: false, ...overrides,
});

/** Select the Attention Paper row and press Open. */
async function openFirstProject() {
  fireEvent.click(await screen.findByRole("button", { name: /Attention Paper/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
}

afterEach(() => {
  cleanup();
  clearAppLogs();
  vi.resetAllMocks();
});

describe("Overleaf settings section", () => {
  const descriptionOf = (name: string) => screen.getByRole("combobox", { name })
    .closest("[data-slot='settings-row']")?.querySelector(".ui-settings-row-description");
  const pick = async (combobox: HTMLElement, option: string) => {
    fireEvent.pointerDown(combobox, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: option }));
  };

  it("presents sync mode and deletion behavior as dropdowns, with concise live-editing status", async () => {
    mockInvoke({ overleaf_status: connected });
    const onSyncModeChange = vi.fn();
    const onRemoteDeleteChange = vi.fn();
    const { rerender } = render(settings({ onSyncModeChange, onRemoteDeleteChange }));

    const syncMode = screen.getByRole("combobox", { name: "Sync mode" });
    const deletionBehavior = screen.getByRole("combobox", { name: "When you delete a file here" });
    expect(syncMode).toHaveTextContent("Live sync");
    expect(descriptionOf("Sync mode")).toHaveTextContent("Edits sync live with Overleaf");
    await pick(syncMode, "Manual");
    expect(onSyncModeChange).toHaveBeenCalledWith("manual");
    rerender(settings({ syncMode: "manual", onSyncModeChange, onRemoteDeleteChange }));
    expect(descriptionOf("Sync mode")).toHaveTextContent("Sync only when you click the sync button");
    expect(deletionBehavior).toHaveTextContent("Ask before deleting");
    await pick(deletionBehavior, "Delete on Overleaf too");
    expect(onRemoteDeleteChange).toHaveBeenCalledWith("always");
    expect(screen.queryByText("Open a linked project to start editing live.")).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced connection settings")).not.toBeInTheDocument();
    expect(await screen.findByText(/Connected as researcher@example\.edu/)).toBeInTheDocument();

    // Live-editing status stays concise instead of expanding the settings row.
    rerender(settings({ channel: "error", channelDetail: "the websocket was refused" }));
    const unavailable = await screen.findByText("Live editing is unavailable; regular syncing continues");
    expect(unavailable).toHaveAttribute("title", "the websocket was refused");
    rerender(settings({ channel: "live" }));
    expect(screen.getByText("Live editing is connected")).toBeInTheDocument();
  });

  it("renders disconnected guidance, cancels a pending sign-in cleanly, and connects through begin_login + polling", async () => {
    let poll: unknown = { status: "pending", session: null };
    mockInvoke({ ...signsIn, overleaf_status: disconnected, overleaf_poll_login: () => poll });
    render(settings());
    expect(await screen.findByText(/Open and sync Overleaf projects in Lattice/)).toBeInTheDocument();

    // The waiting state shows while the login window is open, and cancels cleanly.
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/Sign-in was cancelled/)).toBeInTheDocument();

    poll = signsIn.overleaf_poll_login;
    fireEvent.click(screen.getByRole("button", { name: /Connect to Overleaf/ }));
    await waitFor(() => expect(invokeCalls("overleaf_begin_login")).toHaveLength(2));
    expect(await screen.findByText(/Connected as researcher@example\.edu/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("pauses and resumes a (legacy, host-less) link, telling the app each time so the toolbar follows", async () => {
    const onLinkChanged = vi.fn();
    let paused = false;
    mockInvoke({
      overleaf_status: connected,
      // A legacy link without a stored host stays active on the current session.
      overleaf_link: () => ({ ...linkedProject, host: "", lastSync: null, paused }),
      overleaf_set_paused: (args: { paused: boolean }) => { paused = args.paused; },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    render(settings({ onLinkChanged }));
    expect(await screen.findByText(/This project syncs with “Attention Paper”/)).toBeInTheDocument();
    expect(screen.queryByText(/This project uses \./)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Pause syncing" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_set_paused", { projectRoot: "/tmp/project", paused: true }));
    // Without this the cloud button, live channel and chat all kept running
    // against a project that had just been told to stop.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalled());

    // The link is still here — that is the whole point, so resuming can merge
    // rather than start over.
    const resume = await screen.findByRole("button", { name: "Resume syncing" });
    expect(screen.getByText(/Syncing with .*Attention Paper.* is paused/)).toBeInTheDocument();

    fireEvent.click(resume);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_set_paused", { projectRoot: "/tmp/project", paused: false }));
    expect(await screen.findByRole("button", { name: "Pause syncing" })).toBeInTheDocument();
  });

  it("signs out only once the warning is accepted, then lets the user reconnect", async () => {
    let current = connected;
    const onLinkChanged = vi.fn();
    vi.mocked(confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockInvoke({
      overleaf_status: () => current,
      overleaf_link: linkedProject,
      overleaf_disconnect: () => { current = disconnected; },
    });
    render(settings({ onLinkChanged }));
    expect(await screen.findByText(/Connected as researcher@example\.edu/)).toBeInTheDocument();
    const signOut = screen.getByRole("button", { name: "Sign out" });

    // Cancelling the warning keeps the Overleaf session connected.
    fireEvent.click(signOut);
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(signOut).toBeEnabled());
    expect(invoke).not.toHaveBeenCalledWith("overleaf_disconnect");
    expect(screen.getByText(/Connected as researcher@example\.edu/)).toBeInTheDocument();

    fireEvent.click(signOut);
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(
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

  it.each([
    ["the account belongs to another host", {
      overleaf_status: { ...connected, host: "https://overleaf-b.example" },
      overleaf_link: { ...linkedProject, host: "https://overleaf-a.example" },
    }, [/This project uses https:\/\/overleaf-a\.example/, /Sign out above, then connect to that host/]],
    ["connection status cannot be read", {
      overleaf_status: () => { throw new Error("Keychain is unavailable"); },
      overleaf_link: linkedProject,
    }, ["Keychain is unavailable", /Connection status is unavailable\. This project remains linked to https:\/\/www\.overleaf\.com/]],
  ])("keeps a linked project's controls unavailable when %s", async (_case, commands: CommandTable, notices) => {
    mockInvoke(commands);
    render(settings());
    expect(await screen.findByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    for (const notice of notices) expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
  });
});

describe("Overleaf picker dialog", () => {
  it("lists projects with owner and update time, hides archived ones until asked, and filters by search", async () => {
    mockConnectedPicker();
    renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Open from Overleaf" });
    expect(dialog).toHaveClass("modal-dialog-content");
    expect(within(dialog).queryByRole("separator")).not.toBeInTheDocument();
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(screen.getByText("Thesis Draft")).toBeInTheDocument();
    expect(screen.getByText(/Ada · updated/)).toBeInTheDocument();
    const projectListViewport = screen.getByLabelText("Overleaf projects");
    expect(projectListViewport).toHaveAttribute("data-slot", "scroll-area-viewport");
    expect(projectListViewport.querySelectorAll("[data-slot='scroll-area-viewport']")).toHaveLength(0);
    expect(projectListViewport.closest("[data-slot='scroll-area']")).toHaveClass("overleaf-project-list-scroll");
    expect(screen.queryByText("Old Notes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByText("Old Notes")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search Overleaf projects"), { target: { value: "atten" } });
    expect(screen.getByText("Attention Paper")).toBeInTheDocument();
    expect(screen.queryByText("Thesis Draft")).not.toBeInTheDocument();
  });

  it("groups owned projects and supports searching, arrow navigation and Enter to open", async () => {
    mockConnectedPicker();
    renderPicker();
    await screen.findByText("Attention Paper");
    expect(within(screen.getByRole("region", { name: "Your projects" })).getByText("Attention Paper")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Other projects" })).getByText("Thesis Draft")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /Attention Paper/ });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /Thesis Draft/ });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs()));
  });

  it("opens the focused row on Enter, not the selected one, and leaves other targets and IME input alone", async () => {
    mockConnectedPicker({ overleaf_clone_project: "/tmp/cloned/Thesis Draft" });
    renderPicker();
    const first = await screen.findByRole("button", { name: /Attention Paper/ });
    fireEvent.click(first);
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    // WebKit can report the accepting Enter as keyCode 229 / "Process", or
    // right after compositionend with no composing flag at all.
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(search, { key: "Process" });
    fireEvent.compositionStart(search);
    fireEvent.compositionEnd(search);
    fireEvent.keyDown(search, { key: "Enter" });
    // The guard lifts once the event turn that ended composition is over.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.change(search, { target: { value: "a" } });
    const clear = screen.getByRole("button", { name: "Clear search" });
    fireEvent.keyDown(clear, { key: "Enter" });
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", expect.anything());
    fireEvent.keyDown(screen.getByRole("button", { name: /Thesis Draft/ }), { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "overleaf_clone_project", cloneArgs({ projectId: "p2", name: "Thesis Draft", accessLevel: "readAndWrite" }),
    ));
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", cloneArgs());
  });

  it("uploads the current local project and keeps the dialog locked until it is linked", async () => {
    mockConnectedPicker();
    vi.mocked(confirm).mockResolvedValue(true);
    let finishPublish: (published: boolean) => void = () => undefined;
    const onPublish = vi.fn(() => new Promise<boolean>((resolve) => { finishPublish = resolve; }));
    const { onClose } = renderPicker({ currentProject: { name: "Local Draft" }, onPublish });
    const name = await screen.findByRole("textbox", { name: "New Overleaf project name" });
    expect(name).toHaveValue("Local Draft");
    fireEvent.change(name, { target: { value: "Shared Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and connect" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(vi.mocked(confirm).mock.calls[0]![0]).toContain("Lattice app data");
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith("Shared Draft"));
    expect(await screen.findByText(/Uploading Shared Draft to Overleaf/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeDisabled();
    expect(screen.getByLabelText("Search Overleaf projects")).toBeDisabled();
    finishPublish(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("clones the selected project and reports the new root", async () => {
    mockConnectedPicker();
    const { onClose, onBeforeClone, onCloned } = renderPicker();
    await openFirstProject();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs()));
    expect(onBeforeClone).toHaveBeenCalledOnce();
    const cloneCall = vi.mocked(invoke).mock.calls.findIndex(([command]) => command === "overleaf_clone_project");
    expect(onBeforeClone.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[cloneCall]!);
    // The backend answers with the folder a project already lives in, so an
    // already-downloaded project is an ordinary open, not a failure.
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not change roots when the current project is still syncing", async () => {
    mockConnectedPicker();
    const onBeforeClone = vi.fn(() => false);
    const { onCloned } = renderPicker({ onBeforeClone });
    await openFirstProject();

    await waitFor(() => expect(onBeforeClone).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", expect.anything());
    expect(onCloned).not.toHaveBeenCalled();
  });

  it.each(["owner", "readAndWrite", "readOnly", "review", "unknown", null] as const)(
    "preserves the %s access level when cloning",
    async (accessLevel) => {
      mockConnectedPicker({ overleaf_list_projects: [{ ...projects[0]!, accessLevel }] });
      renderPicker();
      await openFirstProject();
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs({ accessLevel })));
    },
  );

  it.each([true, false])("offers to link a folder left behind by Stop syncing instead of a second copy (accepted: %s)", async (accepted) => {
    mockConnectedPicker({
      overleaf_clone_target: { kind: "occupied", path: "/tmp/cloned/Attention Paper", folder: "Attention Paper" },
    });
    vi.mocked(confirm).mockResolvedValue(accepted);
    renderPicker();
    await openFirstProject();

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(vi.mocked(confirm).mock.calls[0]![0]).toContain("local conflict");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs({ adopt: accepted })));
  });

  it("still reports a real failure and keeps the dialog open", async () => {
    mockConnectedPicker({ overleaf_clone_project: () => { throw new Error("Could not reach Overleaf."); } });
    render(<AppToastStack />);
    const { onClose, onBeforeClone, onCloneCancelled } = renderPicker();
    await openFirstProject();
    // The modal repeats transfer errors inline so its focus trap does not
    // hide the failure from assistive technology.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach Overleaf/);
    expect(onBeforeClone).toHaveBeenCalledOnce();
    expect(onCloneCancelled).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs the standard connect flow inside the dialog when not connected", async () => {
    mockInvoke({ overleaf_status: disconnected, overleaf_list_projects: projects, ...signsIn });
    renderPicker();
    expect(await screen.findByText(/isn’t connected yet/)).toBeInTheDocument();
    // The disconnected state stays focused on standard sign-in.
    expect(screen.queryByRole("button", { name: "Advanced options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect to Overleaf" }));
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
  });

  it("turns an expired project-list session into a guided reconnect state", async () => {
    let listAttempts = 0;
    mockConnectedPicker({
      overleaf_list_projects: () => {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error("Overleaf session expired. Reconnect in Settings → Overleaf.");
        return projects;
      },
      overleaf_disconnect: undefined,
      ...signsIn,
    });
    renderPicker();

    expect(await screen.findByText(/Your Overleaf session has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/Reconnect in Settings/)).not.toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_disconnect"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect to Overleaf" }));

    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_begin_login", { title: "Sign in to Overleaf" });
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("closes on Escape only while no download is in flight", async () => {
    let resolveClone: (root: string) => void = () => undefined;
    mockConnectedPicker({ overleaf_clone_project: () => new Promise<string>((resolve) => { resolveClone = resolve; }) });
    const { onClose } = renderPicker();
    await openFirstProject();
    expect(await screen.findByText(/Downloading Attention Paper from Overleaf/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeDisabled();
    resolveClone("/tmp/cloned/Attention Paper");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
