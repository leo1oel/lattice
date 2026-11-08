import { deferred, fileNode, findProjectTreeItem, invokeCalls, projectCommands, projectSnapshot, type Commands } from "./app-test-utils";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { appHarness } from "./app-test-mount";

const { renderApp } = appHarness();

const snapshot = projectSnapshot({ files: [fileNode("main.tex"), fileNode("notes.tex")] });
const pathOf = (args: InvokeArgs | undefined) => (args as { path?: string } | undefined)?.path;

/** The project's own reads ran: annotations, history and to-dos. */
async function expectScanned() {
  await waitFor(() => {
    expect(invokeCalls("list_annotations").length).toBeGreaterThan(0);
    expect(invokeCalls("list_history").length).toBeGreaterThan(0);
  });
}

// An entry whose restore was cut short used to skip the project's scan, so
// its annotations stayed empty and the next one made replaced the file with
// just itself (implicit-state audit S1).
describe("project entry scans", () => {
  it("reads the project's annotations and history once the restored file opens", async () => {
    renderApp({ ...projectCommands(snapshot), list_annotations: { annotations: [], rounds: [] } } satisfies Commands);
    await expectScanned();
  });

  it("still reads them when the restored main file cannot be read", async () => {
    renderApp({
      ...projectCommands(snapshot),
      list_annotations: { annotations: [], rounds: [] },
      read_project_file: (args) => {
        if (pathOf(args) === "main.tex") throw new Error("main.tex is not valid UTF-8");
        return "\\section{Notes}";
      },
    } satisfies Commands);
    await expectScanned();
  });

  it("still reads them when the writer opens another file before the restored one loads", async () => {
    const restored = deferred<string>();
    renderApp({
      ...projectCommands(snapshot),
      list_annotations: { annotations: [], rounds: [] },
      read_project_file: (args) => (pathOf(args) === "main.tex" ? restored.promise : "\\section{Notes}"),
    } satisfies Commands);
    fireEvent.click(await findProjectTreeItem("notes.tex"));
    // The restore's read lands after the writer's choice, which wins.
    restored.resolve("\\documentclass{article}");
    await expectScanned();
  });
});
