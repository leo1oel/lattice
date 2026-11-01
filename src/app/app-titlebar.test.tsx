import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar } from "./app-titlebar";

const appWindow = vi.hoisted(() => ({
  title: vi.fn(async () => "Lattice Beta"),
  setTitle: vi.fn(async (_title: string) => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));
vi.mock("../project/project-dialogs", () => ({ ProjectMenu: () => null }));
afterEach(cleanup);

type Documents = ComponentProps<typeof AppTitlebar>["documents"];

function titlebarProps(documents: Documents = { paper: null, activeTab: "" }, focusBar?: ComponentProps<typeof AppTitlebar>["focusBar"]) {
  // Unused menu props belong to the mocked ProjectMenu, not this layout.
  return {
    project: { root: "/paper", manifest: { name: "Paper" } },
    documents,
    projectMenu: { open: false, setOpen: vi.fn(), importing: false, building: true },
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
