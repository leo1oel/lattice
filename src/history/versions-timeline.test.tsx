import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { VersionsTimeline } from "./versions-timeline";
import { AppToastStack } from "../telemetry/app-log";
import { clearAppLogs } from "../telemetry/app-log-store";
import type { GitLogEntry } from "../app-types";
import { mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

const repoStatus = { available: true, repository: true, branch: "main", files: [] };

const logEntries: GitLogEntry[] = [
  {
    hash: "aaa111", shortHash: "aaa111", authorName: "Robin", timestamp: "2026-07-24T00:00:00Z", message: "Tighten the abstract",
    files: [{ path: "main.tex", kind: "modified" }, { path: "figs/loss.png", kind: "added" }],
  },
  {
    hash: "bbb222", shortHash: "bbb222", authorName: "Mia", timestamp: "2026-07-23T00:00:00Z", message: "Initial import",
    files: [{ path: "main.tex", kind: "added" }],
  },
];

/** A repository with `logEntries`, plus whatever else the test needs answered. */
function mockGitLog(extra: CommandTable = {}) {
  mockInvoke({ git_status: repoStatus, git_log: logEntries, ...extra });
}

const lineDiff = { git_show_diff: { before: "old line\n", after: "new line\n", binary: false } };

async function expandFirstEntry() {
  fireEvent.click(await screen.findByRole("button", { name: /Tighten the abstract/ }));
  const body = document.querySelector<HTMLElement>(".versions-entry.expanded");
  expect(body).not.toBeNull();
  return body!;
}

afterEach(() => {
  cleanup();
  clearAppLogs();
  // Also restores `listen`'s factory implementation and drops queued `confirm` answers.
  vi.resetAllMocks();
});

describe("VersionsTimeline", () => {
  it("shows a graceful note when git is unavailable", async () => {
    mockInvoke({ git_status: { available: false, repository: false, branch: null, files: [] } });
    render(<VersionsTimeline />);
    expect(await screen.findByText("Version history needs Git, which isn’t available on this Mac")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save version/ })).not.toBeInTheDocument();
  });

  it("shows the empty-repo state and enables tracking via git_init", async () => {
    let repository = false;
    mockInvoke({
      git_status: () => ({ ...repoStatus, repository }),
      git_init: () => ({ ...repoStatus, repository: (repository = true) }),
      git_log: [],
    });
    render(<VersionsTimeline />);

    expect(await screen.findByText("Track versions of this project to see who changed what and roll back safely")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable version tracking/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_init"));
    expect(await screen.findByText(/No versions yet\./)).toBeInTheDocument();
  });

  it("renders timeline entries with authors, messages, and file counts", async () => {
    mockGitLog();
    render(<VersionsTimeline />);

    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
    for (const text of ["Initial import", "Robin", "Mia", "2 files", "1 file"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(invoke).toHaveBeenCalledWith("git_log", { limit: 100 });

    const body = await expandFirstEntry();
    for (const name of [/main\.tex/, /figs\/loss\.png/, /Restore project to this version/]) {
      expect(within(body).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("loads a file diff via git_show_diff into one non-virtualized Pierre surface, and closes it on a second click", async () => {
    mockGitLog(lineDiff);
    render(<VersionsTimeline />);

    const row = within(await expandFirstEntry()).getByRole("button", { name: /main\.tex/ });
    fireEvent.click(row);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_show_diff", { rev: "aaa111", path: "main.tex" }));
    const viewer = await screen.findByLabelText("Diff for main.tex");
    await waitFor(() => expect(viewer.querySelector("diffs-container")).not.toBeNull());
    expect(viewer.querySelectorAll("diffs-container")).toHaveLength(1);
    expect(viewer.querySelector("[data-virtualizer]")).toBeNull();

    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByLabelText("Diff for main.tex")).not.toBeInTheDocument());
  });

  it("notes binary files instead of rendering a diff", async () => {
    mockGitLog({ git_show_diff: { before: null, after: null, binary: true } });
    render(<VersionsTimeline />);

    fireEvent.click(within(await expandFirstEntry()).getByRole("button", { name: /figs\/loss\.png/ }));
    expect(await screen.findByText("Binary file changed")).toBeInTheDocument();
  });

  it("restores a file only after confirmation and reports the change", async () => {
    const onVersionsChanged = vi.fn();
    mockGitLog({ ...lineDiff, git_restore_file: undefined });
    render(<VersionsTimeline onVersionsChanged={onVersionsChanged} />);

    fireEvent.click(within(await expandFirstEntry()).getByRole("button", { name: /main\.tex/ }));
    const restore = await screen.findByRole("button", { name: /Restore this file/ });

    vi.mocked(confirm).mockResolvedValueOnce(false);
    fireEvent.click(restore);
    expect(invoke).not.toHaveBeenCalledWith("git_restore_file", { rev: "aaa111", path: "main.tex" });

    vi.mocked(confirm).mockResolvedValueOnce(true);
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_restore_file", { rev: "aaa111", path: "main.tex" }));
    expect(confirm).toHaveBeenCalledWith("Restore main.tex to this version? Your current file will be overwritten.", expect.anything());
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalledTimes(1));
  });

  it("saves a manual version with the typed label", async () => {
    const onVersionsChanged = vi.fn();
    mockGitLog({ git_auto_commit: "ccc333" });
    // Outcomes are toasts now, so the shared stack has to be on screen for the
    // assertion below to mean what it did when the panel printed them inline.
    render(<><VersionsTimeline onVersionsChanged={onVersionsChanged} /><AppToastStack /></>);

    fireEvent.click(await screen.findByRole("button", { name: /Save version/ }));
    fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "Before rebuttal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_auto_commit", { message: "Before rebuttal", author: null }));
    expect(await screen.findByText("Version saved.")).toBeInTheDocument();
    expect(onVersionsChanged).toHaveBeenCalledTimes(1);
  });

  it("refreshes an open timeline when project files change", async () => {
    mockGitLog();
    render(<VersionsTimeline projectRoot="/tmp/paper" />);
    await screen.findByRole("button", { name: /Tighten the abstract/ });
    const updated = { ...logEntries[0], hash: "new123", message: "Latest agent edits" };
    mockInvoke({ git_status: repoStatus, git_log: [updated, ...logEntries] });
    const subscription = vi.mocked(listen).mock.calls.find(([name]) => name === "project-fs-changed");
    expect(subscription).toBeDefined();
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => subscription![1]({ event: "project-fs-changed", id: 1, payload: { root: "/tmp/other" } }));
    expect(vi.mocked(invoke).mock.calls).toHaveLength(calls);
    act(() => subscription![1]({ event: "project-fs-changed", id: 1, payload: { root: "/tmp/paper" } }));
    expect(await screen.findByRole("button", { name: /Latest agent edits/ })).toBeInTheDocument();
  });

  it("restores the whole project after confirmation, reporting success only after the reload and build", async () => {
    let finish!: () => void;
    const onVersionsChanged = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    mockGitLog({ git_restore_project: "ddd444" });
    vi.mocked(confirm).mockResolvedValue(true);
    render(<><VersionsTimeline onVersionsChanged={onVersionsChanged} /><AppToastStack /></>);
    const restore = within(await expandFirstEntry()).getByRole("button", { name: /Restore project to this version/ });
    fireEvent.click(restore);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_restore_project", { rev: "aaa111" }));
    expect(vi.mocked(confirm).mock.calls[0]?.[0]).toMatch(/nothing is lost/);
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalledTimes(1));
    expect(restore).toBeDisabled();
    expect(screen.queryByText("Project restored.")).not.toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByText("Project restored.")).toBeInTheDocument();
    expect(restore).toBeEnabled();
  });
});
