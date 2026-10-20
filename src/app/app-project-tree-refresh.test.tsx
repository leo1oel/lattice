import { deferred, dirNode, emitTauriEvent, fileNode, findProjectTreeItem, invokeCalls, projectCommands, projectSnapshot, queryProjectTreeItem, ROOT } from "./app-test-utils";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileNode, ProjectSnapshot } from "../app-types";
import { appHarness } from "./app-test-mount";

const { renderApp } = appHarness();

// Files and folders that land in the project folder from Finder or another
// app; the backend's scan (refresh_project) finds them on disk.
const ADDED: FileNode[] = [
  dirNode("figures", [fileNode("figures/a.png"), fileNode("figures/b.png")]),
  fileNode("main.tex"),
  fileNode("notes.md"),
];

/** A project whose every scan reads `disk.files` as it is at that moment, unless `disk.hold` keeps the scan out. */
async function openProject() {
  const disk = { files: [fileNode("main.tex")], hold: null as Promise<void> | null };
  renderApp({
    ...projectCommands(projectSnapshot()),
    refresh_project: () => {
      const snapshot = projectSnapshot({ files: disk.files });
      return disk.hold ? disk.hold.then((): ProjectSnapshot => snapshot) : snapshot;
    },
  });
  await findProjectTreeItem("main.tex");
  // The tree's first scan, on opening, has landed: nothing after it is a scan that was coming anyway.
  await waitFor(() => expect(invokeCalls("refresh_project").length).toBeGreaterThan(0));
  await act(async () => {});
  return disk;
}

describe("project tree refresh", () => {
  it("rescans when the window comes back to the front, though no watcher report came", async () => {
    const disk = await openProject();
    disk.files = ADDED;
    await act(async () => {});
    expect(queryProjectTreeItem("notes.md")).toBeNull();

    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await findProjectTreeItem("notes.md")).toBeInTheDocument();
    expect(queryProjectTreeItem("figures/")).not.toBeNull();
  });

  it("rescans when the project is opened again, which raises the window already showing it", async () => {
    const disk = await openProject();
    disk.files = ADDED;
    emitTauriEvent("project-reopened", { root: "/tmp/another-project" });
    await act(async () => {});
    expect(queryProjectTreeItem("notes.md")).toBeNull();

    emitTauriEvent("project-reopened", { root: ROOT });
    expect(await findProjectTreeItem("notes.md")).toBeInTheDocument();
  });

  it("rescans from the tree's context menu and the command palette", async () => {
    const disk = await openProject();
    disk.files = ADDED;
    fireEvent.contextMenu(screen.getByLabelText("Project files"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh file tree" }));
    expect(await findProjectTreeItem("notes.md")).toBeInTheDocument();

    disk.files = [...ADDED, fileNode("later.md")];
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("searchbox", { name: "Command palette" });
    fireEvent.change(palette, { target: { value: "Refresh file tree" } });
    fireEvent.keyDown(palette, { key: "Enter" });
    expect(await findProjectTreeItem("later.md")).toBeInTheDocument();
  });

  it("scans again after a scan that was out when the watcher reported more", async () => {
    // A copy lands in two bursts; the scan the first one started reads the
    // folder before the second. Dropping the second report left its files out
    // until the 30-second poll.
    const disk = await openProject();
    const scan = deferred();
    disk.hold = scan.promise;
    disk.files = [fileNode("main.tex"), fileNode("notes.md")];
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["notes.md"] });
    disk.hold = null;
    disk.files = ADDED;
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["figures", "figures/a.png", "figures/b.png"] });
    await act(async () => scan.resolve());

    expect(await findProjectTreeItem("figures/")).toBeInTheDocument();
    expect(queryProjectTreeItem("notes.md")).not.toBeNull();
  });
});
