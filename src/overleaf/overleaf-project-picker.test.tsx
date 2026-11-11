import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverleafPickerDialog } from "./overleaf-project-picker";
import { ToastStack } from "../telemetry/toast-stack";
import { clearAppLogs } from "../telemetry/app-log-store";
import type { OverleafInvite, OverleafProject, OverleafProjectList, OverleafStatus } from "../app-types";
import { invokeCalls, mockInvoke, mockListen, type CommandTable } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const disconnected: OverleafStatus = { connected: false, expired: false, email: null, name: null, host: "https://www.overleaf.com" };
const connected: OverleafStatus = { ...disconnected, connected: true, email: "researcher@example.edu", name: "Robin" };
/** A sign-in window that reports the account connected on the first poll. */
const signsIn: CommandTable = {
  overleaf_begin_login: undefined, overleaf_cancel_login: undefined, overleaf_poll_login: { status: "connected", session: connected },
};

const project = (id: string, name: string, overrides: Partial<OverleafProject> = {}): OverleafProject => ({
  id, name, lastUpdated: "2026-07-24T00:00:00Z", ownerEmail: "researcher@example.edu", ownerName: "Robin",
  accessLevel: "owner", archived: false, trashed: false, ...overrides,
});
const projects = [
  project("p1", "Attention Paper"),
  project("p2", "Thesis Draft", { lastUpdated: "2026-07-20T00:00:00Z", ownerEmail: "ada@example.edu", ownerName: "Ada", accessLevel: "readAndWrite" }),
  project("p3", "Old Notes", { lastUpdated: null, ownerEmail: null, ownerName: null, archived: true }),
];

/** What `overleaf_list_projects` answers: these projects, and these invitations still waiting on Overleaf. */
const listed = (list: OverleafProject[] = projects, invites: OverleafInvite[] = []): OverleafProjectList => ({ projects: list, invites });

/** A connected account listing `projects`, plus whatever else the test needs answered. */
function mockConnectedPicker(extra: CommandTable = {}) {
  mockInvoke({
    overleaf_status: connected,
    overleaf_list_projects: listed(),
    overleaf_clone_project: "/tmp/cloned/Attention Paper",
    ...extra,
  });
}

