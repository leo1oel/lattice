import { expectInvoked, invokeCalls, overleafLink, overleafStatus, projectCommands, projectSnapshot } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp, renderOverleafPaper } = appHarness();

/**
 * "Open from Overleaf" for a project already linked to a folder on this Mac
 * opens that folder — raising the window that shows it — instead of
 * downloading a second copy that would sync too and drift from the first.
 */
const NATIVE_VLM = "/Users/writer/Papers/Native VLM";
const pickerCommands = {
  overleaf_status: () => overleafStatus(),
  overleaf_list_projects: () => ({
    projects: [{
      id: "vlm", name: "Native VLM", lastUpdated: "2026-11-01T00:00:00Z", ownerEmail: "writer@example.edu",
      ownerName: "Writer", accessLevel: "owner", archived: false, trashed: false,
    }],
    invites: [],
  }),
  overleaf_local_copies: () => ({ vlm: { path: NATIVE_VLM, display: "~/Papers/Native VLM" } }),
  overleaf_reopen_local_copy: () => undefined,
  open_project_window: () => ({ label: "project-2", focusedExisting: true }),
};

async function openNativeVlm() {
  fireEvent.click(await screen.findByRole("button", { name: /Native VLM/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
}

describe("opening a project from Overleaf that already has a folder here", () => {
  it("hands it to its own window from a window already showing a project", async () => {
    renderOverleafPaper({ ...pickerCommands, overleaf_link: () => overleafLink({ projectId: "other" }) }, { syncMode: "manual" });
    const actions = await screen.findByRole("button", { name: "Overleaf project actions" });
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open another Overleaf project" }));
    expect(await screen.findByText("Opens your local copy at ~/Papers/Native VLM")).toBeInTheDocument();
    await openNativeVlm();
    await expectInvoked("open_project_window", { path: NATIVE_VLM });
    expect(invokeCalls("overleaf_clone_project")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByLabelText("Open from Overleaf")).not.toBeInTheDocument());
  });

  it("opens it in an empty window, or raises the window that already has it", async () => {
    let elsewhere = true;
    renderApp({
      ...projectCommands(null),
      ...pickerCommands,
      open_project: () => {
        if (elsewhere) throw new Error("This project is already open in another Lattice window. Open it in the browser from that window instead.");
        return projectSnapshot({ root: NATIVE_VLM });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open from Overleaf" }));
    await openNativeVlm();
    await expectInvoked("open_project_window", { path: NATIVE_VLM });
    // Raising the other window is the answer, not a failure to report.
    expect(screen.queryByText(/already open in another Lattice window/)).not.toBeInTheDocument();
    expect(invokeCalls("overleaf_clone_project")).toHaveLength(0);

    elsewhere = false;
    fireEvent.click(await screen.findByRole("button", { name: "Open from Overleaf" }));
    await openNativeVlm();
    await waitFor(() => expect(invokeCalls("open_project")).toHaveLength(2));
    expect(invokeCalls("open_project_window")).toHaveLength(1);
  });
});
