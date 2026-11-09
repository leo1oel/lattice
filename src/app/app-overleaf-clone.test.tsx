import { buildButton, buildResult, expectInvoked, invokeCalls, overleafLink, overleafStatus, waitForBuildIdle } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

const { renderOverleafPaper } = appHarness();

// S7 in the implicit-state audit: the picker claimed this window's project
// switch before downloading, and the download then opened in a window of its
// own, so nothing ever finished or undid the claim. The window kept showing
// its project with no project behind it: no tree or git refresh, builds and
// syncs skipped, a Build saying the project had no LaTeX document.
it("leaves the window's own project working after downloading another Overleaf project into a new window", async () => {
  const cloned = "/tmp/overleaf/Thesis";
  renderOverleafPaper({
    overleaf_status: () => overleafStatus(),
    overleaf_link: () => overleafLink({ projectId: "other" }),
    overleaf_list_projects: () => ({
      projects: [{
        id: "thesis", name: "Thesis", lastUpdated: "2026-11-01T00:00:00Z", ownerEmail: "writer@example.edu",
        ownerName: "Writer", accessLevel: "owner", archived: false, trashed: false,
      }],
      invites: [],
    }),
    overleaf_local_copies: () => ({}),
    overleaf_clone_target: () => ({ kind: "free", path: cloned, folder: "Thesis" }),
    overleaf_clone_project: () => cloned,
    open_project_window: () => ({ label: "project-2", focusedExisting: false }),
    build_project: buildResult({ rootDocument: "main.tex" }),
  }, { syncMode: "manual" });
  const actions = await screen.findByRole("button", { name: "Overleaf project actions" });
  fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open another Overleaf project" }));
  fireEvent.click(await screen.findByRole("button", { name: /Thesis/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await expectInvoked("open_project_window", { path: cloned });
  await waitFor(() => expect(screen.queryByLabelText("Open from Overleaf")).not.toBeInTheDocument());

  const builds = invokeCalls("build_project").length;
  fireEvent.click(buildButton());
  await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(builds + 1));
  await waitForBuildIdle();
  expect(screen.queryByText(/has no LaTeX document to build yet/)).not.toBeInTheDocument();
});
