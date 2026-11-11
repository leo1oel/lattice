import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar } from "./app-titlebar";
import { windowProjects } from "./window-projects";

const appWindow = vi.hoisted(() => ({
  title: vi.fn(async () => "Lattice Beta"),
  setTitle: vi.fn(async (_title: string) => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));
vi.mock("../project/project-menu", () => ({ ProjectMenu: () => null }));
afterEach(() => {
  cleanup();
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
      lifecycle: { projectMenuOpen: false, setProjectMenuOpen: vi.fn(), clone: { show: vi.fn() }, busyLabel: null, ...lifecycle },
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
