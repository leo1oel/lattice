import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";
import { OverleafHistoryPanel } from "./overleaf-history";
import type { OverleafFileEntry, OverleafUpdate } from "./use-overleaf-history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

const NOW = Date.now();

const update = (overrides: Partial<OverleafUpdate> = {}): OverleafUpdate => ({
  fromVersion: 10, toVersion: 11, startTs: NOW - 120_000, endTs: NOW - 60_000,
  authors: ["Ada Lovelace"], paths: ["main.tex"], labels: [], origin: null, ...overrides,
});
const label = (id: string, comment: string, version: number) => ({ id, comment, version, createdAt: null, author: null });

/** The panel's backend: one update, whose changed files are `files`. */
function mockHistory(files: OverleafFileEntry[], extra: CommandTable = {}, updates = [update()]) {
  mockInvoke({
    overleaf_history_updates: { updates, nextBefore: null },
    overleaf_history_files: { diff: files },
    overleaf_history_diff: { diff: [{ u: "kept\n" }, { d: "old claim\n" }, { i: "new claim\n" }] },
    ...extra,
  });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const renderPanel = (props: Partial<Parameters<typeof OverleafHistoryPanel>[0]> = {}) =>
  render(<OverleafHistoryPanel projectRoot="/tmp/project" onClose={() => undefined} {...props} />);

/** Render, expand the first entry, and return it plus its changed-files list once that has loaded. */
async function openEntry(props: Parameters<typeof renderPanel>[0] = {}) {
  renderPanel(props);
  fireEvent.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
  const body = document.querySelector<HTMLElement>(".versions-entry.expanded")!;
  expect(body).not.toBeNull();
  // The header's own paths line can share a filename with a file row, so
  // file lookups are scoped to the list rather than the whole entry.
  const files = await waitFor(() => {
    const container = body.querySelector<HTMLElement>(".versions-files");
    if (!container && !body.querySelector(".versions-note")) throw new Error("files have not loaded yet");
    return container!;
  });
  return { body, files };
}

describe("OverleafHistoryPanel", () => {
  it("groups by day and shows the author, origin, and labels on the timeline", async () => {
    mockHistory([], {}, [update({ toVersion: 12, origin: "dropbox", labels: [label("l1", "Submitted draft", 12)] })]);
    renderPanel();

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Dropbox")).toBeInTheDocument();
    expect(screen.getByText("Submitted draft")).toBeInTheDocument();
  });

  it("expands an entry and lists only the files overleaf_history_files marks as changed", async () => {
    mockHistory([
      { pathname: "main.tex", operation: "edited" },
      // No `operation`: unchanged across the range, must not show as a change.
      { pathname: "refs.bib" },
      { pathname: "old.tex", operation: "removed", deletedAtV: 9 },
    ]);
    const { files } = await openEntry();
    expect(invoke).toHaveBeenCalledWith("overleaf_history_files", { projectRoot: "/tmp/project", from: 10, to: 11 });
    expect(within(files).getByText("main.tex")).toBeInTheDocument();
    expect(within(files).getByText("old.tex")).toBeInTheDocument();
    expect(within(files).queryByText("refs.bib")).not.toBeInTheDocument();
  });

  it("renders a text diff through the shared Pierre renderer and closes it when the row is clicked again", async () => {
    mockHistory([{ pathname: "main.tex", operation: "edited" }]);
    const { files } = await openEntry();
    const row = within(files).getByRole("button", { name: /main\.tex/ });
    fireEvent.click(row);

    const viewer = await screen.findByLabelText("Diff for main.tex");
    await waitFor(() => expect(viewer.querySelector("diffs-container")).not.toBeNull());
    expect(viewer.querySelector("[data-virtualizer]")).toBeNull();

    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByLabelText("Diff for main.tex")).not.toBeInTheDocument());
  });

  it("shows a binary file as a plain notice instead of crashing", async () => {
    mockHistory([{ pathname: "figs/loss.png", operation: "added" }], { overleaf_history_diff: { diff: { binary: true } } });
    const { files } = await openEntry();
    fireEvent.click(within(files).getByRole("button", { name: /figs\/loss\.png/ }));
    expect(await screen.findByText("Binary file changed")).toBeInTheDocument();
  });

  it("restores the whole project only after confirmation", async () => {
    const onRestored = vi.fn();
    mockHistory([], { overleaf_history_revert: undefined });
    const { body } = await openEntry({ onRestored });
    const restore = within(body).getByRole("button", { name: /Restore whole project to this version/ });

    vi.mocked(confirm).mockResolvedValueOnce(false);
    fireEvent.click(restore);
    expect(invoke).not.toHaveBeenCalledWith("overleaf_history_revert", expect.anything());
    expect(onRestored).not.toHaveBeenCalled();

    vi.mocked(confirm).mockResolvedValueOnce(true);
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", { projectRoot: "/tmp/project", version: 11 }));
    expect(vi.mocked(confirm).mock.calls.at(-1)?.[0]).toMatch(/deleted/);
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("restores a single changed file and a deleted file using its own version", async () => {
    mockHistory([
      { pathname: "main.tex", operation: "edited" },
      { pathname: "old.tex", operation: "removed", deletedAtV: 4 },
    ], { overleaf_history_revert: undefined, overleaf_history_restore_file: undefined });
    const { files } = await openEntry();

    fireEvent.click(within(files).getByRole("button", { name: /Restore this file/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_revert", { projectRoot: "/tmp/project", version: 11, path: "main.tex" }));
    fireEvent.click(within(files).getByRole("button", { name: /^Restore$/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_restore_file", { projectRoot: "/tmp/project", version: 4, path: "old.tex" }));
  });

  it("names a version and removes a label", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    mockHistory([], { overleaf_history_add_label: undefined, overleaf_history_delete_label: undefined }, [
      update({ labels: [label("l1", "Draft 1", 11)] }),
    ]);
    const { body } = await openEntry();

    fireEvent.click(within(body).getByRole("button", { name: /Name this version/ }));
    fireEvent.change(within(body).getByLabelText("Version label"), { target: { value: "Camera ready" } });
    fireEvent.click(within(body).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_add_label", { projectRoot: "/tmp/project", version: 11, comment: "Camera ready" }));

    fireEvent.click(within(body).getByTitle('Remove the "Draft 1" label'));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Remove the “Draft 1” label"), expect.anything()));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_history_delete_label", { projectRoot: "/tmp/project", labelId: "l1" }));
  });
});
