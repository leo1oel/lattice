import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { OverleafHistoryPanel } from "./overleaf-history";
import type { OverleafFileEntry, OverleafUpdate } from "./overleaf-history-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

const NOW = Date.now();

function update(overrides: Partial<OverleafUpdate> = {}): OverleafUpdate {
  return {
    fromVersion: 10,
    toVersion: 11,
    startTs: NOW - 120_000,
    endTs: NOW - 60_000,
    authors: ["Ada Lovelace"],
    paths: ["main.tex"],
    labels: [],
    origin: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(confirm).mockReset();
  vi.restoreAllMocks();
});

async function expandEntry(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
  const body = document.querySelector<HTMLElement>(".overleaf-history-entry.expanded");
  expect(body).not.toBeNull();
  return body!;
}

/**
 * The header button's own text (the file paths line) can share a filename
 * with a row in the changed-files list below it, so file-row lookups are
 * scoped to this container rather than the whole expanded entry.
 */
async function filesContainerOf(body: HTMLElement) {
  return waitFor(() => {
    const container = body.querySelector<HTMLElement>(".overleaf-history-files");
    if (!container) throw new Error("changed-files list has not rendered yet");
    return container;
  });
}

describe("OverleafHistoryPanel", () => {
  it("groups by day and shows the author, origin, and labels on the timeline", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") {
        return {
          updates: [
            update({
              toVersion: 12,
              origin: "dropbox",
              labels: [{ id: "l1", comment: "Submitted draft", version: 12, createdAt: null, author: null }],
            }),
          ],
          nextBefore: null,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Dropbox")).toBeInTheDocument();
    expect(screen.getByText("Submitted draft")).toBeInTheDocument();
  });

  it("expands an entry and lists only the files overleaf_history_files marks as changed", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") {
        expect(args).toEqual({ from: 10, to: 11 });
        const entries: OverleafFileEntry[] = [
          { pathname: "main.tex", operation: "edited" },
          // No `operation`: unchanged across the range, must not show as a change.
          { pathname: "refs.bib" },
          { pathname: "old.tex", operation: "removed", deletedAtV: 9 },
        ];
        return { diff: entries };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);
    const filesContainer = await filesContainerOf(body);

    expect(within(filesContainer).getByText("main.tex")).toBeInTheDocument();
    expect(within(filesContainer).getByText("old.tex")).toBeInTheDocument();
    expect(within(filesContainer).queryByText("refs.bib")).not.toBeInTheDocument();
  });

  it("renders a text diff through the shared Pierre renderer", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") {
        return { diff: [{ pathname: "main.tex", operation: "edited" }] };
      }
      if (command === "overleaf_history_diff") {
        return { diff: [{ u: "kept\n" }, { d: "old claim\n" }, { i: "new claim\n" }] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);
    const filesContainer = await filesContainerOf(body);
    fireEvent.click(within(filesContainer).getByRole("button", { name: /main\.tex/ }));

    const viewer = await screen.findByLabelText("Diff for main.tex");
    await waitFor(() => expect(viewer.querySelector("diffs-container")).not.toBeNull());
    expect(viewer.querySelector("[data-virtualizer]")).toBeNull();
  });

  it("closes an open file when its row is clicked again", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") {
        return { diff: [{ pathname: "main.tex", operation: "edited" }] };
      }
      if (command === "overleaf_history_diff") {
        return { diff: [{ u: "kept\n" }, { d: "old claim\n" }, { i: "new claim\n" }] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);
    const filesContainer = await filesContainerOf(body);
    const row = within(filesContainer).getByRole("button", { name: /main\.tex/ });

    fireEvent.click(row);
    expect(await screen.findByLabelText("Diff for main.tex")).toBeInTheDocument();

    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByLabelText("Diff for main.tex")).not.toBeInTheDocument());
  });

  it("shows a binary file as a plain notice instead of crashing", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") {
        return { diff: [{ pathname: "figs/loss.png", operation: "added" }] };
      }
      if (command === "overleaf_history_diff") return { diff: { binary: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);
    const filesContainer = await filesContainerOf(body);
    fireEvent.click(within(filesContainer).getByRole("button", { name: /figs\/loss\.png/ }));

    expect(await screen.findByText("Binary file changed.")).toBeInTheDocument();
  });

  it("restores the whole project only after confirmation", async () => {
    const onRestored = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") return { diff: [] };
      if (command === "overleaf_history_revert") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const confirmSpy = vi.mocked(confirm);
    render(<OverleafHistoryPanel onClose={() => undefined} onRestored={onRestored} />);
    const body = await expandEntry(/Ada Lovelace/);
    const restore = within(body).getByRole("button", { name: /Restore whole project to this version/ });

    confirmSpy.mockResolvedValueOnce(false);
    fireEvent.click(restore);
    expect(invoke).not.toHaveBeenCalledWith("overleaf_history_revert", { version: 11 });
    expect(onRestored).not.toHaveBeenCalled();

    confirmSpy.mockResolvedValueOnce(true);
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", { version: 11 }));
    expect(confirmSpy.mock.calls[confirmSpy.mock.calls.length - 1]?.[0]).toMatch(/deleted/);
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("restores a single changed file and a deleted file using its own version", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") return { updates: [update()], nextBefore: null };
      if (command === "overleaf_history_files") {
        return {
          diff: [
            { pathname: "main.tex", operation: "edited" },
            { pathname: "old.tex", operation: "removed", deletedAtV: 4 },
          ],
        };
      }
      if (command === "overleaf_history_revert") return undefined;
      if (command === "overleaf_history_restore_file") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);
    const filesContainer = await filesContainerOf(body);

    fireEvent.click(within(filesContainer).getByRole("button", { name: /Restore this file/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", { version: 11, path: "main.tex" }));

    fireEvent.click(within(filesContainer).getByRole("button", { name: /^Restore$/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_restore_file", { version: 4, path: "old.tex" }));
  });

  it("names a version and removes a label", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_history_labels") return [];
      if (command === "overleaf_history_updates") {
        return {
          updates: [update({ labels: [{ id: "l1", comment: "Draft 1", version: 11, createdAt: null, author: null }] })],
          nextBefore: null,
        };
      }
      if (command === "overleaf_history_files") return { diff: [] };
      if (command === "overleaf_history_add_label") return undefined;
      if (command === "overleaf_history_delete_label") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<OverleafHistoryPanel onClose={() => undefined} />);
    const body = await expandEntry(/Ada Lovelace/);

    fireEvent.click(within(body).getByRole("button", { name: /Name this version/ }));
    fireEvent.change(within(body).getByLabelText("Version label"), { target: { value: "Camera ready" } });
    fireEvent.click(within(body).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_add_label", { version: 11, comment: "Camera ready" }));

    fireEvent.click(within(body).getByTitle('Remove the "Draft 1" label'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_delete_label", { labelId: "l1" }));
  });
});
