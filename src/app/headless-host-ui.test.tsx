import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CanvasToolbar } from "../canvas/canvas-toolbar";
import { markHeadlessHost } from "../platform/headless-host";
import ProjectTabs from "./project-tabs";

/** A headless host's tab is the only window there is, and has no Lattice app to go back to (browser_host.rs). */
async function tabMenu() {
  const actions = { openInThisWindow: vi.fn(async () => true), openProjectWindow: vi.fn(async () => null) };
  render(
    <ProjectTabs
      projects={[{ root: "/paper", name: "Paper" }, { root: "/notes", name: "Notes" }]}
      active="/paper"
      activeTab={<button type="button">Paper</button>}
      actions={actions}
      disabled={false}
    />,
  );
  fireEvent.contextMenu(within(screen.getByRole("group", { name: "Projects in this window" })).getByRole("button", { name: "Notes" }));
  return within(await screen.findByRole("menu"));
}

function toolbar() {
  render(<CanvasToolbar activePath="main.tex" activeKind="document" dirty={false} commentCount={0} onHistory={vi.fn()} onGit={vi.fn()} onComments={vi.fn()}
    inBrowserTab onMoveWorkspace={vi.fn()} />);
}

it("offers another window, or the Lattice app, only where there is one", async () => {
  expect((await tabMenu()).getByRole("menuitem", { name: "Open in New Window" })).toBeInTheDocument();
  cleanup();
  toolbar();
  expect(screen.getByRole("button", { name: "Open in Lattice app" })).toBeInTheDocument();
  cleanup();
  markHeadlessHost();
  const menu = await tabMenu();
  expect(menu.queryByRole("menuitem", { name: "Open in New Window" })).toBeNull();
  expect(menu.getByRole("menuitem", { name: "Close" })).toBeInTheDocument();
  cleanup();
  toolbar();
  expect(screen.queryByRole("button", { name: "Open in Lattice app" })).toBeNull();
});
