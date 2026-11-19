// The harness's module mocks register as it loads: import it before anything it mocks.
import { expectInvoked, projectCommands, projectSnapshot } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ settingsDialog });

describe("recent projects on the welcome screen", () => {
  it("lists twenty more projects under the desk, marked, and finds any of the hundred by name", async () => {
    const recents = Array.from({ length: 30 }, (_, index) => ({ name: `Paper ${index}`, path: `/Users/writer/Papers/p${index}` }));
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify(recents));
    const older = projectSnapshot({ root: recents[27].path, name: "Paper 27" });
    renderApp({
      ...projectCommands(null),
      // The newest does not reopen, so launch stays on the welcome screen.
      open_project: (args) => {
        if ((args as { path: string }).path === older.root) return older;
        throw new Error("No such file or directory (os error 2)");
      },
      recent_project_states: (args) => (args as { paths: string[] }).paths.map((path) => ({
        missing: path === recents[0].path || path === recents[4].path, overleaf: path === recents[5].path || path === recents[27].path,
      })),
    });
    const list = (await screen.findByRole("heading", { name: "More projects" })).parentElement!;
    await waitFor(() => expect(within(list).getByRole("button", { name: /Paper 5/ })).toHaveTextContent("Overleaf"));
    expect(within(list).getByRole("button", { name: /Paper 4/ })).toHaveTextContent("Missing");
    // The desk shows 1 to 3 (0 is the one launch could not reopen); the list 4 to 23.
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).queryByRole("button", { name: /Paper 24/ })).not.toBeInTheDocument();
    // Marked, never dropped: the folder that is gone stays in the stored list.
    expect(JSON.parse(localStorage.getItem("lattice.recent-projects.v1")!)).toHaveLength(30);

    fireEvent.click(within(list).getByRole("button", { name: "Show all 30 projects" }));
    const search = await screen.findByRole("searchbox", { name: "Search recent projects" });
    fireEvent.change(search, { target: { value: "paper 27" } });
    const found = await screen.findByRole("option", { name: "Paper 27" });
    expect(found).toHaveTextContent("Overleaf");
    fireEvent.click(found);
    await expectInvoked("open_project", { path: older.root });
  });

});
