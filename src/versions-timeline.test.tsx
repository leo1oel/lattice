import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HistoryDrawer } from "./history-drawer";
import { VersionsTimeline } from "./versions-timeline";
import type { GitLogEntry } from "./app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const repoStatus = { available: true, repository: true, branch: "main", files: [] };

const logEntries: GitLogEntry[] = [
  {
    hash: "aaa111",
    shortHash: "aaa111",
    authorName: "Leo",
    timestamp: "2026-07-24T00:00:00Z",
    message: "Tighten the abstract",
    files: [
      { path: "main.tex", kind: "modified" },
      { path: "figs/loss.png", kind: "added" },
    ],
  },
  {
    hash: "bbb222",
    shortHash: "bbb222",
    authorName: "Mia",
    timestamp: "2026-07-23T00:00:00Z",
    message: "Initial import",
    files: [{ path: "main.tex", kind: "added" }],
  },
];

function mockGitLog() {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "git_status") return repoStatus;
    if (command === "git_log") return logEntries;
    throw new Error(`Unexpected command: ${command}`);
  });
}

async function expandFirstEntry() {
  fireEvent.click(await screen.findByRole("button", { name: /Tighten the abstract/ }));
  const body = document.querySelector<HTMLElement>(".versions-entry.expanded");
  expect(body).not.toBeNull();
  return body!;
}

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
});

describe("HistoryDrawer tabs", () => {
  const historyItem = {
    id: "t1",
    label: "Edit main.tex",
    timestamp: "2026-07-16T00:00:00Z",
    files: ["main.tex"],
  };

  // This test runs before the fallback test below: both mutate the module-level
  // last-used-tab memory, and this one ends by re-selecting Versions.
  it("defaults to Versions and keeps Changes content across tab switches", async () => {
    mockGitLog();
    render(
      <HistoryDrawer
        history={[historyItem]}
        onClose={() => undefined}
        onRevert={() => undefined}
        onDelete={() => undefined}
      />,
    );

    // Versions is the default tab.
    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
    expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByText("Edit main.tex")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();

    // Switching back still shows the same Changes content.
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.getByText("Edit main.tex")).toBeInTheDocument();

    // Leave the module-level tab memory on Versions for the next test.
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
  });

  it("falls back to the Changes tab when the git backend is unreachable", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <HistoryDrawer
        history={[historyItem]}
        onClose={() => undefined}
        onRevert={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(await screen.findByText("Edit main.tex")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("VersionsTimeline", () => {
  it("shows a graceful note when git is unavailable", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return { available: false, repository: false, branch: null, files: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<VersionsTimeline />);
    expect(
      await screen.findByText("Version history needs Git, which isn't available on this Mac."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save version/ })).not.toBeInTheDocument();
  });

  it("shows the empty-repo state and enables tracking via git_init", async () => {
    let repository = false;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return { ...repoStatus, repository };
      if (command === "git_init") {
        repository = true;
        return { ...repoStatus, repository };
      }
      if (command === "git_log") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<VersionsTimeline />);

    expect(
      await screen.findByText("Track versions of this project to see who changed what and roll back safely."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable version tracking/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_init"));
    expect(await screen.findByText(/No versions yet\./)).toBeInTheDocument();
  });

  it("renders timeline entries with authors, messages, and file counts", async () => {
    mockGitLog();
    render(<VersionsTimeline />);

    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
    expect(screen.getByText("Initial import")).toBeInTheDocument();
    expect(screen.getByText("Leo")).toBeInTheDocument();
    expect(screen.getByText("Mia")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("1 file")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_log", { limit: 100 });

    const body = await expandFirstEntry();
    expect(within(body).getByRole("button", { name: /main\.tex/ })).toBeInTheDocument();
    expect(within(body).getByRole("button", { name: /figs\/loss\.png/ })).toBeInTheDocument();
    expect(within(body).getByRole("button", { name: /Restore project to this version/ })).toBeInTheDocument();
  });

  it("loads a file diff via git_show_diff and renders added/removed lines", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return repoStatus;
      if (command === "git_log") return logEntries;
      if (command === "git_show_diff") return { before: "old line\n", after: "new line\n", binary: false };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<VersionsTimeline />);

    const body = await expandFirstEntry();
    fireEvent.click(within(body).getByRole("button", { name: /main\.tex/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_show_diff", { rev: "aaa111", path: "main.tex" }));
    const diff = await screen.findByLabelText("Diff for main.tex");
    expect(diff).toHaveTextContent("- old line");
    expect(diff).toHaveTextContent("+ new line");
  });

  it("notes binary files instead of rendering a diff", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return repoStatus;
      if (command === "git_log") return logEntries;
      if (command === "git_show_diff") return { before: null, after: null, binary: true };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<VersionsTimeline />);

    const body = await expandFirstEntry();
    fireEvent.click(within(body).getByRole("button", { name: /figs\/loss\.png/ }));
    expect(await screen.findByText("Binary file changed.")).toBeInTheDocument();
  });

  it("restores a file only after confirmation and reports the change", async () => {
    const onVersionsChanged = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return repoStatus;
      if (command === "git_log") return logEntries;
      if (command === "git_show_diff") return { before: "old line\n", after: "new line\n", binary: false };
      if (command === "git_restore_file") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<VersionsTimeline onVersionsChanged={onVersionsChanged} />);

    const body = await expandFirstEntry();
    fireEvent.click(within(body).getByRole("button", { name: /main\.tex/ }));
    const restore = await screen.findByRole("button", { name: /Restore this file/ });

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(restore);
    expect(invoke).not.toHaveBeenCalledWith("git_restore_file", { rev: "aaa111", path: "main.tex" });

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_restore_file", { rev: "aaa111", path: "main.tex" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Restore main.tex to this version? Your current file will be overwritten.",
    );
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalledTimes(1));
  });

  it("saves a manual version with the typed label", async () => {
    const onVersionsChanged = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return repoStatus;
      if (command === "git_log") return logEntries;
      if (command === "git_auto_commit") return "ccc333";
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<VersionsTimeline onVersionsChanged={onVersionsChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /Save version/ }));
    fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "Before rebuttal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_auto_commit", {
      message: "Before rebuttal",
      author: null,
    }));
    expect(await screen.findByText("Version saved.")).toBeInTheDocument();
    expect(onVersionsChanged).toHaveBeenCalledTimes(1);
  });

  it("restores the whole project after confirmation", async () => {
    const onVersionsChanged = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return repoStatus;
      if (command === "git_log") return logEntries;
      if (command === "git_restore_project") return "ddd444";
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<VersionsTimeline onVersionsChanged={onVersionsChanged} />);

    const body = await expandFirstEntry();
    fireEvent.click(within(body).getByRole("button", { name: /Restore project to this version/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_restore_project", { rev: "aaa111" }));
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/nothing is lost/);
    await waitFor(() => expect(onVersionsChanged).toHaveBeenCalledTimes(1));
  });
});
