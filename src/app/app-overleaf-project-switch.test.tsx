import { chooseProjectMenuItem, expectInvoked, notesSnapshot, readFiles } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { overleafSession } from "./app-test-overleaf";
import { invoke } from "@tauri-apps/api/core";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { renderOverleafPaper } = appHarness();

/**
 * #1208: switching the window to another project while a file was open live
 * left that file's leave to the teardown after `open_project` had moved the
 * window, which refused it. The OT checkpoint was never written, and the
 * writer was told the file's syncing was paused.
 */
describe("switching projects while a file is open live", () => {
  it("hands the file back to Overleaf before the window moves", async () => {
    const OLD_ROOT = "/tmp/lattice-overleaf-paper";
    renderOverleafPaper({
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}" }, ""),
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      overleaf_rt_connect: () => overleafSession({ publicId: "me", userId: "me" }),
      overleaf_rt_join_doc: { text: "\\documentclass{article}", version: 4, comments: [], changes: [], caughtUp: [], resumed: false },
      overleaf_rt_leave_doc: null,
      overleaf_rt_update_position: null,
      open_tutorial_project: () => notesSnapshot(),
    }, { syncMode: "live" });
    await expectInvoked("overleaf_rt_join_doc", expect.objectContaining({ projectRoot: OLD_ROOT, docId: "main-doc" }));

    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    const order = vi.mocked(invoke).mock.calls.map(([command]) => command);
    const left = order.indexOf("overleaf_rt_leave_doc");
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(order.indexOf("open_tutorial_project"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("overleaf_rt_leave_doc", expect.objectContaining({
      projectRoot: OLD_ROOT, docId: "main-doc", checkpoint: expect.objectContaining({ version: 4 }),
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Notes"));
    expect(screen.queryByText(/hand this file back/)).not.toBeInTheDocument();
  });
});
