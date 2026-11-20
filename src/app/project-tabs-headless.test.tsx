import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { markHeadlessHost } from "../platform/headless-host";
import ProjectTabs from "./project-tabs";

/** A headless host's tab is the only window there is (browser_host.rs). */
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

it("offers a project a window of its own only where there can be one", async () => {
  expect((await tabMenu()).getByRole("menuitem", { name: "Open in New Window" })).toBeInTheDocument();
  cleanup();
  markHeadlessHost();
  const menu = await tabMenu();
  expect(menu.queryByRole("menuitem", { name: "Open in New Window" })).toBeNull();
  expect(menu.getByRole("menuitem", { name: "Close" })).toBeInTheDocument();
});
