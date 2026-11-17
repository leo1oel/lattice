import {
  editorViewAt, emitTauriEvent, expectInvoked, fileNode, invokeCalls, persistLayout, projectCommands,
  projectSnapshot, ROOT, setAutoBuildMode, waitForBuildIdle,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { persistFileViewStates } from "../settings/app-settings";
import { windowProjects } from "./window-projects";
// Collect the real title bar's lazy tab surface before the interaction deadline.
import "./project-tabs";

const { renderApp } = appHarness({ documentCanvas });
const notes = projectSnapshot({ root: "/tmp/lattice-notes", name: "Notes", files: [fileNode("main.tex"), fileNode("appendix.tex")] });

afterEach(() => {
  act(() => {
    for (const { root } of windowProjects.get()) windowProjects.remove(root);
  });
});

it("inserts a received project at the drop slot and restores its open file and caret", async () => {
  setAutoBuildMode("manual");
  persistLayout(notes.root, { openTabs: ["main.tex", "appendix.tex"], activeFile: "appendix.tex", canvasMode: "source" });
  persistFileViewStates(notes.root, { "appendix.tex": { text: { cursor: 6, scrollTop: 0 } } });
  renderApp({ ...projectCommands(undefined, "First line\nSecond line"), receive_project_tab: notes });
  await waitForBuildIdle();

  emitTauriEvent("project-tab-move-request", { id: "test-move", beforeRoot: ROOT });

  await expectInvoked("receive_project_tab", { id: "test-move", activeRoot: ROOT });
  await waitFor(() => expect(windowProjects.get().map(({ root }) => root)).toEqual([notes.root, ROOT]));
  const tabs = await screen.findByRole("group", { name: "Projects in this window" });
  expect(within(tabs).getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes");
  await screen.findByRole("tab", { name: "appendix.tex", selected: true });
  expect(await screen.findByRole("tab", { name: "main.tex" })).toBeInTheDocument();
  await waitFor(() => expect(editorViewAt().state.selection.main.head).toBe(6));
});

it("declines a received project when the writer keeps the destination's running build", async () => {
  setAutoBuildMode("manual");
  let finishBuild!: (value: unknown) => void;
  const running = new Promise((resolve) => { finishBuild = resolve; });
  let builds = 0;
  renderApp({
    ...projectCommands(),
    build_project: () => (++builds === 1 ? { success: true } : running),
    receive_project_tab: null,
  }, { confirmations: true });
  await waitFor(() => expect(builds).toBe(1));
  await waitForBuildIdle();
  fireEvent.click(screen.getByRole("button", { name: "Build" }));
  await waitFor(() => expect(builds).toBe(2));

  emitTauriEvent("project-tab-move-request", { id: "cancelled-move", beforeRoot: null });
  fireEvent.click(within(await screen.findByRole("dialog", { name: /Switch away/ })).getByRole("button", { name: "Cancel" }));

  await expectInvoked("receive_project_tab", { id: "cancelled-move", activeRoot: null });
  expect(invokeCalls("receive_project_tab")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Lattice paper");
  expect(windowProjects.get().map(({ root }) => root)).toEqual([ROOT]);
  finishBuild({ success: true });
});