/** Render the picker; its callbacks are spies (the optional ones are no-ops unless overridden). */
function renderPicker(props: Partial<Parameters<typeof OverleafPickerDialog>[0]> = {}) {
  const callbacks = { onClose: vi.fn(), onCloned: vi.fn() };
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

// Vitest empties CSS imports, so the picker's stylesheet is loaded off disk
// into jsdom's CSSOM: the sizing test reads computed styles, not source text.
const pickerSheet = document.createElement("style");
pickerSheet.textContent = readFileSync("src/overleaf/overleaf-connect.css", "utf8");
document.head.append(pickerSheet);

afterEach(() => {
  cleanup();
  clearAppLogs();
  vi.resetAllMocks();
});

describe("Overleaf picker dialog", () => {
  // jsdom has no layout, so the test reads the computed sizing of the rendered
  // list. The body and its frame grow with the dialog; a fixed cap on the list
  // inside them left a blank band in the frame, below a last row cut off for
  // want of that very space.
  it("lets the project list fill its frame instead of stopping short of it", async () => {
    mockConnectedPicker();
    renderPicker();
    await screen.findByText("Attention Paper");
    const list = screen.getByLabelText("Overleaf projects").closest<HTMLElement>(".overleaf-project-list-scroll")!;
    const frame = list.closest<HTMLElement>(".overleaf-stage")!;
    const body = frame.closest<HTMLElement>(".overleaf-picker-body")!;

    for (const element of [body, frame, list]) {
      expect(getComputedStyle(element).flexGrow, element.className).toBe("1");
    }
    const listStyle = getComputedStyle(list);
    expect(["0", "0px"]).toContain(listStyle.minHeight);
    expect(["", "none"]).toContain(listStyle.maxHeight);
  });

  it("lists projects with owner and update time, hides archived ones until asked, and filters by search", async () => {
    mockConnectedPicker();
    renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Open from Overleaf" });
    expect(dialog).toHaveClass("modal-dialog-content");
    expect(within(dialog).queryByRole("separator")).not.toBeInTheDocument();
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(screen.getByText("Thesis Draft")).toBeInTheDocument();
    expect(screen.getByText(/Ada, updated/)).toBeInTheDocument();
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

  it("lists every project in Overleaf's own order, newest first whoever owns it, with arrow navigation and Enter to open", async () => {
    const shared = project("p4", "Shared Review", { lastUpdated: "2026-07-30T00:00:00Z", ownerEmail: "ada@example.edu", ownerName: "Ada", accessLevel: "readWrite" });
    mockConnectedPicker({ overleaf_list_projects: listed([...projects, shared]) });
    renderPicker();
    await screen.findByText("Attention Paper");
    // One list: no "Your projects" / "Other projects" split.
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    const rows = screen.getAllByRole("button", { pressed: false }).filter((row) => row.dataset.projectId);
    expect(rows.map((row) => row.dataset.projectId)).toEqual(["p4", "p1", "p2"]);
    expect(within(rows[0]!).getByText(/Ada, updated/)).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /Shared Review/ });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /Attention Paper/ });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
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
    expect(await screen.findByText(/Uploading Shared Draft…/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeDisabled();
    expect(screen.getByLabelText("Search Overleaf projects")).toBeDisabled();
    finishPublish(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("clones the selected project and reports the new root", async () => {
    mockConnectedPicker();
    const { onClose, onCloned } = renderPicker();
    await openFirstProject();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs()));
    // The backend answers with the folder a project already lives in, so an
    // already-downloaded project is an ordinary open, not a failure.
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // The captain's case: a folder linked to the project already sits on this
  // Mac, outside the download folder. Opening the project from Overleaf used
  // to download a second copy that synced too and drifted from the first.
  const nativeVlm = { path: "/Users/me/Papers/Native VLM", display: "~/Papers/Native VLM" };
  it("opens the folder already linked to a project instead of downloading a second copy", async () => {
    mockConnectedPicker({ overleaf_local_copies: { p1: nativeVlm }, overleaf_reopen_local_copy: undefined });
    const onOpenLocalCopy = vi.fn();
    const { onClose, onCloned } = renderPicker({ onOpenLocalCopy, knownFolders: [{ path: nativeVlm.path }] });
    expect(await screen.findByText("Opens your local copy at ~/Papers/Native VLM")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_local_copies", {
      names: ["Attention Paper", "Thesis Draft", "Old Notes"], folders: [nativeVlm.path],
    });
    // Only the project that has a folder here says so.
    const thesis = screen.getByRole("button", { name: /Thesis Draft/ });
    expect(within(thesis).queryByText(/Opens your local copy/)).not.toBeInTheDocument();

    // There is no way to download a second copy beside it.
    fireEvent.click(screen.getByRole("button", { name: /Attention Paper/ }));
    expect(screen.queryByRole("button", { name: "Download a new copy" })).not.toBeInTheDocument();
    await openFirstProject();
    await waitFor(() => expect(onOpenLocalCopy).toHaveBeenCalledWith(nativeVlm.path));
    expect(onClose).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", expect.anything());
    expect(onCloned).not.toHaveBeenCalled();
  });

  // A slow drive among the folders checked can hold the lookup back; Open
  // pressed meanwhile must not download a second copy of a linked folder.
  it("waits for the local-copy lookup before choosing to download", async () => {
    let answer: (copies: unknown) => void = () => undefined;
    mockConnectedPicker({
      overleaf_local_copies: () => new Promise((resolve) => { answer = resolve; }),
      overleaf_reopen_local_copy: undefined,
    });
    const onOpenLocalCopy = vi.fn();
    const { onCloned } = renderPicker({ onOpenLocalCopy });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_local_copies", expect.anything()));
    await openFirstProject();
    // Busy meanwhile: a second Open cannot start another open or download.
    expect(await screen.findByText(/Opening Attention Paper…/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    // A lookup stuck on an unresponsive drive must not trap the writer here.
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    answer({ p1: nativeVlm });
    await waitFor(() => expect(onOpenLocalCopy).toHaveBeenCalledWith(nativeVlm.path));
    expect(onOpenLocalCopy).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", expect.anything());
    expect(onCloned).not.toHaveBeenCalled();
  });

  it("looks up local copies once, not again for each new callback from a re-rendering parent", async () => {
    mockConnectedPicker({ overleaf_local_copies: { p1: nativeVlm } });
    const knownFolders = [{ path: nativeVlm.path }];
    const props = { onClose: vi.fn(), onCloned: vi.fn(), knownFolders };
    const { rerender } = render(<OverleafPickerDialog open {...props} onOpenLocalCopy={() => undefined} />);
    await screen.findByText("Opens your local copy at ~/Papers/Native VLM");
    rerender(<OverleafPickerDialog open {...props} onOpenLocalCopy={() => undefined} />);
    rerender(<OverleafPickerDialog open {...props} onOpenLocalCopy={() => undefined} />);
    expect(invokeCalls("overleaf_local_copies")).toHaveLength(1);
  });

  it("drops an open whose picker closed before the lookup answered", async () => {
    let answer: (copies: unknown) => void = () => undefined;
    mockConnectedPicker({ overleaf_local_copies: () => new Promise((resolve) => { answer = resolve; }) });
    const onOpenLocalCopy = vi.fn();
    const { onCloned } = renderPicker({ onOpenLocalCopy });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_local_copies", expect.anything()));
    await openFirstProject();
    cleanup();
    answer({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_target", expect.anything());
    expect(onCloned).not.toHaveBeenCalled();
  });

  // The role the dashboard reports now is what the copy syncs with: a viewer
  // promoted to editor since the last visit can write at once.
  it.each(["readAndWrite", null] as const)("gives the local copy the %s role Overleaf reports before opening it", async (accessLevel) => {
    mockConnectedPicker({
      overleaf_list_projects: listed([{ ...projects[0]!, accessLevel }]),
      overleaf_local_copies: { p1: nativeVlm },
      overleaf_reopen_local_copy: undefined,
    });
    const onOpenLocalCopy = vi.fn();
    renderPicker({ onOpenLocalCopy });
    await screen.findByText("Opens your local copy at ~/Papers/Native VLM");
    await openFirstProject();
    await waitFor(() => expect(onOpenLocalCopy).toHaveBeenCalledWith(nativeVlm.path));
    expect(invoke).toHaveBeenCalledWith("overleaf_reopen_local_copy", { path: nativeVlm.path, projectId: "p1", accessLevel });
    const reopen = vi.mocked(invoke).mock.calls.findIndex(([command]) => command === "overleaf_reopen_local_copy");
    expect(vi.mocked(invoke).mock.invocationCallOrder[reopen]).toBeLessThan(onOpenLocalCopy.mock.invocationCallOrder[0]!);
  });

  it("reports a local copy it could not ready and keeps the dialog open", async () => {
    mockConnectedPicker({
      overleaf_local_copies: { p1: nativeVlm },
      overleaf_reopen_local_copy: () => { throw new Error("/Users/me/Papers/Native VLM is no longer linked to this Overleaf project."); },
    });
    const onOpenLocalCopy = vi.fn();
    const { onClose } = renderPicker({ onOpenLocalCopy });
    await screen.findByText("Opens your local copy at ~/Papers/Native VLM");
    await openFirstProject();
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(/no longer linked/));
    expect(onOpenLocalCopy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("downloads as before when no folder here is linked to the project", async () => {
    mockConnectedPicker({ overleaf_local_copies: {} });
    const onOpenLocalCopy = vi.fn();
    const { onCloned } = renderPicker({ onOpenLocalCopy });
    await openFirstProject();
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
    expect(screen.queryByRole("button", { name: "Download a new copy" })).not.toBeInTheDocument();
    expect(onOpenLocalCopy).not.toHaveBeenCalled();
  });

  it.each(["owner", "readAndWrite", "readOnly", "review", "unknown", null] as const)(
    "preserves the %s access level when cloning",
    async (accessLevel) => {
      mockConnectedPicker({ overleaf_list_projects: listed([{ ...projects[0]!, accessLevel }]) });
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
    expect(vi.mocked(confirm).mock.calls[0]![0]).toContain("kept side by side");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", cloneArgs({ adopt: accepted })));
  });

  it("still reports a real failure and keeps the dialog open", async () => {
    mockConnectedPicker({ overleaf_clone_project: () => { throw new Error("Could not reach Overleaf."); } });
    render(<ToastStack />);
    const { onClose, onCloned } = renderPicker();
    await openFirstProject();
    // The modal repeats transfer errors inline so its focus trap does not
    // hide the failure from assistive technology.
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(/Could not reach Overleaf/));
    expect(onCloned).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs the standard connect flow inside the dialog when not connected", async () => {
    mockInvoke({ overleaf_status: disconnected, overleaf_list_projects: listed(), ...signsIn });
    renderPicker();
    expect(await screen.findByRole("button", { name: "Connect to Overleaf" })).toBeInTheDocument();
    // The disconnected state stays focused on standard sign-in.
    expect(screen.queryByRole("button", { name: "Advanced options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect to Overleaf" }));
    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
  });

  it("turns an expired project-list session into a guided reconnect state", async () => {
    let listAttempts = 0;
    let status = connected;
    mockConnectedPicker({
      overleaf_status: () => status,
      overleaf_list_projects: () => {
        listAttempts += 1;
        if (listAttempts === 1) {
          // The backend records the expiry before it answers.
          status = { ...connected, connected: false, expired: true };
          throw new Error("Overleaf session expired. Reconnect in Settings → Overleaf.");
        }
        return listed();
      },
      ...signsIn,
    });
    renderPicker();

    expect(await screen.findByText(/Your Overleaf session expired/)).toBeInTheDocument();
    expect(screen.queryByText(/Reconnect in Settings/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("overleaf_disconnect");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect to Overleaf" }));

    expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_begin_login", { title: "Sign in to Overleaf", backLabel: "Back to Overleaf sign-in" });
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("says how much of a long download has arrived (#670)", async () => {
    const emit = mockListen();
    let resolveClone: (root: string) => void = () => undefined;
    mockConnectedPicker({ overleaf_clone_project: () => new Promise<string>((resolve) => { resolveClone = resolve; }) });
    const { onCloned } = renderPicker();
    await openFirstProject();
    expect(await screen.findByText("Downloading Attention Paper…")).toBeInTheDocument();
    await waitFor(() => expect(listen).toHaveBeenCalledWith("overleaf-download-progress", expect.any(Function)));
    // Overleaf streams the zip as it builds it, so usually without a size:
    // the bar sweeps and says what has arrived.
    emit({ received: 12_400_000, total: null });
    expect(await screen.findByText(/^12\.4 MB received · 0:\d\d elapsed$/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar).toHaveAttribute("data-indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // With a size, it fills.
    emit({ received: 30_000_000, total: 41_000_000 });
    expect(await screen.findByText(/^30 MB of 41 MB/)).toBeInTheDocument();
    expect(screen.getByText("73%")).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow", "73");
    expect(bar).not.toHaveAttribute("data-indeterminate");
    resolveClone("/tmp/cloned/Attention Paper");
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/tmp/cloned/Attention Paper"));
  });

  it("closes on Escape only while no download is in flight", async () => {
    let resolveClone: (root: string) => void = () => undefined;
    mockConnectedPicker({ overleaf_clone_project: () => new Promise<string>((resolve) => { resolveClone = resolve; }) });
    const { onClose } = renderPicker();
    await openFirstProject();
    expect(await screen.findByText(/Downloading Attention Paper…/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Open from Overleaf" })).toBeDisabled();
    resolveClone("/tmp/cloned/Attention Paper");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows invitations still waiting on Overleaf, opens them there, and reloads the list after", async () => {
    const invite: OverleafInvite = {
      projectId: "p9", projectName: "Grant Draft", inviterName: "Ada", url: "https://www.overleaf.com/project/p9/invite/token/t1",
    };
    let list = listed(projects, [invite]);
    mockConnectedPicker({ overleaf_list_projects: () => list });
    renderPicker();
    const invitations = await screen.findByRole("region", { name: "Invitations" });
    expect(within(invitations).getByText("Grant Draft")).toBeInTheDocument();
    expect(within(invitations).getByText("Ada invited you. Accept on Overleaf to open it here")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload list" })).not.toBeInTheDocument();
    // Accepting is done on Overleaf: Lattice opens the invitation there.
    fireEvent.click(within(invitations).getByRole("button", { name: "Open invitation" }));
    expect(openUrl).toHaveBeenCalledWith(invite.url);
    list = listed([...projects, project("p9", "Grant Draft", { ownerName: "Ada", accessLevel: "readWrite" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Reload list" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Invitations" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Grant Draft/ })).toBeInTheDocument();
  });

  it("opens a project from a pasted link through the usual download", async () => {
    const shared = project("64b000000000000000000002", "Shared Paper", { ownerName: "Ada", accessLevel: "readWrite" });
    const link = "https://www.overleaf.com/project/64b000000000000000000002";
    mockConnectedPicker({ overleaf_resolve_link: { kind: "project", project: shared }, overleaf_clone_project: "/tmp/cloned/Shared Paper" });
    renderPicker();
    await screen.findByText("Attention Paper");
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    fireEvent.change(search, { target: { value: link } });
    // A link is looked up, not used to filter the list.
    expect(await screen.findByText("Shared Paper")).toBeInTheDocument();
    expect(screen.queryByText("Attention Paper")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_resolve_link", { link });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_clone_project", {
      projectId: shared.id, name: "Shared Paper", accessLevel: "readWrite", adopt: false,
    }));
  });

  it("asks Overleaf once for a link typed out by hand", async () => {
    mockConnectedPicker({ overleaf_resolve_link: { kind: "unrecognized" } });
    renderPicker();
    await screen.findByText("Attention Paper");
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    for (const typed of ["www.overleaf.com/", "www.overleaf.com/read/", "www.overleaf.com/read/abcdefghijkl"]) {
      fireEvent.change(search, { target: { value: typed } });
    }
    expect(await screen.findByText("That isn’t an Overleaf project link")).toBeInTheDocument();
    const asked = vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_resolve_link");
    expect(asked).toEqual([["overleaf_resolve_link", { link: "www.overleaf.com/read/abcdefghijkl" }]]);
    // Words are still a search.
    fireEvent.change(search, { target: { value: "thesis" } });
    expect(await screen.findByText("Thesis Draft")).toBeInTheDocument();
  });

  it.each([
    [{ kind: "needsJoin", projectName: "Lab Notes", url: "https://www.overleaf.com/read/abcdefghijkl" },
      "This account hasn’t joined “Lab Notes” yet", "Open link in browser"],
    [{ kind: "invited", projectName: "Grant Draft", url: "https://www.overleaf.com/project/p9/invite/token/t1" },
      "Your invitation to “Grant Draft” is waiting on Overleaf", "Open invitation"],
    [{ kind: "noAccess" }, "researcher@example.edu can’t open this project", null],
    [{ kind: "notFound" }, "Overleaf doesn’t recognize this link", null],
    [{ kind: "otherHost", host: "latex.example.edu" }, "This link is for latex.example.edu", null],
  ] as const)("says what to do on Overleaf when a pasted link opens nothing yet (%o)", async (answer, title, action) => {
    mockConnectedPicker({ overleaf_resolve_link: answer });
    renderPicker();
    await screen.findByText("Attention Paper");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Overleaf projects" }), { target: { value: "https://www.overleaf.com/x/y" } });
    expect(await screen.findByText(title)).toBeInTheDocument();
    if (action && "url" in answer) {
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(openUrl).toHaveBeenCalledWith(answer.url);
    }
    expect(invoke).not.toHaveBeenCalledWith("overleaf_clone_project", expect.anything());
  });

  it("asks again when the same link is pasted after joining on Overleaf", async () => {
    const shared = project("64b000000000000000000002", "Lab Notes", { ownerName: "Ada", accessLevel: "readWrite" });
    const link = "https://www.overleaf.com/read/abcdefghijkl";
    let joined = false;
    mockConnectedPicker({
      overleaf_resolve_link: () => joined
        ? { kind: "project", project: shared }
        : { kind: "needsJoin", projectName: "Lab Notes", url: link },
    });
    renderPicker();
    await screen.findByText("Attention Paper");
    const search = screen.getByRole("searchbox", { name: "Search Overleaf projects" });
    fireEvent.paste(search);
    fireEvent.change(search, { target: { value: link } });
    expect(await screen.findByText("This account hasn’t joined “Lab Notes” yet")).toBeInTheDocument();
    joined = true;
    // Pasting over the same text changes nothing in the field.
    fireEvent.paste(search);
    expect(await screen.findByRole("button", { name: /Lab Notes/ })).toBeInTheDocument();
    expect(screen.queryByText("This account hasn’t joined “Lab Notes” yet")).not.toBeInTheDocument();
    const asked = vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_resolve_link");
    expect(asked).toEqual([["overleaf_resolve_link", { link }], ["overleaf_resolve_link", { link }]]);
  });

  it("offers a retry when looking up a link fails", async () => {
    let attempts = 0;
    mockConnectedPicker({
      overleaf_resolve_link: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Could not reach Overleaf: timed out");
        return { kind: "noAccess" };
      },
    });
    renderPicker();
    await screen.findByText("Attention Paper");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Overleaf projects" }), { target: { value: "https://www.overleaf.com/project/x" } });
    expect(await screen.findByText("Could not reach Overleaf: timed out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("researcher@example.edu can’t open this project")).toBeInTheDocument();
  });
});
