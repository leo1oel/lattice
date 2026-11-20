// The harness's module mocks register as it loads: import it before anything it mocks.
import {
  buildButton, buildResult, deferred, expectInvoked, expectNotification, invokeCalls, pause, projectCommands, projectSnapshot, ROOT, setAutoBuildMode,
  waitForBuildIdle,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { flushWindowProjectGroup, windowProjects } from "./window-projects";

const { renderApp } = appHarness();

/** Projects in this window (#822): another project opened here, beside the first, and switched between. */
const NOTES = "/tmp/notes";
const snapshots: Record<string, ReturnType<typeof projectSnapshot>> = {
  [ROOT]: projectSnapshot({ name: "Paper" }),
  [NOTES]: projectSnapshot({ root: NOTES, name: "Notes" }),
};
const openProject = (args: InvokeArgs | undefined) => snapshots[(args as { path: string }).path];

function rememberRecents() {
  localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
    { name: "Paper", path: ROOT }, { name: "Notes", path: NOTES },
  ]));
}

async function openNotesHere() {
  const title = await screen.findByRole("button", { name: "Switch project" });
  await waitFor(() => expect(title).toBeEnabled());
  fireEvent.pointerDown(title, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open Notes in this window" }));
}

afterEach(async () => {
  await flushWindowProjectGroup();
  act(() => windowProjects.restore([]));
});

describe("projects in this window", () => {
  it("restores an ordered group with the active project selected and saves a new selection", async () => {
    setAutoBuildMode("manual");
    const projects = [{ root: ROOT, name: "Paper" }, { root: NOTES, name: "Notes" }];
    renderApp({
      ...projectCommands(snapshots[NOTES]),
      load_project_tab_group: { activeRoot: NOTES, projects },
      open_project: openProject,
      project_shown_elsewhere: false,
    });
    const group = await screen.findByRole("group", { name: "Projects in this window" });
    expect(windowProjects.get()).toEqual(projects);
    expect(within(group).getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes");
    await waitForBuildIdle();

    fireEvent.click(within(group).getByRole("button", { name: "Paper" }));
    await expectInvoked("save_project_tab_group", { group: { activeRoot: ROOT, projects } });
    expect(within(group).getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
  });

  it("starts in Welcome after an explicit last-window close", async () => {
    rememberRecents();
    renderApp({ ...projectCommands(null), load_project_tab_group: { activeRoot: null, projects: [] } });
    expect(await screen.findByRole("heading", { level: 1, name: "Lattice" })).toBeInTheDocument();
    expect(invokeCalls("open_project")).toHaveLength(0);
  });

  it("opens a recent project in this window beside the first, as a tab to switch back by", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    renderApp({ ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: false });
    await openNotesHere();
    await expectInvoked("open_project", { path: NOTES });
    const tabs = await screen.findByRole("group", { name: "Projects in this window" });
    expect(within(tabs).getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes");
    // The default stays a window of its own: this window was asked for.
    expect(invokeCalls("open_project_window")).toHaveLength(0);

    fireEvent.click(within(tabs).getByRole("button", { name: "Paper" }));
    await waitFor(() => expect(invokeCalls("open_project", (args) => (args as { path: string }).path === ROOT)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Projects in this window" }))
      .getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper"));

    // ⌃Tab goes round the window's projects; ⌘1 to ⌘9 stay the layouts'.
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() => expect(invokeCalls("open_project", (args) => (args as { path: string }).path === NOTES)).toHaveLength(2));
  });

  it("asks before a switch would stop the build running in the project it leaves", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    // The project's own up-to-date check on entry is quiet; the writer's Build is the one that runs.
    const build = deferred<unknown>();
    let builds = 0;
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: false,
      build_project: () => (builds++ === 0 ? buildResult() : build.promise),
    }, { confirmations: true });
    await waitFor(() => expect(builds).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: "Build" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toBeDisabled());
    // The title's menu waits out a build, as it always has; the palette offers this window too.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Open Notes in this window/ }));
    const dialog = await screen.findByRole("dialog", { name: "Switch away from “Paper”?" });
    expect(dialog).toHaveTextContent("the build");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Switch away/ })).toBeNull());
    expect(invokeCalls("open_project")).toHaveLength(0);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Open Notes in this window/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: /Switch away/ })).getByRole("button", { name: "Switch project" }));
    await expectInvoked("open_project", { path: NOTES });
    build.resolve(buildResult());
  });

  it("takes the project in place when the host answers that this tab opens it (a headless host)", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: false,
      open_project_window: () => ({ label: "browser-1", focusedExisting: false, openHere: true }),
    });
    const title = await screen.findByRole("button", { name: "Switch project" });
    await waitFor(() => expect(title).toBeEnabled());
    fireEvent.pointerDown(title, { button: 0, pointerType: "mouse" });
    // The plain entry, which elsewhere gives the project a window of its own.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Notes" }));
    await expectInvoked("open_project_window", { path: NOTES });
    await expectInvoked("open_project", { path: NOTES });
    const tabs = await screen.findByRole("group", { name: "Projects in this window" });
    expect(within(tabs).getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes");
    expect(within(tabs).getByRole("button", { name: "Paper" })).toBeInTheDocument();
  });

  it("raises the window that already shows a project, keeping its tab here", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: true,
      open_project_window: () => ({ label: "project-1", focusedExisting: true }),
    });
    await openNotesHere();
    await expectInvoked("open_project_window", { path: NOTES });
    expect(invokeCalls("open_project")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
  });

  it("keeps the build queued here when the project asked for is shown in another window", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    const running = deferred<unknown>();
    let builds = 0;
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: true,
      open_project_window: () => ({ label: "project-1", focusedExisting: true }),
      build_project: () => (builds++ === 1 ? running.promise : buildResult()()),
    }, { confirmations: true });
    await waitFor(() => expect(builds).toBe(1));
    await waitForBuildIdle();
    fireEvent.click(buildButton());
    await waitFor(() => expect(builds).toBe(2));
    // The Build button queues another pass while one runs.
    fireEvent.click(buildButton());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Open Notes in this window/ }));
    await expectInvoked("open_project_window", { path: NOTES });
    // Nothing here is interrupted, so nothing is asked.
    expect(screen.queryByRole("dialog", { name: /Switch away/ })).toBeNull();
    expect(invokeCalls("open_project")).toHaveLength(0);

    running.resolve(buildResult()());
    await waitFor(() => expect(builds).toBe(3));
  });

  it("waits out a switch still checking its project before the tutorial may take the window", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    const lookup = deferred<boolean>();
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: () => lookup.promise,
      open_tutorial_project: projectSnapshot({ root: "/tmp/tutorial", name: "Tutorial" }),
    });
    await openNotesHere();
    await expectInvoked("project_shown_elsewhere", { path: NOTES });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Open guided tutorial/ }));
    // The palette runs its choice once it has closed and handed focus back.
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).toBeNull());
    await act(() => pause(100));
    lookup.resolve(false);
    await expectInvoked("open_project", { path: NOTES });
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes"));
    expect(invokeCalls("open_tutorial_project")).toHaveLength(0);
  });

  it("shows the switch under way while it checks its project, and drops it when another window has it", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    const lookup = deferred<boolean>();
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject, project_shown_elsewhere: () => lookup.promise,
      open_project_window: () => ({ label: "project-1", focusedExisting: true }),
    });
    await openNotesHere();
    await expectInvoked("project_shown_elsewhere", { path: NOTES });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), { button: 0, pointerType: "mouse" });
    expect(await screen.findByText("Switching project…")).toBeInTheDocument();
    lookup.resolve(true);
    await expectInvoked("open_project_window", { path: NOTES });
    await waitFor(() => expect(screen.queryByText("Switching project…")).toBeNull());
    expect(invokeCalls("open_project")).toHaveLength(0);
  });

  it("leaves the project here untouched when the folder asked for is gone, and keeps it listed, marked missing", async () => {
    setAutoBuildMode("manual");
    rememberRecents();
    renderApp({
      ...projectCommands(snapshots[ROOT]), open_project: openProject,
      project_shown_elsewhere: () => { throw new Error("No such file or directory (os error 2)"); },
      recent_project_states: (args) => (args as { paths: string[] }).paths.map((path) => ({ missing: path === NOTES, overleaf: false })),
    });
    await openNotesHere();
    await expectNotification(/No such file or directory/);
    expect(invokeCalls("open_project")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("lattice.recent-projects.v1") ?? "[]"))
      .toContainEqual(expect.objectContaining({ path: NOTES, missing: true })));
  });
});
