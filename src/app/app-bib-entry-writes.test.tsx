import {
  expectInvoked, fileNodes, openTreeFile, projectSnapshot, refreshableProject, ROOT, type Commands,
} from "./app-test-utils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";

const { renderApp } = appHarness({ documentCanvas });

const pathOf = (args: InvokeArgs | undefined) => (args as { path?: string } | undefined)?.path;
const OPENED = "@misc{opened, title={Read when the file opened}}\n";
const DURING = `${OPENED}@misc{during, title={Added by Overleaf meanwhile}}\n`;

// "New entry" on the open bibliography wrote the editor's text from when the
// dialog rendered, with no base, so an entry Overleaf, the agent or an import
// added since was lost (implicit-state audit S3).
describe("a new bibliography entry", () => {
  it("goes into the file as it is on disk now, as a merge against what it read", async () => {
    const disk = { bib: OPENED };
    renderApp({
      ...refreshableProject(projectSnapshot({ trusted: true, files: fileNodes("main.tex", "references.bib") })),
      read_project_file: (args) => (pathOf(args) === "references.bib" ? disk.bib : "\\documentclass{article}"),
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
    } satisfies Commands);
    await openTreeFile("references.bib");
    await waitFor(() => expect(document.querySelector(".source-editor .cm-content")?.textContent).toContain("Read when the file opened"));

    // Another writer adds an entry before the disk poll shows it.
    disk.bib = DURING;
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    const palette = await screen.findByRole("searchbox", { name: "Command palette" });
    fireEvent.change(palette, { target: { value: "Add papers" } });
    fireEvent.keyDown(palette, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Typed by hand" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Doe, Jane" } });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));

    await expectInvoked("write_project_file", {
      path: "references.bib",
      content: expect.stringMatching(/^@misc\{opened[^]*@misc\{during[^]*title = \{Typed by hand\}/),
      projectRoot: ROOT,
      baseContent: DURING,
    });
  });
});
