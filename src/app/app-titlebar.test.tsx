import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar } from "./app-titlebar";
import { listenForProjectTabDrops } from "./project-tab-drop";
import { windowProjects } from "./window-projects";

const appWindow = vi.hoisted(() => ({
  label: "",
  title: vi.fn(async () => "Lattice Beta"),
  setTitle: vi.fn(async (_title: string) => {}),
}));
const desktop = vi.hoisted(() => ({
  hit: vi.fn(async (): Promise<{ windowLabel: string; x: number; y: number } | null> => null),
  events: new Map<string, (message: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string) => command === "project_tab_drag_target" ? desktop.hit() : Promise.resolve() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (message: { payload: unknown }) => void, options?: { target: string }) => {
    const id = `${options?.target}:${event}`;
    desktop.events.set(id, handler);
    return () => desktop.events.delete(id);
  },
  emitTo: async (target: string, event: string, payload: unknown) => {
    desktop.events.get(`${target}:${event}`)?.({ payload });
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));
vi.mock("../project/project-menu", () => ({ ProjectMenu: () => null }));
afterEach(() => {
  cleanup();
  appWindow.label = "";
  desktop.events.clear();
  desktop.hit.mockReset();
  for (const { root } of windowProjects.get()) windowProjects.remove(root);
});

type Documents = ComponentProps<typeof AppTitlebar>["documents"];

function titlebarProps(
  documents: Documents = { paper: null, activeTab: "" },
  focusBar?: ComponentProps<typeof AppTitlebar>["focusBar"],
  lifecycle: Record<string, unknown> = {},
) {
  // Unused menu props belong to the mocked ProjectMenu, not this layout.
  return {
    project: { root: "/paper", manifest: { name: "Paper" } },
    documents,
    projectMenu: {
      lifecycle: { projectMenuOpen: false, setProjectMenuOpen: vi.fn(), clone: { show: vi.fn() }, recentFinder: { show: vi.fn() }, busyLabel: null, ...lifecycle },
      importing: false,
      building: true,
    },
    panelControls: <button type="button">Panels</button>,
    canvasToolbar: <button type="button">Project history</button>,
    focusBar,
  } as unknown as ComponentProps<typeof AppTitlebar>;
}

it("carries the project switcher, the panel controls and the tools, but no build button", () => {
  render(<AppTitlebar {...titlebarProps()} />);
  expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
  // A running build keeps the project from being switched underneath it.
  expect(screen.getByRole("button", { name: "Switch project" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Panels" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Project history" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
});

it("names the window for its project and the document in front, then gives back the launch name", async () => {
  // The Window menu, the Dock and Mission Control list windows by this title,
  // so three open projects must not all read "Lattice".
  const titles = () => appWindow.setTitle.mock.calls.map(([title]) => title);
  // Let an earlier test's unmount finish naming the window before counting.
  await new Promise((resolve) => setTimeout(resolve));
  appWindow.setTitle.mockClear();
  const view = render(<AppTitlebar {...titlebarProps({ paper: null, activeTab: "chapters/intro.tex" })} />);
  await waitFor(() => expect(titles()).toEqual(["Paper — intro.tex"]));
  const paper = { title: "Attention Is All You Need" } as Documents["paper"];
  view.rerender(<AppTitlebar {...titlebarProps({ paper, activeTab: "paper:1706.03762" })} />);
  view.rerender(<AppTitlebar {...titlebarProps()} />);
  await waitFor(() => expect(titles()).toHaveLength(3));
  view.unmount();
  // Each new title replaces the last directly; the launch name (the build
  // flavor's product name, read once) returns only when the project closes.
  await waitFor(() => expect(titles()).toEqual([
    "Paper — intro.tex", "Paper — Attention Is All You Need", "Paper", "Lattice Beta",
  ]));
  expect(appWindow.title).toHaveBeenCalledTimes(1);
});

it("hands focus mode's bar the name of the document in front", () => {
  const focusBar = vi.fn((title: string) => <span>{title}</span>);
  render(<AppTitlebar {...titlebarProps({ paper: null, activeTab: "sections/method.tex" }, focusBar)} />);
  expect(screen.getByText("method.tex")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Switch project" })).toBeNull();
});

it("shows the projects in this window as tabs once there are two, the active one being the menu (#822)", async () => {
  const openInThisWindow = vi.fn(async () => true);
  const openProjectWindow = vi.fn(async () => null);
  act(() => {
    windowProjects.enter({ root: "/paper", name: "Paper" }, null);
    windowProjects.enter({ root: "/notes", name: "Notes" }, { root: "/paper", name: "Paper" });
    windowProjects.enter({ root: "/paper", name: "Paper" }, { root: "/notes", name: "Notes" });
  });
  render(<AppTitlebar {...titlebarProps(undefined, undefined, { openInThisWindow, openProjectWindow })} />);
  const tabs = await screen.findByRole("group", { name: "Projects in this window" });
  expect(within(tabs).getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
  fireEvent.click(within(tabs).getByRole("button", { name: "Notes" }));
  expect(openInThisWindow).toHaveBeenCalledWith("/notes");

  // Closing a project in the background only takes its tab away.
  fireEvent.click(within(tabs).getByRole("button", { name: "Close Notes" }));
  await waitFor(() => expect(windowProjects.get().map(({ root }) => root)).toEqual(["/paper"]));
  expect(screen.queryByRole("group", { name: "Projects in this window" })).toBeNull();
  expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
});

it("closes the active project by switching to its neighbour first, and keeps it when the switch is refused", async () => {
  const openInThisWindow = vi.fn(async () => false);
  act(() => {
    windowProjects.enter({ root: "/paper", name: "Paper" }, null);
    windowProjects.enter({ root: "/notes", name: "Notes" }, { root: "/paper", name: "Paper" });
    windowProjects.enter({ root: "/paper", name: "Paper" }, { root: "/notes", name: "Notes" });
  });
  render(<AppTitlebar {...titlebarProps(undefined, undefined, { openInThisWindow, openProjectWindow: vi.fn() })} />);
  const tabs = await screen.findByRole("group", { name: "Projects in this window" });
  fireEvent.click(within(tabs).getByRole("button", { name: "Close Paper" }));
  await waitFor(() => expect(openInThisWindow).toHaveBeenCalledWith("/notes"));
  // Declined (work running, or the switch failed): the project stays in the window.
  expect(windowProjects.get().map(({ root }) => root)).toEqual(["/paper", "/notes"]);
  openInThisWindow.mockResolvedValue(true);
  fireEvent.click(within(tabs).getByRole("button", { name: "Close Paper" }));
  await waitFor(() => expect(windowProjects.get().map(({ root }) => root)).toEqual(["/notes"]));
});

it("moves a project to a window of its own from its tab's menu", async () => {
  const openProjectWindow = vi.fn(async () => null);
  act(() => {
    windowProjects.enter({ root: "/paper", name: "Paper" }, null);
    windowProjects.enter({ root: "/notes", name: "Notes" }, { root: "/paper", name: "Paper" });
    windowProjects.enter({ root: "/paper", name: "Paper" }, { root: "/notes", name: "Notes" });
  });
  render(<AppTitlebar {...titlebarProps(undefined, undefined, { openInThisWindow: vi.fn(), openProjectWindow })} />);
  const tabs = await screen.findByRole("group", { name: "Projects in this window" });
  fireEvent.contextMenu(within(tabs).getByRole("button", { name: "Notes" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open in New Window" }));
  await waitFor(() => expect(openProjectWindow).toHaveBeenCalledWith("/notes"));
  await waitFor(() => expect(windowProjects.get().map(({ root }) => root)).toEqual(["/paper"]));
});

function place(element: Element, x: number, width: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(x, 0, width, 36));
}

function dragPointer(x: number, y = 18) {
  return { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y };
}

function twoProjects() {
  act(() => {
    windowProjects.enter({ root: "/paper", name: "Paper" }, null);
    windowProjects.enter({ root: "/notes", name: "Notes" }, { root: "/paper", name: "Paper" });
  });
}

it("reorders by where the project tab is released and keeps the active project", async () => {
  twoProjects();
  const openInThisWindow = vi.fn(async () => true);
  render(<AppTitlebar {...titlebarProps(undefined, undefined, { openInThisWindow })} />);
  const tabs = await screen.findByRole("group", { name: "Projects in this window" });
  const strip = tabs.parentElement!;
  place(strip, 50, 180);
  place(tabs.querySelector('[data-project-root="/paper"]')!, 50, 80);
  const notes = within(tabs).getByRole("button", { name: "Notes" });
  place(notes.parentElement!, 130, 80);

  fireEvent.pointerDown(notes, dragPointer(160));
  fireEvent.blur(within(tabs).getByRole("button", { name: "Switch project" }));
  fireEvent.pointerMove(window, dragPointer(65));
  // The first press loads the drag controller.
  await waitFor(() => expect(strip).toHaveAttribute("data-project-drop"));
  expect(windowProjects.get().map(({ root }) => root)).toEqual(["/paper", "/notes"]);
  fireEvent.pointerUp(window, dragPointer(65));
  fireEvent.click(notes, { detail: 1 });
  expect(windowProjects.get().map(({ root }) => root)).toEqual(["/notes", "/paper"]);
  expect(openInThisWindow).not.toHaveBeenCalled();
  expect(strip).not.toHaveAttribute("data-project-drop");
});

it("opens the project menu on a click and clears the drag when Escape is pressed", async () => {
  appWindow.label = "main";
  const moveProjectTab = vi.fn(async () => {});
  const setProjectMenuOpen = vi.fn();
  const props = titlebarProps(undefined, undefined, { moveProjectTab, setProjectMenuOpen });
  props.projectMenu.building = false;
  render(<AppTitlebar {...props} />);
  const title = screen.getByRole("button", { name: "Switch project" });
  fireEvent.pointerDown(title, dragPointer(80));
  fireEvent.pointerUp(window, dragPointer(80));
  fireEvent.click(title, { detail: 1 });
  expect(setProjectMenuOpen).toHaveBeenCalledExactlyOnceWith(true);

  fireEvent.pointerDown(title, dragPointer(80));
  fireEvent.pointerMove(window, dragPointer(120));
  await waitFor(() => expect(title.parentElement).toHaveAttribute("data-project-dragging"));
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window, dragPointer(-10));
  fireEvent.click(title, { detail: 1 });
  expect(title.parentElement).not.toHaveAttribute("data-project-dragging");
  expect(setProjectMenuOpen).toHaveBeenCalledTimes(1);
  expect(moveProjectTab).not.toHaveBeenCalled();
});

it("detaches a project tab dropped on the desktop", async () => {
  appWindow.label = "main";
  desktop.hit.mockResolvedValue(null);
  twoProjects();
  const moveProjectTab = vi.fn(async () => {});
  render(<AppTitlebar {...titlebarProps(undefined, undefined, { moveProjectTab })} />);
  const notes = within(await screen.findByRole("group", { name: "Projects in this window" }))
    .getByRole("button", { name: "Notes" });
  fireEvent.pointerDown(notes, dragPointer(160));
  fireEvent.pointerMove(window, dragPointer(-10));
  fireEvent.pointerUp(window, dragPointer(-10));
  await waitFor(() => expect(moveProjectTab).toHaveBeenCalledExactlyOnceWith("/notes", null));
});

it("finds an insertion slot in the other window for a dragged single-project title", async () => {
  const peerStrip = document.createElement("div");
  peerStrip.setAttribute("data-project-drop-enabled", "");
  const peerTab = document.createElement("div");
  peerTab.dataset.projectRoot = "/notes";
  peerStrip.append(peerTab);
  document.body.append(peerStrip);
  place(peerStrip, 50, 150);
  place(peerTab, 50, 100);
  appWindow.label = "project-1";
  const stop = listenForProjectTabDrops(peerStrip, appWindow.label);
  try {
    appWindow.label = "main";
    desktop.hit.mockResolvedValue({ windowLabel: "project-1", x: 70 / window.innerWidth, y: 18 / window.innerHeight });
    const moveProjectTab = vi.fn(async () => {});
    const props = titlebarProps(undefined, undefined, { moveProjectTab });
    props.projectMenu.building = false;
    render(<AppTitlebar {...props} />);
    const title = screen.getByRole("button", { name: "Switch project" });
    fireEvent.pointerDown(title, dragPointer(80));
    fireEvent.pointerMove(window, dragPointer(-10));
    await waitFor(() => expect(peerStrip).toHaveAttribute("data-project-drop"));
    fireEvent.pointerUp(window, dragPointer(-10));
    await waitFor(() => expect(moveProjectTab).toHaveBeenCalledExactlyOnceWith("/paper", {
      windowLabel: "project-1",
      beforeRoot: "/notes",
    }));
    expect(peerStrip).not.toHaveAttribute("data-project-drop");
  } finally {
    stop();
    peerStrip.remove();
  }
});
