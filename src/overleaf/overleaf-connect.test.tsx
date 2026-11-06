import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverleafSettingsSection } from "./overleaf-connect";
import { clearAppLogs, getAppLogEntry, getAppToastOptions, getVisibleAppToastIds } from "../telemetry/app-log-store";
import type { OverleafLink, OverleafStatus } from "../app-types";
import { invokeCalls, mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const disconnected: OverleafStatus = { connected: false, expired: false, email: null, name: null, host: "https://www.overleaf.com" };
const connected: OverleafStatus = { ...disconnected, connected: true, email: "researcher@example.edu", name: "Robin" };
const linkedProject: OverleafLink = {
  projectId: "p1", projectName: "Attention Paper", host: "https://www.overleaf.com", lastSync: "2026-07-24T00:00:00Z", paused: false,
};
/** A sign-in window that reports the account connected on the first poll. */
const signsIn: CommandTable = {
  overleaf_begin_login: undefined, overleaf_cancel_login: undefined, overleaf_poll_login: { status: "connected", session: connected },
};

type SettingsProps = Parameters<typeof OverleafSettingsSection>[0];
const settingsDefaults: SettingsProps = {
  projectRoot: "/tmp/project", syncMode: "live", onSyncModeChange: () => {}, channel: "off", channelDetail: null,
  remoteDelete: "ask", onRemoteDeleteChange: () => {}, onLinkChanged: () => {},
};
const settings = (props: Partial<SettingsProps> = {}) => <OverleafSettingsSection {...settingsDefaults} {...props} />;

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
    // "Live sync" and "Manual" say what they do; only a live channel's state gets a line.
    expect(descriptionOf("Sync mode")).toBeFalsy();
    await pick(syncMode, "Manual");
    expect(onSyncModeChange).toHaveBeenCalledWith("manual");
    rerender(settings({ syncMode: "manual", onSyncModeChange, onRemoteDeleteChange }));
    expect(descriptionOf("Sync mode")).toBeFalsy();
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
    expect(await screen.findByRole("heading", { name: "Overleaf" })).toBeInTheDocument();

    // The waiting state shows while the login window is open, and cancels cleanly.
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/Sign-in was cancelled/)).toBeInTheDocument();
    // The backend closes the sign-in window and saves nothing a poll still
    // under way captures, so the account cannot connect behind "cancelled".
    expect(invokeCalls("overleaf_cancel_login")).toHaveLength(1);

    poll = signsIn.overleaf_poll_login;
    fireEvent.click(screen.getByRole("button", { name: /Connect to Overleaf/ }));
    await waitFor(() => expect(invokeCalls("overleaf_begin_login")).toHaveLength(2));
    expect(await screen.findByText(/Connected as researcher@example\.edu/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_poll_login");
  });

  it("ignores a poll from a cancelled sign-in once the next sign-in has started", async () => {
    let answerFirstPoll: (poll: unknown) => void = () => undefined;
    const firstPoll = new Promise((resolve) => { answerFirstPoll = resolve; });
    let polls = 0;
    mockInvoke({
      ...signsIn,
      overleaf_status: disconnected,
      overleaf_poll_login: () => (++polls === 1 ? firstPoll : { status: "pending", session: null }),
    });
    render(settings());

    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: /Connect to Overleaf/ }));
    expect(await screen.findByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign-in was cancelled/)).not.toBeInTheDocument();
    await waitFor(() => expect(polls).toBe(2));

    // The backend answers the first attempt's poll with "cancelled" because
    // that attempt has ended; it must not end the attempt now under way.
    answerFirstPoll({ status: "cancelled", session: null });
    await firstPoll;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/Waiting for you to sign in in the Overleaf window/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign-in was cancelled/)).not.toBeInTheDocument();
    expect(invokeCalls("overleaf_cancel_login")).toHaveLength(1);
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
    vi.mocked(confirm).mockClear();
    render(settings({ onLinkChanged }));
    expect(await screen.findByText(/This project syncs with “Attention Paper”/)).toBeInTheDocument();
    expect(screen.queryByText(/This project uses \./)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Pause syncing" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_set_paused", { projectRoot: "/tmp/project", paused: true }));
    // Without this the cloud button, live channel and chat all kept running
    // against a project that had just been told to stop.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalled());
    // Nothing is lost by pausing, so it happens at once and the notice offers
    // Resume instead of a confirmation standing in front of it.
    expect(confirm).not.toHaveBeenCalled();
    const notice = getVisibleAppToastIds().map(getAppLogEntry).find((entry) => entry?.title === "Overleaf sync paused");
    expect(notice && getAppToastOptions(notice.id)?.primaryAction?.label).toBe("Resume");

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
      expect.stringMatching(/Sign out of Overleaf\?[\s\S]*Linked projects stop syncing[\s\S]*Downloaded files stay on this Mac/),
      expect.objectContaining({ kind: "warning" }),
    ));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_disconnect"));
    expect(await screen.findByRole("button", { name: /Connect to Overleaf/ })).toBeInTheDocument();
    expect(screen.getByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    expect(screen.getByText(/Sign in to https:\/\/www\.overleaf\.com to resume syncing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
    expect(onLinkChanged).toHaveBeenCalled();
  });

  it.each([
    ["the account belongs to another host", {
      overleaf_status: { ...connected, host: "https://overleaf-b.example" },
      overleaf_link: { ...linkedProject, host: "https://overleaf-a.example" },
    }, [/This project uses https:\/\/overleaf-a\.example/, /Sign out and connect to it to resume/]],
    ["connection status cannot be read", {
      overleaf_status: () => { throw new Error("Keychain is unavailable"); },
      overleaf_link: linkedProject,
    }, ["Keychain is unavailable", /Couldn’t check the connection\. Still linked to https:\/\/www\.overleaf\.com/]],
  ])("keeps a linked project's controls unavailable when %s", async (_case, commands: CommandTable, notices) => {
    mockInvoke(commands);
    render(settings());
    expect(await screen.findByText(/“Attention Paper” stays linked/)).toBeInTheDocument();
    for (const notice of notices) expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause syncing|Resume syncing/ })).not.toBeInTheDocument();
  });
});
